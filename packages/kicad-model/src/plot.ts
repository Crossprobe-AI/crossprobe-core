/**
 * Board plots as SVG, like KiCad's Plot dialog (SVG) and `kicad-cli pcb export svg`: the same
 * layer plot as the Gerbers (plotLayer), drawn with SVG paths in millimetres. Layers stack in the
 * order given, each in its colour; clear polarity (knockout text, drill holes) erases only within
 * its layer, by masking what that layer drew before it.
 */
import type { Point } from "./geometry.js";
import type { Board } from "./board.js";
import { arcPoints } from "./drc.js";
import { onLayer, plotLayer, type Plotter } from "./fab.js";

const n = (v: number) => (Math.round(v * 1e4) / 1e4).toString();

class Box {
  /** Ignore pen widths (KiCad's board area is the outline's centre line). */
  constructor(private bare = false) {}
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;
  add(p: Point, r = 0) {
    if (this.bare) r = 0;
    this.x0 = Math.min(this.x0, p.x - r);
    this.y0 = Math.min(this.y0, p.y - r);
    this.x1 = Math.max(this.x1, p.x + r);
    this.y1 = Math.max(this.y1, p.y + r);
  }
  get empty() {
    return !(this.x1 >= this.x0);
  }
}

/** Draws plotLayer's primitives as SVG shapes, filled (or stroked) with currentColor. */
class SvgPlotter implements Plotter {
  /** Finished content of the layer (masked groups nest as polarity flips). */
  private dark: string[] = [];
  private clear: string[] = [];
  private polarity: "D" | "C" = "D";
  private masks: string[] = [];
  constructor(
    private id: string,
    readonly box: Box,
  ) {}

  private push(el: string) {
    (this.polarity === "D" ? this.dark : this.clear).push(el);
  }
  /** Close a clear run: everything drawn so far goes in a group masked by the clear shapes. */
  private flush() {
    if (!this.clear.length) return;
    const id = `${this.id}-m${this.masks.length}`;
    this.masks.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="-10000" y="-10000" width="20000" height="20000"><rect x="-10000" y="-10000" width="20000" height="20000" fill="#fff"/><g fill="#000" stroke="#000">${this.clear.join("")}</g></mask>`);
    this.dark = [`<g mask="url(#${id})">${this.dark.join("")}</g>`];
    this.clear = [];
  }
  setPolarity(p: "D" | "C") {
    if (p === this.polarity) return;
    if (p === "D") {
      this.polarity = "D";
      this.flush();
    } else this.polarity = "C";
  }
  flashCircle(at: Point, d: number) {
    this.box.add(at, d / 2);
    this.push(`<circle cx="${n(at.x)}" cy="${n(at.y)}" r="${n(d / 2)}" stroke="none"/>`);
  }
  flashRect(at: Point, w: number, h: number) {
    this.box.add(at, Math.max(w, h) / 2);
    this.push(`<rect x="${n(at.x - w / 2)}" y="${n(at.y - h / 2)}" width="${n(w)}" height="${n(h)}" stroke="none"/>`);
  }
  flashOval(at: Point, w: number, h: number) {
    this.box.add(at, Math.max(w, h) / 2);
    const r = Math.min(w, h) / 2;
    this.push(`<rect x="${n(at.x - w / 2)}" y="${n(at.y - h / 2)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" stroke="none"/>`);
  }
  stroke(pts: Point[], w: number) {
    if (!pts.length) return;
    if (pts.length < 2) return this.flashCircle(pts[0]!, w);
    for (const p of pts) this.box.add(p, w / 2);
    this.push(`<path d="M${pts.map((p) => `${n(p.x)} ${n(p.y)}`).join("L")}" fill="none" stroke-width="${n(Math.max(w, 0.001))}"/>`);
  }
  arc(a: Point, m: Point, b: Point, w: number) {
    this.stroke(arcPoints(a, m, b).pts, w);
  }
  region(polys: Point[][]) {
    const d = polys
      .filter((p) => p.length >= 3)
      .map((p) => {
        for (const q of p) this.box.add(q);
        return `M${p.map((q) => `${n(q.x)} ${n(q.y)}`).join("L")}Z`;
      })
      .join("");
    if (d) this.push(`<path d="${d}" stroke="none"/>`);
  }
  /** The layer's group, and its masks. */
  done(color: string, layer: string): { defs: string; body: string } {
    this.flush();
    return { defs: this.masks.join(""), body: `<g id="${this.id}" data-layer="${layer}" fill="${color}" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">${this.dark.join("")}</g>` };
  }
}

export interface SvgPlotOptions {
  /** Colour per layer; layers without one are black. */
  colors?: Record<string, string>;
  /** Mirror left to right (to read bottom layers from below). */
  mirror?: boolean;
  /** Drill holes as actual-size openings on copper and mask layers (KiCad's default). */
  drillMarks?: boolean;
  /** Page background; none by default. */
  background?: string;
  /** Margin around the board area, mm. */
  margin?: number;
}

/**
 * Drill marks, actual size, as KiCad plots them on copper and mask layers: a hole is knocked out
 * of a pad on the layer that is bigger than it, and drawn dark otherwise (a hole with nothing
 * around it on this layer, like an NPTH, shows as a dark disc, as a drill map). Vias are knocked
 * out where they reach the layer.
 */
function drillMarks(g: Plotter, board: Board, layer: string) {
  const copper = board.copperLayers;
  const i = copper.indexOf(layer);
  const mask = layer.endsWith(".Mask");
  const tented = layer === "F.Mask" ? board.setup.tentFront : board.setup.tentBack;
  g.setPolarity("C");
  for (const v of board.vias) {
    const [a, b] = [copper.indexOf(v.layers[0]!), copper.indexOf(v.layers[v.layers.length - 1]!)];
    if (mask ? !tented : i >= Math.min(a, b) && i <= Math.max(a, b)) g.flashCircle(v.at, v.drill);
  }
  const mark = (pad: Board["footprints"][number]["pads"][number]) => {
    if (pad.drillSize && Math.abs(pad.drillSize.x - pad.drillSize.y) > 1e-9) {
      const swap = Math.round(((pad.rotation % 180) + 180) % 180) === 90;
      const { x: w, y: h } = pad.drillSize;
      if (Math.abs(((pad.rotation % 90) + 90) % 90) < 1e-6) g.flashOval(pad.at, swap ? h : w, swap ? w : h);
      else g.flashCircle(pad.at, Math.min(w, h));
    } else g.flashCircle(pad.at, pad.drill!);
  };
  const pads = board.footprints.flatMap((fp) => fp.pads).filter((p) => p.drill);
  const knocked = (p: (typeof pads)[number]) => onLayer(p.layers, layer) && (p.size.x > (p.drillSize?.x ?? p.drill!) + 1e-9 || p.size.y > (p.drillSize?.y ?? p.drill!) + 1e-9);
  for (const p of pads) if (knocked(p)) mark(p);
  g.setPolarity("D");
  for (const p of pads) if (!knocked(p)) mark(p);
}

/** The given layers of a board in one SVG, sized to the board outline (else to what's drawn), in mm. */
export function plotSvg(board: Board, layers: string[], o: SvgPlotOptions = {}): string {
  const box = new Box();
  const parts = layers.map((layer, i) => {
    const g = new SvgPlotter(`l${i}`, box);
    plotLayer(g, board, layer);
    if (o.drillMarks !== false && (layer.endsWith(".Cu") || layer.endsWith(".Mask"))) drillMarks(g, board, layer);
    return g.done(o.colors?.[layer] ?? "#000", layer);
  });
  // The page is the board area (KiCad's page-size-mode 2) when there's an outline.
  const edge = new Box(true);
  const ink = new SvgPlotter("edge", edge);
  plotLayer(ink, board, "Edge.Cuts");
  const area = edge.empty ? box : edge;
  const m = o.margin ?? 1;
  const [x0, y0, x1, y1] = area.empty ? [0, 0, 10, 10] : [area.x0 - m, area.y0 - m, area.x1 + m, area.y1 + m];
  const w = x1 - x0;
  const h = y1 - y0;
  const flip = o.mirror ? ` transform="translate(${n(x0 + x1)} 0) scale(-1 1)"` : "";
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}mm" height="${n(h)}mm" viewBox="${n(x0)} ${n(y0)} ${n(w)} ${n(h)}">`,
    `<title>${layers.join(", ")}</title>`,
    `<defs>${parts.map((p) => p.defs).join("")}</defs>`,
    o.background ? `<rect x="${n(x0)}" y="${n(y0)}" width="${n(w)}" height="${n(h)}" fill="${o.background}"/>` : "",
    `<g${flip}>${parts.map((p) => p.body).join("")}</g>`,
    `</svg>`,
    "",
  ].join("\n");
}

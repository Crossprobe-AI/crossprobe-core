/**
 * Footprints from a land pattern's dimensions, the way KiCad's footprint generator lays them out:
 * dual rows (SOIC, SOP, DFN / SON), quad (QFN, QFP, with an exposed pad and paste windows),
 * two-terminal chips, and through-hole pin grids (headers). The numbers come from a datasheet's
 * recommended land pattern; this only places them: pad 1 top-left, quad parts numbered counter-
 * clockwise, a fab body with a pin-1 corner, silkscreen clear of the pads and an IPC courtyard.
 */
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addFpGraphic, addFpPad, addFpPasteWindows, footprintNode, fpCourtyardBox, newFootprintText, placeFpField, setFpCourtyard, setFpProps } from "./footprint-edit.js";
import type { Point } from "./geometry.js";

export interface LandPattern {
  family: "dual" | "quad" | "chip" | "grid";
  name: string;
  description?: string;
  /** Signal pins (dual, quad), not counting an exposed pad; for a grid, its pad count. */
  pins: number;
  /** Centre-to-centre between neighbouring pads along a row. */
  pitch?: number;
  /** Pad size across the row (along the pitch) and along it (out from the body). */
  padWidth: number;
  padLength?: number;
  /**
   * Where the rows are: any one of C (centre-to-centre between opposite pads), Z (outer edge to
   * outer edge) or G (inner edge to inner edge); with padLength, or Z and G together.
   */
  rowSpan?: number;
  outerSpan?: number;
  innerSpan?: number;
  /** Quad parts with a different span top/bottom (rectangular bodies): the same, for the other pair of sides. */
  rowSpanY?: number;
  outerSpanY?: number;
  innerSpanY?: number;
  /** Quad parts with unequal sides: pins on the left (and right) side; the rest go top and bottom. */
  pinsLeft?: number;
  exposedPad?: { w: number; h: number; pasteColumns?: number; pasteRows?: number; pasteCoverage?: number };
  /** The package body (fab layer), centred. */
  body?: { w: number; h: number };
  shape?: "roundrect" | "rect" | "oval" | "circle";
  /** Grid (through-hole): columns and rows, drill, and the row pitch if it differs. */
  columns?: number;
  rows?: number;
  rowPitch?: number;
  drill?: number;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Pad length and centre-to-centre span from whichever two of length, C, Z and G are given. */
export function rowGeometry(o: { padLength?: number; rowSpan?: number; outerSpan?: number; innerSpan?: number }): { length: number; span: number } {
  const { padLength: L, rowSpan: C, outerSpan: Z, innerSpan: G } = o;
  if (L !== undefined && C !== undefined) return { length: L, span: C };
  if (L !== undefined && Z !== undefined) return { length: L, span: Z - L };
  if (L !== undefined && G !== undefined) return { length: L, span: G + L };
  if (Z !== undefined && G !== undefined) return { length: (Z - G) / 2, span: (Z + G) / 2 };
  if (C !== undefined && Z !== undefined) return { length: Z - C, span: C };
  if (C !== undefined && G !== undefined) return { length: C - G, span: C };
  throw new Error("The land pattern needs the pad length and one of C, Z or G (or Z and G)");
}

/** The footprint (.kicad_mod text) for a land pattern. */
export function landPatternText(lp: LandPattern): string {
  const smd = lp.family !== "grid";
  const doc = parse(newFootprintText(lp.name, { smd, description: lp.description }));
  const fp = footprintNode(doc);
  const shape = lp.shape ?? (smd ? "roundrect" : "oval");
  const pad = (number: number, at: Point, size: Point, s = shape) =>
    addFpPad(fp, { number: String(number), type: smd ? "smd" : "thru_hole", shape: s, at: { x: r4(at.x), y: r4(at.y) }, size: { x: r4(size.x), y: r4(size.y) }, drill: smd ? undefined : lp.drill });
  // Where the pads end (for silkscreen and pin-1 marks).
  let padBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const grow = (at: Point, size: Point) => {
    padBox = { x0: Math.min(padBox.x0, at.x - size.x / 2), y0: Math.min(padBox.y0, at.y - size.y / 2), x1: Math.max(padBox.x1, at.x + size.x / 2), y1: Math.max(padBox.y1, at.y + size.y / 2) };
  };
  const place = (n: number, at: Point, size: Point, s?: typeof shape) => {
    pad(n, at, size, s);
    grow(at, size);
  };

  if (lp.family === "chip") {
    const g = rowGeometry(lp);
    for (const [k, x] of [[1, -g.span / 2], [2, g.span / 2]] as const) place(k, { x, y: 0 }, { x: g.length, y: lp.padWidth });
  } else if (lp.family === "dual") {
    const g = rowGeometry(lp);
    const per = lp.pins / 2;
    const e = lp.pitch!;
    for (let i = 0; i < per; i++) place(i + 1, { x: -g.span / 2, y: -((per - 1) / 2) * e + i * e }, { x: g.length, y: lp.padWidth });
    for (let i = 0; i < per; i++) place(per + i + 1, { x: g.span / 2, y: ((per - 1) / 2) * e - i * e }, { x: g.length, y: lp.padWidth });
  } else if (lp.family === "quad") {
    const gx = rowGeometry(lp);
    const gy = rowGeometry({ padLength: lp.padLength, rowSpan: lp.rowSpanY ?? lp.rowSpan, outerSpan: lp.outerSpanY ?? lp.outerSpan, innerSpan: lp.innerSpanY ?? lp.innerSpan });
    const left = lp.pinsLeft ?? lp.pins / 4;
    const top = (lp.pins - 2 * left) / 2;
    const e = lp.pitch!;
    let n = 1;
    // Left side top to bottom, bottom left to right, right bottom to top, top right to left.
    for (let i = 0; i < left; i++) place(n++, { x: -gx.span / 2, y: -((left - 1) / 2) * e + i * e }, { x: gx.length, y: lp.padWidth });
    for (let i = 0; i < top; i++) place(n++, { x: -((top - 1) / 2) * e + i * e, y: gy.span / 2 }, { x: lp.padWidth, y: gy.length });
    for (let i = 0; i < left; i++) place(n++, { x: gx.span / 2, y: ((left - 1) / 2) * e - i * e }, { x: gx.length, y: lp.padWidth });
    for (let i = 0; i < top; i++) place(n++, { x: ((top - 1) / 2) * e - i * e, y: -gy.span / 2 }, { x: lp.padWidth, y: gy.length });
  } else {
    // A pin grid: numbered across each row (1, 2 on the first row of a 2-column header), pad 1 square.
    const cols = lp.columns ?? 1;
    const rows = lp.rows ?? Math.ceil(lp.pins / cols);
    const e = lp.pitch!;
    const ey = lp.rowPitch ?? e;
    let n = 1;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols && n <= lp.pins; i++) place(n, { x: i * e, y: j * ey }, { x: lp.padLength ?? lp.padWidth, y: lp.padWidth }, n++ === 1 ? "rect" : shape);
  }

  if (lp.exposedPad && (lp.family === "quad" || lp.family === "dual")) {
    const ep = lp.exposedPad;
    const id = addFpPad(fp, { number: String(lp.pins + 1), type: "smd", shape: "rect", at: { x: 0, y: 0 }, size: { x: ep.w, y: ep.h }, heatsink: true });
    addFpPasteWindows(fp, id, { columns: ep.pasteColumns ?? Math.max(1, Math.round(ep.w / 1.2)), rows: ep.pasteRows ?? Math.max(1, Math.round(ep.h / 1.2)), coverage: ep.pasteCoverage ?? 0.65 });
  }

  // Fab: the body with its pin-1 corner cut (KiCad's convention), else the pads' extent.
  const bw = lp.body?.w ?? padBox.x1 - padBox.x0;
  const bh = lp.body?.h ?? padBox.y1 - padBox.y0;
  const cx = lp.family === "grid" ? (padBox.x0 + padBox.x1) / 2 : 0;
  const cy = lp.family === "grid" ? (padBox.y0 + padBox.y1) / 2 : 0;
  const cut = Math.min(1, Math.min(bw, bh) * 0.25);
  const [x0, y0, x1, y1] = [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2].map(r4) as [number, number, number, number];
  addFpGraphic(fp, { kind: "poly", layer: "F.Fab", points: [{ x: r4(x0 + cut), y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: r4(y0 + cut) }] });

  // Silkscreen: the body outline outside the pads, 0.2 mm out (KiCad's silk-to-pad gap keeps it clear of the copper).
  const gap = 0.2;
  const s = { x0: Math.min(x0, padBox.x0) - gap, y0: Math.min(y0, padBox.y0) - gap, x1: Math.max(x1, padBox.x1) + gap, y1: Math.max(y1, padBox.y1) + gap };
  if (lp.family === "dual" || lp.family === "chip") {
    // Top and bottom edges only, between the pad rows (the rows themselves stay bare).
    const ix0 = lp.family === "chip" ? -(rowGeometry(lp).span / 2 - rowGeometry(lp).length / 2) + gap : x0;
    const ix1 = -ix0;
    for (const y of [Math.min(y0, padBox.y0) - gap, Math.max(y1, padBox.y1) + gap]) addFpGraphic(fp, { kind: "line", layer: "F.SilkS", points: [{ x: r4(ix0), y: r4(y) }, { x: r4(ix1), y: r4(y) }] });
    if (lp.family === "dual") addFpGraphic(fp, { kind: "line", layer: "F.SilkS", points: [{ x: r4(s.x0), y: r4(s.y0) }, { x: r4(ix0), y: r4(s.y0) }] });
  } else if (lp.family === "quad") {
    // The corners, clear of the pad rows; pin 1's corner gets a tick out to the pads.
    const l = 0.4;
    const corners: Array<[number, number, number, number]> = [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]];
    for (const [x, y, sx, sy] of corners) {
      const ox = x - sx * gap;
      const oy = y - sy * gap;
      addFpGraphic(fp, { kind: "line", layer: "F.SilkS", points: [{ x: r4(ox), y: r4(oy) }, { x: r4(ox + sx * l), y: r4(oy) }] });
      addFpGraphic(fp, { kind: "line", layer: "F.SilkS", points: [{ x: r4(ox), y: r4(oy) }, { x: r4(ox), y: r4(oy + sy * l) }] });
    }
  } else {
    addFpGraphic(fp, { kind: "rect", layer: "F.SilkS", points: [{ x: r4(s.x0), y: r4(s.y0) }, { x: r4(s.x1), y: r4(s.y1) }] });
  }
  setFpCourtyard(fp);
  // Reference above the courtyard and Value below it, 0.7 mm out (KiCad's generator: R_0603 at ±1.43).
  const crt = fpCourtyardBox(fp);
  if (crt) {
    placeFpField(fp, "Reference", { x: r4((crt.x0 + crt.x1) / 2), y: r4(crt.y0 - 0.7) });
    placeFpField(fp, "Value", { x: r4((crt.x0 + crt.x1) / 2), y: r4(crt.y1 + 0.7) });
  }
  if (lp.description) setFpProps(fp, { description: lp.description });
  return serialize(doc);
}

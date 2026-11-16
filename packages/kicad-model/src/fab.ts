/**
 * Fabrication outputs from a board: Gerber X2 per layer (copper, solder
 * mask, paste, silkscreen, board outline), Excellon drill files (plated and
 * non-plated), a bill of materials and a pick-and-place position file, laid
 * out and named the way KiCad's plotter names them so fabs recognise them.
 *
 * Coordinates are mm with Y flipped (Gerber and Excellon are Y-up, KiCad is
 * Y-down). Simple pads are flashed with standard apertures; other pad shapes
 * and zone fills are regions. Text is plotted in KiCad's stroke font (see stroke-font.ts).
 */
import { flashChecker, type Board, type BoardText, type Footprint, type Graphic, type Pad, type Via } from "./board.js";
import { arcPoints, projectDesignRules, type DesignRules } from "./drc.js";
import { gerberJob, gerberProjectGuid } from "./gbrjob.js";
import { ipcD356 } from "./ipc356.js";
import type { Point } from "./geometry.js";
import { strokeAdvance, strokeGlyph, strokeLinePositions } from "./stroke-font.js";
import { fracture, padCopperCenter, padPolygons } from "./zone-fill.js";
import ClipperLib from "clipper-lib";
import { projectFileName } from "./new-project.js";

const fmt = (v: number) => String(Math.round(v * 1e6));
const num = (v: number) => String(Math.round(v * 1e6) / 1e6);

/** Does a pad/via layer list (with *.Cu, F&B.Cu wildcards) include `layer`? */
/** Is an item with these layers (wildcards like *.Mask, F&B.Cu) on `layer`? */
export function onLayer(layers: string[], layer: string): boolean {
  return layers.some((l) => l === layer || (l.startsWith("*.") && layer.endsWith(l.slice(1))) || (l.startsWith("F&B.") && (layer === `F.${l.slice(4)}` || layer === `B.${l.slice(4)}`)));
}

// ---------------------------------------------------------------------------
// Gerber writer
// ---------------------------------------------------------------------------

/** What a layer plot draws with: Gerber's primitives (also drawn as SVG, see plot.ts). */
export interface Plotter {
  /** "C" (clear) erases what was drawn before it, until "D" (dark) again. */
  setPolarity(p: "D" | "C"): void;
  flashCircle(at: Point, d: number): void;
  flashRect(at: Point, w: number, h: number): void;
  flashOval(at: Point, w: number, h: number): void;
  /** A stroked polyline with a round pen of width w. */
  stroke(pts: Point[], w: number): void;
  /** A circular arc from a through m to b, stroked with width w. */
  arc(a: Point, m: Point, b: Point, w: number): void;
  /** Filled polygons (simple outlines). */
  region(polys: Point[][]): void;
}

class Gerber implements Plotter {
  private apertures = new Map<string, number>();
  private body: string[] = [];
  private current?: number;
  private polarity: "D" | "C" = "D";

  constructor(private header: string[]) {}

  private use(def: string) {
    let d = this.apertures.get(def);
    if (d === undefined) this.apertures.set(def, (d = 10 + this.apertures.size));
    if (this.current !== d) {
      this.body.push(`D${d}*`);
      this.current = d;
    }
  }
  private xy = (p: Point) => `X${fmt(p.x)}Y${fmt(-p.y)}`;

  setPolarity(p: "D" | "C") {
    if (p !== this.polarity) this.body.push(`%LP${p}*%`);
    this.polarity = p;
  }
  flashCircle(at: Point, d: number) {
    this.use(`C,${num(d)}`);
    this.body.push(`${this.xy(at)}D03*`);
  }
  flashRect(at: Point, w: number, h: number) {
    this.use(`R,${num(w)}X${num(h)}`);
    this.body.push(`${this.xy(at)}D03*`);
  }
  flashOval(at: Point, w: number, h: number) {
    this.use(`O,${num(w)}X${num(h)}`);
    this.body.push(`${this.xy(at)}D03*`);
  }
  /** A stroked polyline with a round pen of width w. */
  stroke(pts: Point[], w: number) {
    if (pts.length < 2) return pts[0] && this.flashCircle(pts[0], w);
    this.use(`C,${num(Math.max(w, 0.001))}`);
    this.body.push(`${this.xy(pts[0]!)}D02*`);
    for (const p of pts.slice(1)) this.body.push(`${this.xy(p)}D01*`);
  }
  /** A circular arc from a through m to b, stroked with width w. */
  arc(a: Point, m: Point, b: Point, w: number) {
    const { pts } = arcPoints(a, m, b);
    const c = circleCenter(a, m, b);
    if (!c) return this.stroke([a, b], w);
    this.use(`C,${num(Math.max(w, 0.001))}`);
    // In Gerber's Y-up frame, the turn a→m→b decides the direction.
    const cross = (m.x - a.x) * (-(b.y) + m.y) - (-(m.y) + a.y) * (b.x - m.x);
    this.body.push("G75*", `${this.xy(a)}D02*`, cross > 0 ? "G03*" : "G02*", `${this.xy(b)}I${fmt(c.x - a.x)}J${fmt(-(c.y - a.y))}D01*`, "G01*");
    void pts;
  }
  /** Filled polygons (simple outlines). */
  region(polys: Point[][]) {
    for (const poly of polys) {
      if (poly.length < 3) continue;
      this.body.push("G36*", `${this.xy(poly[0]!)}D02*`);
      for (const p of poly.slice(1)) this.body.push(`${this.xy(p)}D01*`);
      this.body.push(`${this.xy(poly[0]!)}D01*`, "G37*");
    }
  }
  get empty() {
    return this.body.length === 0;
  }
  toString(): string {
    const ads = [...this.apertures].map(([def, d]) => {
      const [kind, size] = def.split(",");
      return `%ADD${d}${kind},${size}*%`;
    });
    return [...this.header, "%FSLAX46Y46*%", "%MOMM*%", "%LPD*%", "G01*", ...ads, ...this.body, "M02*", ""].join("\n");
  }
}

function circleCenter(a: Point, m: Point, b: Point): Point | undefined {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-12) return undefined;
  const sq = (p: Point) => p.x * p.x + p.y * p.y;
  return {
    x: (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d,
    y: (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d,
  };
}

// ---------------------------------------------------------------------------
// Primitives: graphics, text, pads
// ---------------------------------------------------------------------------

function plotGraphic(g: Plotter, gr: Graphic) {
  const p = gr.points;
  const w = gr.width;
  switch (gr.kind) {
    case "line":
      return g.stroke([p[0]!, p[1]!], w);
    case "arc":
      return g.arc(p[0]!, p[1]!, p[2]!, w);
    case "circle": {
      const r = Math.hypot(p[1]!.x - p[0]!.x, p[1]!.y - p[0]!.y);
      const ring = Array.from({ length: 73 }, (_, i) => ({ x: p[0]!.x + r * Math.cos((i * Math.PI) / 36), y: p[0]!.y + r * Math.sin((i * Math.PI) / 36) }));
      if (gr.fill) g.region([ring.slice(0, -1)]);
      if (w > 0 || !gr.fill) g.stroke(ring, w);
      return;
    }
    case "rect": {
      const [a, b] = [p[0]!, p[1]!];
      const loop = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
      if (gr.fill) g.region([loop]);
      if (w > 0 || !gr.fill) g.stroke([...loop, a], w);
      return;
    }
    case "poly": {
      if (gr.fill) g.region([p]);
      if (w > 0 || !gr.fill) g.stroke([...p, p[0]!], w);
      return;
    }
    default:
      return g.stroke(p, w);
  }
}

const glyphCache = new Map<number, { half: number; strokes: Point[][] }>();

/**
 * Strokes of a text item in its own frame (x along the text, y down, anchor at
 * the origin) and the transform to board mm. Glyph height = size.y, as KiCad
 * sizes text.
 */
/**
 * A line split at KiCad's text markup: ~{…} is overbarred; ^{…} and _{…}
 * (super/subscript) are shown as plain text here. Unclosed markup stays literal.
 */
function markupRuns(line: string): Array<{ text: string; overbar: boolean }> {
  const out: Array<{ text: string; overbar: boolean }> = [];
  let plain = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if ((c === "~" || c === "^" || c === "_") && line[i + 1] === "{") {
      const end = line.indexOf("}", i + 2);
      if (end > 0) {
        if (plain) out.push({ text: plain, overbar: false });
        plain = "";
        out.push({ text: line.slice(i + 2, end), overbar: c === "~" });
        i = end;
        continue;
      }
    }
    plain += c;
  }
  if (plain) out.push({ text: plain, overbar: false });
  return out;
}

function textLayout(t: BoardText): { strokes: Point[][]; place: (p: Point) => Point; unplace: (p: Point) => Point } {
  // KiCad's split: a trailing newline doesn't start another line.
  const lines = t.text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const mirror = t.justify.includes("mirror");
  const advance = (line: string) => markupRuns(line).reduce((w, r) => w + strokeAdvance(r.text), 0);
  // Footprint texts stay readable (KiCad's keep-upright), unless unlocked.
  let a = ((t.rotation % 360) + 360) % 360;
  if (t.keepUpright && a > 90 && a <= 270) a -= 180;
  const rad = (a * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const origins = strokeLinePositions(lines, t.size, textPen(t), t.justify, advance);
  const strokes: Point[][] = [];
  const m = mirror ? -1 : 1;
  lines.forEach((line, li) => {
    let x = origins[li]!.x;
    const base = origins[li]!.y;
    for (const run of markupRuns(line)) {
      const x0 = x;
      for (const ch of run.text) {
        const g = strokeGlyph(ch.codePointAt(0)!);
        for (const st of g.strokes) strokes.push(st.map((p) => ({ x: (x + p.x * t.size.x) * m, y: base + p.y * t.size.y })));
        x += g.width * t.size.x;
      }
      // KiCad's overbar: 1.23 heights above the baseline, trimmed by a tenth of the width at each end.
      if (run.overbar && x > x0) {
        const y = base - t.size.y * 1.23;
        const trim = t.size.x * 0.1;
        strokes.push([{ x: (x0 + trim) * m, y }, { x: (x - trim) * m, y }]);
      }
    }
  });
  // Rotate CCW by `a` in a Y-down frame, then place at the anchor (and back).
  return {
    strokes,
    place: (p) => ({ x: t.at.x + p.x * c + p.y * s, y: t.at.y - p.x * s + p.y * c }),
    unplace: (p) => {
      const dx = p.x - t.at.x, dy = p.y - t.at.y;
      return { x: dx * c - dy * s, y: dx * s + dy * c };
    },
  };
}

/**
 * A TrueType text's filled glyphs (KiCad's cached outlines) as simple
 * polygons, holes joined to their outlines; undefined for stroke-font text.
 */
export function textOutline(t: BoardText): Point[][] | undefined {
  if (!t.outline?.length) return undefined;
  const S = 1e5;
  const c = new ClipperLib.Clipper();
  c.AddPaths(t.outline.map((loop) => loop.map((p) => ({ X: Math.round(p.x * S), Y: Math.round(p.y * S) }))), ClipperLib.PolyType.ptSubject, true);
  const merged: ClipperLib.Paths = [];
  c.Execute(ClipperLib.ClipType.ctUnion, merged, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
  return fracture(merged);
}

/** Strokes of a text item in board mm (none for TrueType text: see textOutline). */
export function textStrokes(t: BoardText): Point[][] {
  if (t.outline?.length) return [];
  const { strokes, place } = textLayout(t);
  return strokes.map((st) => st.map(place));
}

/**
 * The pen a board text is drawn with: its thickness (KiCad's default, an
 * eighth of the height, when none is given), 1.6 times heavier when bold,
 * never more than a quarter of the text size.
 */
export const textPen = (t: BoardText) => Math.min((t.thickness || t.size.y / 8) * (t.bold ? 1.6 : 1), Math.min(t.size.x, t.size.y) / 4);

/**
 * Knockout text: the filled box (in board coordinates) and the letter strokes
 * cut out of it, as KiCad plots it.
 */
export function knockoutText(t: BoardText): { box: Point[]; strokes: Point[][] } | undefined {
  const w = textPen(t);
  const { strokes, place, unplace } = textLayout(t);
  // TrueType glyphs already have their thickness: their outline bounds the box.
  const pts = t.outline?.length ? t.outline.flat().map(unplace) : strokes.flat();
  if (!pts.length) return undefined;
  const m = (t.outline?.length ? 0 : w / 2) + Math.max(w / 2, t.size.y / 9);
  const x0 = Math.min(...pts.map((p) => p.x)) - m;
  const x1 = Math.max(...pts.map((p) => p.x)) + m;
  const y0 = Math.min(...pts.map((p) => p.y)) - m;
  const y1 = Math.max(...pts.map((p) => p.y)) + m;
  return { box: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }].map(place), strokes: strokes.map((st) => st.map(place)) };
}

function plotText(g: Plotter, t: BoardText) {
  const w = textPen(t);
  const glyphs = textOutline(t);
  if (glyphs) {
    if (!t.knockout) return g.region(glyphs);
    const k = knockoutText(t);
    if (!k) return;
    g.region([k.box]);
    g.setPolarity("C");
    g.region(glyphs);
    g.setPolarity("D");
    return;
  }
  if (!t.knockout) {
    for (const st of textStrokes(t)) g.stroke(st, w);
    return;
  }
  // Knockout: a filled box around the text with the strokes cut out of it.
  const k = knockoutText(t);
  if (!k) return;
  g.region([k.box]);
  g.setPolarity("C");
  for (const st of k.strokes) g.stroke(st, w);
  g.setPolarity("D");
}

export const hasCopper = (pad: Pad) => pad.layers.some((l) => l.endsWith(".Cu"));

const isRight = (deg: number) => Math.abs(((deg % 90) + 90) % 90) < 1e-6 || Math.abs((((deg % 90) + 90) % 90) - 90) < 1e-6;

/** A pad's shape grown by `grow` mm: flashed when it is a standard aperture, else a region. */
function plotPad(g: Plotter, pad: Pad, grow: number) {
  const at = padCopperCenter(pad);
  const w = pad.size.x + 2 * grow;
  const h = pad.size.y + 2 * grow;
  if (w <= 0 || h <= 0) return;
  const swap = isRight(pad.rotation) && Math.round(((pad.rotation % 180) + 180) % 180) === 90;
  if (pad.shape === "circle") return g.flashCircle(at, w);
  if (isRight(pad.rotation) && !pad.chamfer && pad.shape !== "custom") {
    if (pad.shape === "rect") return g.flashRect(at, swap ? h : w, swap ? w : h);
    if (pad.shape === "oval") return Math.abs(w - h) < 1e-9 ? g.flashCircle(at, w) : g.flashOval(at, swap ? h : w, swap ? w : h);
  }
  if (pad.shape === "roundrect" && !pad.chamfer) return g.region([roundRectOutline(pad, at, w, h, Math.min(pad.size.x, pad.size.y) * (pad.roundrectRatio ?? 0.25) + grow)]);
  g.region(padPolygons(pad, grow));
}

/** A rounded rectangle with its corner arcs traced exactly (vertices on the arcs), rotated with the pad. */
function roundRectOutline(pad: Pad, at: Point, w: number, h: number, r: number): Point[] {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  const hw = w / 2 - rad;
  const hh = h / 2 - rad;
  const a = (pad.rotation * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const out: Point[] = [];
  const corners: Array<[number, number, number]> = [
    [hw, hh, 0],
    [-hw, hh, Math.PI / 2],
    [-hw, -hh, Math.PI],
    [hw, -hh, (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, start] of corners) {
    for (let k = 0; k <= 16; k++) {
      const t = start + (Math.PI / 2) * (k / 16);
      const x = cx + rad * Math.cos(t);
      const y = cy + rad * Math.sin(t);
      // KiCad rotates CCW in a Y-down frame.
      out.push({ x: at.x + x * c + y * s, y: at.y - x * s + y * c });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export interface FabOptions {
  /** Base name for files (the project name). */
  name: string;
  /** Also write JLCPCB's assembly BOM and CPL files. */
  jlcpcb?: boolean;
  /** ISO timestamp for the file headers; defaults to now. */
  date?: string;
  /** The project's design rules, for the Gerber job file's clearances (KiCad's defaults without). */
  rules?: DesignRules;
  /** Adds a Datasheet column to the BOM: reference → text (the part's datasheet link, or where its pinned evidence is). */
  datasheets?: Record<string, string>;
}

function fileFunction(board: Board, layer: string): string {
  const copper = board.copperLayers;
  if (layer.endsWith(".Cu")) {
    const i = copper.indexOf(layer) + 1;
    return `Copper,L${i},${layer === "F.Cu" ? "Top" : layer === "B.Cu" ? "Bot" : "Inr"}`;
  }
  const side = layer.startsWith("F.") ? "Top" : "Bot";
  if (layer.endsWith(".Mask")) return `Soldermask,${side}`;
  if (layer.endsWith(".Paste")) return `Paste,${side}`;
  if (layer.endsWith(".SilkS")) return `Legend,${side}`;
  if (layer === "Edge.Cuts") return "Profile,NP";
  return "Other,User";
}

const fileLayerName = (board: Board, layer: string) => {
  const user = board.layers.find((l) => l.name === layer)?.userName;
  // KiCad names files after the layer's display name with "." → "_".
  return (user ?? (layer.endsWith(".SilkS") ? layer.replace("SilkS", "Silkscreen") : layer)).replace(/\./g, "_");
};

/** One layer as a Gerber X2 file. */
export function plotGerber(board: Board, layer: string, o: FabOptions): string {
  const g = new Gerber([
    `%TF.GenerationSoftware,Crossprobe,Crossprobe,1*%`,
    `%TF.CreationDate,${o.date ?? new Date().toISOString()}*%`,
    `%TF.ProjectId,${o.name.replace(/[^A-Za-z0-9_-]/g, "_")},${gerberProjectGuid(`${o.name}.kicad_pcb`)},${board.revision ?? "rev?"}*%`,
    `%TF.SameCoordinates,Original*%`,
    `%TF.FileFunction,${fileFunction(board, layer)}*%`,
    `%TF.FilePolarity,${layer.endsWith(".Mask") ? "Negative" : "Positive"}*%`,
  ]);
  plotLayer(g, board, layer);
  return g.toString();
}

/** Everything on one layer, as KiCad plots it, drawn with `g`. */
export function plotLayer(g: Plotter, board: Board, layer: string): void {
  const copper = layer.endsWith(".Cu");
  const mask = layer.endsWith(".Mask");
  const paste = layer.endsWith(".Paste");
  const flashed = copper ? flashChecker(board) : undefined;

  // Zone fills first, then everything drawn on top.
  if (copper) for (const z of board.zones) for (const f of z.fills) if (f.layer === layer && !z.keepout) g.region([f.points]);

  const graphics = (fp?: Footprint) => (fp ? fp.graphics : board.drawings).filter((gr) => gr.layer === layer);
  for (const fp of board.footprints) for (const gr of graphics(fp)) plotGraphic(g, gr);
  for (const gr of graphics()) plotGraphic(g, gr);

  // Texts on whatever layer they're on (KiCad plots them on all of them).
  for (const fp of board.footprints) for (const t of fp.texts) if (t.layer === layer) plotText(g, t);
  for (const t of board.texts) if (t.layer === layer) plotText(g, t);

  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      if (!onLayer(pad.layers, layer)) continue;
      if (copper) {
        if (pad.type === "np_thru_hole" && Math.max(pad.size.x, pad.size.y) <= (pad.drill ?? 0) + 1e-9) continue;
        if (pad.type !== "smd" && pad.type !== "connect" && flashed && !flashed(pad, layer)) continue;
        plotPad(g, pad, 0);
      } else if (mask) {
        // Pads with no copper (mask- or paste-only) are plotted as drawn, without margins, as in KiCad.
        plotPad(g, pad, hasCopper(pad) ? (pad.maskMargin ?? fp.maskMargin ?? board.setup.maskMargin) : 0);
      } else if (paste) {
        if (pad.type !== "smd" && pad.type !== "connect") continue;
        const copperPad = hasCopper(pad);
        const margin = copperPad ? (pad.pasteMargin ?? fp.pasteMargin ?? board.setup.pasteMargin) : 0;
        const ratio = copperPad ? (pad.pasteRatio ?? fp.pasteRatio ?? board.setup.pasteRatio) : 0;
        if (pad.shape === "custom") {
          // Custom shapes shrink or grow as one outline.
          g.region(padPolygons(pad, margin + ratio * Math.min(pad.size.x, pad.size.y)));
          continue;
        }
        // KiCad applies the ratio per axis: each side moves by margin + ratio × that side.
        const size = { x: pad.size.x + 2 * (margin + ratio * pad.size.x), y: pad.size.y + 2 * (margin + ratio * pad.size.y) };
        if (size.x > 0 && size.y > 0) {
          // Round corners grow or shrink with the margin, like an offset outline.
          const r0 = pad.shape === "roundrect" ? Math.min(pad.size.x, pad.size.y) * (pad.roundrectRatio ?? 0.25) : 0;
          const r = Math.max(0, r0 + Math.min(size.x - pad.size.x, size.y - pad.size.y) / 2);
          plotPad(g, { ...pad, size, roundrectRatio: pad.shape === "roundrect" ? r / Math.min(size.x, size.y) : pad.roundrectRatio }, 0);
        }
      }
    }
  }

  if (copper) {
    for (const t of board.tracks) {
      if (t.layer !== layer) continue;
      if (t.kind === "arc" && t.mid) g.arc(t.start, t.mid, t.end, t.width);
      else g.stroke([t.start, t.end], t.width);
    }
    const index = board.copperLayers;
    for (const v of board.vias) {
      const [a, b] = [index.indexOf(v.layers[0]!), index.indexOf(v.layers[v.layers.length - 1]!)];
      const i = index.indexOf(layer);
      if (i < Math.min(a, b) || i > Math.max(a, b)) continue;
      if (flashed && !flashed(v, layer)) continue;
      g.flashCircle(v.at, v.size);
    }
  }
  if (mask) {
    const tented = layer === "F.Mask" ? board.setup.tentFront : board.setup.tentBack;
    if (!tented) for (const v of board.vias) g.flashCircle(v.at, v.size + 2 * board.setup.maskMargin);
  }
}

// ---------------------------------------------------------------------------
// Drill files (Excellon)
// ---------------------------------------------------------------------------

interface Hole {
  at: Point;
  d: number;
  /** For slots: the far end of the slot (the hole runs from `at` to `to`). */
  to?: Point;
}

/** A via's copper span, top to bottom. */
export function viaSpan(board: Board, v: Via): [string, string] {
  const copper = board.copperLayers;
  const idx = v.layers.map((l) => copper.indexOf(l)).filter((i) => i >= 0);
  if (idx.length < 2) return [copper[0]!, copper[copper.length - 1]!];
  return [copper[Math.min(...idx)]!, copper[Math.max(...idx)]!];
}
const isThroughSpan = (board: Board, s: [string, string]) => s[0] === board.copperLayers[0] && s[1] === board.copperLayers[board.copperLayers.length - 1];

/** KiCad's name for a drill span: the two layers in its layer-ID order (F.Cu, B.Cu, In1.Cu…), "front", "back" or "inN". */
export function drillSpanName(s: [string, string]): string {
  const id = (l: string) => (l === "F.Cu" ? 0 : l === "B.Cu" ? 1 : Number(/^In(\d+)\.Cu$/.exec(l)?.[1] ?? 99) + 1);
  const name = (l: string) => (l === "F.Cu" ? "front" : l === "B.Cu" ? "back" : `in${/^In(\d+)\.Cu$/.exec(l)?.[1] ?? "?"}`);
  return [...s].sort((a, b) => id(a) - id(b)).map(name).join("-");
}

/** The spans of the board's blind, buried and micro vias (each gets its own drill file). */
export function drillSpans(board: Board): Array<[string, string]> {
  const out = new Map<string, [string, string]>();
  for (const v of board.vias) {
    const s = viaSpan(board, v);
    if (!isThroughSpan(board, s)) out.set(s.join(), s);
  }
  const copper = board.copperLayers;
  return [...out.values()].sort((a, b) => copper.indexOf(a[0]) - copper.indexOf(b[0]) || copper.indexOf(a[1]) - copper.indexOf(b[1]));
}

function holesOf(board: Board, plated: boolean, span?: [string, string]): Hole[] {
  const out: Hole[] = [];
  if (span) {
    for (const v of board.vias) if (viaSpan(board, v).join() === span.join()) out.push({ at: v.at, d: v.drill });
    return out;
  }
  if (plated) for (const v of board.vias) if (isThroughSpan(board, viaSpan(board, v))) out.push({ at: v.at, d: v.drill });
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      if (!pad.drill) continue;
      if ((pad.type === "np_thru_hole") === plated) continue;
      if (pad.drillSize && Math.abs(pad.drillSize.x - pad.drillSize.y) > 1e-9) {
        const { x: w, y: h } = pad.drillSize;
        const d = Math.min(w, h);
        const half = (Math.max(w, h) - d) / 2;
        const r = (pad.rotation * Math.PI) / 180;
        const axis = w > h ? { x: Math.cos(r), y: -Math.sin(r) } : { x: Math.sin(r), y: Math.cos(r) };
        out.push({ at: { x: pad.at.x - axis.x * half, y: pad.at.y - axis.y * half }, to: { x: pad.at.x + axis.x * half, y: pad.at.y + axis.y * half }, d });
      } else out.push({ at: pad.at, d: pad.drill });
    }
  }
  return out;
}

/**
 * An Excellon drill file (metric, decimal, absolute) for plated or non-plated holes; with a
 * span, the blind, buried or micro vias between those two layers.
 */
export function drillFile(board: Board, plated: boolean, o: FabOptions, span?: [string, string]): string {
  const holes = holesOf(board, plated, span);
  const copper = board.copperLayers;
  const fn = span
    ? (() => {
        const [a, b] = [copper.indexOf(span[0]) + 1, copper.indexOf(span[1]) + 1];
        return `Plated,${a},${b},${a === 1 || b === copper.length ? "Blind" : "Buried"}`;
      })()
    : `${plated ? "Plated" : "NonPlated"},1,${copper.length},${plated ? "PTH" : "NPTH"}`;
  const sizes = [...new Set(holes.map((h) => Math.round(h.d * 1000) / 1000))].sort((a, b) => a - b);
  const xy = (p: Point) => `X${num(p.x)}Y${num(-p.y)}`;
  const lines = [
    "M48",
    `; DRILL file {Crossprobe} date ${o.date ?? new Date().toISOString()}`,
    "; FORMAT={-:-/ absolute / metric / decimal}",
    `; #@! TF.GenerationSoftware,Crossprobe,Crossprobe,1`,
    `; #@! TF.FileFunction,${fn}`,
    "FMAT,2",
    "METRIC",
    ...sizes.map((d, i) => `T${i + 1}C${d.toFixed(3)}`),
    "%",
    "G90",
    "G05",
  ];
  sizes.forEach((d, i) => {
    lines.push(`T${i + 1}`);
    for (const h of holes.filter((h) => Math.abs(Math.round(h.d * 1000) / 1000 - d) < 1e-9)) lines.push(h.to ? `${xy(h.at)}G85${xy(h.to)}` : xy(h.at));
  });
  lines.push("M30", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Assembly: BOM and positions
// ---------------------------------------------------------------------------

const csv = (cells: Array<string | number>) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",");

/** A bill of materials grouped by value, footprint and part number. */
export function bomCsv(board: Board, datasheets?: Record<string, string>): string {
  const fields = ["MPN", "Manufacturer", "LCSC"];
  const groups = new Map<string, Footprint[]>();
  for (const fp of board.footprints) {
    if (fp.attributes.excludeFromBom || fp.attributes.boardOnly || fp.attributes.dnp || !fp.reference) continue;
    const key = [fp.value, fp.libId, ...fields.map((f) => fp.properties[f] ?? "")].join("\0");
    groups.set(key, [...(groups.get(key) ?? []), fp]);
  }
  const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const rows = [...groups.values()].map((fps) => fps.sort((a, b) => natural(a.reference, b.reference))).sort((a, b) => natural(a[0]!.reference, b[0]!.reference));
  return [
    csv(["Reference", "Value", "Footprint", "Qty", ...fields, ...(datasheets ? ["Datasheet"] : [])]),
    ...rows.map((fps) => csv([fps.map((f) => f.reference).join(","), fps[0]!.value, fps[0]!.libId, fps.length, ...fields.map((f) => fps[0]!.properties[f] ?? ""), ...(datasheets ? [datasheets[fps[0]!.reference] ?? (fps[0]!.properties["Datasheet"] !== "~" ? (fps[0]!.properties["Datasheet"] ?? "") : "")] : [])])),
    "",
  ].join("\n");
}

/** A pick-and-place file in KiCad's CSV layout (mm, Y up, rotation in degrees). */
export function positionCsv(board: Board): string {
  const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const parts = board.footprints.filter((fp) => !fp.attributes.excludeFromPosFiles && fp.reference).sort((a, b) => natural(a.reference, b.reference));
  const r6 = (v: number) => (Math.round(v * 1e6) / 1e6 || 0).toFixed(6);
  return [
    "Ref,Val,Package,PosX,PosY,Rot,Side",
    ...parts.map((fp) => {
      const bottom = fp.layer === "B.Cu";
      return [csv([fp.reference, fp.value, fp.libId.slice(fp.libId.indexOf(":") + 1)]), r6(fp.at.x), r6(-fp.at.y), r6(fp.rotation), bottom ? "bottom" : "top"].join(",");
    }),
    "",
  ].join("\n");
}

/**
 * JLCPCB's assembly BOM: Comment, Designator, Footprint, "LCSC Part #" (from
 * an LCSC / "LCSC Part" / JLCPCB field when the part has one).
 */
export function bomJlcpcb(board: Board): string {
  const lcsc = (fp: Footprint) => fp.properties["LCSC"] ?? fp.properties["LCSC Part"] ?? fp.properties["LCSC Part #"] ?? fp.properties["JLCPCB"] ?? "";
  const groups = new Map<string, Footprint[]>();
  for (const fp of board.footprints) {
    if (fp.attributes.excludeFromBom || fp.attributes.boardOnly || fp.attributes.dnp || !fp.reference) continue;
    const key = [fp.value, fp.libId, lcsc(fp)].join("\0");
    groups.set(key, [...(groups.get(key) ?? []), fp]);
  }
  const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const rows = [...groups.values()].map((fps) => fps.sort((a, b) => natural(a.reference, b.reference))).sort((a, b) => natural(a[0]!.reference, b[0]!.reference));
  return [csv(["Comment", "Designator", "Footprint", "LCSC Part #"]), ...rows.map((fps) => csv([fps[0]!.value, fps.map((f) => f.reference).join(","), fps[0]!.libId.slice(fps[0]!.libId.indexOf(":") + 1), lcsc(fps[0]!)])), ""].join("\n");
}

/**
 * JLCPCB's pick-and-place (CPL) file: Designator, Mid X, Mid Y, Layer,
 * Rotation. Through-hole and board-only parts are left out, as JLCPCB's
 * SMT service places SMD parts only.
 */
export function cplJlcpcb(board: Board): string {
  const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const parts = board.footprints
    .filter((fp) => !fp.attributes.excludeFromPosFiles && !fp.attributes.boardOnly && !fp.attributes.dnp && fp.reference && fp.attributes.mount === "smd")
    .sort((a, b) => natural(a.reference, b.reference));
  const mm = (v: number) => `${(Math.round(v * 1e4) / 1e4 || 0).toFixed(4)}mm`;
  return [
    csv(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"]),
    ...parts.map((fp) => csv([fp.reference, mm(fp.at.x), mm(-fp.at.y), fp.layer === "B.Cu" ? "Bottom" : "Top", String(((Math.round(fp.rotation * 100) / 100) % 360 + 360) % 360)])),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Everything a fab needs
// ---------------------------------------------------------------------------

/** The layers KiCad's plot dialog selects by default for fabrication. */
export function fabLayers(board: Board): string[] {
  const has = (l: string) => board.layers.some((x) => x.name === l);
  return [...board.copperLayers, ...["F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Edge.Cuts"].filter(has)];
}

/** File name → contents: Gerbers, drill files, BOM and positions. */
export function fabricationFiles(board: Board, o: FabOptions): Record<string, string> {
  const date = o.date ?? new Date().toISOString();
  // File names go to fab houses' upload forms: keep them portable whatever the board is called.
  const name = projectFileName(o.name);
  const opts = { ...o, date, name };
  const out: Record<string, string> = {};
  const gerbers = fabLayers(board).map((layer) => ({ path: `${name}-${fileLayerName(board, layer)}.gbr`, layer }));
  for (const g of gerbers) out[g.path] = plotGerber(board, g.layer, opts);
  // The job file that tells a fab what each Gerber is, as KiCad writes it next to them.
  out[`${name}-job.gbrjob`] = gerberJob(board, { name, files: gerbers, rules: o.rules ?? projectDesignRules(), date });
  out[`${name}-PTH.drl`] = drillFile(board, true, opts);
  if (board.footprints.some((f) => f.pads.some((p) => p.type === "np_thru_hole" && p.drill))) out[`${name}-NPTH.drl`] = drillFile(board, false, opts);
  for (const sp of drillSpans(board)) out[`${name}-${drillSpanName(sp)}.drl`] = drillFile(board, true, opts, sp);
  out[`${name}-bom.csv`] = bomCsv(board, o.datasheets);
  out[`${name}-pos.csv`] = positionCsv(board);
  // The bare-board test netlist fabs ask for, as KiCad names it.
  out[`${name}.d356`] = ipcD356(board);
  if (o.jlcpcb) {
    out[`${name}-bom-jlcpcb.csv`] = bomJlcpcb(board);
    out[`${name}-cpl-jlcpcb.csv`] = cplJlcpcb(board);
  }
  return out;
}

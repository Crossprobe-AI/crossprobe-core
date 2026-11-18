/**
 * Align and distribute, as KiCad's Align/Distribute tool does them (pcbnew's
 * ALIGN_DISTRIBUTE_TOOL, reimplemented from its behaviour):
 *
 * - Items are compared by their bounding boxes; a footprint's box leaves its
 *   text out (FOOTPRINT::GetBoundingBox(false)).
 * - Align: locked items stay put and set the target; else the item under the
 *   cursor does; else the extreme item (leftmost for "left", and so on).
 * - Distribute: the two outermost items stay put; the others are spaced so
 *   their centres, or the gaps between them, are equal. Locked items are left
 *   out of a distribution.
 *
 * Boxes and moves are in mm, computed in KiCad's integer nanometres so the
 * rounding is KiCad's.
 */
import type { Board, BoardText, Footprint, Graphic, Pad, TextBox } from "./board.js";
import { strokeGlyph } from "./stroke-font.js";
import type { Point } from "./geometry.js";
import { padShapes, shapeBox } from "./drc.js";

/** A box in mm: left, top, right, bottom. */
export interface Box4 {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const NM = 1e6;
const nm = (v: number) => Math.round(v * NM);
/** KiCad rounds halves away from zero. */
const KiROUND = (v: number) => Math.sign(v) * Math.round(Math.abs(v));

class Bounds {
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;
  point(p: Point, r = 0) {
    this.x0 = Math.min(this.x0, p.x - r);
    this.y0 = Math.min(this.y0, p.y - r);
    this.x1 = Math.max(this.x1, p.x + r);
    this.y1 = Math.max(this.y1, p.y + r);
  }
  box(b: Box4) {
    this.point({ x: b.x0, y: b.y0 });
    this.point({ x: b.x1, y: b.y1 });
  }
  get empty() {
    return this.x0 > this.x1;
  }
  result(): Box4 {
    return { x0: this.x0, y0: this.y0, x1: this.x1, y1: this.y1 };
  }
}

/** The circle through three points (an arc's start, mid and end). */
function arcCenter(a: Point, m: Point, b: Point): Point | undefined {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-12) return undefined;
  const a2 = a.x * a.x + a.y * a.y, m2 = m.x * m.x + m.y * m.y, b2 = b.x * b.x + b.y * b.y;
  return { x: (a2 * (m.y - b.y) + m2 * (b.y - a.y) + b2 * (a.y - m.y)) / d, y: (a2 * (b.x - m.x) + m2 * (a.x - b.x) + b2 * (m.x - a.x)) / d };
}

/** An arc's box: its ends and the axis extremes it passes (EDA_SHAPE::computeArcBBox). */
function arcBox(out: Bounds, a: Point, m: Point, b: Point, filled: boolean, r: number): void {
  const c = arcCenter(a, m, b);
  out.point(a, r);
  out.point(b, r);
  if (!c) return;
  if (filled) out.point(c, r);
  const rad = Math.hypot(a.x - c.x, a.y - c.y);
  // Angles in KiCad's frame (y down), swept from start through mid to end.
  const ang = (p: Point) => Math.atan2(p.y - c.y, p.x - c.x);
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const t0 = ang(a);
  const ccw = norm(ang(m) - t0) <= norm(ang(b) - t0);
  const sweep = ccw ? norm(ang(b) - t0) : -norm(t0 - ang(b));
  for (let k = 0; k < 4; k++) {
    const t = (k * Math.PI) / 2;
    const off = sweep >= 0 ? norm(t - t0) : norm(t0 - t);
    if (off > 0 && off < Math.abs(sweep)) out.point({ x: c.x + rad * Math.cos(t), y: c.y + rad * Math.sin(t) }, r);
  }
}

/** A graphic's box, with half its line width (PCB_SHAPE::GetBoundingBox). */
export function graphicBox(g: Graphic): Box4 {
  const out = new Bounds();
  const r = Math.max(0, g.width) / 2;
  const [a, b, c] = g.points;
  if (g.kind === "circle" && a && b) out.point(a, Math.hypot(b.x - a.x, b.y - a.y) + r);
  else if (g.kind === "arc" && a && b && c) arcBox(out, a, b, c, g.fill, r);
  else for (const p of g.points) out.point(p, r);
  return out.result();
}

/** A pad's box: its copper on every layer, and its hole. */
export function padBox(pad: Pad): Box4 {
  const out = new Bounds();
  for (const s of padShapes(pad)) out.box(shapeBox(s));
  const hole = pad.drillSize ?? (pad.drill ? { x: pad.drill, y: pad.drill } : undefined);
  if (hole && hole.x > 0) {
    const rr = Math.min(hole.x, hole.y) / 2;
    const half = hole.x > hole.y ? { x: hole.x / 2 - rr, y: 0 } : { x: 0, y: hole.y / 2 - rr };
    const t = (pad.rotation * Math.PI) / 180;
    // KiCad's rotation is clockwise on screen (y down).
    const o = { x: half.x * Math.cos(t) + half.y * Math.sin(t), y: -half.x * Math.sin(t) + half.y * Math.cos(t) };
    out.point({ x: pad.at.x + o.x, y: pad.at.y + o.y }, rr);
    out.point({ x: pad.at.x - o.x, y: pad.at.y - o.y }, rr);
  }
  if (out.empty) out.point(pad.at);
  return out.result();
}

const USER_LAYERS = new Set(["Cmts.User", "Dwgs.User", "Eco1.User", "Eco2.User"]);

/**
 * A footprint's box without its text, as KiCad's align tool takes it: its
 * position (with 0.25 mm all round), its graphics except dimensions and those
 * on the comment and drawing layers, and its pads.
 */
export function footprintBoxNoText(fp: Footprint): Box4 {
  const out = new Bounds();
  out.point(fp.at, 0.25);
  for (const g of fp.graphics) if (!g.dimension && !USER_LAYERS.has(g.layer)) out.box(graphicBox(g));
  for (const p of fp.pads) out.box(padBox(p));
  return out.result();
}

/**
 * A footprint's box with its texts, as KiCad's group and selection boxes take it
 * (FOOTPRINT::GetBoundingBox(true)): its position (0.25 mm all round), all its graphics, its
 * pads and its visible texts.
 */
export function footprintBoxWithText(fp: Footprint): Box4 {
  const out = new Bounds();
  out.point(fp.at, 0.25);
  for (const g of fp.graphics) out.box(graphicBox(g));
  for (const p of fp.pads) out.box(padBox(p));
  for (const t of fp.texts) out.box(textBox(t));
  return out.result();
}

/**
 * The box around items, as KiCad's group (PCB_GROUP::GetBoundingBox) and selection boxes take it:
 * footprints with their texts, and the items this model doesn't hold (`Board.otherBoxes`).
 */
export function itemsBox(board: Board, uuids: string[]): Box4 | undefined {
  const out = new Bounds();
  for (const u of uuids) {
    const it = indexOf(board).get(u);
    const b = it?.kind === "footprint" ? footprintBoxWithText(it.item) : (boardItemBox(board, u) ?? board.otherBoxes?.[u]);
    if (b) out.box(b);
  }
  return out.empty ? undefined : out.result();
}

/** A group's box as KiCad gives it (PCB_GROUP::GetBoundingBox), from its items (groupItems): their box, 0.25 mm larger all round. */
export function groupBox(board: Board, items: string[]): Box4 | undefined {
  const b = itemsBox(board, items);
  return b && { x0: b.x0 - 0.25, y0: b.y0 - 0.25, x1: b.x1 + 0.25, y1: b.y1 + 0.25 };
}

type Indexed =
  | { kind: "footprint"; item: Footprint }
  | { kind: "track"; item: Board["tracks"][number] }
  | { kind: "via"; item: Board["vias"][number] }
  | { kind: "zone"; item: Board["zones"][number] }
  | { kind: "graphic"; item: Graphic }
  | { kind: "text"; item: BoardText }
  | { kind: "textbox"; item: TextBox };
const indexes = new WeakMap<Board, Map<string, Indexed>>();
function indexOf(board: Board): Map<string, Indexed> {
  let m = indexes.get(board);
  if (m) return m;
  m = new Map();
  const add = (uuid: string | undefined, v: Indexed) => uuid && !m!.has(uuid) && m!.set(uuid, v);
  for (const item of board.footprints) add(item.uuid, { kind: "footprint", item });
  for (const item of board.tracks) add(item.uuid, { kind: "track", item });
  for (const item of board.vias) add(item.uuid, { kind: "via", item });
  for (const item of board.zones) add(item.uuid, { kind: "zone", item });
  for (const item of board.drawings) add(item.uuid, { kind: "graphic", item });
  for (const item of board.texts) add(item.uuid, { kind: "text", item });
  for (const item of board.textBoxes) add(item.uuid, { kind: "textbox", item });
  indexes.set(board, m);
  return m;
}

/** The box of any board item by UUID (footprints without their text), or undefined. */
export function boardItemBox(board: Board, uuid: string): Box4 | undefined {
  const it = indexOf(board).get(uuid);
  if (!it) return undefined;
  switch (it.kind) {
    case "footprint":
      return footprintBoxNoText(it.item);
    case "track": {
      const t = it.item;
      const out = new Bounds();
      // An arc's own shape already carries half its width (and a nanometre); the track adds it again.
      if (t.kind === "arc" && t.mid) arcBox(out, t.start, t.mid, t.end, false, t.width + 1e-6);
      else (out.point(t.start, t.width / 2), out.point(t.end, t.width / 2));
      return out.result();
    }
    case "via": {
      const v = it.item;
      return { x0: v.at.x - v.size / 2, y0: v.at.y - v.size / 2, x1: v.at.x + v.size / 2, y1: v.at.y + v.size / 2 };
    }
    case "zone": {
      const out = new Bounds();
      for (const p of it.item.outline) out.point(p);
      return out.result();
    }
    case "graphic":
      return graphicBox(it.item);
    case "text":
      return textBox(it.item);
    case "textbox": {
      // The box, with half its border (EDA_SHAPE's bounding box).
      const out = new Bounds();
      for (const p of it.item.corners) out.point(p, Math.max(0, it.item.borderWidth) / 2);
      return out.result();
    }
  }
}

/**
 * A line's extents in the stroke font (STROKE_FONT::GetTextAsGlyphs, through
 * KiCad's markup): each run from where it starts to its end less the
 * inter-character gap; subscripts and superscripts at 0.8 size.
 */
function lineExtents(line: string, w: number, h: number): { x: number; y: number } {
  const runs: Array<{ text: string; kind: string }> = [];
  let plain = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const end = line[i + 1] === "{" && (c === "~" || c === "^" || c === "_") ? line.indexOf("}", i + 2) : -1;
    if (end > 0) {
      if (plain) runs.push({ text: plain, kind: "" });
      plain = "";
      runs.push({ text: line.slice(i + 2, end), kind: c });
      i = end;
    } else plain += c;
  }
  if (plain) runs.push({ text: plain, kind: "" });
  // Nothing drawn: no box at all.
  if (!runs.length) return { x: 0, y: 0 };
  const out = new Bounds();
  let x = 0;
  for (const r of runs) {
    const small = r.kind === "_" || r.kind === "^";
    const gw = small ? w * 0.8 : w, gh = small ? h * 0.8 : h;
    const x0 = x;
    for (const ch of r.text) x += KiROUND(strokeGlyph(ch.codePointAt(0)!).width * gw);
    // KiCad's box doesn't follow the sub- and superscripts up or down.
    out.point({ x: x0, y: 0 });
    out.point({ x: x - KiROUND(gw * 0.2), y: -gh });
  }
  return { x: out.x1 - out.x0, y: out.y1 - out.y0 };
}

/**
 * A board text's box as KiCad computes it (PCB_TEXT::GetBoundingBox): the
 * stroke font's advance and height, padded by one and a half pens, plus 17%
 * of the height; justified, padded for knockout, then rotated about the anchor.
 * TrueType text takes its glyph outlines' box.
 */
export function textBox(t: BoardText): Box4 {
  if (t.outline?.length) {
    const out = new Bounds();
    for (const loop of t.outline) for (const p of loop) out.point(p);
    return out.result();
  }
  const w = nm(t.size.x), h = nm(t.size.y);
  const thickness = nm(t.thickness);
  // EDA_TEXT::GetEffectiveTextPenWidth: the thickness, else a fifth (bold) or an eighth of the width; at most a quarter of the size.
  let pen = thickness > 1 ? thickness : t.bold ? KiROUND(w / 5) : KiROUND(w / 8);
  pen = Math.min(pen, KiROUND(Math.min(w, h) * 0.25));
  // wxStringSplit: a trailing newline doesn't start another line.
  const lines = t.text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const pad = 2 * KiROUND(pen * 1.5);
  const ext = lines.map((l) => { const e = lineExtents(l, w, h); return { x: e.x + pad, y: e.y + pad }; });
  const fudge = KiROUND(ext[0]!.y * 0.17);
  let bw = Math.max(...ext.map((e) => e.x));
  let bh = ext[0]!.y + fudge;
  if (lines.length > 1) bh += KiROUND((lines.length - 1) * h * 1.68 * 0.9583);
  // An overbar on the first line raises the box by a sixth of its height.
  if (lines[0]!.includes("~{")) bh += Math.trunc(ext[0]!.y / 6);
  const ax = nm(t.at.x), ay = nm(t.at.y);
  let x = ax, y = ay;
  const j = t.justify;
  const mirror = j.includes("mirror");
  if (j.includes("left")) { if (mirror) x -= bw; }
  else if (j.includes("right")) { if (!mirror) x -= bw; }
  else x -= Math.trunc(bw / 2);
  if (j.includes("top")) y -= fudge;
  else if (j.includes("bottom")) y -= bh - fudge;
  else y -= Math.trunc(bh / 2);
  if (t.knockout) {
    const m = Math.max(KiROUND(pen / 2), KiROUND(h / 9));
    x -= m; y -= m; bw += 2 * m; bh += 2 * m;
  }
  const a = ((((t.rotation % 360) + 360) % 360) * Math.PI) / 180;
  const out = new Bounds();
  for (const [px, py] of [[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]] as const) {
    const dx = px - ax, dy = py - ay;
    out.point(a ? { x: Math.round(ax + dx * Math.cos(a) + dy * Math.sin(a)), y: Math.round(ay - dx * Math.sin(a) + dy * Math.cos(a)) } : { x: px, y: py });
  }
  const b = out.result();
  return { x0: b.x0 / NM, y0: b.y0 / NM, x1: b.x1 / NM, y1: b.y1 / NM };
}

export type AlignMode = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";
export type DistributeMode = "centersX" | "gapsX" | "centersY" | "gapsY";

export interface ArrangeItem {
  uuid: string;
  box: Box4;
  locked?: boolean;
}

export interface ArrangeMove {
  uuid: string;
  dx: number;
  dy: number;
}

type IBox = { uuid: string; l: number; t: number; r: number; b: number };
const ibox = (it: ArrangeItem): IBox => ({ uuid: it.uuid, l: nm(it.box.x0), t: nm(it.box.y0), r: nm(it.box.x1), b: nm(it.box.y1) });
// BOX2I::Centre(): origin + size / 2, in integers.
const cx = (b: IBox) => b.l + Math.trunc((b.r - b.l) / 2);
const cy = (b: IBox) => b.t + Math.trunc((b.b - b.t) / 2);

const ALIGN: Record<AlignMode, { value: (b: IBox) => number; before: (a: number, b: number) => boolean; axis: "x" | "y" }> = {
  left: { value: (b) => b.l, before: (a, b) => a < b, axis: "x" },
  right: { value: (b) => b.r, before: (a, b) => a > b, axis: "x" },
  centerX: { value: cx, before: (a, b) => a < b, axis: "x" },
  top: { value: (b) => b.t, before: (a, b) => a < b, axis: "y" },
  bottom: { value: (b) => b.b, before: (a, b) => a > b, axis: "y" },
  centerY: { value: cy, before: (a, b) => a < b, axis: "y" },
};

/**
 * The moves that align items: what KiCad's Align Left/Right/Top/Bottom and
 * Align Center X/Y do. `cursor` (mm), when given, picks the item under it as
 * the target. Locked items never move.
 */
export function alignMoves(items: ArrangeItem[], mode: AlignMode, cursor?: Point): ArrangeMove[] {
  const spec = ALIGN[mode];
  // std::sort by the edge; a stable sort keeps ties in selection order.
  const order = (list: ArrangeItem[]) =>
    list.map(ibox).sort((a, b) => (spec.before(spec.value(a), spec.value(b)) ? -1 : spec.before(spec.value(b), spec.value(a)) ? 1 : 0));
  const free = order(items.filter((i) => !i.locked));
  const locked = order(items.filter((i) => i.locked));
  if (!free.length) return [];
  const c = cursor && { x: nm(cursor.x), y: nm(cursor.y) };
  const under = (b: IBox) => !!c && c.x >= b.l && c.x <= b.r && c.y >= b.t && c.y <= b.b;
  const pool = locked.length ? locked : free;
  const target = spec.value(pool.find(under) ?? pool[0]!);
  const out: ArrangeMove[] = [];
  for (const b of free) {
    const d = target - spec.value(b);
    if (d) out.push({ uuid: b.uuid, dx: spec.axis === "x" ? d / NM : 0, dy: spec.axis === "y" ? d / NM : 0 });
  }
  return out;
}

/**
 * The moves that distribute items: KiCad's Distribute Horizontally/Vertically,
 * by centres or by gaps. The first and last item stay; at least three items
 * are needed. Locked items are not distributed.
 */
export function distributeMoves(items: ArrangeItem[], mode: DistributeMode): ArrangeMove[] {
  const list = items.filter((i) => !i.locked).map(ibox);
  if (list.length < 3) return [];
  const x = mode.endsWith("X");
  const deltas: number[] = new Array(list.length).fill(0);
  if (mode.startsWith("centers")) {
    const centre = (b: IBox) => (x ? cx(b) : cy(b));
    list.sort((a, b) => centre(a) - centre(b));
    const pos = list.map(centre);
    const start = pos[0]!;
    const gap = (pos[pos.length - 1]! - start) / (pos.length - 1);
    for (let i = 1; i < pos.length - 1; i++) deltas[i] = start + KiROUND(i * gap) - pos[i]!;
  } else {
    list.sort((a, b) => (x ? a.l - b.l : a.t - b.t));
    const spans = list.map((b) => (x ? [b.l, b.r] : [b.t, b.b]) as [number, number]);
    let totalGap = spans[spans.length - 1]![0] - spans[0]![1];
    for (let i = 1; i < spans.length - 1; i++) totalGap -= spans[i]![1] - spans[i]![0];
    const perGap = totalGap / (spans.length - 1);
    let target = spans[0]![1];
    for (let i = 1; i < spans.length - 1; i++) {
      const [s, e] = spans[i]!;
      deltas[i] = target - s + KiROUND(i * perGap);
      target += e - s;
    }
  }
  const out: ArrangeMove[] = [];
  list.forEach((b, i) => {
    const d = deltas[i]!;
    if (d) out.push({ uuid: b.uuid, dx: x ? d / NM : 0, dy: x ? 0 : d / NM });
  });
  return out;
}

/** A circle's centre through three points, or undefined when they are in line. */
const centreOf = (a: Point, m: Point, b: Point) => arcCenter(a, m, b);

/**
 * An item's position as KiCad's GetPosition gives it: a footprint's or via's
 * anchor, a track's start (an arc track's centre), a zone's first corner, an arc's centre, a
 * polygon's first point, another shape's start, a text's anchor; with
 * `pad`, that pad of the footprint.
 */
export function boardItemPosition(board: Board, uuid: string, pad?: string): Point | undefined {
  const it = indexOf(board).get(uuid);
  if (!it) return undefined;
  switch (it.kind) {
    case "footprint":
      return (pad !== undefined && it.item.pads.find((p) => p.number === pad)?.at) || it.item.at;
    case "track": {
      const t = it.item;
      return (t.kind === "arc" && t.mid && centreOf(t.start, t.mid, t.end)) || t.start;
    }
    case "via":
      return it.item.at;
    case "zone":
      return it.item.outline[0];
    case "graphic": {
      const [a, m, b] = it.item.points;
      if (it.item.kind === "arc" && a && m && b) return centreOf(a, m, b) ?? a;
      return a;
    }
    case "text":
      return it.item.at;
    case "textbox":
      // A box's start (or first corner when turned), as KiCad's GetPosition.
      return it.item.corners[0];
  }
}

/**
 * KiCad's Position Relative: the selection moves together so that its anchor
 * (the top-left footprint, else the top-left item, by position) lands at
 * `reference` + `offset`. Locked items are left out, as KiCad filters them
 * from the selection. `polar`: the offset is a radius and an angle (degrees,
 * clockwise on screen, as KiCad's y runs down).
 */
export function positionRelativeMoves(board: Board, items: Array<{ uuid: string; locked?: boolean }>, reference: Point, offset: Point, polar = false): ArrangeMove[] {
  const free = items.filter((i) => !i.locked);
  const placed = free.flatMap((i) => {
    const at = boardItemPosition(board, i.uuid);
    return at ? [{ uuid: i.uuid, at, footprint: indexOf(board).get(i.uuid)!.kind === "footprint" }] : [];
  });
  const topLeft = (list: typeof placed) => list.reduce<(typeof placed)[number] | undefined>((best, c) => (!best || c.at.x < best.at.x || (c.at.x === best.at.x && c.at.y < best.at.y) ? c : best), undefined);
  const anchor = topLeft(placed.filter((p) => p.footprint)) ?? topLeft(placed);
  if (!anchor) return [];
  const t = polar
    ? { x: KiROUND(nm(offset.x) * Math.cos((offset.y * Math.PI) / 180)), y: KiROUND(nm(offset.x) * Math.sin((offset.y * Math.PI) / 180)) }
    : { x: nm(offset.x), y: nm(offset.y) };
  const dx = (nm(reference.x) + t.x - nm(anchor.at.x)) / NM;
  const dy = (nm(reference.y) + t.y - nm(anchor.at.y)) / NM;
  if (!dx && !dy) return [];
  return placed.map((p) => ({ uuid: p.uuid, dx, dy }));
}

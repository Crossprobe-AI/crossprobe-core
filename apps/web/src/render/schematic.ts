/**
 * Schematic rendering: turns one sheet instance into a display list in sheet
 * millimetres (Y down). Graphics come straight from the file's syntax tree;
 * references, units and nets come from the design model, so each instance of
 * a reused sheet shows its own designators.
 */
import { arg, atomText, findChild, findChildren, headOf, isAtom, isList, type List } from "@crossprobe/kicad-sexpr";
import {
  transformLibPoint,
  unitLetter,
  type Netlist,
  type Orientation,
  type Point,
  type Schematic,
  type SheetInstance,
  shownText,
  intersheetRefs,
  defaultFrame,
  drawingSheetPrims,
  sheetsByPage,
  type DrawingSheet,
  type DrawingSheetPrim, bitmapInfoBase64, TABLE_BY_CELL, bitmapSizeMm } from "@crossprobe/kicad-model";
import type { Prim, Role, SchItem, SheetView } from "./types";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const f = (n: number) => (Math.round(n * 1000) / 1000).toString();
const pt = (n: List | undefined): Point => ({ x: Number(arg(n, 0) ?? 0), y: Number(arg(n, 1) ?? 0) });
const str = (n: List | undefined, i = 0) => String(arg(n, i) ?? "");
/** Average glyph advance of KiCad's stroke font, as a fraction of text height. */
const CHAR_W = 0.9;
export const textWidth = (text: string, size: number) => plainText(text).length * size * CHAR_W;
/** Text without KiCad markup (~{overbar}, _{sub}, ^{super}). */
export function plainText(text: string): string {
  return text.replace(/[~_^]\{([^}]*)\}/g, "$1");
}

const PAPER: Record<string, [number, number]> = {
  A5: [210, 148], A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
  USLetter: [279.4, 215.9], USLegal: [355.6, 215.9], USLedger: [431.8, 279.4],
};

interface Effects {
  size: number;
  h: "start" | "middle" | "end";
  v: "top" | "middle" | "bottom";
  hidden: boolean;
  bold: boolean;
  italic: boolean;
}

function effectsOf(node: List | undefined, fallbackSize = 1.27): Effects {
  const e = node && findChild(node, "effects");
  const font = e && findChild(e, "font");
  const size = Number(arg(font && findChild(font, "size"), 0) ?? fallbackSize) || fallbackSize;
  const j = e && findChild(e, "justify");
  const js = j ? j.children.slice(1).filter(isAtom).map(atomText) : [];
  let hidden = false;
  for (const n of [node, e]) {
    if (!n) continue;
    for (const c of n.children) {
      if (isAtom(c) && c.raw === "hide") hidden = true;
      if (headOf(c) === "hide") hidden = arg(c as List, 0) !== "no";
    }
  }
  return {
    size,
    h: js.includes("left") ? "start" : js.includes("right") ? "end" : "middle",
    v: js.includes("top") ? "top" : js.includes("bottom") ? "bottom" : "middle",
    hidden,
    bold: !!(font && findChild(font, "bold") && arg(findChild(font, "bold"), 0) !== "no"),
    italic: !!(font && findChild(font, "italic") && arg(findChild(font, "italic"), 0) !== "no"),
  };
}

/** Unit vector for a KiCad sheet-space angle (0 = right, 90 = up on screen). */
const dir = (deg: number): Point => {
  const r = (((deg % 360) + 360) % 360) as number;
  return r === 0 ? { x: 1, y: 0 } : r === 90 ? { x: 0, y: -1 } : r === 180 ? { x: -1, y: 0 } : r === 270 ? { x: 0, y: 1 } : { x: Math.cos((deg * Math.PI) / 180), y: -Math.sin((deg * Math.PI) / 180) };
};
const flipH = (h: Effects["h"]): Effects["h"] => (h === "start" ? "end" : h === "end" ? "start" : "middle");
const flipV = (v: Effects["v"]): Effects["v"] => (v === "top" ? "bottom" : v === "bottom" ? "top" : "middle");

/** Make a text readable: reading angles of 180/270 become 0/90 with flipped justification. */
function readable(angle: number, h: Effects["h"], v: Effects["v"]): { angle: number; h: Effects["h"]; v: Effects["v"] } {
  const a = ((Math.round(angle) % 360) + 360) % 360;
  if (a === 180) return { angle: 0, h: flipH(h), v: flipV(v) };
  if (a === 270) return { angle: 90, h: flipH(h), v: flipV(v) };
  return { angle: a, h, v };
}

function text(x: number, y: number, s: string, e: Effects, angle: number, role: Role): Prim {
  const r = readable(angle, e.h, e.v);
  return { t: "text", x, y, text: s, size: e.size, angle: r.angle, anchor: r.h, baseline: r.v, role, bold: e.bold, italic: e.italic };
}

function polyPath(points: Point[], close = false): string {
  return points.map((p, i) => `${i ? "L" : "M"}${f(p.x)} ${f(p.y)}`).join("") + (close ? "Z" : "");
}

/** SVG arc through three points. */
function arcPath(a: Point, m: Point, b: Point): string {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-9) return polyPath([a, b]);
  const sq = (p: Point) => p.x * p.x + p.y * p.y;
  const cx = (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d;
  const cy = (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  const ang = (p: Point) => Math.atan2(p.y - cy, p.x - cx);
  const tau = Math.PI * 2;
  const norm = (x: number) => ((x % tau) + tau) % tau;
  const toMid = norm(ang(m) - ang(a));
  const toEnd = norm(ang(b) - ang(a));
  const sweep = toMid < toEnd ? 1 : 0;
  const span = sweep ? toEnd : tau - toEnd;
  return `M${f(a.x)} ${f(a.y)}A${f(r)} ${f(r)} 0 ${span > Math.PI ? 1 : 0} ${sweep} ${f(b.x)} ${f(b.y)}`;
}

function strokeWidth(node: List): number | undefined {
  const w = Number(arg(findChild(findChild(node, "stroke") ?? node, "width"), 0) ?? 0);
  return w > 0 ? w : undefined;
}

function fillType(node: List): "none" | "outline" | "background" {
  const fill = findChild(node, "fill");
  const t = fill ? str(findChild(fill, "type") ?? fill) : "none";
  return t === "outline" ? "outline" : t === "background" || t === "color" ? "background" : "none";
}

/** Draw a graphic shape (polyline, rectangle, circle, arc, bezier) through a point transform. */
function shape(node: List, tf: (p: Point) => Point, role: Role, fillRole: Role, out: Prim[]): void {
  const head = headOf(node);
  const w = strokeWidth(node);
  const fill = fillType(node);
  const push = (d: string, closed: boolean) => {
    if (fill !== "none" && closed) out.push({ t: "path", d, role: fill === "outline" ? role : fillRole, fill: true });
    out.push({ t: "path", d, role, w });
  };
  switch (head) {
    case "polyline": {
      const pts = findChildren(findChild(node, "pts") ?? node, "xy").map(pt).map(tf);
      const closed = pts.length > 2 && pts[0]!.x === pts[pts.length - 1]!.x && pts[0]!.y === pts[pts.length - 1]!.y;
      if (fill !== "none" && pts.length > 2) out.push({ t: "path", d: polyPath(pts, true), role: fill === "outline" ? role : fillRole, fill: true });
      out.push({ t: "path", d: polyPath(pts, closed), role, w });
      break;
    }
    case "rectangle": {
      const a = pt(findChild(node, "start"));
      const b = pt(findChild(node, "end"));
      push(polyPath([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }].map(tf), true), true);
      break;
    }
    case "circle": {
      const c = tf(pt(findChild(node, "center")));
      const r = Number(arg(findChild(node, "radius"), 0) ?? 0);
      if (fill !== "none") out.push({ t: "circle", cx: c.x, cy: c.y, r, role: fill === "outline" ? role : fillRole, fill: true });
      out.push({ t: "circle", cx: c.x, cy: c.y, r, role, w });
      break;
    }
    case "arc": {
      const s = findChild(node, "start");
      const m = findChild(node, "mid");
      const e = findChild(node, "end");
      if (s && m && e) {
        const d = arcPath(tf(pt(s)), tf(pt(m)), tf(pt(e)));
        if (fill !== "none") out.push({ t: "path", d: d + "Z", role: fill === "outline" ? role : fillRole, fill: true });
        out.push({ t: "path", d, role, w });
      }
      break;
    }
    case "bezier": {
      const p = findChildren(findChild(node, "pts") ?? node, "xy").map(pt).map(tf);
      if (p.length === 4) out.push({ t: "path", d: `M${f(p[0]!.x)} ${f(p[0]!.y)}C${[p[1]!, p[2]!, p[3]!].map((q) => `${f(q.x)} ${f(q.y)}`).join(" ")}`, role, w });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

/** Matrix of a symbol orientation acting on sheet-space vectors. */
function orientationMatrix(o: Orientation) {
  const col = (x: number, y: number) => transformLibPoint({ x, y: -y }, o, { x: 0, y: 0 });
  const ex = col(1, 0);
  const ey = col(0, 1);
  const apply = (v: Point): Point => ({ x: ex.x * v.x + ey.x * v.y, y: ex.y * v.x + ey.y * v.y });
  // Orthogonal matrix: the inverse is the transpose.
  const inverse = (v: Point): Point => ({ x: ex.x * v.x + ex.y * v.y, y: ey.x * v.x + ey.y * v.y });
  return { apply, inverse };
}

/** Screen reading angle of a lib-space direction after the symbol transform. */
function screenAngle(libAngle: number, o: Orientation): number {
  const d = { x: Math.cos((libAngle * Math.PI) / 180), y: Math.sin((libAngle * Math.PI) / 180) };
  const t = transformLibPoint(d, o, { x: 0, y: 0 });
  return (Math.round((Math.atan2(-t.y, t.x) * 180) / Math.PI) + 360) % 360;
}

/**
 * Symbol fields are positioned in the symbol's frame: lay the text box out
 * there, transform the box, and centre the text in the result. This is how
 * KiCad keeps field text upright and correctly placed for any orientation.
 */
function fieldPrim(value: string, node: List, o: Orientation, origin: Point, role: Role): Prim | undefined {
  const e = effectsOf(node);
  if (e.hidden || !value) return undefined;
  const at = findChild(node, "at");
  const p = pt(at);
  const stored = ((Number(arg(at, 2) ?? 0) % 180) + 180) % 180; // 0 or 90
  const m = orientationMatrix(o);
  const l = m.inverse({ x: p.x - origin.x, y: p.y - origin.y });
  const w = textWidth(value, e.size);
  const h = e.size;
  const along = (j: Effects["h"]) => (j === "start" ? [0, w] : j === "end" ? [-w, 0] : [-w / 2, w / 2]);
  const across = (j: Effects["v"]) => (j === "top" ? [0, h] : j === "bottom" ? [-h, 0] : [-h / 2, h / 2]);
  let xs: number[], ys: number[];
  if (stored === 0) {
    xs = along(e.h).map((d) => l.x + d);
    ys = across(e.v).map((d) => l.y + d);
  } else {
    ys = along(e.h).map((d) => l.y - d);
    xs = across(e.v).map((d) => l.x + d);
  }
  const corners = [
    { x: xs[0]!, y: ys[0]! }, { x: xs[1]!, y: ys[0]! }, { x: xs[0]!, y: ys[1]! }, { x: xs[1]!, y: ys[1]! },
  ].map((c) => m.apply(c));
  const cx = corners.reduce((s, c) => s + c.x, 0) / 4 + origin.x;
  const cy = corners.reduce((s, c) => s + c.y, 0) / 4 + origin.y;
  const vertical = (stored === 90) !== (o.rotation % 180 !== 0);
  return { t: "text", x: cx, y: cy, text: value, size: e.size, angle: vertical ? 90 : 0, anchor: "middle", baseline: "middle", role, bold: e.bold, italic: e.italic };
}

interface PinDraw {
  number: string;
  prims: Prim[];
  /** Connection point (pin tip) in sheet coordinates. */
  tip: Point;
  /** Direction from the tip away from the body, in KiCad degrees (0 right, 90 up). */
  outward: number;
}

function symbolGraphics(
  lib: List,
  unit: number,
  bodyStyle: number,
  o: Orientation,
  origin: Point,
  isPower: boolean,
  /** Pins switched to an alternate function: number → its name. */
  alternates?: Record<string, string>,
): { body: Prim[]; pins: PinDraw[] } {
  const tf = (p: Point) => transformLibPoint(p, o, origin);
  const body: Prim[] = [];
  const pins: PinDraw[] = [];
  const pinNames = findChild(lib, "pin_names");
  const nameOffset = Number(arg(findChild(pinNames ?? lib, "offset"), 0) ?? 0.508);
  const hideNames = isPower || (!!pinNames && (pinNames.children.some((c) => isAtom(c) && c.raw === "hide") || arg(findChild(pinNames, "hide"), 0) === "yes"));
  const pinNumbers = findChild(lib, "pin_numbers");
  const hideNumbers = isPower || (!!pinNumbers && (pinNumbers.children.some((c) => isAtom(c) && c.raw === "hide") || arg(findChild(pinNumbers, "hide"), 0) === "yes"));

  for (const sub of findChildren(lib, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(str(sub, 0));
    const u = m ? Number(m[1]) : 0;
    const b = m ? Number(m[2]) : 0;
    if ((u !== 0 && u !== unit) || (b !== 0 && b !== bodyStyle)) continue;
    for (const g of sub.children) {
      if (!isList(g)) continue;
      const head = headOf(g);
      if (head === "pin") {
        const draw = pinGraphics(g, o, origin, nameOffset, hideNames, hideNumbers, alternates);
        if (draw) pins.push(draw);
      } else if (head === "text") {
        const e = effectsOf(g);
        if (e.hidden) continue;
        const at = findChild(g, "at");
        const p = tf(pt(at));
        body.push(text(p.x, p.y, str(g, 0), e, screenAngle(Number(arg(at, 2) ?? 0) / (Number(arg(at, 2) ?? 0) > 360 ? 10 : 1), o), "body"));
      } else if (head) {
        shape(g, tf, "body", "bodyFill", body);
      }
    }
  }
  // Background fills go underneath everything else in the symbol, as in KiCad.
  const isBackground = (p: Prim) => p.t !== "text" && p.t !== "image" && p.role === "bodyFill";
  return { body: [...body.filter(isBackground), ...body.filter((p) => !isBackground(p))], pins };
}

function pinGraphics(pin: List, o: Orientation, origin: Point, nameOffset: number, hideNames: boolean, hideNumbers: boolean, alternates?: Record<string, string>): PinDraw | undefined {
  const isHidden =
    pin.children.some((c) => isAtom(c) && c.raw === "hide") || arg(findChild(pin, "hide"), 0) === "yes";
  if (isHidden) return undefined;
  const at = findChild(pin, "at");
  const p = pt(at);
  const angle = Number(arg(at, 2) ?? 0);
  const len = Number(arg(findChild(pin, "length"), 0) ?? 2.54);
  const d = { x: Math.round(Math.cos((angle * Math.PI) / 180)), y: Math.round(Math.sin((angle * Math.PI) / 180)) };
  const end = { x: p.x + d.x * len, y: p.y + d.y * len };
  const tf = (q: Point) => transformLibPoint(q, o, origin);
  const a = tf(p);
  const b = tf(end);
  const prims: Prim[] = [{ t: "path", d: polyPath([a, b]), role: "pin" }];

  // A pin switched to an alternate function is drawn with that function's name and shape.
  const chosen = alternates?.[str(findChild(pin, "number"))];
  const alternate = chosen === undefined ? undefined : findChildren(pin, "alternate").find((a) => str(a, 0) === chosen);
  const style = alternate ? str(alternate, 2) : str(pin, 1);
  if (style === "inverted" || style === "inverted_clock") {
    const r = 0.635;
    const c = tf({ x: end.x - d.x * r, y: end.y - d.y * r });
    prims.push({ t: "circle", cx: c.x, cy: c.y, r, role: "pin" });
  }

  const sa = screenAngle(angle, o); // direction from tip into the body
  const nameNode = findChild(pin, "name");
  const numberNode = findChild(pin, "number");
  const name = alternate ? str(alternate, 0) : str(nameNode);
  const number = str(numberNode);
  const ne = effectsOf(nameNode);
  const nume = effectsOf(numberNode);
  const u = dir(sa);
  const perp = { x: -u.y, y: u.x }; // perpendicular, "above" the pin for horizontal pins after readable()
  const up = (dist: number) => (sa === 0 || sa === 180 ? { x: 0, y: -dist } : { x: -dist, y: 0 });

  if (!hideNames && name && name !== "~" && !ne.hidden) {
    if (nameOffset > 0) {
      const q = { x: b.x + u.x * nameOffset, y: b.y + u.y * nameOffset };
      prims.push(text(q.x, q.y, name, { ...ne, h: "start", v: "middle" }, sa, "pinName"));
    } else {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const off = up(0.25);
      prims.push(text(mid.x + off.x, mid.y + off.y, name, { ...ne, h: "middle", v: "bottom" }, sa, "pinName"));
    }
  }
  if (!hideNumbers && number && !nume.hidden) {
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const off = nameOffset > 0 ? up(0.25) : { x: -up(0.25).x, y: -up(0.25).y };
    prims.push(text(mid.x + off.x, mid.y + off.y, number, { ...nume, h: "middle", v: nameOffset > 0 ? "bottom" : "top" }, sa, "pinNumber"));
  }
  void perp;
  return { number, prims, tip: a, outward: (sa + 180) % 360 };
}

// ---------------------------------------------------------------------------
// Labels and sheets
// ---------------------------------------------------------------------------

function labelPrims(node: List, kind: "local" | "global" | "hierarchical", shown: string): Prim[] {
  const e = effectsOf(node);
  const at = findChild(node, "at");
  const p = pt(at);
  const angle = Number(arg(at, 2) ?? 0);
  const s = shown;
  const u = dir(angle);
  const size = e.size;
  const role: Role = kind === "local" ? "labelLocal" : kind === "global" ? "labelGlobal" : "labelHier";

  if (kind === "local") {
    const off = angle % 180 === 0 ? { x: 0, y: -size * 0.2 } : { x: -size * 0.2, y: 0 };
    return [text(p.x + off.x, p.y + off.y, s, { ...e, h: "start", v: "bottom" }, angle, role)];
  }

  const shapeName = str(findChild(node, "shape"));
  const h = size * 1.4;
  const n = { x: -u.y, y: u.x };
  const at2 = (along: number, acrossBy: number) => ({ x: p.x + u.x * along + n.x * acrossBy, y: p.y + u.y * along + n.y * acrossBy });

  if (kind === "global") {
    const len = textWidth(s, size) + h;
    const nose = h / 2;
    const inNose = shapeName === "input" || shapeName === "bidirectional" || shapeName === "tri_state";
    const outNose = shapeName === "output" || shapeName === "bidirectional" || shapeName === "tri_state";
    const pts = [
      at2(0, 0),
      at2(inNose ? nose : 0, -h / 2),
      at2(len - (outNose ? nose : 0), -h / 2),
      at2(len, 0),
      at2(len - (outNose ? nose : 0), h / 2),
      at2(inNose ? nose : 0, h / 2),
    ];
    if (!inNose) pts.splice(0, 1, at2(0, -h / 2), at2(0, h / 2));
    const c = at2(len / 2, 0);
    return [
      { t: "path", d: polyPath(pts, true), role },
      text(c.x, c.y, s, { ...e, h: "middle", v: "middle" }, angle, role),
    ];
  }

  // Hierarchical label: a small arrow at the connection point, then the text.
  const a = size;
  const shapePts =
    shapeName === "output"
      ? [at2(0, 0), at2(a / 2, -a / 2), at2(a, -a / 2), at2(a, a / 2), at2(a / 2, a / 2)]
      : shapeName === "input"
        ? [at2(0, -a / 2), at2(a / 2, -a / 2), at2(a, 0), at2(a / 2, a / 2), at2(0, a / 2)]
        : shapeName === "bidirectional" || shapeName === "tri_state"
          ? [at2(0, 0), at2(a / 2, -a / 2), at2(a, 0), at2(a / 2, a / 2)]
          : [at2(0, -a / 2), at2(a, -a / 2), at2(a, a / 2), at2(0, a / 2)];
  const t = at2(a + size * 0.4, 0);
  return [
    { t: "path", d: polyPath(shapePts, true), role },
    text(t.x, t.y, s, { ...e, h: "start", v: "middle" }, angle, role),
  ];
}

/**
 * A global label's list of pages, where KiCad puts it: where the file has its field, or (a field
 * still at the label's anchor) just past the end of the label, reading the same way.
 */
function intersheetRefsPrim(node: List, refs: string, label: Prim[]): Prim {
  const at = findChild(node, "at");
  const anchor = pt(at);
  const field = findChildren(node, "property").find((p) => str(p, 0) === "Intersheetrefs");
  const fieldAt = field && findChild(field, "at");
  const e = effectsOf(field ?? node);
  if (fieldAt && (Math.abs(Number(arg(fieldAt, 0)) - anchor.x) > 1e-4 || Math.abs(Number(arg(fieldAt, 1)) - anchor.y) > 1e-4)) {
    return text(Number(arg(fieldAt, 0)), Number(arg(fieldAt, 1)), refs, { ...e, hidden: false, v: "middle" }, Number(arg(fieldAt, 2) ?? 0), "field");
  }
  const angle = Number(arg(at, 2) ?? 0);
  const box = bboxOf(label)!;
  const margin = 2 * Math.round(0.15 * e.size * 1e4) / 1e4;
  const len = Math.max(box.w, box.h) + margin;
  const d = dir(angle);
  return text(anchor.x + d.x * len, anchor.y + d.y * len, refs, { ...e, hidden: false, h: "start", v: "middle" }, angle, "field");
}

function sheetPrims(node: List): Prim[] {
  const at = pt(findChild(node, "at"));
  const size = pt(findChild(node, "size"));
  const out: Prim[] = [
    { t: "path", d: polyPath([at, { x: at.x + size.x, y: at.y }, { x: at.x + size.x, y: at.y + size.y }, { x: at.x, y: at.y + size.y }], true), role: "sheet", w: strokeWidth(node) },
  ];
  for (const p of findChildren(node, "property")) {
    const e = effectsOf(p);
    if (e.hidden) continue;
    const key = str(p, 0);
    const value = str(p, 1);
    const pa = findChild(p, "at");
    const q = pt(pa);
    const isName = key === "Sheetname" || key === "Sheet name";
    const isFile = key === "Sheetfile" || key === "Sheet file";
    out.push(text(q.x, q.y, isFile ? `File: ${value}` : value, e, Number(arg(pa, 2) ?? 0), isName ? "sheetName" : isFile ? "sheetFile" : "field"));
  }
  for (const pin of findChildren(node, "pin")) {
    const e = effectsOf(pin);
    const q = pt(findChild(pin, "at"));
    const name = str(pin, 0);
    // Which edge is the pin on? Text goes inside the sheet.
    const eps = 0.01;
    const side = Math.abs(q.x - at.x) < eps ? "left" : Math.abs(q.x - (at.x + size.x)) < eps ? "right" : Math.abs(q.y - at.y) < eps ? "top" : "bottom";
    const inward = side === "left" ? 0 : side === "right" ? 180 : side === "top" ? 270 : 90;
    const u = dir(inward);
    const a = e.size;
    const n = { x: -u.y, y: u.x };
    const P = (along: number, acrossBy: number) => ({ x: q.x + u.x * along + n.x * acrossBy, y: q.y + u.y * along + n.y * acrossBy });
    out.push({ t: "path", d: polyPath([P(0, -a / 2), P(a / 2, -a / 2), P(a, 0), P(a / 2, a / 2), P(0, a / 2)], true), role: "sheetPin" });
    const t = P(a + a * 0.4, 0);
    out.push(text(t.x, t.y, name, { ...e, h: "start", v: "middle" }, inward, "sheetPin"));
  }
  return out;
}

/** A drawing sheet's piece as drawn primitives. */
function sheetPrim(p: DrawingSheetPrim): Prim[] {
  switch (p.kind) {
    case "line":
      return [{ t: "path", d: polyPath([p.a, p.b]), role: "frame", w: p.width }];
    case "rect":
      return [{ t: "path", d: polyPath([p.a, { x: p.b.x, y: p.a.y }, p.b, { x: p.a.x, y: p.b.y }], true), role: "frame", w: p.width }];
    case "polygon":
      return [{ t: "path", d: polyPath(p.points, true), role: "frame", fill: true }];
    case "text": {
      const e: Effects = { size: p.size.y, h: p.h === "left" ? "start" : p.h === "right" ? "end" : "middle", v: p.v === "center" ? "middle" : p.v, hidden: false, bold: p.bold, italic: p.italic };
      const lines = p.text.split("\n");
      const step = p.size.y * 1.6;
      const r = (p.angle * Math.PI) / 180;
      // Lines stack down the text's own direction.
      // Squeezed to its maxlen: narrower than it is tall.
      const xScale = p.size.y > 0 && Math.abs(p.size.x - p.size.y) > 1e-6 ? p.size.x / p.size.y : undefined;
      return lines.map((line, i) => {
        const k = (i - (p.v === "bottom" ? lines.length - 1 : p.v === "center" ? (lines.length - 1) / 2 : 0)) * step;
        const t = text(p.at.x + k * Math.sin(r), p.at.y + k * Math.cos(r), line, e, p.angle, "frame");
        return xScale && t.t === "text" ? { ...t, xScale } : t;
      });
    }
    case "bitmap":
      return [{ t: "image", x: p.at.x, y: p.at.y, w: p.w, h: p.h, href: `data:${p.mime};base64,${p.png}` }];
  }
}

/** The default page frame (shared with the board view: defaultFrame). */
function frame(paper: { w: number; h: number }, title: Record<string, string>, sheetLabel: string, file: string): Prim[] {
  return defaultFrame(paper, title, sheetLabel, file).flatMap(sheetPrim);
}

/** Rough extent of an item's primitives (path coordinates, circles, text boxes). */
function bboxOf(prims: Prim[]): SchItem["bbox"] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  for (const p of prims) {
    if (p.t === "circle") { add(p.cx - p.r, p.cy - p.r); add(p.cx + p.r, p.cy + p.r); }
    else if (p.t === "image") { add(p.x, p.y); add(p.x + p.w, p.y + p.h); }
    else if (p.t === "text") { const w = textWidth(p.text, p.size) / 2; add(p.x - w, p.y - p.size); add(p.x + w, p.y + p.size); }
    else {
      // Path data: coordinate pairs after M/L/C (arcs are skipped; their end points are close enough).
      for (const seg of p.d.split(/[MLCZ]/)) {
        if (seg.includes("A")) continue;
        const n = seg.trim().split(/[\s,]+/).map(Number).filter((v) => !Number.isNaN(v));
        for (let i = 0; i + 1 < n.length; i += 2) add(n[i]!, n[i + 1]!);
      }
    }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
}

/** Embedded schematic image (base64 PNG/JPEG), sized as KiCad sizes it (see bitmapInfo) × scale. */
function imagePrim(node: List): Prim | undefined {
  const at = pt(findChild(node, "at"));
  const scale = Number(arg(findChild(node, "scale"), 0) ?? 1);
  const data = findChild(node, "data");
  if (!data) return undefined;
  const b64 = data.children.slice(1).filter(isAtom).map(atomText).join("").replace(/\s+/g, "");
  // Sized as KiCad sizes it: by the PNG's own resolution, else 300 pixels per inch.
  const info = bitmapInfoBase64(b64);
  if (!info) return undefined;
  const { w: mmW, h: mmH } = bitmapSizeMm(info, scale);
  return { t: "image", x: at.x - mmW / 2, y: at.y - mmH / 2, w: mmW, h: mmH, href: `data:${info.mime};base64,${b64}` };
}

/** KiCad 7+ text box: a rectangle with word-wrapped text inside its margins. */
/**
 * A table: each cell's fill and text, the outside border, the line under the header row, and the
 * lines between rows and columns, drawn along each cell's own edges so a spanned cell stays whole.
 */
function tablePrims(node: List, shown: (text: string) => string): Prim[] {
  const out: Prim[] = [];
  const cells = findChildren(findChild(node, "cells") ?? node, "table_cell");
  if (!cells.length) return out;
  const cols = Number(arg(findChild(node, "column_count"), 0) ?? 1) || 1;
  const border = findChild(node, "border");
  const seps = findChild(node, "separators");
  const yes = (n: List | undefined, k: string) => !!n && arg(findChild(n, k), 0) === "yes";
  const width = (n: List | undefined) => {
    const stroke = n && findChild(n, "stroke");
    return (stroke && Number(arg(findChild(stroke, "width"), 0) ?? 0)) || undefined;
  };
  const box = (c: List) => {
    const p = pt(findChild(c, "at"));
    const s = findChild(c, "size");
    return { x: p.x, y: p.y, w: Number(arg(s, 0) ?? 0), h: Number(arg(s, 1) ?? 0) };
  };
  const live = cells.filter((c) => Number(arg(findChild(c, "span"), 0) ?? 1) > 0);
  for (const c of live) out.push(...textBoxPrims(c, shown(str(c, 0)), false));
  const all = live.map(box);
  const x0 = Math.min(...all.map((b) => b.x));
  const y0 = Math.min(...all.map((b) => b.y));
  const x1 = Math.max(...all.map((b) => b.x + b.w));
  const y1 = Math.max(...all.map((b) => b.y + b.h));
  const line = (a: Point, b: Point, w?: number): Prim => ({ t: "path", d: polyPath([a, b]), role: "note", w });
  const eps = 1e-6;
  const sepW = width(seps);
  for (const [i, c] of cells.entries()) {
    if (Number(arg(findChild(c, "span"), 0) ?? 1) <= 0) continue;
    const b = box(c);
    // Right and bottom edges inside the table.
    if (yes(seps, "cols") && b.x + b.w < x1 - eps) out.push(line({ x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, sepW));
    const headerRow = i < cols;
    if (b.y + b.h < y1 - eps && (yes(seps, "rows") || (headerRow && yes(border, "header")))) out.push(line({ x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h }, headerRow && yes(border, "header") ? width(border) : sepW));
  }
  if (yes(border, "external")) out.push({ t: "path", d: polyPath([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], true), role: "note", w: width(border) });
  return out;
}

/** A text box, or (without its outline) a table cell: the fill, the outline, and the text wrapped and justified inside the margins. */
function textBoxPrims(node: List, shown: string, outline = true): Prim[] {
  const out: Prim[] = [];
  const at = findChild(node, "at");
  const start = findChild(node, "start");
  const p = pt(at ?? start);
  const size = findChild(node, "size");
  const end = findChild(node, "end");
  const w = size ? Number(arg(size, 0)) : Number(arg(end, 0)) - p.x;
  const h = size ? Number(arg(size, 1)) : Number(arg(end, 1)) - p.y;
  const fill = fillType(node);
  const rect = polyPath([p, { x: p.x + w, y: p.y }, { x: p.x + w, y: p.y + h }, { x: p.x, y: p.y + h }], true);
  if (fill !== "none") out.push({ t: "path", d: rect, role: "bodyFill", fill: true });
  if (outline) out.push({ t: "path", d: rect, role: "note", w: strokeWidth(node) });
  const e = effectsOf(node);
  const margins = findChild(node, "margins");
  // Left, top, right, bottom.
  const [ml, mt, mr, mb] = margins ? [0, 1, 2, 3].map((i) => Number(arg(margins, i) ?? arg(margins, 0))) : [e.size * 0.6, e.size * 0.6, e.size * 0.6, e.size * 0.6];
  const m = ml!;
  const maxChars = Math.max(4, Math.floor((w - ml! - mr!) / (e.size * CHAR_W)));
  const lines: string[] = [];
  for (const para of shown.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (line && (line + " " + word).length > maxChars) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  // Justified in the box: left, centre or right; top, middle or bottom.
  const x = e.h === "end" ? p.x + w - mr! : e.h === "middle" ? p.x + (ml! + w - mr!) / 2 : p.x + m;
  const step = e.size * 1.6;
  const block = (lines.length - 1) * step;
  const y0 = e.v === "bottom" ? p.y + h - mb! - block : e.v === "middle" ? p.y + (mt! + h - mb!) / 2 - block / 2 : p.y + mt!;
  lines.forEach((line, i) => out.push(text(x, y0 + i * step, line, { ...e, h: e.h, v: e.v === "bottom" ? "bottom" : e.v === "middle" ? "middle" : "top" }, 0, "note")));
  return out;
}

// ---------------------------------------------------------------------------

export function renderSheet(
  sheet: SheetInstance,
  root: List,
  schematic: Schematic,
  netlist: Netlist,
  pinNets: Map<string, string>,
  /** The project's drawing sheet (.kicad_wks), drawn instead of the default frame. */
  drawingSheet?: DrawingSheet,
): SheetView {
  const items: SchItem[] = [];
  const nets = netlist.sheetItems.get(sheet.path);
  const libs = new Map<string, List>();
  for (const s of findChildren(findChild(root, "lib_symbols") ?? root, "symbol")) libs.set(str(s, 0), s);
  const placements = schematic.placements.filter((p) => p.sheet === sheet);

  const paperNode = findChild(root, "paper");
  const paperName = str(paperNode);
  let [w, h] = paperName === "User" ? [Number(arg(paperNode, 1)), Number(arg(paperNode, 2))] : (PAPER[paperName] ?? PAPER["A4"]!);
  if (paperNode?.children.some((c) => isAtom(c) && c.raw === "portrait")) [w, h] = [h, w];
  const paper = { w, h };
  /** A text as KiCad shows it: its variables (${REVISION}, ${REFERENCE}, ${R1:VALUE}…) replaced. */
  const shown = (s: string, of?: (typeof placements)[number]) => (s.includes("${") ? shownText(s, sheet, schematic, of) : s);
  const title: Record<string, string> = {};
  const tb = findChild(root, "title_block");
  for (const c of tb?.children ?? []) if (isList(c)) title[headOf(c) === "comment" ? `comment${arg(c, 0)}` : headOf(c)!] = shown(str(c, headOf(c) === "comment" ? 1 : 0));
  if (drawingSheet) {
    const pages = sheetsByPage(schematic);
    const index = pages.indexOf(sheet);
    const info = {
      titleBlock: sheet.data.titleBlock,
      paper: paperName || "A4",
      page: sheet.pageNumber ?? String(index + 1),
      pages: pages.length,
      sheetName: sheet.ref?.name ?? "",
      sheetPath: sheet.namePath,
      fileName: sheet.file,
      variables: schematic.textVariables,
      generator: "Crossprobe",
    };
    items.push({ kind: "graphic", prims: drawingSheetPrims(drawingSheet, w, h, info, index === 0).flatMap(sheetPrim) });
  } else items.push({ kind: "graphic", prims: frame(paper, title, sheet.namePath, sheet.file) });

  let wireIndex = 0;
  let labelIndex = 0;
  let symbolIndex = 0;
  for (const node of root.children) {
    if (!isList(node)) continue;
    const start = items.length;
    switch (headOf(node)) {
      case "wire":
      case "bus": {
        const isBus = headOf(node) === "bus";
        const pts = findChildren(findChild(node, "pts") ?? node, "xy").map(pt);
        const net = isBus ? undefined : nets?.wires[wireIndex];
        if (!isBus) wireIndex++;
        items.push({ kind: isBus ? "bus" : "wire", net, points: pts, prims: [{ t: "path", d: polyPath(pts), role: isBus ? "bus" : "wire", w: strokeWidth(node) }] });
        break;
      }
      case "bus_entry": {
        const a = pt(findChild(node, "at"));
        const s = pt(findChild(node, "size"));
        items.push({ kind: "wire", prims: [{ t: "path", d: polyPath([a, { x: a.x + s.x, y: a.y + s.y }]), role: "wire" }] });
        break;
      }
      case "junction": {
        const p = pt(findChild(node, "at"));
        const d = Number(arg(findChild(node, "diameter"), 0) ?? 0) || 0.9144;
        items.push({ kind: "junction", points: [p], prims: [{ t: "circle", cx: p.x, cy: p.y, r: d / 2, role: "junction", fill: true }] });
        break;
      }
      case "no_connect": {
        const p = pt(findChild(node, "at"));
        const s = 0.6096;
        items.push({
          kind: "noconnect",
          points: [p],
          prims: [{ t: "path", d: `M${f(p.x - s)} ${f(p.y - s)}L${f(p.x + s)} ${f(p.y + s)}M${f(p.x + s)} ${f(p.y - s)}L${f(p.x - s)} ${f(p.y + s)}`, role: "noconnect" }],
        });
        break;
      }
      case "label":
      case "global_label":
      case "hierarchical_label": {
        const kind = headOf(node) === "label" ? "local" : headOf(node) === "global_label" ? "global" : "hierarchical";
        const prims = labelPrims(node, kind, shown(str(node, 0)));
        if (kind === "global" && schematic.intersheetRefs?.show) {
          const refs = intersheetRefs(schematic, sheet, str(node, 0));
          if (refs) prims.push(intersheetRefsPrim(node, refs, prims));
        }
        items.push({ kind: "label", net: nets?.labels[labelIndex++], points: [pt(findChild(node, "at"))], prims, text: str(node, 0), shape: kind === "local" ? undefined : str(findChild(node, "shape")) || "input" });
        break;
      }
      case "text": {
        const e = effectsOf(node);
        const at = findChild(node, "at");
        const p = pt(at);
        const lines = shown(str(node, 0)).split("\n");
        const angle = Number(arg(at, 2) ?? 0);
        const step = e.size * 1.6;
        // Lines stack "down" the text: along +y for horizontal text, +x for vertical.
        // The vertical justification decides which line sits on the anchor.
        const r = readable(angle, e.h, e.v);
        const first = r.v === "bottom" ? -(lines.length - 1) : r.v === "middle" ? -(lines.length - 1) / 2 : 0;
        const prims = lines.map((line, i) => {
          const k = (first + i) * step;
          return text(r.angle === 90 ? p.x + k : p.x, r.angle === 90 ? p.y : p.y + k, line, e, angle, "note");
        });
        items.push({ kind: "text", prims, text: str(node, 0) });
        break;
      }
      case "image": {
        const img = imagePrim(node);
        if (img) items.push({ kind: "graphic", prims: [img] });
        break;
      }
      case "table": {
        // The table's lines are one item (selected and moved as a whole); each cell is its own, to edit.
        // A KiCad 9 table has no UUID: it goes by its first cell's.
        const cellList = findChildren(findChild(node, "cells") ?? node, "table_cell");
        const tableId = str(findChild(node, "uuid")) || (cellList[0] ? `${TABLE_BY_CELL}${str(findChild(cellList[0], "uuid"))}` : "");
        const lines = tablePrims(node, (t) => shown(t)).filter((p) => p.t !== "text");
        // The cells' extent, so a table drawn with no lines still has a box to select.
        let box: { x: number; y: number; w: number; h: number } | undefined;
        for (const c of cellList) {
          const p = pt(findChild(c, "at"));
          const s = findChild(c, "size");
          const [x1, y1] = [p.x + Number(arg(s, 0) ?? 0), p.y + Number(arg(s, 1) ?? 0)];
          const [x0, y0] = [Math.min(p.x, box?.x ?? Infinity), Math.min(p.y, box?.y ?? Infinity)];
          box = { x: x0, y: y0, w: Math.max(x1, box ? box.x + box.w : -Infinity) - x0, h: Math.max(y1, box ? box.y + box.h : -Infinity) - y0 };
        }
        items.push({ kind: "graphic", prims: lines, uuid: tableId || undefined, bbox: box ?? (lines.length ? bboxOf(lines) : undefined) });
        for (const c of cellList) {
          if (Number(arg(findChild(c, "span"), 0) ?? 1) <= 0) continue;
          const p = pt(findChild(c, "at"));
          const s = findChild(c, "size");
          const [w, h] = [Number(arg(s, 0) ?? 0), Number(arg(s, 1) ?? 0)];
          const hit: Prim = { t: "path", d: polyPath([p, { x: p.x + w, y: p.y }, { x: p.x + w, y: p.y + h }, { x: p.x, y: p.y + h }], true), role: "cellHit", fill: true };
          items.push({ kind: "cell", prims: [hit, ...textBoxPrims(c, shown(str(c, 0)), false).filter((q) => q.t === "text")], uuid: str(findChild(c, "uuid")), owner: tableId || undefined, text: str(c, 0) });
        }
        break;
      }
      case "text_box": {
        items.push({ kind: "text", prims: textBoxPrims(node, shown(str(node, 0))), text: str(node, 0) });
        break;
      }
      case "polyline":
      case "rectangle":
      case "circle":
      case "arc":
      case "bezier": {
        const prims: Prim[] = [];
        shape(node, (p) => p, "note", "note", prims);
        items.push({ kind: "graphic", prims });
        break;
      }
      case "netclass_flag":
      case "directive_label": {
        const at = findChild(node, "at");
        const p = pt(at);
        const angle = Number(arg(at, 2) ?? 0);
        const len = Number(arg(findChild(node, "length"), 0) ?? 2.54);
        // The stub leaves the wire upward at 0°, then turns with the angle (KiCad's degrees, counter-clockwise).
        const d = dir((angle + 90) % 360);
        const end = { x: p.x + d.x * len, y: p.y + d.y * len };
        const r = 0.635;
        const shapeName = str(findChild(node, "shape")) || "round";
        const tip = { x: end.x + d.x * r, y: end.y + d.y * r };
        const prims: Prim[] = [{ t: "path", d: polyPath([p, end]), role: "directive" }];
        if (shapeName === "round" || shapeName === "dot") prims.push({ t: "circle", cx: tip.x, cy: tip.y, r, role: "directive", fill: shapeName === "dot" });
        else if (shapeName === "diamond") prims.push({ t: "path", d: polyPath([end, { x: tip.x - d.y * r, y: tip.y + d.x * r }, { x: end.x + d.x * 2 * r, y: end.y + d.y * 2 * r }, { x: tip.x + d.y * r, y: tip.y - d.x * r }], true), role: "directive" });
        else prims.push({ t: "path", d: polyPath([{ x: end.x - d.y * r, y: end.y + d.x * r }, { x: end.x - d.y * r + d.x * 2 * r, y: end.y + d.x * r + d.y * 2 * r }, { x: end.x + d.y * r + d.x * 2 * r, y: end.y - d.x * r + d.y * 2 * r }, { x: end.x + d.y * r, y: end.y - d.x * r }], true), role: "directive" });
        const classes = findChildren(node, "property").find((f) => str(f, 0) === "Netclass");
        for (const f of findChildren(node, "property")) {
          const value = str(f, 1);
          if (!value || effectsOf(f).hidden) continue;
          const fa = findChild(f, "at");
          prims.push(text(Number(arg(fa, 0)), Number(arg(fa, 1)), value, { ...effectsOf(f), v: "middle" }, Number(arg(fa, 2) ?? 0), "directive"));
        }
        items.push({ kind: "directive", points: [p], prims, text: classes ? str(classes, 1) : "", field: "Netclass" });
        break;
      }
      case "rule_area": {
        const prims: Prim[] = [];
        const outline = findChild(node, "polyline");
        if (outline) {
          const pts = findChildren(findChild(outline, "pts") ?? outline, "xy").map(pt);
          prims.push({ t: "path", d: polyPath(pts, true), role: "ruleArea", dash: true });
        }
        items.push({ kind: "ruleArea", prims, uuid: str(findChild(outline ?? node, "uuid")) });
        break;
      }
      case "sheet": {
        const uuid = str(findChild(node, "uuid"));
        const name = findChildren(node, "property").find((p) => /^Sheet ?name$/.test(str(p, 0)));
        const page = findChildren(findChild(node, "instances") ?? node, "project").flatMap((p) => findChildren(p, "path")).find((p) => str(p, 0) === sheet.path);
        items.push({ kind: "sheet", sheetPath: `${sheet.path}/${uuid}`, prims: sheetPrims(node), text: str(name, 1), pinNames: findChildren(node, "pin").map((p) => str(p, 0)), page: page ? str(findChild(page, "page")) : undefined });
        break;
      }
      case "symbol": {
        const placement = placements[symbolIndex++];
        const sym = sheet.data.symbols[symbolIndex - 1];
        if (!sym) break;
        const libNode = libs.get(sym.libId);
        const o: Orientation = { rotation: sym.rotation, mirrorX: sym.mirrorX, mirrorY: sym.mirrorY };
        const isPower = !!placement?.lib?.power;
        const reference = placement?.reference ?? sym.properties["Reference"] ?? "?";
        const unit = placement?.unit ?? sym.unit;
        const shownRef = placement?.lib && placement.lib.unitCount > 1 ? reference + unitLetter(unit) : reference;
        const prims: Prim[] = [];
        let pins: PinDraw[] = [];
        if (libNode) {
          const g = symbolGraphics(libNode, unit, sym.bodyStyle, o, sym.at, isPower, sym.pinAlternates);
          prims.push(...g.body);
          pins = g.pins;
        }
        // A part that is not populated is crossed out, corner to corner of its body and pins.
        if (sym.dnp) {
          const b = bboxOf([...prims, ...pins.flatMap((p) => p.prims.filter((q) => q.t !== "text"))]);
          if (b) prims.push({ t: "path", d: `M${f(b.x)} ${f(b.y)}L${f(b.x + b.w)} ${f(b.y + b.h)}M${f(b.x + b.w)} ${f(b.y)}L${f(b.x)} ${f(b.y + b.h)}`, role: "dnp", w: 0.4572 });
        }
        const ref = isPower || reference.startsWith("#") ? undefined : reference;
        const net = isPower ? sym.properties["Value"] : undefined;
        items.push({ kind: "symbol", ref, reference, net, prims });
        // Each shown field is an item of its own: it can be moved, turned and edited apart from the symbol.
        for (const prop of findChildren(node, "property")) {
          const key = str(prop, 0);
          const value = key === "Reference" ? shownRef : shown(str(prop, 1), placement);
          const role: Role = key === "Reference" ? "reference" : key === "Value" ? (isPower ? "labelPower" : "value") : "field";
          const p = fieldPrim(value, prop, o, sym.at, role);
          if (p) items.push({ kind: "field", ref, net, prims: [p], field: key, owner: sym.uuid, uuid: `${sym.uuid}#${key}`, text: key === "Reference" ? reference : str(prop, 1) });
        }
        for (const pin of pins) {
          items.push({ kind: "pin", ref, pin: pin.number, outward: pin.outward, net: ref ? pinNets.get(`${reference}\0${pin.number}`) : undefined, prims: pin.prims, points: [pin.tip] });
        }
        break;
      }
    }
    // A text or label with a link (KiCad's href).
    const href = arg(findChild(findChild(node, "effects") ?? node, "href"), 0);
    if (href !== undefined && items.length > start) items[start]!.href = String(href);
    // Tag what this node produced with its UUID (pins get their symbol's), for editing.
    const id = str(findChild(node, "uuid"));
    if (id) for (let k = start; k < items.length; k++) items[k]!.uuid ??= id;
  }

  for (const item of items) if (item.kind !== "graphic" || item.prims[0]?.t === "image") item.bbox = bboxOf(item.prims);

  return {
    path: sheet.path,
    namePath: sheet.namePath,
    name: sheet.ref?.name ?? "Root",
    file: sheet.file,
    page: sheet.pageNumber ?? String(sheetsByPage(schematic).indexOf(sheet) + 1),
    paper,
    title,
    items,
    children: schematic.sheets.filter((s) => s.parent === sheet).map((s) => s.path),
  };
}

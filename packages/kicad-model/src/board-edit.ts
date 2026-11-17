/**
 * Board editing on the .kicad_pcb syntax tree: move, rotate, flip, delete,
 * add tracks and vias, set footprint fields and pad nets. Like the
 * schematic edits, these change only the nodes they touch.
 *
 * File conventions (checked against KiCad's own pcbnew in the tests):
 * footprint children are stored in the footprint's frame, unrotated, while
 * pad and text angles are absolute (they include the footprint's rotation).
 */
import { arg, findChild, findChildren, format, headOf, insertAt, isAtom, isList, list, num, parse, removeChild, setArg, str, sym, walk, type Document, type List, type Node } from "@crossprobe/kicad-sexpr";
import type { Point } from "./geometry.js";
import { dimensionGeometry } from "./board.js";

export function boardRoot(doc: Document): List {
  const root = doc.children.find((c): c is List => isList(c) && headOf(c) === "kicad_pcb");
  if (!root) throw new Error("Not a KiCad board");
  return root;
}

const uuidOf = (n: List) => String(arg(findChild(n, "uuid") ?? findChild(n, "tstamp"), 0) ?? "");

/** A top-level board item (footprint, track, via, zone, drawing, text) by UUID. */
export function findBoardItem(root: List, uuid: string): List | undefined {
  return root.children.find((c): c is List => isList(c) && uuidOf(c) === uuid);
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** KiCad orientation range for footprints: (-180, 180]. */
function norm180(a: number): number {
  let v = a % 360;
  if (v <= -180) v += 360;
  if (v > 180) v -= 360;
  return r6(v) === 0 ? 0 : r6(v);
}
/**
 * Footprint texts are kept readable (KiCad's KeepUpright): angles fold into
 * [0, 180), swapping left/right justification when they do.
 */
function setTextAngle(text: List, at: List, angle: number) {
  let v = norm360(angle);
  // `(unlocked yes)` texts rotate freely; others stay readable.
  const unlocked = arg(findChild(text, "unlocked"), 0) === "yes";
  if (v >= 180 && !unlocked) {
    v = norm360(v - 180);
    const justify = findChild(findChild(text, "effects") ?? text, "justify");
    if (justify) {
      justify.children.forEach((c, i) => {
        if (i > 0 && isAtom(c) && (c.raw === "left" || c.raw === "right")) justify.children[i] = sym(c.raw === "left" ? "right" : "left");
      });
    }
  }
  setAngle(at, v, true);
}

/** Turn an `fp_rect` into the equivalent four-corner `fp_poly`. */
function rectToPoly(rect: List) {
  const s = findChild(rect, "start");
  const e = findChild(rect, "end");
  if (!s || !e) return;
  const a = getXY(s);
  const b = getXY(e);
  const pts = list("pts", list("xy", a.x, a.y), list("xy", b.x, a.y), list("xy", b.x, b.y), list("xy", a.x, b.y));
  rect.children[0] = sym("fp_poly");
  const i = rect.children.indexOf(s);
  rect.children[i] = pts;
  removeChild(rect, e);
  format(pts, "\t\t\t");
}

/** Pads and texts: [0, 360). */
function norm360(a: number): number {
  let v = a % 360;
  if (v < 0) v += 360;
  return r6(v) === 360 ? 0 : r6(v);
}

/** Rotate p around c by `deg` degrees (KiCad: positive is counter-clockwise on screen). */
export function rotatePoint(p: Point, c: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: r6(c.x + dx * cos + dy * sin), y: r6(c.y - dx * sin + dy * cos) };
}

const getXY = (n: List): Point => ({ x: Number(arg(n, 0) ?? 0), y: Number(arg(n, 1) ?? 0) });
function setXY(n: List, p: Point) {
  setArg(n, 0, num(r6(p.x)));
  setArg(n, 1, num(r6(p.y)));
}
/** Set the angle of an `(at x y [angle])`; footprints and pads omit a zero angle, as KiCad does. */
function setAngle(at: List, angle: number, keepZero: boolean) {
  const has = at.children.length > 3;
  if (angle === 0 && !keepZero) {
    if (has) {
      at.children.splice(3);
      at.trivia.splice(3);
    }
    return;
  }
  setArg(at, 2, num(angle));
}

const POINT_HEADS = new Set(["xy", "start", "end", "mid", "center", "at"]);

/** Apply a point transform to every coordinate in a board-level item. */
function mapPoints(node: List, f: (p: Point) => Point) {
  for (const c of node.children) {
    if (!isList(c)) continue;
    const h = headOf(c)!;
    if (POINT_HEADS.has(h)) setXY(c, f(getXY(c)));
    else mapPoints(c, f);
  }
}

export function moveBoardItem(node: List, dx: number, dy: number): void {
  if (headOf(node) === "footprint") {
    const at = findChild(node, "at");
    if (at) setXY(at, { x: getXY(at).x + dx, y: getXY(at).y + dy });
    return;
  }
  mapPoints(node, (p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** Rotate an item by `deg` around `center` (default: a footprint's own anchor). */
export function rotateBoardItem(node: List, deg: number, center?: Point): void {
  const head = headOf(node);
  if (head === "footprint") {
    const at = findChild(node, "at")!;
    const c = center ?? getXY(at);
    setXY(at, rotatePoint(getXY(at), c, deg));
    setAngle(at, norm180(Number(arg(at, 2) ?? 0) + deg), false);
    for (const ch of node.children) {
      if (!isList(ch)) continue;
      const h = headOf(ch);
      if (h === "pad" || h === "property" || h === "fp_text") {
        const a = findChild(ch, "at");
        if (!a) continue;
        if (h === "pad") setAngle(a, norm360(Number(arg(a, 2) ?? 0) + deg), false);
        else setTextAngle(ch, a, Number(arg(a, 2) ?? 0) + deg);
      }
    }
    // KiCad rectangles are axis-aligned: at other angles they become polygons.
    if (norm360(Number(arg(at, 2) ?? 0)) % 90 !== 0) {
      for (const ch of findChildren(node, "fp_rect")) rectToPoly(ch);
    }
    return;
  }
  const c = center ?? itemCenter(node);
  mapPoints(node, (p) => rotatePoint(p, c, deg));
  if (head === "gr_text") {
    const a = findChild(node, "at");
    if (a) setAngle(a, norm360(Number(arg(a, 2) ?? 0) + deg), true);
  }
}

/** Mean of an item's coordinates; good enough as a rotation centre for drawings. */
export function itemCenter(node: List): Point {
  if (headOf(node) === "footprint") return getXY(findChild(node, "at")!);
  let x = 0;
  let y = 0;
  let n = 0;
  const visit = (l: List) => {
    for (const c of l.children) {
      if (!isList(c)) continue;
      if (POINT_HEADS.has(headOf(c)!)) {
        const p = getXY(c);
        x += p.x;
        y += p.y;
        n++;
      } else visit(c);
    }
  };
  visit(node);
  return n ? { x: r6(x / n), y: r6(y / n) } : { x: 0, y: 0 };
}

const flipLayerName = (l: string) => (l.startsWith("F.") ? "B." + l.slice(2) : l.startsWith("B.") ? "F." + l.slice(2) : l);

function flipLayers(node: List) {
  for (const h of ["layer", "layers"]) {
    const l = findChild(node, h);
    if (!l) continue;
    l.children.forEach((c, i) => {
      if (i > 0 && isAtom(c) && c.kind === "string") l.children[i] = str(flipLayerName(String(arg(l, i - 1))));
    });
  }
}

/** Negate local y of every coordinate below `node` (not descending into `at` angles). */
function mirrorLocalY(node: List) {
  for (const c of node.children) {
    if (!isList(c)) continue;
    const h = headOf(c)!;
    if (POINT_HEADS.has(h) || h === "offset") {
      const p = getXY(c);
      setArg(c, 1, num(r6(-p.y)));
    } else mirrorLocalY(c);
  }
}

/** Toggle `mirror` in a text's `(effects (justify …))`. */
function toggleMirror(text: List) {
  let effects = findChild(text, "effects");
  if (!effects) return;
  let justify = findChild(effects, "justify");
  if (!justify) {
    justify = list("justify", sym("mirror"));
    insertAt(effects, effects.children.length, justify);
    return;
  }
  const i = justify.children.findIndex((c, k) => k > 0 && isAtom(c) && c.raw === "mirror");
  if (i > 0) {
    justify.children.splice(i, 1);
    justify.trivia.splice(i, 1);
    if (justify.children.length === 1) removeChild(effects, justify);
  } else insertAt(justify, justify.children.length, sym("mirror"));
}

/**
 * Flip a footprint to the other side, mirrored left/right around `centerX`
 * (default: in place), the way KiCad's Flip does it.
 */
export function flipFootprint(node: List, centerX?: number): void {
  const at = findChild(node, "at")!;
  const p = getXY(at);
  const cx = centerX ?? p.x;
  setXY(at, { x: 2 * cx - p.x, y: p.y });
  setAngle(at, norm180(180 - Number(arg(at, 2) ?? 0)), false);
  flipLayers(node);
  for (const ch of node.children) {
    if (!isList(ch)) continue;
    const h = headOf(ch)!;
    if (h === "at" || h === "layer" || h === "model") continue;
    flipLayers(ch);
    if (h === "pad") {
      const a = findChild(ch, "at")!;
      setArg(a, 1, num(r6(-getXY(a).y)));
      setAngle(a, norm360(180 - Number(arg(a, 2) ?? 0)), false);
      for (const sub of ch.children) if (isList(sub) && headOf(sub) !== "at") mirrorLocalY(sub);
      const chamfer = findChild(ch, "chamfer");
      if (chamfer) {
        chamfer.children.forEach((c, i) => {
          if (i === 0 || !isAtom(c)) return;
          const v = c.raw.replace(/^top_/, "\0").replace(/^bottom_/, "top_").replace("\0", "bottom_");
          chamfer.children[i] = sym(v);
        });
      }
    } else if (h === "property" || h === "fp_text") {
      const a = findChild(ch, "at");
      if (a) {
        setArg(a, 1, num(r6(-getXY(a).y)));
        setTextAngle(ch, a, -Number(arg(a, 2) ?? 0));
      }
      // Only side-specific texts (F./B. layers) mirror; Cmts.User etc. stay readable.
      if (/^[FB]\./.test(String(arg(findChild(ch, "layer"), 0) ?? ""))) toggleMirror(ch);
    } else if (h === "fp_text_box" || h.startsWith("fp_") || h === "zone" || h === "dimension") {
      mirrorLocalY(ch);
      if (h === "fp_text_box") toggleMirror(ch);
    }
  }
}

/**
 * Paste copies of board items (their S-expression text): each gets new UUIDs
 * throughout (`uuid` for the item itself), moves by (dx, dy), and a footprint
 * the next free reference with its prefix (R3 → R7), as KiCad's duplicate does.
 */
export function pasteBoardItems(root: List, items: Array<{ text: string; uuid: string }>, dx: number, dy: number): void {
  const used = new Set(
    findChildren(root, "footprint").map((f) => {
      const p = findChildren(f, "property").find((q) => arg(q, 0) === "Reference") ?? findChildren(f, "fp_text").find((q) => arg(q, 0) === "reference");
      return String((p && arg(p, 1)) ?? "");
    }),
  );
  for (const { text, uuid } of items) {
    const node = parse(text).children.find(isList);
    if (!node) continue;
    walk(node, (n) => {
      if (headOf(n) === "uuid" || headOf(n) === "tstamp") setArg(n, 0, str(newBoardUuid()));
      return true;
    });
    const own = findChild(node, "uuid");
    if (own) setArg(own, 0, str(uuid));
    moveBoardItem(node, dx, dy);
    if (headOf(node) === "footprint") {
      const p = findChildren(node, "property").find((q) => arg(q, 0) === "Reference") ?? findChildren(node, "fp_text").find((q) => arg(q, 0) === "reference");
      if (p) {
        const ref = String(arg(p, 1) ?? "");
        const prefix = ref.replace(/\d+$/, "") || "REF";
        let n = 1;
        while (used.has(`${prefix}${n}`)) n++;
        used.add(`${prefix}${n}`);
        setArg(p, 1, str(`${prefix}${n}`));
      }
      setLocked(node, false);
    }
    insertBoardItem(root, node);
  }
}

/** Lock or unlock a footprint, track or via, as KiCad writes it: (locked yes) after the header. */
/**
 * Move one of a footprint's texts (its reference, value or a free text) by a board-space offset,
 * as KiCad does when the text is dragged on its own: the offset is turned into the footprint's frame.
 */
export function moveFootprintText(root: List, footprintUuid: string, textUuid: string, dx: number, dy: number): boolean {
  const fp = findBoardItem(root, footprintUuid);
  const text = fp?.children.find((c, i): c is List => isList(c) && (headOf(c) === "property" || headOf(c) === "fp_text") && (uuidOf(c) || `${footprintUuid}#${i}`) === textUuid);
  const at = text && findChild(text, "at");
  if (!fp || !at) return false;
  const r = (Number(arg(findChild(fp, "at"), 2) ?? 0) * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const p = getXY(at);
  setXY(at, { x: r6(p.x + dx * c - dy * s), y: r6(p.y + dx * s + dy * c) });
  return true;
}

export function setLocked(node: List, locked: boolean): void {
  for (const c of [...node.children]) if ((isAtom(c) && c.raw === "locked") || headOf(c) === "locked") removeChild(node, c);
  if (!locked) return;
  // After the item's own name (a footprint's library id), before the rest.
  const at = headOf(node) === "footprint" && node.children.length > 1 && !isList(node.children[1]!) ? 2 : 1;
  insertAt(node, at, list("locked", sym("yes")));
}

export function deleteBoardItem(root: List, uuid: string): boolean {
  const n = findBoardItem(root, uuid);
  return n ? removeChild(root, n) : false;
}

export function newBoardUuid(): string {
  return globalThis.crypto.randomUUID();
}

/** KiCad ≤ 9 boards number their nets in a `(net N "name")` table; KiCad 10 uses names. */
function netNode(root: List, name: string): List {
  const table = findChildren(root, "net");
  if (!table.length) return list("net", str(name));
  let entry = table.find((n) => arg(n, 1) === name);
  if (!entry) {
    const next = Math.max(0, ...table.map((n) => Number(arg(n, 0) ?? 0))) + 1;
    entry = list("net", next, str(name));
    insertAt(root, root.children.indexOf(table[table.length - 1]!) + 1, format(entry, "\t"), "");
  }
  return list("net", Number(arg(entry, 0)));
}

/** Insert next to the last item of the same kind, else before the first track/footprint-less tail. */
export function insertBoardItem(root: List, item: List): void {
  const head = headOf(item);
  let index = -1;
  root.children.forEach((c, i) => {
    if (headOf(c) === head || (head === "via" && (headOf(c) === "segment" || headOf(c) === "arc"))) index = i;
  });
  if (index < 0) {
    index = root.children.findIndex((c) => ["zone", "group", "embedded_fonts"].includes(headOf(c) ?? "")) - 1;
    if (index < -1) index = root.children.length - 1;
  }
  insertAt(root, index + 1, format(item, "\t"), "");
}

export interface NewTrack {
  start: Point;
  end: Point;
  width: number;
  layer: string;
  net: string;
}

export function addTrack(root: List, t: NewTrack): string {
  const id = newBoardUuid();
  const items: Node[] = [
    list("start", r6(t.start.x), r6(t.start.y)),
    list("end", r6(t.end.x), r6(t.end.y)),
    list("width", t.width),
    list("layer", str(t.layer)),
  ];
  if (t.net) items.push(netNode(root, t.net));
  items.push(list("uuid", str(id)));
  insertBoardItem(root, list("segment", ...items));
  return id;
}

export interface NewVia {
  /** Blind, buried or micro: from layers[0] to layers[1] only. */
  type?: "blind" | "buried" | "micro";
  at: Point;
  size: number;
  drill: number;
  layers: [string, string];
  net: string;
}

export function addVia(root: List, v: NewVia): string {
  const id = newBoardUuid();
  const items: Node[] = [
    list("at", r6(v.at.x), r6(v.at.y)),
    list("size", v.size),
    list("drill", v.drill),
    list("layers", str(v.layers[0]), str(v.layers[1])),
  ];
  if (v.net) items.push(netNode(root, v.net));
  items.push(list("uuid", str(id)));
  insertBoardItem(root, v.type && v.type !== ("through" as string) ? list("via", sym(v.type), ...items) : list("via", ...items));
  return id;
}

/** Move one end of a track (`index` 0 = start, 1 = end). */
export function moveTrackEnd(node: List, index: 0 | 1, to: Point): void {
  const n = findChild(node, index === 0 ? "start" : "end");
  if (n) setXY(n, to);
}

/** Set a footprint's DNP and exclude-from-BOM flags (its `attr` list), each only when given. */
export function setFootprintAttributes(node: List, a: { dnp?: boolean; excludeFromBom?: boolean }): void {
  let attr = findChild(node, "attr");
  if (!attr) {
    attr = list("attr", sym("smd"));
    const after = findChild(node, "property") ? findChildren(node, "property").pop()! : findChild(node, "layer");
    insertAt(node, after ? node.children.indexOf(after) + 1 : node.children.length, attr);
  }
  const flag = (name: string, on: boolean | undefined) => {
    if (on === undefined) return;
    const i = attr!.children.findIndex((c) => isAtom(c) && c.raw === name);
    if (on && i < 0) insertAt(attr!, attr!.children.length, sym(name));
    if (!on && i >= 0) removeChild(attr!, attr!.children[i]!);
  };
  flag("dnp", a.dnp);
  flag("exclude_from_bom", a.excludeFromBom);
}

/** Set a footprint property (Reference, Value, …), creating it hidden on F.Fab if missing. */
export function setFootprintField(node: List, name: string, value: string): void {
  const p = findChildren(node, "property").find((q) => arg(q, 0) === name);
  if (p) {
    setArg(p, 1, str(value));
    return;
  }
  const fp = findChildren(node, "fp_text").find((t) => arg(t, 0) === name.toLowerCase());
  if (fp && (name === "Reference" || name === "Value")) {
    setArg(fp, 1, str(value));
    return;
  }
  const layer = String(arg(findChild(node, "layer"), 0) ?? "F.Cu").startsWith("B.") ? "B.Fab" : "F.Fab";
  const prop = list(
    "property",
    str(name),
    str(value),
    list("at", 0, 0, 0),
    list("layer", str(layer)),
    list("hide", sym("yes")),
    list("uuid", str(newBoardUuid())),
    list("effects", list("font", list("size", 1, 1), list("thickness", 0.15))),
  );
  const last = findChildren(node, "property").pop();
  insertAt(node, last ? node.children.indexOf(last) + 1 : 1, prop);
}

/** Set (or clear, with "") the net of a footprint pad. */
export function setPadNet(root: List, footprint: List, padNumber: string, net: string): void {
  for (const pad of findChildren(footprint, "pad")) {
    if (String(arg(pad, 0)) !== padNumber) continue;
    const old = findChild(pad, "net");
    if (!net) {
      if (old) removeChild(pad, old);
      continue;
    }
    const table = findChildren(root, "net");
    const node = table.length ? (() => {
      const n = netNode(root, net);
      // Pads keep the name too in ≤ 9 files: (net 3 "GND").
      setArg(n, 1, str(net));
      return n;
    })() : list("net", str(net));
    if (old) pad.children[pad.children.indexOf(old)] = node;
    else {
      const anchor = findChild(pad, "pinfunction") ?? findChild(pad, "pintype") ?? findChild(pad, "uuid");
      insertAt(pad, anchor ? pad.children.indexOf(anchor) : pad.children.length, node);
    }
  }
}

/**
 * Change a footprint's pads numbered `padNumber` on the board (KiCad's pad
 * properties): size, shape, round drill. The footprint then differs from its
 * library, as it does in KiCad.
 */
export function setPadProps(footprint: List, padNumber: string, p: { size?: { x: number; y: number }; shape?: string; drill?: number }): void {
  for (const pad of findChildren(footprint, "pad")) {
    if (String(arg(pad, 0)) !== padNumber) continue;
    if (p.shape) setArg(pad, 2, sym(p.shape));
    if (p.size) {
      const n = findChild(pad, "size");
      if (n) {
        setArg(n, 0, num(r6(p.size.x)));
        setArg(n, 1, num(r6(p.size.y)));
      }
    }
    if (p.drill !== undefined) {
      const n = findChild(pad, "drill");
      // A round drill (an oval one, (drill oval x y), becomes round).
      if (n) {
        n.children.splice(1);
        n.trivia.splice(1);
        insertAt(n, 1, num(r6(p.drill)));
      }
    }
  }
}

/** Change a track's width and/or layer. */
export function setTrackProps(node: List, p: { width?: number; layer?: string }): void {
  if (p.width !== undefined) {
    const w = findChild(node, "width");
    if (w) setArg(w, 0, num(r6(p.width)));
  }
  if (p.layer !== undefined) {
    const l = findChild(node, "layer");
    if (l) setArg(l, 0, str(p.layer));
  }
}

/** Change a via's diameter and/or drill. */
export function setViaProps(node: List, p: { size?: number; drill?: number }): void {
  if (p.size !== undefined) {
    const s = findChild(node, "size");
    if (s) setArg(s, 0, num(r6(p.size)));
  }
  if (p.drill !== undefined) {
    const d = findChild(node, "drill");
    if (d) setArg(d, 0, num(r6(p.drill)));
  }
}

/**
 * Replace a zone's filled polygons (KiCad's fractured form: one simple
 * polygon per filled area, holes joined by zero-width cuts).
 */
export function setZoneFills(zone: List, fills: Array<{ layer: string; polygons: Point[][] }>): void {
  for (const f of findChildren(zone, "filled_polygon")) removeChild(zone, f);
  // `(fill yes …)` marks the zone as filled.
  const fill = findChild(zone, "fill");
  if (fill && !fill.children.some((c) => isAtom(c) && c.raw === "yes")) insertAt(fill, 1, sym("yes"));
  for (const { layer, polygons } of fills) {
    for (const poly of polygons) {
      if (poly.length < 3) continue;
      const pts = list("pts", ...poly.map((p) => list("xy", r6(p.x), r6(p.y))));
      insertAt(zone, zone.children.length, list("filled_polygon", list("layer", str(layer)), pts));
    }
  }
}

export interface NewBoardShape {
  kind: "rect" | "poly" | "line" | "circle" | "arc";
  /** rect / line: two corners · circle: centre and a point on it · arc: start, mid, end · poly: the vertices. */
  points: Point[];
  layer: string;
  width: number;
  fill?: boolean;
}

/** A board-level graphic (gr_rect, gr_poly, gr_line, gr_circle): outlines, silkscreen, drawings. */
export function addBoardShape(root: List, s: NewBoardShape): string {
  const id = newBoardUuid();
  const xy = (p: Point) => list("xy", r6(p.x), r6(p.y));
  const geometry: Node[] =
    s.kind === "poly"
      ? [list("pts", ...s.points.map(xy))]
      : s.kind === "circle"
        ? [list("center", r6(s.points[0]!.x), r6(s.points[0]!.y)), list("end", r6(s.points[1]!.x), r6(s.points[1]!.y))]
        : s.kind === "arc"
          ? (["start", "mid", "end"] as const).map((k, i) => list(k, r6(s.points[i]!.x), r6(s.points[i]!.y)))
          : [list("start", r6(s.points[0]!.x), r6(s.points[0]!.y)), list("end", r6(s.points[1]!.x), r6(s.points[1]!.y))];
  const items: Node[] = [...geometry, list("stroke", list("width", s.width), list("type", sym("solid")))];
  if (s.kind !== "line" && s.kind !== "arc") items.push(list("fill", sym(s.fill ? "yes" : "no")));
  items.push(list("layer", str(s.layer)), list("uuid", str(id)));
  insertBoardItem(root, list(`gr_${s.kind}`, ...items));
  return id;
}

export interface NewZone {
  net: string;
  layers: string[];
  outline: Point[];
  /** Zone clearance to other nets (mm); KiCad's default 0.5. */
  clearance?: number;
  minThickness?: number;
  thermalGap?: number;
  thermalWidth?: number;
  priority?: number;
  name?: string;
  /** A rule area instead of copper: what it keeps out (true = not allowed). `net` is then "". */
  keepout?: { tracks?: boolean; vias?: boolean; pads?: boolean; copperpour?: boolean; footprints?: boolean };
}

/**
 * An aligned (or orthogonal) dimension between two points, `height` from
 * them, measuring in mm. The text sits as KiCad places it outside the
 * crossbar: at its middle, a text height and a pen width out, along it and
 * kept readable.
 */
export function addDimension(
  root: List,
  d: { start: Point; end: Point; height: number; layer: string; vertical?: boolean; orthogonal?: boolean; textSize?: number; precision?: number },
): string {
  const id = newBoardUuid();
  const size = d.textSize ?? 1;
  const pen = size * 0.15;
  const type = d.orthogonal ? "orthogonal" : "aligned";
  const g = dimensionGeometry({ type, start: d.start, end: d.end, height: d.height, vertical: d.vertical });
  const [cs, ce] = g.crossbar ?? [d.start, d.end];
  const value = d.orthogonal ? Math.abs(d.vertical ? d.end.y - d.start.y : d.end.x - d.start.x) : Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y);
  const text = `${value.toFixed(d.precision ?? 2)} mm`;
  // Text position: KiCad's "outside" placement.
  const c = { x: (ce.x - cs.x) / 2, y: (ce.y - cs.y) / 2 };
  const rot = c.x === 0 ? (c.y > 0 ? -90 : 90) : c.x < 0 ? -90 : 90;
  const r = (rot * Math.PI) / 180;
  // KiCad's RotatePoint turns (x, y) by -angle in screen terms: (x cos + y sin, -x sin + y cos).
  const o = { x: c.x * Math.cos(r) + c.y * Math.sin(r), y: -c.x * Math.sin(r) + c.y * Math.cos(r) };
  const ol = Math.hypot(o.x, o.y) || 1;
  const dist = pen + size;
  const at = { x: cs.x + c.x + (o.x / ol) * dist, y: cs.y + c.y + (o.y / ol) * dist };
  let angle = (Math.atan2(-(ce.y - cs.y), ce.x - cs.x) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle <= -90) angle += 180;
  const items: Node[] = [
    list("type", sym(type)),
    list("layer", str(d.layer)),
    list("uuid", str(id)),
    list("pts", list("xy", r6(d.start.x), r6(d.start.y)), list("xy", r6(d.end.x), r6(d.end.y))),
    list("height", r6(d.height)),
  ];
  if (d.orthogonal) items.push(list("orientation", d.vertical ? 1 : 0));
  items.push(
    list("format", list("prefix", str("")), list("suffix", str("")), list("units", 2), list("units_format", 1), list("precision", d.precision ?? 2)),
    list("style", list("thickness", 0.1), list("arrow_length", 1.27), list("text_position_mode", 0), list("arrow_direction", sym("outward")), list("extension_height", 0.58642), list("extension_offset", 0.5), list("keep_text_aligned", sym("yes"))),
    list("gr_text", str(text), list("at", r6(at.x), r6(at.y), r6(angle)), list("layer", str(d.layer)), list("uuid", str(newBoardUuid())), list("effects", list("font", list("size", size, size), list("thickness", pen)))),
  );
  insertBoardItem(root, list("dimension", ...items));
  return id;
}

/**
 * A teardrop as KiCad stores one: a zone named $teardrop_padvia$ with the
 * teardrop attribute, connecting solid, filled with its own outline.
 */
export function addTeardropZone(root: List, t: { net: string; layer: string; outline: Point[]; priority: number }): string {
  const id = newBoardUuid();
  const pts = () => list("pts", ...t.outline.map((p) => list("xy", r6(p.x), r6(p.y))));
  const items: Node[] = [];
  if (t.net) items.push(netNode(root, t.net));
  if (findChildren(root, "net").length) items.push(list("net_name", str(t.net)));
  items.push(
    list("layer", str(t.layer)),
    list("uuid", str(id)),
    list("name", str("$teardrop_padvia$")),
    list("hatch", sym("full"), 0.1),
    list("priority", t.priority),
    list("attr", list("teardrop", list("type", sym("padvia")))),
    list("connect_pads", sym("yes"), list("clearance", 0)),
    list("min_thickness", 0.0254),
    list("filled_areas_thickness", sym("no")),
    list("fill", sym("yes"), list("thermal_gap", 0.5), list("thermal_bridge_width", 0.5), list("island_removal_mode", 1), list("island_area_min", 10)),
    list("polygon", pts()),
    list("filled_polygon", list("layer", str(t.layer)), pts()),
  );
  insertBoardItem(root, list("zone", ...items));
  return id;
}

/** Remove every teardrop zone; returns how many. */
export function removeTeardrops(root: List): number {
  let n = 0;
  for (const z of findChildren(root, "zone")) {
    const attr = findChild(z, "attr");
    const uuid = arg(findChild(z, "uuid") ?? z, 0);
    if (attr && findChild(attr, "teardrop") && uuid && deleteBoardItem(root, String(uuid))) n++;
  }
  return n;
}

/** A copper zone outline (unfilled: refill to compute its copper). Defaults are KiCad's. */
export function addZone(root: List, z: NewZone): string {
  const id = newBoardUuid();
  const items: Node[] = [];
  if (z.net) items.push(netNode(root, z.net));
  if (findChildren(root, "net").length) items.push(list("net_name", str(z.net)));
  items.push(z.layers.length === 1 ? list("layer", str(z.layers[0]!)) : list("layers", ...z.layers.map((l) => str(l))));
  items.push(list("uuid", str(id)));
  if (z.name) items.push(list("name", str(z.name)));
  items.push(list("hatch", sym("edge"), 0.5));
  if (z.priority) items.push(list("priority", z.priority));
  items.push(
    list("connect_pads", list("clearance", z.clearance ?? (z.keepout ? 0 : 0.5))),
    list("min_thickness", z.minThickness ?? 0.25),
    list("filled_areas_thickness", sym("no")),
    ...(z.keepout
      ? [list("keepout", ...(["tracks", "vias", "pads", "copperpour", "footprints"] as const).map((k) => list(k, sym(z.keepout![k] ? "not_allowed" : "allowed"))))]
      : []),
    list("fill", list("thermal_gap", z.thermalGap ?? 0.5), list("thermal_bridge_width", z.thermalWidth ?? 0.5)),
    list("polygon", list("pts", ...z.outline.map((p) => list("xy", r6(p.x), r6(p.y))))),
  );
  insertBoardItem(root, list("zone", ...items));
  return id;
}

/** Change a zone's net and/or copper layer. Its old fill no longer applies, so it is dropped. */
export function setZoneProps(root: List, zone: List, p: { net?: string; layer?: string; connect?: "thermal" | "solid" | "none" | "tht" }): void {
  if (p.connect !== undefined) {
    // KiCad: (connect_pads [yes | no | thru_hole_only] (clearance …)); no keyword is thermal reliefs.
    let cp = findChild(zone, "connect_pads");
    if (!cp) insertAt(zone, zone.children.length, (cp = list("connect_pads", list("clearance", 0.5))));
    const mode = cp.children.slice(1).find((c) => isAtom(c));
    if (mode) removeChild(cp, mode);
    const word = { solid: "yes", none: "no", tht: "thru_hole_only", thermal: undefined }[p.connect];
    if (word) insertAt(cp, 1, sym(word));
  }
  if (p.net !== undefined) {
    const old = findChild(zone, "net");
    const fresh = netNode(root, p.net);
    if (old) setArg(old, 0, fresh.children[1] as Parameters<typeof setArg>[2]);
    else insertAt(zone, 1, fresh);
    const name = findChild(zone, "net_name");
    if (name) setArg(name, 0, str(p.net));
  }
  if (p.layer !== undefined) {
    // Single-layer zones only; multi-layer zones keep their layer set.
    const layer = findChild(zone, "layer");
    if (layer) setArg(layer, 0, str(p.layer));
  }
  for (const f of findChildren(zone, "filled_polygon")) removeChild(zone, f);
}

/** Reposition a board graphic's defining points (rect / line: start, end · circle: center, end). */
export function setGraphicPoints(node: List, points: Point[]): void {
  const keys = headOf(node) === "gr_circle" ? ["center", "end"] : ["start", "end"];
  keys.forEach((k, i) => {
    const n = findChild(node, k);
    if (n && points[i]) setXY(n, points[i]!);
  });
}

/** The outline of a rectangle with rounded corners, as KiCad draws one: four lines and four arcs. */
export function roundedRectShapes(a: Point, b: Point, radius: number, layer: string, width: number): NewBoardShape[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  if (r <= 0) return [{ kind: "rect", points: [{ x: x0, y: y0 }, { x: x1, y: y1 }], layer, width }];
  const k = r * (1 - Math.SQRT1_2);
  const line = (p: Point, q: Point): NewBoardShape => ({ kind: "line", points: [p, q], layer, width });
  const arc = (p: Point, m: Point, q: Point): NewBoardShape => ({ kind: "arc", points: [p, m, q], layer, width });
  return [
    line({ x: x0 + r, y: y0 }, { x: x1 - r, y: y0 }),
    arc({ x: x1 - r, y: y0 }, { x: x1 - k, y: y0 + k }, { x: x1, y: y0 + r }),
    line({ x: x1, y: y0 + r }, { x: x1, y: y1 - r }),
    arc({ x: x1, y: y1 - r }, { x: x1 - k, y: y1 - k }, { x: x1 - r, y: y1 }),
    line({ x: x1 - r, y: y1 }, { x: x0 + r, y: y1 }),
    arc({ x: x0 + r, y: y1 }, { x: x0 + k, y: y1 - k }, { x: x0, y: y1 - r }),
    line({ x: x0, y: y1 - r }, { x: x0, y: y0 + r }),
    arc({ x: x0, y: y0 + r }, { x: x0 + k, y: y0 + k }, { x: x0 + r, y: y0 }),
  ];
}

export interface NewBoardText {
  text: string;
  at: Point;
  layer: string;
  /** Glyph height (mm); width follows. */
  size?: number;
  thickness?: number;
  angle?: number;
}

/** A board text (gr_text); text on a back layer is mirrored so it reads correctly from below. */
export function addBoardText(root: List, t: NewBoardText): string {
  const id = newBoardUuid();
  const size = t.size ?? 1;
  const effects: Node[] = [list("font", list("size", size, size), list("thickness", t.thickness ?? Math.round(size * 0.15 * 1000) / 1000))];
  if (t.layer.startsWith("B.")) effects.push(list("justify", sym("mirror")));
  insertBoardItem(root, list("gr_text", str(t.text), list("at", r6(t.at.x), r6(t.at.y), t.angle ?? 0), list("layer", str(t.layer)), list("uuid", str(id)), list("effects", ...effects)));
  return id;
}

/** Change a board text's content, size or layer (moving to the back mirrors it). */
export function setBoardText(node: List, p: { text?: string; size?: number; layer?: string }): void {
  if (p.text !== undefined) setArg(node, 0, str(p.text));
  const effects = findChild(node, "effects");
  const font = effects && findChild(effects, "font");
  if (p.size !== undefined && font) {
    const size = findChild(font, "size");
    if (size) {
      setArg(size, 0, p.size);
      setArg(size, 1, p.size);
    }
    const th = findChild(font, "thickness");
    if (th) setArg(th, 0, Math.round(p.size * 0.15 * 1000) / 1000);
  }
  if (p.layer !== undefined) {
    const layer = findChild(node, "layer");
    if (layer) setArg(layer, 0, str(p.layer));
    if (effects) {
      const back = p.layer.startsWith("B.");
      let justify = findChild(effects, "justify");
      const mirrored = !!justify?.children.some((c) => isAtom(c) && c.raw === "mirror");
      if (back && !mirrored) {
        if (justify) insertAt(justify, justify.children.length, sym("mirror"));
        else insertAt(effects, effects.children.length, (justify = list("justify", sym("mirror"))));
      } else if (!back && mirrored && justify) {
        const m = justify.children.find((c) => isAtom(c) && c.raw === "mirror")!;
        justify.children.splice(justify.children.indexOf(m), 1);
        if (justify.children.length === 1) removeChild(effects, justify);
      }
    }
  }
}

/**
 * Set the number of copper layers (2, 4, 6 …), as KiCad's Board Setup does: inner layers
 * In1.Cu … are listed between F.Cu and B.Cu (ids 4, 6, …), and a stackup, when the board has
 * one, is rebuilt with prepreg outside and cores inside, keeping the board thickness. Fewer
 * layers are refused while anything sits on a layer that would go. Returns an error, if any.
 */
export function setCopperLayerCount(root: List, count: number): string | undefined {
  if (count < 2 || count > 32 || count % 2) return "The copper layer count must be even, from 2 to 32";
  const layers = findChild(root, "layers");
  if (!layers) return "The board has no layer table";
  const copper = layers.children.filter((c): c is List => isList(c) && /\.Cu$/.test(String(arg(c, 0) ?? "")));
  const inner = (k: number) => `In${k}.Cu`;
  const wanted = ["F.Cu", ...Array.from({ length: count - 2 }, (_, k) => inner(k + 1)), "B.Cu"];
  const going = copper.map((c) => String(arg(c, 0))).filter((n) => !wanted.includes(n));
  if (going.length) {
    // Anything but the layer table and the stackup naming a layer that goes keeps it.
    let used: string | undefined;
    for (const c of root.children) {
      if (!isList(c) || ["layers", "setup"].includes(headOf(c) ?? "")) continue;
      walk(c, (n) => {
        for (const a of n.children) if (!used && isAtom(a) && going.includes(atomValue(a))) used = atomValue(a);
      });
      if (used) return `${used} still has copper on it: move or delete it first`;
    }
  }
  // The copper entries, in KiCad's order and ids, keeping each existing layer's type and user name.
  const old = new Map(copper.map((c) => [String(arg(c, 0)), c]));
  const id = (name: string) => (name === "F.Cu" ? 0 : name === "B.Cu" ? 2 : 2 + 2 * Number(name.slice(2, -3)));
  const fresh = wanted.map((name) => {
    const was = old.get(name);
    if (was) {
      was.children[0] = num(id(name));
      return was;
    }
    return { ...list("x", str(name), sym("signal")), children: [num(id(name)), str(name), sym("signal")] } as List;
  });
  const at = layers.children.indexOf(copper[0]!);
  for (const c of copper) removeChild(layers, c);
  fresh.forEach((c, k) => insertAt(layers, at + k, c));
  const stackup = findChild(findChild(root, "setup") ?? list("setup"), "stackup");
  if (stackup) rebuildStackup(root, stackup, wanted);
  return undefined;
}

const atomValue = (n: Node) => (isAtom(n) ? n.raw.replace(/^"|"$/g, "") : "");

function rebuildStackup(root: List, stackup: List, copper: string[]): void {
  const thickness = Number(arg(findChild(findChild(root, "general") ?? list("general"), "thickness"), 0) ?? 1.6);
  const entries = stackup.children.filter((c): c is List => isList(c) && headOf(c) === "layer");
  const name = (c: List) => String(arg(c, 0) ?? "");
  const top = entries.filter((c) => ["F.SilkS", "F.Paste", "F.Mask"].includes(name(c)));
  const bottom = entries.filter((c) => ["B.Mask", "B.Paste", "B.SilkS"].includes(name(c)));
  const masks = [...top, ...bottom].reduce((t, c) => t + Number(arg(findChild(c, "thickness"), 0) ?? 0), 0);
  const cu = 0.035;
  const gaps = copper.length - 1;
  // Prepreg next to the outer layers, cores between the inner pairs (KiCad's default build-up).
  const kinds = Array.from({ length: gaps }, (_, k) => (gaps === 1 ? "core" : k % 2 === 0 ? "prepreg" : "core"));
  const prepreg = gaps === 1 ? 0 : 0.1;
  const cores = kinds.filter((k) => k === "core").length;
  const core = Math.max(0.1, (thickness - masks - cu * copper.length - prepreg * kinds.filter((k) => k === "prepreg").length) / cores);
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const middle: List[] = [];
  copper.forEach((l, k) => {
    middle.push(list("layer", str(l), list("type", str("copper")), list("thickness", num(cu))));
    if (k < gaps) middle.push(list("layer", str(`dielectric ${k + 1}`), list("type", str(kinds[k]!)), list("thickness", num(r4(kinds[k] === "core" ? core : prepreg))), list("material", str("FR4")), list("epsilon_r", num(4.5)), list("loss_tangent", num(0.02))));
  });
  // Mask, paste and silk stay; the copper and dielectric entries between them are replaced.
  const first = stackup.children.indexOf(entries.find((c) => !top.includes(c)) ?? entries[0]!);
  for (const c of entries) if (!top.includes(c) && !bottom.includes(c)) removeChild(stackup, c);
  const from = top.length ? stackup.children.indexOf(top.at(-1)!) + 1 : Math.max(1, first);
  middle.forEach((c, k) => insertAt(stackup, from + k, c));
}

export interface StackupSpec {
  /** Copper thickness per copper layer, front to back (mm). */
  copper: number[];
  /** Between each pair of copper layers, front to back. */
  dielectrics: Array<{ type: "core" | "prepreg"; thickness: number; material: string; epsilonR: number; lossTangent?: number }>;
  mask?: number;
}

/** A fab's published build-ups, as stackups for the board. */
export const STACKUPS: Record<string, StackupSpec> = {
  // JLCPCB's default 4-layer 1.6 mm build (their impedance calculator's JLC04161H-7628).
  "JLC04161H-7628": {
    copper: [0.035, 0.0152, 0.0152, 0.035],
    dielectrics: [
      { type: "prepreg", thickness: 0.2104, material: "7628", epsilonR: 4.4 },
      { type: "core", thickness: 1.065, material: "FR4", epsilonR: 4.6 },
      { type: "prepreg", thickness: 0.2104, material: "7628", epsilonR: 4.4 },
    ],
  },
};

/**
 * Write the board's stackup (KiCad's Board Setup › Physical Stackup): silkscreen, paste and mask
 * on each side, the copper and dielectric layers between, and the board thickness as their sum.
 * The copper layer count must already match.
 */
export function setStackup(root: List, spec: StackupSpec): string | undefined {
  const copper = (findChild(root, "layers")?.children ?? []).filter((c): c is List => isList(c) && /\.Cu$/.test(String(arg(c, 0) ?? ""))).map((c) => String(arg(c, 0)));
  if (copper.length !== spec.copper.length) return `The stackup has ${spec.copper.length} copper layers; the board has ${copper.length}`;
  let setup = findChild(root, "setup");
  if (!setup) {
    const layers = findChild(root, "layers")!;
    insertAt(root, root.children.indexOf(layers) + 1, (setup = list("setup")));
  }
  const old = findChild(setup, "stackup");
  if (old) removeChild(setup, old);
  const mask = spec.mask ?? 0.01;
  const item = (name: string, type: string, ...rest: List[]) => list("layer", str(name), list("type", str(type)), ...rest);
  const entries: List[] = [item("F.SilkS", "Top Silk Screen"), item("F.Paste", "Top Solder Paste"), item("F.Mask", "Top Solder Mask", list("thickness", num(mask)))];
  copper.forEach((l, k) => {
    entries.push(item(l, "copper", list("thickness", num(spec.copper[k]!))));
    const d = spec.dielectrics[k];
    if (d) entries.push(item(`dielectric ${k + 1}`, d.type, list("thickness", num(d.thickness)), list("material", str(d.material)), list("epsilon_r", num(d.epsilonR)), list("loss_tangent", num(d.lossTangent ?? 0.02))));
  });
  entries.push(item("B.Mask", "Bottom Solder Mask", list("thickness", num(mask))), item("B.Paste", "Bottom Solder Paste"), item("B.SilkS", "Bottom Silk Screen"));
  const stackup = list("stackup", ...entries, list("copper_finish", str("None")), list("dielectric_constraints", sym("no")));
  insertAt(setup, 1, stackup);
  const total = Math.round((spec.copper.reduce((a, b) => a + b, 0) + spec.dielectrics.reduce((a, d) => a + d.thickness, 0) + 2 * mask) * 1e4) / 1e4;
  const general = findChild(root, "general");
  const th = general && findChild(general, "thickness");
  if (th) setArg(th, 0, num(total));
  return undefined;
}
/**
 * Schematic editing on the syntax tree of a .kicad_sch file.
 *
 * Each operation changes only the nodes it touches, so a saved file differs
 * from the original by exactly the edit (byte-identical elsewhere), and
 * KiCad opens it as if the change had been made in KiCad. New items use
 * KiCad's own layout and fresh UUIDs.
 */
import {
  arg,
  findChild,
  findChildren,
  format,
  headOf,
  insertAt,
  isAtom,
  isList,
  list,
  num,
  parse,
  removeChild,
  serialize,
  setArg,
  str,
  sym,
  type Document,
  type List,
} from "@crossprobe/kicad-sexpr";
import type { Point } from "./geometry.js";

export type NewLabelKind = "label" | "global_label" | "hierarchical_label";

/** The `(kicad_sch …)` root of a parsed sheet file. */
export function sheetRoot(doc: Document): List {
  const root = doc.children.find((c): c is List => isList(c) && headOf(c) === "kicad_sch");
  if (!root) throw new Error("Not a KiCad schematic");
  return root;
}

const uuidOf = (node: List) => String(arg(findChild(node, "uuid"), 0) ?? "");

/** A top-level item (symbol, wire, label, junction, …) by its UUID. */
export function findItem(root: List, uuid: string): List | undefined {
  return root.children.find((c): c is List => isList(c) && uuidOf(c) === uuid);
}

/** KiCad schematic coordinates are 100 nm units: keep edits on that grid. */
const snapIU = (v: number) => Math.round(v * 1e4) / 1e4;

function shiftAt(node: List | undefined, dx: number, dy: number) {
  if (!node) return;
  setArg(node, 0, snapIU(Number(arg(node, 0) ?? 0) + dx));
  setArg(node, 1, snapIU(Number(arg(node, 1) ?? 0) + dy));
}

/** Move an item by (dx, dy) mm, including its fields, pins and points. */
export function moveItem(node: List, dx: number, dy: number): void {
  switch (headOf(node)) {
    case "wire":
    case "bus":
    case "polyline":
      for (const xy of findChildren(findChild(node, "pts") ?? node, "xy")) shiftAt(xy, dx, dy);
      return;
    case "rectangle":
      shiftAt(findChild(node, "start"), dx, dy);
      shiftAt(findChild(node, "end"), dx, dy);
      return;
    case "circle":
      shiftAt(findChild(node, "center"), dx, dy);
      return;
    case "arc":
      for (const k of ["start", "mid", "end"]) shiftAt(findChild(node, k), dx, dy);
      return;
    default:
      shiftAt(findChild(node, "at"), dx, dy);
      // Symbol and sheet fields, and sheet pins, are stored in sheet coordinates.
      for (const p of findChildren(node, "property")) shiftAt(findChild(p, "at"), dx, dy);
      if (headOf(node) === "sheet") for (const p of findChildren(node, "pin")) shiftAt(findChild(p, "at"), dx, dy);
  }
}

/**
 * Rotate a symbol (or label) 90° counter-clockwise about its anchor, as
 * KiCad's R does. Field positions rotate with it.
 */
export function rotateItem(node: List): void {
  const at = findChild(node, "at");
  if (!at) return;
  const x = Number(arg(at, 0));
  const y = Number(arg(at, 1));
  const a = (Number(arg(at, 2) ?? 0) + 90) % 360;
  setArg(at, 2, a);
  for (const p of findChildren(node, "property")) {
    const pa = findChild(p, "at");
    if (!pa) continue;
    // Counter-clockwise on screen with Y pointing down.
    const dx = Number(arg(pa, 0)) - x;
    const dy = Number(arg(pa, 1)) - y;
    setArg(pa, 0, snapIU(x + dy));
    setArg(pa, 1, snapIU(y - dx));
  }
}

/** Mirror a symbol about its horizontal ("x") or vertical ("y") axis, as KiCad's X/Y keys do. */
export function mirrorSymbol(node: List, axis: "x" | "y"): void {
  const at = findChild(node, "at");
  if (!at || headOf(node) !== "symbol") return;
  const x = Number(arg(at, 0));
  const y = Number(arg(at, 1));
  const mirror = findChild(node, "mirror");
  const current = mirror ? String(arg(mirror, 0)) : "";
  // Mirroring twice on the same axis cancels; KiCad stores one mirror axis.
  if (current === axis) removeChild(node, mirror!);
  else if (mirror) setArg(mirror, 0, sym(axis));
  else insertAt(node, node.children.indexOf(at) + 1, list("mirror", axis));
  for (const p of findChildren(node, "property")) {
    const pa = findChild(p, "at");
    if (!pa) continue;
    if (axis === "x") setArg(pa, 1, snapIU(2 * y - Number(arg(pa, 1))));
    else setArg(pa, 0, snapIU(2 * x - Number(arg(pa, 0))));
  }
}

/** The flags of a placed symbol, in the order KiCad writes them. */
const SYMBOL_FLAGS = ["unit", "body_style", "convert", "exclude_from_sim", "in_bom", "on_board", "in_pos_files", "dnp"];

/** Set a child like `(dnp yes)` of a placed symbol, adding it where KiCad writes it. */
function setSymbolChild(node: List, head: string, value: number | ReturnType<typeof sym>): void {
  const f = findChild(node, head);
  if (f) return void setArg(f, 0, value);
  const before = SYMBOL_FLAGS.slice(0, SYMBOL_FLAGS.indexOf(head)).reverse().map((h) => findChild(node, h)).find(Boolean) ?? findChild(node, "at");
  insertAt(node, before ? node.children.indexOf(before) + 1 : node.children.length, list(head, value));
}

/** Set a placed symbol's flags (each only when given): do not populate, in the BOM, on the board, left out of simulation. */
export function setSymbolAttributes(node: List, a: { dnp?: boolean; inBom?: boolean; onBoard?: boolean; excludeFromSim?: boolean }): void {
  const set = (head: string, on: boolean) => setSymbolChild(node, head, sym(on ? "yes" : "no"));
  if (a.excludeFromSim !== undefined) set("exclude_from_sim", a.excludeFromSim);
  if (a.inBom !== undefined) set("in_bom", a.inBom);
  if (a.onBoard !== undefined) set("on_board", a.onBoard);
  if (a.dnp !== undefined) set("dnp", a.dnp);
}

/**
 * Switch a placed symbol to another body style (1 = the first, 2 = De Morgan or the second named style).
 * `fileVersion` is the sheet file's `(version …)`: files from before KiCad 10 call it `convert`.
 */
export function setSymbolBodyStyle(node: List, style: number, fileVersion = Infinity): void {
  const old = findChild(node, "convert");
  if (old && !findChild(node, "body_style")) {
    if (style === 1) removeChild(node, old);
    else setArg(old, 0, style);
  } else if (fileVersion >= 20250827) setSymbolChild(node, "body_style", style);
  else if (style !== 1) setSymbolChild(node, "convert", style);
}

/** Switch a placed symbol's pin to one of its alternate functions by name; `undefined` is the pin's own function. */
export function setPinAlternate(node: List, pin: string, alternate: string | undefined): void {
  let p = findChildren(node, "pin").find((c) => arg(c, 0) === pin);
  if (!p) {
    if (alternate === undefined) return;
    p = list("pin", str(pin), list("uuid", str(newUuid())));
    const pins = findChildren(node, "pin");
    const after = pins[pins.length - 1] ?? findChildren(node, "property").pop();
    insertAt(node, after ? node.children.indexOf(after) + 1 : node.children.length, p);
  }
  const a = findChild(p, "alternate");
  if (alternate === undefined) {
    if (a) removeChild(p, a);
  } else if (a) setArg(a, 0, str(alternate));
  else insertAt(p, p.children.length, list("alternate", str(alternate)));
}

/** A field of a placed symbol, once it is placed by hand: KiCad no longer lays the fields out itself. */
function ownField(node: List, name: string): List | undefined {
  const prop = findChildren(node, "property").find((p) => arg(p, 0) === name);
  const auto = findChild(node, "fields_autoplaced");
  if (prop && auto) removeChild(node, auto);
  return prop;
}

/** Move one field of a placed symbol by (dx, dy) mm. */
export function moveField(node: List, name: string, dx: number, dy: number): void {
  const field = ownField(node, name);
  if (field) shiftAt(findChild(field, "at"), dx, dy);
}

/** Turn one field of a placed symbol between horizontal and vertical. */
export function rotateField(node: List, name: string): void {
  const field = ownField(node, name);
  const at = field && findChild(field, "at");
  if (at) setArg(at, 2, (Number(arg(at, 2) ?? 0) % 180 === 0 ? 90 : 0));
}

/** Show or hide a field of a placed symbol on the sheet. */
export function setFieldVisible(node: List, name: string, visible: boolean): void {
  const prop = findChildren(node, "property").find((p) => arg(p, 0) === name);
  if (!prop) return;
  let effects = findChild(prop, "effects");
  if (!effects) {
    if (visible) return;
    effects = list("effects", list("font", list("size", 1.27, 1.27)));
    insertAt(prop, prop.children.length, effects);
  }
  // Older files write a bare `hide`; newer ones `(hide yes)`.
  const bare = effects.children.find((c) => isAtom(c) && c.raw === "hide");
  const hide = findChild(effects, "hide");
  if (visible) {
    if (bare) removeChild(effects, bare);
    if (hide) removeChild(effects, hide);
  } else if (hide) setArg(hide, 0, sym("yes"));
  else if (!bare) insertAt(effects, effects.children.length, list("hide", sym("yes")));
}

/**
 * Set a symbol field. Changing the Reference also updates the per-instance
 * reference for `sheetPath`, which is what KiCad actually uses.
 */
export function setSymbolField(node: List, name: string, value: string, sheetPath?: string): void {
  const props = findChildren(node, "property");
  const prop = props.find((p) => arg(p, 0) === name);
  if (prop) {
    setArg(prop, 1, str(value));
  } else {
    // New fields are added hidden, at the symbol's position, like KiCad does.
    const at = findChild(node, "at");
    const field = list(
      "property",
      str(name),
      str(value),
      list("at", Number(arg(at, 0) ?? 0), Number(arg(at, 1) ?? 0), 0),
      list("effects", list("font", list("size", 1.27, 1.27)), list("hide", "yes")),
    );
    const last = props[props.length - 1];
    insertAt(node, last ? node.children.indexOf(last) + 1 : node.children.length, field);
  }
  if (name === "Reference" && sheetPath) {
    for (const project of findChildren(findChild(node, "instances") ?? node, "project")) {
      for (const path of findChildren(project, "path")) {
        if (arg(path, 0) === sheetPath) {
          const ref = findChild(path, "reference");
          if (ref) setArg(ref, 0, str(value));
        }
      }
    }
  }
}

export function deleteItem(root: List, uuid: string): boolean {
  const node = findItem(root, uuid);
  return node ? removeChild(root, node) : false;
}

export function newUuid(): string {
  return globalThis.crypto.randomUUID();
}

/** Insert a new top-level item next to others of its kind (KiCad re-sorts on save anyway). */
function insertTopLevel(root: List, item: List): void {
  const head = headOf(item);
  let index = -1;
  root.children.forEach((c, i) => {
    if (headOf(c) === head) index = i;
  });
  if (index < 0) {
    // Before the first symbol / sheet / instance table, else at the end.
    index = root.children.findIndex((c) => ["symbol", "sheet", "sheet_instances", "embedded_fonts"].includes(headOf(c) ?? "")) - 1;
    if (index < -1) index = root.children.length - 1;
  }
  insertAt(root, index + 1, format(item, "\t"), "");
}

const xy = (p: Point) => list("xy", snapIU(p.x), snapIU(p.y));

/** Add wire segments through `points` (consecutive pairs). Returns the new UUIDs. */
/**
 * Where a wire's end lands on the middle of another wire, a junction joins
 * them; KiCad's editor adds it automatically, so we do too.
 */
function autoJunctions(root: List, fresh: Array<[Point, Point]>): void {
  const segs: Array<[Point, Point]> = [];
  const junctions: Point[] = [];
  for (const c of root.children) {
    if (!isList(c)) continue;
    const h = headOf(c);
    if (h === "wire") {
      const pts = findChild(c, "pts");
      const xys = pts ? findChildren(pts, "xy").map((n) => ({ x: Number(arg(n, 0)), y: Number(arg(n, 1)) })) : [];
      if (xys.length === 2) segs.push([xys[0]!, xys[1]!]);
    } else if (h === "junction") {
      const at = findChild(c, "at");
      if (at) junctions.push({ x: Number(arg(at, 0)), y: Number(arg(at, 1)) });
    }
  }
  const same = (p: Point, q: Point) => Math.abs(p.x - q.x) < 1e-4 && Math.abs(p.y - q.y) < 1e-4;
  const inside = (p: Point, [a, b]: [Point, Point]) => {
    if (same(p, a) || same(p, b)) return false;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) > 1e-6) return false;
    return p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6 && p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6;
  };
  const isFresh = (s: [Point, Point]) => fresh.some((f) => same(f[0], s[0]) && same(f[1], s[1]));
  const wanted: Point[] = [];
  for (const f of fresh) {
    // A new end on an old wire's middle, or an old end on the new wire's middle.
    for (const end of f) if (segs.some((s) => !isFresh(s) && inside(end, s))) wanted.push(end);
    for (const s of segs) if (!isFresh(s)) for (const end of s) if (inside(end, f)) wanted.push(end);
  }
  for (const p of wanted) {
    if (junctions.some((j) => same(j, p))) continue;
    junctions.push(p);
    addJunction(root, p);
  }
}

export function addWire(root: List, points: Point[]): string[] {
  const ids: string[] = [];
  const fresh: Array<[Point, Point]> = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.x === b.x && a.y === b.y) continue;
    const id = newUuid();
    insertTopLevel(root, list("wire", list("pts", xy(a), xy(b)), list("stroke", list("width", 0), list("type", "default")), list("uuid", str(id))));
    ids.push(id);
    fresh.push([a, b]);
  }
  autoJunctions(root, fresh);
  return ids;
}

/** A bus (a polyline of segments, like a wire), as KiCad writes them. */
export function addBus(root: List, points: Point[]): string[] {
  const ids: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.x === b.x && a.y === b.y) continue;
    const id = newUuid();
    insertTopLevel(root, list("bus", list("pts", xy(a), xy(b)), list("stroke", list("width", 0), list("type", "default")), list("uuid", str(id))));
    ids.push(id);
  }
  return ids;
}

/**
 * A bus entry: the short diagonal from a bus to a member wire, from `at` to `at + size`
 * (KiCad's is 2.54 mm each way; the signs pick which way it leans).
 */
export function addBusEntry(root: List, at: Point, size: Point = { x: 2.54, y: 2.54 }): string {
  const id = newUuid();
  insertTopLevel(root, list("bus_entry", list("at", snapIU(at.x), snapIU(at.y)), list("size", size.x, size.y), list("stroke", list("width", 0), list("type", "default")), list("uuid", str(id))));
  return id;
}

const strokeFill = (o: { dash?: boolean; fill?: "none" | "outline" | "background" }) => [
  list("stroke", list("width", 0), list("type", o.dash ? "dash" : "default")),
  list("fill", list("type", o.fill ?? "none")),
];

/** Schematic text (KiCad's Text tool), 1.27 mm unless given; angle 0 or 90. */
export function addSchText(root: List, text: string, at: Point, o: { size?: number; angle?: number } = {}): string {
  const id = newUuid();
  const s = o.size ?? 1.27;
  insertTopLevel(root, list("text", str(text), list("exclude_from_sim", "no"), list("at", snapIU(at.x), snapIU(at.y), o.angle ?? 0), list("effects", list("font", list("size", s, s)), list("justify", "left", "bottom")), list("uuid", str(id))));
  return id;
}

/** A text box from corner a to corner b (KiCad's Text Box tool). */
export function addSchTextBox(root: List, text: string, a: Point, b: Point, o: { size?: number } = {}): string {
  const id = newUuid();
  const s = o.size ?? 1.27;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  insertTopLevel(
    root,
    list(
      "text_box",
      str(text),
      list("exclude_from_sim", "no"),
      list("at", snapIU(x), snapIU(y), 0),
      list("size", snapIU(Math.abs(b.x - a.x)), snapIU(Math.abs(b.y - a.y))),
      list("margins", 0.9525, 0.9525, 0.9525, 0.9525),
      list("stroke", list("width", 0), list("type", "default")),
      list("fill", list("type", "none")),
      list("effects", list("font", list("size", s, s)), list("justify", "left", "top")),
      list("uuid", str(id)),
    ),
  );
  return id;
}

export type SchGraphic = { kind: "polyline"; points: Point[] } | { kind: "rectangle"; points: [Point, Point] } | { kind: "circle"; points: [Point, Point] };

/** A drawing: lines (a polyline), a rectangle (two corners) or a circle (centre, a point on it). */
export function addSchGraphic(root: List, g: SchGraphic, o: { dash?: boolean; fill?: "none" | "outline" | "background" } = {}): string {
  const id = newUuid();
  const P = (p: Point) => [snapIU(p.x), snapIU(p.y)] as const;
  let node: List;
  if (g.kind === "polyline") node = list("polyline", list("pts", ...g.points.map((p) => xy(p))), ...strokeFill(o), list("uuid", str(id)));
  else if (g.kind === "rectangle") node = list("rectangle", list("start", ...P(g.points[0])), list("end", ...P(g.points[1])), ...strokeFill(o), list("uuid", str(id)));
  else {
    const [c, e] = g.points;
    node = list("circle", list("center", ...P(c)), list("radius", snapIU(Math.hypot(e.x - c.x, e.y - c.y))), ...strokeFill(o), list("uuid", str(id)));
  }
  insertTopLevel(root, node);
  return id;
}

/** Change the text of a label, text or text box. */
export function setItemText(node: List, text: string): void {
  setArg(node, 0, str(text));
}

export function addJunction(root: List, at: Point): string {
  const id = newUuid();
  insertTopLevel(root, list("junction", list("at", snapIU(at.x), snapIU(at.y)), list("diameter", 0), list("color", 0, 0, 0, 0), list("uuid", str(id))));
  return id;
}

export function addNoConnect(root: List, at: Point): string {
  const id = newUuid();
  insertTopLevel(root, list("no_connect", list("at", snapIU(at.x), snapIU(at.y)), list("uuid", str(id))));
  return id;
}

export type LabelShape = "input" | "output" | "bidirectional" | "tri_state" | "passive";

/**
 * Add a net label. `angle` 0 reads left-to-right with the anchor at the left.
 * A global label gets the hidden field KiCad lists its other sheets in.
 */
export function addLabel(root: List, kind: NewLabelKind, text: string, at: Point, angle = 0, shape: LabelShape = "bidirectional"): string {
  const id = newUuid();
  const justify = angle === 180 || angle === 270 ? "right" : "left";
  const effects = () => list("effects", list("font", list("size", 1.27, 1.27)), list("justify", justify, ...(kind === "label" ? ["bottom"] : [])));
  const node = list(kind, str(text));
  if (kind !== "label") node.children.push(list("shape", shape));
  node.children.push(list("at", snapIU(at.x), snapIU(at.y), angle), effects(), list("uuid", str(id)));
  if (kind === "global_label") {
    const e = effects();
    e.children.push(list("hide", sym("yes")));
    node.children.push(list("property", str("Intersheetrefs"), str("${INTERSHEET_REFS}"), list("at", snapIU(at.x), snapIU(at.y), 0), e));
  }
  insertTopLevel(root, node);
  return id;
}

/** Change the shape (signal direction) of a global or hierarchical label, or of a sheet pin. */
export function setLabelShape(node: List, shape: LabelShape): void {
  const s = findChild(node, "shape");
  // A sheet pin's shape is its second argument: (pin "name" input (at …)).
  if (headOf(node) === "pin") setArg(node, 1, sym(shape));
  else if (s) setArg(s, 0, sym(shape));
  else if (headOf(node) === "global_label" || headOf(node) === "hierarchical_label") insertAt(node, 2, list("shape", sym(shape)));
}

/** Text value of a top-level item's name argument (labels), for convenience. */
export function itemText(node: List): string | undefined {
  const a = node.children[1];
  return a && isAtom(a) && a.kind === "string" ? String(arg(node, 0)) : undefined;
}

// ---------------------------------------------------------------------------
// Dragging, duplicating and placing
// ---------------------------------------------------------------------------

/** Move one end of a wire (index 0 = start, 1 = end), e.g. to follow a dragged pin. */
export function moveWirePoint(root: List, uuid: string, index: 0 | 1, to: Point): void {
  const wire = findItem(root, uuid);
  const xy = wire && findChildren(findChild(wire, "pts") ?? wire, "xy")[index];
  if (!xy) return;
  setArg(xy, 0, snapIU(to.x));
  setArg(xy, 1, snapIU(to.y));
}

/** Deep copy of a node with fresh formatting (re-parsed from its text). */
function cloneNode(node: List): List {
  return parse(serialize(node)).children[0] as List;
}

/** Give a copied item new UUIDs (its own and its pins'). */
function renewUuids(node: List): string {
  const id = newUuid();
  const own = findChild(node, "uuid");
  if (own) setArg(own, 0, str(id));
  for (const pin of findChildren(node, "pin")) {
    const u = findChild(pin, "uuid");
    if (u) setArg(u, 0, str(newUuid()));
  }
  return id;
}

/** Make sure `target` has the library symbol a placed symbol uses (copied from `source`). */
function ensureLibSymbol(target: List, source: List, libId: string): void {
  const targetLibs = findChild(target, "lib_symbols");
  if (!targetLibs) return;
  if (findChildren(targetLibs, "symbol").some((s) => arg(s, 0) === libId)) return;
  const def = findChildren(findChild(source, "lib_symbols") ?? source, "symbol").find((s) => arg(s, 0) === libId);
  if (def) insertAt(targetLibs, targetLibs.children.length, cloneNode(def), "\t");
}

/**
 * Point a placed symbol's per-instance data at `sheetPaths` (the sheet
 * instances of the file it lives in) with the given reference.
 */
function setInstances(node: List, reference: string, sheetPaths: string[], projectName?: string): void {
  const old = findChild(node, "instances");
  const project = old && findChild(old, "project");
  const name = projectName ?? (project ? String(arg(project, 0)) : "");
  const unit = Number(arg(findChild(node, "unit"), 0) ?? 1);
  const inst = list("instances", list("project", str(name), ...sheetPaths.map((p) => list("path", str(p), list("reference", str(reference)), list("unit", unit)))));
  if (old) {
    const i = node.children.indexOf(old);
    removeChild(node, old);
    insertAt(node, i, inst);
  } else insertAt(node, node.children.length, inst);
  const refProp = findChildren(node, "property").find((p) => arg(p, 0) === "Reference");
  if (refProp) setArg(refProp, 1, str(reference));
}

/**
 * Copy items from one sheet file into another (or the same one), offset by
 * (dx, dy). Symbols get the reference `references[uuid]` (when given) and
 * instance data for `sheetPaths`; their library symbol comes along.
 * Returns the new UUIDs in the same order.
 */
export function duplicateItems(
  source: List,
  target: List,
  uuids: string[],
  dx: number,
  dy: number,
  references: Record<string, string>,
  sheetPaths: string[],
  /** Project the copies belong to (instance data is keyed by it); default: keep the source's. */
  projectName?: string,
): string[] {
  const out: string[] = [];
  for (const id of uuids) {
    const node = findItem(source, id);
    if (!node) continue;
    const copy = cloneNode(node);
    const fresh = renewUuids(copy);
    moveItem(copy, dx, dy);
    if (headOf(copy) === "symbol") {
      const libId = String(arg(findChild(copy, "lib_name") ?? findChild(copy, "lib_id"), 0) ?? "");
      if (source !== target) ensureLibSymbol(target, source, libId);
      const refProp = findChildren(copy, "property").find((p) => arg(p, 0) === "Reference");
      const ref = references[id] ?? String((refProp && arg(refProp, 1)) ?? "?");
      setInstances(copy, ref, sheetPaths, projectName);
    }
    insertTopLevel(target, copy);
    out.push(fresh);
  }
  return out;
}

/**
 * Place a new symbol from a library definition (a `(symbol "Lib:Name" …)` node
 * from any sheet's lib_symbols). Fields come from the library's defaults.
 */
export function placeSymbol(
  target: List,
  libDef: List,
  opts: { at: Point; reference: string; unit?: number; sheetPaths: string[]; projectName: string },
): string {
  const libId = String(arg(libDef, 0));
  const targetLibs = findChild(target, "lib_symbols");
  if (targetLibs && !findChildren(targetLibs, "symbol").some((s) => arg(s, 0) === libId)) {
    insertAt(targetLibs, targetLibs.children.length, cloneNode(libDef), "\t");
  }
  const at = { x: snapIU(opts.at.x), y: snapIU(opts.at.y) };
  const id = newUuid();
  const node = list(
    "symbol",
    list("lib_id", str(libId)),
    list("at", at.x, at.y, 0),
    list("unit", opts.unit ?? 1),
    list("exclude_from_sim", "no"),
    list("in_bom", "yes"),
    list("on_board", "yes"),
    list("dnp", "no"),
    list("uuid", str(id)),
  );
  // Fields at the library's offsets (library Y points up).
  for (const p of findChildren(libDef, "property")) {
    const name = String(arg(p, 0));
    if (name.startsWith("ki_")) continue;
    const pa = findChild(p, "at");
    const field = cloneNode(p);
    setArg(field, 1, str(name === "Reference" ? opts.reference : String(arg(p, 1) ?? "")));
    const fa = findChild(field, "at");
    if (fa && pa) {
      setArg(fa, 0, snapIU(at.x + Number(arg(pa, 0) ?? 0)));
      setArg(fa, 1, snapIU(at.y - Number(arg(pa, 1) ?? 0)));
    }
    node.children.push(field);
  }
  // One (pin "n" (uuid …)) per library pin of the placed unit.
  const pins = new Set<string>();
  for (const unit of findChildren(libDef, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(String(arg(unit, 0)));
    const u = m ? Number(m[1]) : 0;
    if (u !== 0 && u !== (opts.unit ?? 1)) continue;
    for (const pin of findChildren(unit, "pin")) pins.add(String(arg(findChild(pin, "number"), 0) ?? ""));
  }
  for (const n of pins) node.children.push(list("pin", str(n), list("uuid", str(newUuid()))));
  node.trivia = node.children.map((_, i) => (i ? " " : ""));
  setInstances(node, opts.reference, opts.sheetPaths, opts.projectName);
  insertTopLevel(target, node);
  return id;
}

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

/** Text of a new, empty sheet file (what KiCad writes for a fresh sheet). */
export function newSheetFile(uuid = newUuid()): string {
  return [
    "(kicad_sch",
    "\t(version 20250114)",
    '\t(generator "eeschema")',
    '\t(generator_version "9.0")',
    `\t(uuid "${uuid}")`,
    '\t(paper "A4")',
    "\t(lib_symbols)",
    ")",
    "",
  ].join("\n");
}

/**
 * Add a hierarchical sheet symbol. `parentPaths` are the sheet instance
 * paths of the file it goes in; each gets a page number.
 */
export function addSheet(
  root: List,
  opts: { at: Point; size: Point; name: string; file: string; projectName: string; parentPaths: string[]; page: number },
): string {
  const id = newUuid();
  const at = { x: snapIU(opts.at.x), y: snapIU(opts.at.y) };
  const font = () => list("font", list("size", 1.27, 1.27));
  const node = list(
    "sheet",
    list("at", at.x, at.y),
    list("size", snapIU(opts.size.x), snapIU(opts.size.y)),
    list("exclude_from_sim", "no"),
    list("in_bom", "yes"),
    list("on_board", "yes"),
    list("dnp", "no"),
    list("fields_autoplaced", "yes"),
    list("stroke", list("width", 0.1524), list("type", "solid")),
    list("fill", list("color", 0, 0, 0, num("0.0000"))),
    list("uuid", str(id)),
    list("property", str("Sheetname"), str(opts.name), list("at", at.x, snapIU(at.y - 0.7116), 0), list("effects", font(), list("justify", "left", "bottom"))),
    list("property", str("Sheetfile"), str(opts.file), list("at", at.x, snapIU(at.y + opts.size.y + 0.5846), 0), list("effects", font(), list("justify", "left", "top"))),
    list(
      "instances",
      list("project", str(opts.projectName), ...opts.parentPaths.map((p, i) => list("path", str(p), list("page", str(String(opts.page + i)))))),
    ),
  );
  insertTopLevel(root, node);
  return id;
}

/**
 * Add a pin to a sheet symbol on the edge nearest `at`. Returns the pin's
 * position on the edge (snapped), where the wire should connect.
 */
export function addSheetPin(sheet: List, name: string, shape: string, at: Point): Point {
  const sAt = findChild(sheet, "at");
  const sSize = findChild(sheet, "size");
  const x0 = Number(arg(sAt, 0));
  const y0 = Number(arg(sAt, 1));
  const w = Number(arg(sSize, 0));
  const h = Number(arg(sSize, 1));
  const left = Math.abs(at.x - x0) <= Math.abs(at.x - (x0 + w));
  const pos = { x: left ? x0 : x0 + w, y: snapIU(Math.min(Math.max(at.y, y0 + 1.27), y0 + h - 1.27)) };
  const pin = list(
    "pin",
    str(name),
    shape,
    list("at", pos.x, pos.y, left ? 180 : 0),
    list("uuid", str(newUuid())),
    list("effects", list("font", list("size", 1.27, 1.27)), list("justify", left ? "left" : "right")),
  );
  const pins = findChildren(sheet, "pin");
  const after = pins[pins.length - 1] ?? findChildren(sheet, "property").pop();
  insertAt(sheet, after ? sheet.children.indexOf(after) + 1 : sheet.children.length, pin);
  return pos;
}

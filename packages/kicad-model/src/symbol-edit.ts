/**
 * Symbol editing in a symbol library (.kicad_sym), as KiCad's symbol editor writes it: new
 * symbols, pins (number, name, electrical type, shape, side, length), body graphics (rectangle,
 * polyline, circle, text), and the symbol's fields. Library symbols carry no item UUIDs (KiCad
 * doesn't accept them), so pins are named by number and graphics by their place in the symbol.
 * `layoutSymbol` draws the usual box symbol from a pin list (inputs left, outputs right, supplies
 * top, grounds bottom), on KiCad's 2.54 mm grid.
 */
import { arg, atomText, findChild, findChildren, format, headOf, insertAt, isAtom, isList, list, num, parse, removeChild, serialize, setArg, str, sym, type List } from "@crossprobe/kicad-sexpr";
import type { Point } from "./geometry.js";

import type { PinType } from "./sheet.js";
export type PinShape = "line" | "inverted" | "clock" | "inverted_clock" | "input_low" | "clock_low" | "output_low" | "edge_clock_high" | "non_logic";
export const PIN_TYPES: PinType[] = ["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"];
export const PIN_SHAPES: PinShape[] = ["line", "inverted", "clock", "inverted_clock", "input_low", "clock_low", "output_low", "edge_clock_high", "non_logic"];

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const font = () => list("effects", list("font", list("size", num(1.27), num(1.27))));

/** An empty symbol library, as KiCad 10 writes one. */
export function newSymbolLibraryText(): string {
  return `(kicad_symbol_lib\n\t(version 20251024)\n\t(generator "kicad_symbol_editor")\n\t(generator_version "10.0")\n)\n`;
}

export function symbolLibRoot(doc: { children: unknown[] }): List {
  const root = (doc.children as List[]).find((c) => isList(c) && headOf(c) === "kicad_symbol_lib");
  if (!root) throw new Error("Not a KiCad symbol library");
  return root;
}

export const findLibSymbol = (root: List, name: string) => findChildren(root, "symbol").find((s) => arg(s, 0) === name);

export interface SymbolFields {
  reference?: string;
  value?: string;
  footprint?: string;
  datasheet?: string;
  description?: string;
  keywords?: string;
  fpFilters?: string;
}

const field = (key: string, value: string, at: Point, hide: boolean, justify?: string) =>
  list("property", str(key), str(value), list("at", num(r4(at.x)), num(r4(at.y)), num(0)), ...(hide ? [list("hide", sym("yes"))] : []), justify ? list("effects", list("font", list("size", num(1.27), num(1.27))), list("justify", sym(justify))) : font());

/** A new symbol with its fields, an empty body and no pins. */
export function newSymbolNode(name: string, f: SymbolFields = {}): List {
  return list(
    "symbol",
    str(name),
    list("pin_names", list("offset", num(1.016))),
    list("exclude_from_sim", sym("no")),
    list("in_bom", sym("yes")),
    list("on_board", sym("yes")),
    field("Reference", f.reference ?? "U", { x: 0, y: 5.08 }, false),
    field("Value", f.value ?? name, { x: 0, y: -5.08 }, false),
    field("Footprint", f.footprint ?? "", { x: 0, y: 0 }, true),
    field("Datasheet", f.datasheet ?? "", { x: 0, y: 0 }, true),
    field("Description", f.description ?? "", { x: 0, y: 0 }, true),
    ...(f.keywords ? [field("ki_keywords", f.keywords, { x: 0, y: 0 }, true)] : []),
    ...(f.fpFilters ? [field("ki_fp_filters", f.fpFilters, { x: 0, y: 0 }, true)] : []),
    list("symbol", str(`${name}_0_1`)),
    list("symbol", str(`${name}_1_1`)),
    list("embedded_fonts", sym("no")),
  );
}

/** The library text with `symbol` added (replacing one of the same name). */
export function withLibrarySymbol(libText: string | undefined, symbol: List): string {
  const doc = parse(libText ?? newSymbolLibraryText());
  const root = symbolLibRoot(doc);
  const name = String(arg(symbol, 0));
  const old = findLibSymbol(root, name);
  const at = old ? root.children.indexOf(old) : root.children.length;
  if (old) removeChild(root, old);
  insertAt(root, at, format(symbol, "\t"));
  return serialize(doc);
}

/**
 * Units and body styles. A symbol's drawing is split into sub-symbols named `<name>_<unit>_<style>`:
 * unit 0 is drawn in every unit, style 0 in both body styles, style 2 is the De Morgan alternate.
 * Pins belong to a unit and, as in KiCad's synchronized pin mode, are kept the same in both body
 * styles; graphics belong to one unit and style.
 */
export interface UnitScope {
  unit: number;
  style: number;
}

/** A sub-symbol's unit and body style, from its name. */
export const subUnit = (u: List): UnitScope => {
  const m = /_(\d+)_(\d+)$/.exec(String(arg(u, 0)));
  return m ? { unit: Number(m[1]), style: Number(m[2]) } : { unit: 0, style: 0 };
};

/** The sub-symbol for a unit and body style, created (in KiCad's unit, style order) if missing. */
function unitNode(s: List, unit: number, style: number): List {
  const name = `${String(arg(s, 0))}_${unit}_${style}`;
  let u = findChildren(s, "symbol").find((c) => arg(c, 0) === name);
  if (!u) {
    u = list("symbol", str(name));
    const subs = findChildren(s, "symbol");
    const after = subs.filter((c) => {
      const k = subUnit(c);
      return k.unit < unit || (k.unit === unit && k.style < style);
    }).pop();
    const tail = s.children.findIndex((c) => isList(c) && headOf(c) === "embedded_fonts");
    insertAt(s, after ? s.children.indexOf(after) + 1 : subs.length ? s.children.indexOf(subs[0]!) : tail >= 0 ? tail : s.children.length, format(u, "\t\t"));
    u = findChildren(s, "symbol").find((c) => arg(c, 0) === name)!;
  }
  return u;
}

/** Sub-symbols drawn in `unit` (its own and unit 0's), or all of them. */
const unitSubs = (s: List, unit?: number) => findChildren(s, "symbol").filter((u) => unit === undefined || subUnit(u).unit === 0 || subUnit(u).unit === unit);
const allPins = (s: List, unit?: number) => unitSubs(s, unit).flatMap((u) => findChildren(u, "pin"));
const pinNumber = (p: List) => String(arg(findChild(p, "number"), 0) ?? "");
export const findSymPin = (s: List, number: string, unit?: number) => allPins(s, unit).find((p) => pinNumber(p) === number);
/** A pin with all its twins (the same pin in the other body style). */
const findSymPins = (s: List, number: string, unit?: number) => allPins(s, unit).filter((p) => pinNumber(p) === number);

/**
 * How many units; the body styles (2 for De Morgan, or as many as it names); unit names; whether
 * units are locked (not interchangeable); and jumpers: duplicate pin numbers joined, and groups of
 * pins joined inside the part.
 */
export function symbolUnits(s: List): {
  count: number;
  demorgan: boolean;
  styles: number;
  styleNames: string[];
  names: Record<number, string>;
  locked: boolean;
  duplicateJumpers: boolean;
  jumperGroups: string[][];
} {
  const subs = findChildren(s, "symbol").map((u) => ({ u, k: subUnit(u) }));
  const names: Record<number, string> = {};
  for (const { u, k } of subs) {
    const n = findChild(u, "unit_name");
    if (n && k.unit) names[k.unit] = String(arg(n, 0) ?? "");
  }
  const styles = findChild(s, "body_styles");
  const styleNames = styles ? styles.children.slice(1).filter((c) => isAtom(c) && c.raw !== "demorgan").map((c) => String(atomValue(c))) : [];
  const count = Math.max(1, styleNames.length, ...subs.map(({ k }) => k.style));
  const groups = findChild(s, "jumper_pin_groups");
  return {
    count: Math.max(1, ...subs.map(({ k }) => k.unit)),
    demorgan: !styleNames.length && count === 2,
    styles: count,
    styleNames,
    names,
    locked: findChildren(s, "property").some((p) => arg(p, 0) === "ki_locked"),
    duplicateJumpers: arg(findChild(s, "duplicate_pin_numbers_are_jumpers"), 0) === "yes",
    jumperGroups: groups ? groups.children.filter(isList).map((g) => g.children.map((c) => String(atomValue(c)))) : [],
  };
}

const atomValue = (c: unknown) => (isAtom(c as never) ? atomText(c as never) : "");

/** The place for a symbol-level flag, in KiCad's order (after the name, power, body styles, pin options and flags before it). */
const FLAG_ORDER = ["power", "body_styles", "pin_numbers", "pin_names", "exclude_from_sim", "in_bom", "on_board", "in_pos_files", "duplicate_pin_numbers_are_jumpers", "jumper_pin_groups"];
function setFlag(s: List, node: List | undefined, head: string): void {
  const old = findChild(s, head);
  if (old) removeChild(s, old);
  if (!node) return;
  const before = FLAG_ORDER.slice(0, FLAG_ORDER.indexOf(head));
  const prev = s.children.filter((c) => isList(c) && before.includes(headOf(c) ?? "")).pop();
  insertAt(s, prev ? s.children.indexOf(prev) + 1 : 2, node);
}

/**
 * Body styles: none (one), De Morgan (two, unnamed) or named styles. New styles start as a copy
 * of style 1 of each unit, to redraw; dropped ones go with their drawing.
 */
export function setBodyStyles(s: List, styles: { demorgan: true } | { names: string[] } | null): void {
  const n = !styles ? 1 : "demorgan" in styles ? 2 : Math.max(1, styles.names.length);
  for (const u of findChildren(s, "symbol")) if (subUnit(u).style > n) removeChild(s, u);
  for (const u of findChildren(s, "symbol")) {
    const k = subUnit(u);
    if (k.style !== 1) continue;
    for (let st = 2; st <= n; st++) {
      const twin = unitNode(s, k.unit, st);
      if (twin.children.length > 2) continue;
      for (const c of u.children.slice(2)) if (isList(c) && headOf(c) !== "unit_name") insertAt(twin, twin.children.length, format(parse(serialize(c)).children.find(isList) as List, "\t\t\t"));
    }
  }
  setFlag(s, !styles || n < 2 ? undefined : "demorgan" in styles ? list("body_styles", sym("demorgan")) : list("body_styles", ...styles.names.map((x) => str(x))), "body_styles");
}

/** Pins that are jumpers: duplicate numbers joined, and/or named groups of pins joined inside the part. */
export function setJumpers(s: List, j: { duplicate?: boolean; groups?: string[][] }): void {
  if (j.duplicate !== undefined) setFlag(s, list("duplicate_pin_numbers_are_jumpers", sym(j.duplicate ? "yes" : "no")), "duplicate_pin_numbers_are_jumpers");
  if (j.groups !== undefined) {
    const groups = j.groups.map((g) => g.filter(Boolean)).filter((g) => g.length >= 2);
    // Each group is a bare list of pin numbers, which the list helper (it wants a head) can't build.
    const text = `(jumper_pin_groups ${groups.map((g) => `(${g.map((x) => JSON.stringify(x)).join(" ")})`).join(" ")})`;
    setFlag(s, groups.length ? (parse(text).children.find(isList) as List) : undefined, "jumper_pin_groups");
  }
}

/** Change the number of units: new units start empty, dropped ones go with their pins and graphics. */
export function setUnitCount(s: List, n: number): void {
  const { styles } = symbolUnits(s);
  for (const u of findChildren(s, "symbol")) if (subUnit(u).unit > n) removeChild(s, u);
  for (let k = 1; k <= n; k++) for (let st = 1; st <= styles; st++) unitNode(s, k, st);
}

/**
 * Give the symbol a De Morgan body style (each unit's drawing copied to style 2, to redraw), or
 * take it away.
 */
export function setDeMorgan(s: List, on: boolean): void {
  setBodyStyles(s, on ? { demorgan: true } : null);
}

/** A unit's display name ("" for none), kept in its sub-symbols. */
export function setUnitName(s: List, unit: number, name: string): void {
  for (const u of findChildren(s, "symbol")) {
    if (subUnit(u).unit !== unit) continue;
    const old = findChild(u, "unit_name");
    if (old) removeChild(u, old);
    if (name) insertAt(u, 2, list("unit_name", str(name)));
  }
}

/** Units not interchangeable (KiCad's ki_locked field). */
export function setUnitsLocked(s: List, locked: boolean): void {
  const old = findChildren(s, "property").find((p) => arg(p, 0) === "ki_locked");
  if (!locked && old) removeChild(s, old);
  if (locked && !old) {
    const last = findChildren(s, "property").pop();
    insertAt(s, last ? s.children.indexOf(last) + 1 : 2, field("ki_locked", "", { x: 0, y: 0 }, false));
  }
}

/** Move pins to another unit (0: common to all units), in every body style. */
export function setPinUnit(s: List, numbers: string[], unit: number): void {
  const { demorgan } = symbolUnits(s);
  for (const n of numbers)
    for (const p of findSymPins(s, n)) {
      const from = findChildren(s, "symbol").find((u) => u.children.includes(p))!;
      const k = subUnit(from);
      if (k.unit === unit) continue;
      removeChild(from, p);
      const styles = k.style === 0 ? [0] : [k.style];
      for (const st of styles) {
        const to = unitNode(s, unit, st);
        insertAt(to, to.children.length, format(parse(serialize(p)).children.find(isList) as List, "\t\t\t"));
      }
    }
  void demorgan;
}

export interface NewPin {
  number: string;
  name: string;
  type: PinType;
  shape?: PinShape;
  /** The connection point (the pin's free end), in library coordinates (y up). */
  at: Point;
  /** Which way it points into the body: 0 from the left, 180 from the right, 270 from the top, 90 from the bottom. */
  angle: 0 | 90 | 180 | 270;
  length?: number;
  hidden?: boolean;
  /** Other functions a placed symbol can switch the pin to (I2C's SDA on a GPIO pin): they replace the pin's list. */
  alternates?: PinAlternate[];
}

export interface PinAlternate {
  name: string;
  type: PinType;
  shape: PinShape;
}

/** Alternates in KiCad's order: by name, as plain character codes. */
const byName = (list: PinAlternate[]) => [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** Add a pin to a unit (1 unless given), in every body style. */
export function addSymPin(s: List, p: NewPin, unit = 1): void {
  const pin = list(
    "pin",
    sym(p.type),
    sym(p.shape ?? "line"),
    list("at", num(r4(p.at.x)), num(r4(p.at.y)), num(p.angle)),
    list("length", num(r4(p.length ?? 2.54))),
    ...(p.hidden ? [list("hide", sym("yes"))] : []),
    list("name", str(p.name || "~"), font()),
    list("number", str(p.number), font()),
    ...byName(p.alternates ?? []).map((a) => list("alternate", str(a.name), sym(a.type), sym(a.shape))),
  );
  for (let st = 1; st <= symbolUnits(s).styles; st++) {
    const u = unitNode(s, unit, st);
    insertAt(u, u.children.length, format(parse(serialize(pin)).children.find(isList) as List, "\t\t\t"));
  }
}

/** Change a pin: its number, name, type, shape, length, angle or visibility. */
export function setSymPin(s: List, number: string, p: Partial<Omit<NewPin, "at">>, unit?: number): void {
  for (const pin of findSymPins(s, number, unit)) setOnePin(pin, p);
}
function setOnePin(pin: List, p: Partial<Omit<NewPin, "at">>): void {
  if (p.type) setArg(pin, 0, sym(p.type));
  if (p.shape) setArg(pin, 1, sym(p.shape));
  if (p.angle !== undefined) setArg(findChild(pin, "at")!, 2, num(p.angle));
  if (p.length !== undefined) setArg(findChild(pin, "length")!, 0, num(r4(p.length)));
  if (p.name !== undefined) setArg(findChild(pin, "name")!, 0, str(p.name || "~"));
  if (p.number !== undefined) setArg(findChild(pin, "number")!, 0, str(p.number));
  if (p.hidden !== undefined) {
    const h = findChild(pin, "hide");
    if (p.hidden && !h) insertAt(pin, pin.children.indexOf(findChild(pin, "length")!) + 1, list("hide", sym("yes")));
    if (!p.hidden && h) removeChild(pin, h);
  }
  if (p.alternates) {
    // KiCad writes them last, after the number, sorted by name.
    for (const a of findChildren(pin, "alternate")) removeChild(pin, a);
    for (const a of byName(p.alternates)) insertAt(pin, pin.children.length, list("alternate", str(a.name), sym(a.type), sym(a.shape)));
  }
}

const shiftPoints = (n: List, d: Point) => {
  for (const c of n.children) {
    if (!isList(c)) continue;
    const h = headOf(c);
    if (h === "at" || h === "start" || h === "end" || h === "center" || h === "mid" || h === "xy") {
      setArg(c, 0, num(r4(Number(arg(c, 0)) + d.x)));
      setArg(c, 1, num(r4(Number(arg(c, 1)) + d.y)));
    } else if (h === "pts") shiftPoints(c, d);
  }
};

export const moveSymPins = (s: List, numbers: string[], d: Point, unit?: number) => numbers.forEach((n) => findSymPins(s, n, unit).forEach((p) => shiftPoints(p, d)));
export const deleteSymPins = (s: List, numbers: string[], unit?: number) => numbers.forEach((n) => {
  for (const p of findSymPins(s, n, unit)) for (const u of findChildren(s, "symbol")) removeChild(u, p);
});

const GRAPHICS = new Set(["rectangle", "polyline", "circle", "arc", "text", "bezier"]);
/** The body graphics in order (every unit's), for naming them by index. */
export const symGraphics = (s: List) => findChildren(s, "symbol").flatMap((u) => u.children.filter((c): c is List => isList(c) && GRAPHICS.has(headOf(c) ?? "")));

export interface NewSymGraphic {
  kind: "rectangle" | "polyline" | "circle" | "arc" | "text";
  /** rectangle: two corners · polyline: its points · circle: centre and a point on it · arc: start, mid, end · text: where. */
  points: Point[];
  text?: string;
  fill?: "none" | "outline" | "background";
  width?: number;
}

/** Add a body graphic, to every unit's common drawing (unit 0, style 1) unless a unit and style are given. */
export function addSymGraphic(s: List, g: NewSymGraphic, scope: UnitScope = { unit: 0, style: 1 }): void {
  const stroke = list("stroke", list("width", num(g.width ?? 0.254)), list("type", sym("default")));
  const fill = list("fill", list("type", sym(g.fill ?? "none")));
  const pt = (h: string, p: Point) => list(h, num(r4(p.x)), num(r4(p.y)));
  const [a, b] = g.points;
  const node =
    g.kind === "rectangle"
      ? list("rectangle", pt("start", a!), pt("end", b!), stroke, fill)
      : g.kind === "polyline"
        ? list("polyline", list("pts", ...g.points.map((p) => pt("xy", p))), stroke, fill)
        : g.kind === "circle"
          ? list("circle", pt("center", a!), list("radius", num(r4(Math.hypot(b!.x - a!.x, b!.y - a!.y)))), stroke, fill)
          : g.kind === "arc"
            ? list("arc", pt("start", a!), pt("mid", b!), pt("end", g.points[2]!), stroke, fill)
            : list("text", str(g.text ?? ""), list("at", num(r4(a!.x)), num(r4(a!.y)), num(0)), font());
  const u = unitNode(s, scope.unit, scope.style);
  insertAt(u, u.children.length, format(node, "\t\t\t"));
}

export const moveSymGraphics = (s: List, indexes: number[], d: Point) => {
  const g = symGraphics(s);
  for (const i of indexes) if (g[i]) shiftPoints(g[i]!, d);
};
export const deleteSymGraphics = (s: List, indexes: number[]) => {
  const g = symGraphics(s);
  for (const i of [...indexes].sort((x, y) => y - x)) {
    const n = g[i];
    if (n) for (const u of findChildren(s, "symbol")) removeChild(u, n);
  }
};

/** Set fields (Reference prefix, Value, Footprint, Datasheet, Description, keywords, footprint filters) and flags. */
export function setSymFields(s: List, f: SymbolFields & { inBom?: boolean; onBoard?: boolean }): void {
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    const p = findChildren(s, "property").find((q) => arg(q, 0) === key);
    if (p) setArg(p, 1, str(value));
    else {
      const last = findChildren(s, "property").pop();
      insertAt(s, last ? s.children.indexOf(last) + 1 : 1, field(key, value, { x: 0, y: 0 }, true));
    }
  };
  set("Reference", f.reference);
  set("Value", f.value);
  set("Footprint", f.footprint);
  set("Datasheet", f.datasheet);
  set("Description", f.description);
  set("ki_keywords", f.keywords);
  set("ki_fp_filters", f.fpFilters);
  for (const [k, v] of [["in_bom", f.inBom], ["on_board", f.onBoard]] as const) if (v !== undefined) setArg(findChild(s, k) ?? list(k), 0, sym(v ? "yes" : "no"));
}

/**
 * A power symbol as KiCad's power library draws them: a global label named after its value, with
 * one zero-length power input pin, hidden reference #PWR, and an arrow up (a supply) or the
 * ground mark (a ground).
 */
export function newPowerSymbol(name: string, kind: "supply" | "ground"): List {
  const hidden = (key: string, value: string, at: Point, hide: boolean) => list("property", str(key), str(value), list("at", num(at.x), num(at.y), num(0)), ...(hide ? [list("hide", sym("yes"))] : []), font());
  const line = (...pts: Point[]) => list("polyline", list("pts", ...pts.map((p) => list("xy", num(p.x), num(p.y)))), list("stroke", list("width", num(0)), list("type", sym("default"))), list("fill", list("type", sym("none"))));
  const ground = kind === "ground";
  const body = ground
    ? [line({ x: 0, y: 0 }, { x: 0, y: -1.27 }, { x: 1.27, y: -1.27 }, { x: 0, y: -2.54 }, { x: -1.27, y: -1.27 }, { x: 0, y: -1.27 })]
    : [line({ x: -0.762, y: 1.27 }, { x: 0, y: 2.54 }), line({ x: 0, y: 2.54 }, { x: 0.762, y: 1.27 }), line({ x: 0, y: 0 }, { x: 0, y: 2.54 })];
  return list(
    "symbol",
    str(name),
    list("power", sym("global")),
    list("pin_numbers", list("hide", sym("yes"))),
    list("pin_names", list("offset", num(0)), list("hide", sym("yes"))),
    list("exclude_from_sim", sym("no")),
    list("in_bom", sym("yes")),
    list("on_board", sym("yes")),
    hidden("Reference", "#PWR", { x: 0, y: ground ? -6.35 : -3.81 }, true),
    hidden("Value", name, { x: 0, y: ground ? -3.81 : 3.556 }, false),
    hidden("Footprint", "", { x: 0, y: 0 }, true),
    hidden("Datasheet", "", { x: 0, y: 0 }, true),
    hidden("Description", `Power symbol creates a global label with name "${name}"${ground ? " , ground" : ""}`, { x: 0, y: 0 }, true),
    hidden("ki_keywords", "global power", { x: 0, y: 0 }, true),
    list("symbol", str(`${name}_0_1`), ...body),
    list(
      "symbol",
      str(`${name}_1_1`),
      list("pin", sym("power_in"), sym("line"), list("at", num(0), num(0), num(ground ? 270 : 90)), list("length", num(0)), list("name", str(""), font()), list("number", str("1"), font())),
    ),
    list("embedded_fonts", sym("no")),
  );
}

const GROUND = /^(gnd|vss|agnd|dgnd|pgnd|ep|pad|thermal|0v|vee|gnd\d*|avss|dvss)$/i;
const sideOf = (p: { type: PinType; name: string }): "left" | "right" | "top" | "bottom" =>
  p.type === "power_in" || p.type === "power_out" ? (GROUND.test(p.name.replace(/[^A-Za-z0-9]/g, "")) ? "bottom" : p.type === "power_out" ? "right" : "top") : ["output", "tri_state", "open_collector", "open_emitter"].includes(p.type) ? "right" : "left";

/**
 * A box symbol from a pin list, as KiCad's library draws ICs: inputs (and bidirectional, passive)
 * left, outputs right, supplies on top and grounds at the bottom, in the order given; 2.54 mm apart
 * on the 2.54 mm grid, the box sized to the names.
 */
export function layoutSymbol(name: string, pins: Array<{ number: string; name: string; type: PinType; side?: "left" | "right" | "top" | "bottom" }>, f: SymbolFields = {}): List {
  const s = newSymbolNode(name, f);
  const by = { left: [] as typeof pins, right: [] as typeof pins, top: [] as typeof pins, bottom: [] as typeof pins };
  for (const p of pins) by[p.side ?? sideOf(p)].push(p);
  const G = 2.54;
  const L = 2.54;
  const up = (v: number) => Math.ceil(v / G - 1e-9) * G;
  // Name widths (KiCad's font is about 0.8 of its height wide; names sit 1.016 inside the box).
  const w = (list: typeof pins) => Math.max(0, ...list.map((p) => (p.name === "~" ? 0 : p.name.length * 1.27 * 0.8 + 1.016)));
  const rows = Math.max(by.left.length, by.right.length, 1);
  const cols = Math.max(by.top.length, by.bottom.length);
  const height = up(Math.max(rows * G + G, w(by.top) + w(by.bottom) + G));
  const width = up(Math.max(cols * G + G, w(by.left) + w(by.right) + G, 5.08));
  // Even multiples of the grid so the corners and the pins both land on it.
  const hw = Math.ceil(width / 2 / G) * G;
  const hh = Math.ceil(height / 2 / G) * G;
  addSymGraphic(s, { kind: "rectangle", points: [{ x: -hw, y: hh }, { x: hw, y: -hh }], fill: "background" });
  const column = (n: number) => Array.from({ length: n }, (_, i) => r4(((n - 1) / 2 - i) * G));
  const rowsAt = (n: number) => Array.from({ length: n }, (_, i) => r4((-(n - 1) / 2 + i) * G));
  by.left.forEach((p, i) => addSymPin(s, { ...p, at: { x: -hw - L, y: column(by.left.length)[i]! }, angle: 0, length: L }));
  by.right.forEach((p, i) => addSymPin(s, { ...p, at: { x: hw + L, y: column(by.right.length)[i]! }, angle: 180, length: L }));
  by.top.forEach((p, i) => addSymPin(s, { ...p, at: { x: rowsAt(by.top.length)[i]!, y: hh + L }, angle: 270, length: L }));
  by.bottom.forEach((p, i) => addSymPin(s, { ...p, at: { x: rowsAt(by.bottom.length)[i]!, y: -hh - L }, angle: 90, length: L }));
  // Reference above the box's top-left corner, Value below its bottom-left one.
  const ref = findChildren(s, "property").find((q) => arg(q, 0) === "Reference")!;
  const val = findChildren(s, "property").find((q) => arg(q, 0) === "Value")!;
  setArg(findChild(ref, "at")!, 0, num(-hw));
  setArg(findChild(ref, "at")!, 1, num(r4(hh + (by.top.length ? L : 0) + 1.27)));
  setArg(findChild(val, "at")!, 0, num(-hw));
  setArg(findChild(val, "at")!, 1, num(r4(-hh - (by.bottom.length ? L : 0) - 1.27)));
  for (const p of [ref, val]) {
    const e = findChild(p, "effects")!;
    if (!findChild(e, "justify")) insertAt(e, e.children.length, list("justify", sym("left")));
  }
  return s;
}

/** Duplicate pin numbers (KiCad's symbol checker): each number once, unless the symbol says they're jumpers. */
export function symbolProblems(s: List): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  // A symbol with several body styles draws each pin once per style: count one style.
  for (const u of findChildren(s, "symbol").filter((u) => subUnit(u).style <= 1)) for (const p of findChildren(u, "pin")) seen.set(pinNumber(p), (seen.get(pinNumber(p)) ?? 0) + 1);
  const dup = symbolUnits(s).duplicateJumpers ? [] : [...seen].filter(([n, c]) => n && c > 1).map(([n]) => n);
  if (dup.length) out.push(`Pin number${dup.length > 1 ? "s" : ""} ${dup.join(", ")} used more than once`);
  const off = allPins(s).filter((p) => {
    const a = findChild(p, "at")!;
    return [Number(arg(a, 0)), Number(arg(a, 1))].some((v) => Math.abs(v / 1.27 - Math.round(v / 1.27)) > 1e-6);
  });
  if (off.length) out.push(`${off.length} pin${off.length > 1 ? "s" : ""} off the 1.27 mm grid (wires won't connect)`);
  if (!allPins(s).length) out.push("No pins");
  const numbers = new Set(allPins(s).map(pinNumber));
  const stray = symbolUnits(s).jumperGroups.flat().filter((n) => !numbers.has(n));
  if (stray.length) out.push(`Jumper group pin${stray.length > 1 ? "s" : ""} ${stray.join(", ")} not on the symbol`);
  void isAtom;
  return out;
}

export interface SymbolPinView {
  /** Its unit (0: every unit) and body style (0: both). */
  unit: number;
  style: number;
  number: string;
  name: string;
  type: PinType;
  shape: PinShape;
  /** Library coordinates (y up). */
  at: Point;
  angle: number;
  length: number;
  hidden: boolean;
  alternates: PinAlternate[];
}

export interface SymbolGraphicView {
  index: number;
  unit: number;
  style: number;
  kind: "rectangle" | "polyline" | "circle" | "arc" | "text" | "bezier";
  points: Point[];
  radius?: number;
  text?: string;
  fill: string;
}

export interface SymbolView {
  name: string;
  fields: Record<string, string>;
  /** Field positions (library coordinates) and whether they show. */
  fieldAt: Record<string, { at: Point; hidden: boolean }>;
  pins: SymbolPinView[];
  graphics: SymbolGraphicView[];
  units: ReturnType<typeof symbolUnits>;
  power: boolean;
  inBom: boolean;
  onBoard: boolean;
}

/** What the editor shows of a library symbol. */
export function describeSymbol(s: List): SymbolView {
  const pt = (n: List | undefined) => ({ x: Number(arg(n, 0) ?? 0), y: Number(arg(n, 1) ?? 0) });
  const fields: Record<string, string> = {};
  const fieldAt: SymbolView["fieldAt"] = {};
  for (const p of findChildren(s, "property")) {
    const k = String(arg(p, 0));
    fields[k] = String(arg(p, 1) ?? "");
    const effects = findChild(p, "effects");
    fieldAt[k] = { at: pt(findChild(p, "at")), hidden: !!findChild(p, "hide") || !!(effects && (findChild(effects, "hide") || effects.children.some((c) => isAtom(c) && c.raw === "hide"))) };
  }
  const scopeOf = new Map<List, UnitScope>();
  for (const u of findChildren(s, "symbol")) for (const c of u.children) if (isList(c)) scopeOf.set(c, subUnit(u));
  const pins = allPins(s).map((p): SymbolPinView => {
    const a = findChild(p, "at");
    return {
      ...scopeOf.get(p)!,
      number: pinNumber(p),
      name: String(arg(findChild(p, "name"), 0) ?? ""),
      type: String(arg(p, 0)) as PinType,
      shape: String(arg(p, 1)) as PinShape,
      at: pt(a),
      angle: Number(arg(a, 2) ?? 0),
      length: Number(arg(findChild(p, "length"), 0) ?? 2.54),
      hidden: !!findChild(p, "hide") || p.children.some((c) => isAtom(c) && c.raw === "hide"),
      alternates: findChildren(p, "alternate").map((a) => ({ name: String(arg(a, 0) ?? ""), type: String(arg(a, 1) ?? "input") as PinType, shape: String(arg(a, 2) ?? "line") as PinShape })),
    };
  });
  const graphics = symGraphics(s).map((g, index): SymbolGraphicView => {
    const kind = headOf(g) as SymbolGraphicView["kind"];
    const fill = String(arg(findChild(findChild(g, "fill") ?? list("fill"), "type"), 0) ?? "none");
    const base = { index, kind, fill, ...scopeOf.get(g)! };
    if (kind === "rectangle") return { ...base, points: [pt(findChild(g, "start")), pt(findChild(g, "end"))] };
    if (kind === "circle") return { ...base, points: [pt(findChild(g, "center"))], radius: Number(arg(findChild(g, "radius"), 0) ?? 0) };
    if (kind === "arc") return { ...base, points: [pt(findChild(g, "start")), pt(findChild(g, "mid")), pt(findChild(g, "end"))] };
    if (kind === "text") return { ...base, points: [pt(findChild(g, "at"))], text: String(arg(g, 0) ?? "") };
    return { ...base, points: findChildren(findChild(g, "pts") ?? list("pts"), "xy").map(pt) };
  });
  return { name: String(arg(s, 0)), fields, fieldAt, pins, graphics, units: symbolUnits(s), power: !!findChild(s, "power"), inBom: arg(findChild(s, "in_bom"), 0) !== "no", onBoard: arg(findChild(s, "on_board"), 0) !== "no" };
}

/**
 * KiCad's "Update symbol from library" on one sheet: its cached copy of `def` (named "Lib:Name")
 * is replaced, and each placed instance keeps one (pin "n" (uuid …)) per pin of its unit: new pins
 * get one, removed pins lose theirs. Returns how many placed symbols use it.
 */
export function updateSchematicLibSymbol(sheetRoot: List, def: List, newUuid: () => string): number {
  const libId = String(arg(def, 0));
  const libs = findChild(sheetRoot, "lib_symbols");
  const old = libs && findChildren(libs, "symbol").find((d) => arg(d, 0) === libId);
  if (!libs || !old) return 0;
  const at = libs.children.indexOf(old);
  removeChild(libs, old);
  insertAt(libs, at, format(parse(serialize(def)).children.find(isList) as List, "\t\t"));
  let used = 0;
  for (const inst of findChildren(sheetRoot, "symbol")) {
    if (arg(findChild(inst, "lib_id"), 0) !== libId) continue;
    used++;
    const unit = Number(arg(findChild(inst, "unit"), 0) ?? 1);
    const want = new Set<string>();
    for (const u of findChildren(def, "symbol")) {
      const m = /_(\d+)_(\d+)$/.exec(String(arg(u, 0)));
      const n = m ? Number(m[1]) : 0;
      if (n !== 0 && n !== unit) continue;
      for (const p of findChildren(u, "pin")) want.add(String(arg(findChild(p, "number"), 0) ?? ""));
    }
    const have = findChildren(inst, "pin");
    for (const p of have) if (!want.has(String(arg(p, 0)))) removeChild(inst, p);
    const kept = new Set(findChildren(inst, "pin").map((p) => String(arg(p, 0))));
    const anchor = findChildren(inst, "pin").pop() ?? findChildren(inst, "property").pop();
    let i = anchor ? inst.children.indexOf(anchor) + 1 : inst.children.length;
    for (const n of want) if (!kept.has(n)) insertAt(inst, i++, list("pin", str(n), list("uuid", str(newUuid()))));
  }
  return used;
}
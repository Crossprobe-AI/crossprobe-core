/**
 * Design blocks: reusable, ready-made pieces of a design (a module with its
 * reference circuit, a power stage, …), in KiCad's own design-block format
 * (KiCad 9+): `<library>.kicad_blocks/<name>.kicad_block/` holds
 * `<name>.kicad_sch`, an optional `<name>.kicad_pcb` and `<name>.json`
 * (description and keywords).
 *
 * A block here starts as a **spec** (JSON): parts, the net each pin goes to,
 * and for every part and checklist item where it comes from (datasheet and
 * page). `generateBlockSchematic` turns a spec into a schematic in KiCad's
 * layout, and `verifyBlock` checks the result against the spec with the same
 * connectivity code the app uses. So a block's circuit is what the spec says,
 * and each claim in the spec can be traced back to a document.
 */
import { arg, findChild, findChildren, format, headOf, insertAt, isList, list, parse, serialize, setArg, str, sym, type List } from "@crossprobe/kicad-sexpr";
import { buildNetlist } from "./connectivity.js";
import { pointKey, transformLibPoint, type Point } from "./geometry.js";
import { resolveLibrarySymbol } from "./library.js";
import { loadSchematic } from "./project.js";
import { addJunction, addLabel, addNoConnect, addWire, duplicateItems, findItem, newSheetFile, newUuid, placeSymbol, setSymbolField, sheetRoot, TABLE_BY_CELL } from "./schematic-edit.js";

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

/** A document a claim comes from. */
export interface BlockSourceDoc {
  id: string;
  title: string;
  url: string;
  publisher?: string;
  /** Anything the reader should know about reusing it (license, or "values quoted"). */
  note?: string;
}

/** Where a claim comes from: a document and the page. `basis: "convention"` marks common engineering practice that is not in the cited document. */
export interface BlockCitation {
  doc: string;
  page?: number;
  /** Figure, table or section, e.g. "Figure 9-1". */
  where?: string;
}

export type BlockBasis = "datasheet" | "guideline" | "convention";

export interface BlockPart {
  ref: string;
  /** "Library:Symbol", from KiCad's symbol libraries. */
  symbol: string;
  value: string;
  /** "Library:Footprint", from KiCad's footprint libraries. */
  footprint?: string;
  /** Millimetres, on the 2.54 grid. */
  at: [number, number];
  /** Which unit of a multi-unit symbol this places (1 when not given); each unit is its own entry with the same `ref`. */
  unit?: number;
  rotate?: 0 | 90 | 180 | 270;
  dnp?: boolean;
  /** Further symbol fields, e.g. MPN or Datasheet. */
  fields?: Record<string, string>;
  /** Pin number (or name) → net. Nets named in `power` get a power symbol, others a net label. */
  pins: Record<string, string>;
  /** What to do with pins not listed: mark them no-connect (ERC-clean, remove the marker to use a pin), label them with their own name, or leave them. */
  otherPins?: "no_connect" | "label" | "ignore";
  basis: BlockBasis;
  source?: BlockCitation;
  note?: string;
}

export interface BlockCheckItem {
  severity: "required" | "recommended" | "info";
  text: string;
  basis: BlockBasis;
  source?: BlockCitation;
}

export interface BlockSpec {
  /** Folder-safe id, e.g. "esp32-s3-wroom-1-minimal". */
  id: string;
  title: string;
  description: string;
  keywords: string[];
  /** The part family, for browsing, e.g. "MCU module". */
  category: string;
  /** `draft` until a person has checked every value against its source. */
  status: "draft" | "reviewed";
  reviewedBy?: string;
  reviewedAt?: string;
  /** SPDX identifier of the block's own license. */
  license: string;
  /** What the public page says in search results: its title (about 60 characters) and description (about 155). */
  seo?: { title: string; description: string };
  sources: BlockSourceDoc[];
  /** Net name → KiCad power symbol ("power:GND"). */
  power: Record<string, string>;
  parts: BlockPart[];
  /**
   * Pins to join with a drawn wire instead of a net label, as groups of "REF.pin" ("R1.2", "C2.1").
   * They must line up (same x or same y); the first of each group gets the label or power symbol.
   */
  join?: string[][];
  /** Text on the sheet: section headings (`heading`) and short notes with their citation. */
  notes: Array<{ at: [number, number]; text: string; heading?: boolean }>;
  /** The block's PCB layout, if it has one (a .kicad_pcb in the block's folder). */
  layout?: BlockLayout;
  checklist: BlockCheckItem[];
}

/** A place on the board: coordinates in mm, or a pad as "REF.pad" (its centre). */
export type BoardPoint = [number, number] | string;

/**
 * The layout of a block, in KiCad board coordinates (mm, Y down). It places
 * footprints and routes copper; nets are the spec's net names. There is no
 * board outline: a block is placed into someone's board.
 */
export interface BlockLayout {
  /** Where each part's footprint goes, by reference; rotation in degrees (KiCad's: counter-clockwise on screen). */
  parts: Record<string, { at: [number, number]; rotate?: number }>;
  tracks?: Array<{ net: string; layer?: "F.Cu" | "B.Cu"; width: number; path: BoardPoint[] }>;
  vias?: Array<{ net: string; at: BoardPoint; size?: number; drill?: number }>;
  /** Layout rules the block assumes, and where they come from. Shown on the block's page. */
  rules?: BlockCheckItem[];
  /** false: the layout is a placement only (parts positioned, nets left as a ratsnest). Default true. */
  routed?: boolean;
  /** Put reference designators on the fab layer, not the silkscreen (dense placements). */
  fabReferences?: boolean;
}

export type SymbolLibraryText = (library: string) => string;
/** A library symbol in embeddable form (resolveLibrarySymbol's result) by "Library:Name", for callers that hold symbols rather than whole libraries. */
export type SymbolResolver = { resolve: (libId: string) => List };

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface LibPinGeom {
  number: string;
  name: string;
  /** KiCad's electrical type: input, output, bidirectional, passive, power_in, power_out, no_connect, … */
  type: string;
  tip: Point;
  /** KiCad's pin angle: the direction the pin line runs from its tip toward the symbol body. */
  angle: number;
  /** The unit the pin is drawn in; 0 for a pin common to all units. */
  unit: number;
}

/**
 * The pins of one unit of a library symbol (with the pins common to all units), or of every unit
 * with "all", in library coordinates (Y up). Only the normal body style: a De Morgan alternate
 * draws the same pins again.
 */
export function libPins(def: List, unit: number | "all" = 1): LibPinGeom[] {
  const out: LibPinGeom[] = [];
  for (const u of findChildren(def, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(String(arg(u, 0)));
    const n = m ? Number(m[1]) : 0;
    if (m && m[2] !== "0" && m[2] !== "1") continue;
    if (unit !== "all" && n !== 0 && n !== unit) continue;
    for (const pin of findChildren(u, "pin")) {
      const at = findChild(pin, "at");
      out.push({
        type: String(arg(pin, 0) ?? ""),
        number: String(arg(findChild(pin, "number"), 0) ?? ""),
        name: String(arg(findChild(pin, "name"), 0) ?? ""),
        tip: { x: Number(arg(at, 0)), y: Number(arg(at, 1)) },
        angle: Number(arg(at, 2) ?? 0),
        unit: n,
      });
    }
  }
  return out;
}

const orient = (rotation: number) => ({ rotation, mirrorX: false, mirrorY: false });
const ZERO: Point = { x: 0, y: 0 };
const round = (n: number) => Math.round(n * 1e4) / 1e4;
const snapDir = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** A unit vector in library space (Y up) to sheet space (Y down) for a symbol rotated by `rotation`. */
function sheetDir(v: Point, rotation: number): Point {
  return snapDir(transformLibPoint(v, orient(rotation), ZERO));
}

const labelAngle = (d: Point) => (d.x > 0 ? 0 : d.x < 0 ? 180 : d.y < 0 ? 90 : 270);

const STUB = 2.54;

/** Generate the block's schematic file text. `symbols` returns a .kicad_sym library's text by nickname. */
export function generateBlockSchematic(spec: BlockSpec, symbols: SymbolLibraryText | SymbolResolver): string {
  const rootUuid = newUuid();
  const doc = parse(newSheetFile(rootUuid));
  const root = sheetRoot(doc);
  const sheetPaths = [`/${rootUuid}`];
  const defs = new Map<string, List>();
  const def = (libId: string): List => {
    let d = defs.get(libId);
    if (!d) {
      const [lib, name] = libId.split(":");
      if (!lib || !name) throw new Error(`Bad symbol id "${libId}"`);
      defs.set(libId, (d = typeof symbols === "function" ? resolveLibrarySymbol(symbols(lib), lib, name) : symbols.resolve(libId)));
    }
    return d;
  };

  // Title block, with the sources at a glance.
  const titleBlock = list("title_block", list("title", str(spec.title)), list("company", str("Crossprobe design block")), list("comment", 1, str(`Status: ${spec.status}`)));
  insertAt(root, findChild(root, "paper") ? root.children.indexOf(findChild(root, "paper")!) + 1 : 3, format(titleBlock, "\t"), "");

  let powerCount = 0;
  const power = (net: string, at: Point, dir: Point) => {
    const libId = spec.power[net];
    if (!libId) throw new Error(`No power symbol for net "${net}"`);
    const d = def(libId);
    const pin = libPins(d)[0]!;
    // Turn the symbol so its body points away from the part it attaches to.
    const natural = { x: Math.cos((pin.angle * Math.PI) / 180), y: Math.sin((pin.angle * Math.PI) / 180) };
    const rotation = [0, 90, 180, 270].find((r) => {
      const v = sheetDir(natural, r);
      return v.x === dir.x && v.y === dir.y;
    });
    if (rotation === undefined) throw new Error(`Cannot orient ${libId} for direction ${dir.x},${dir.y}`);
    const id = placeSymbol(root, d, { at, reference: `#PWR${String(++powerCount).padStart(4, "0")}`, sheetPaths, projectName: spec.id });
    const node = findItem(root, id)!;
    if (rotation) setArg(findChild(node, "at")!, 2, rotation);
  };

  // Wires are drawn through this, to find the points where three or more things meet (junction dots).
  const wireEnds = new Map<string, { at: Point; n: number }>();
  const tipsAt = new Set<string>();
  const countEnd = (p: Point) => {
    const k = pointKey(p);
    (wireEnds.get(k) ?? wireEnds.set(k, { at: p, n: 0 }).get(k)!).n++;
  };
  const wire = (a: Point, b: Point) => {
    if (pointKey(a) === pointKey(b)) return; // touching pins need no wire
    addWire(root, [a, b]);
    countEnd(a);
    countEnd(b);
  };
  const joinGroups = new Map<string, number[]>(); // "REF.pin" → the groups in spec.join it belongs to
  (spec.join ?? []).forEach((g, i) => g.forEach((k) => (joinGroups.get(k) ?? joinGroups.set(k, []).get(k)!).push(i)));
  const joinTips: Point[][] = (spec.join ?? []).map(() => []);

  for (const part of spec.parts) {
    const d = def(part.symbol);
    const rotation = part.rotate ?? 0;
    const at = { x: part.at[0], y: part.at[1] };
    const id = placeSymbol(root, d, { at, reference: part.ref, unit: part.unit, sheetPaths, projectName: spec.id });
    const node = findItem(root, id)!;
    setSymbolField(node, "Value", part.value);
    if (part.footprint) setSymbolField(node, "Footprint", part.footprint);
    for (const [name, value] of Object.entries(part.fields ?? {})) setSymbolField(node, name, value);
    if (rotation) {
      setArg(findChild(node, "at")!, 2, rotation);
      // The fields sit at fixed offsets in the symbol's own frame: move them with the rotation, upright.
      for (const lp of findChildren(d, "property")) {
        const field = findChildren(node, "property").find((p) => arg(p, 0) === arg(lp, 0));
        const fa = field && findChild(field, "at");
        const la = findChild(lp, "at");
        if (!fa || !la) continue;
        const moved = transformLibPoint({ x: Number(arg(la, 0)), y: Number(arg(la, 1)) }, orient(rotation), at);
        setArg(fa, 0, round(moved.x));
        setArg(fa, 1, round(moved.y));
        setArg(fa, 2, 0);
      }
    }
    if (part.dnp) setArg(findChild(node, "dnp")!, 0, sym("yes")); // a bare keyword, not a string

    const pins = libPins(d, part.unit ?? 1);
    const nets = new Map<string, string>(); // tip position → net, so stacked pins (several GND) connect once
    const wanted: Array<{ pin: LibPinGeom; net: string }> = [];
    for (const [key, net] of Object.entries(part.pins)) {
      const matches = pins.filter((p) => p.number === key);
      const found = matches.length ? matches : pins.filter((p) => p.name === key);
      if (!found.length) throw new Error(`${part.ref} (${part.symbol}) has no pin "${key}"`);
      for (const pin of found) wanted.push({ pin, net });
    }
    if (part.otherPins === "label") {
      const used = new Set(wanted.map((w) => w.pin.number));
      for (const pin of pins) if (!used.has(pin.number)) wanted.push({ pin, net: pin.name });
    }
    if (part.otherPins === "no_connect") {
      const used = new Set(wanted.map((w) => w.pin.number));
      for (const pin of pins) if (!used.has(pin.number)) addNoConnect(root, transformLibPoint(pin.tip, orient(rotation), at));
    }
    for (const { pin, net } of wanted) {
      const tip = transformLibPoint(pin.tip, orient(rotation), at);
      const key = pointKey(tip);
      if (nets.has(key)) {
        if (nets.get(key) !== net) throw new Error(`${part.ref}: pins on the same spot go to different nets (${nets.get(key)}, ${net})`);
        continue;
      }
      nets.set(key, net);
      tipsAt.add(key);
      const out = sheetDir({ x: -Math.cos((pin.angle * Math.PI) / 180), y: -Math.sin((pin.angle * Math.PI) / 180) }, rotation);
      const end = { x: round(tip.x + out.x * STUB), y: round(tip.y + out.y * STUB) };
      // A pin in a join group is wired to the others. It carries the label or power symbol only if it
      // comes first in every group it is in; otherwise another pin of its net does.
      const ref = `${part.ref}.${pin.number}`;
      const groups = joinGroups.get(ref);
      if (groups) {
        for (const g of groups) joinTips[g]!.push(tip);
        if (groups.some((g) => spec.join![g]![0] !== ref)) continue;
      }
      // An unnamed net ("Net-(D1-K)", KiCad's name for one without a label) is just wires between its pins.
      if (net.startsWith("Net-(")) {
        if (!groups) throw new Error(`${ref}: net ${net} has no label, so its pins must be joined`);
        continue;
      }
      wire(tip, end);
      if (spec.power[net]) power(net, end, out);
      else addLabel(root, "label", net, end, labelAngle(out));
    }
  }

  (spec.join ?? []).forEach((g, i) => {
    const tips = joinTips[i]!;
    if (tips.length !== g.length) throw new Error(`join ${g.join(", ")}: a pin is missing or has no net`);
    const sameY = tips.every((t) => Math.abs(t.y - tips[0]!.y) < 1e-6);
    const sameX = tips.every((t) => Math.abs(t.x - tips[0]!.x) < 1e-6);
    if (!sameX && !sameY) throw new Error(`join ${g.join(", ")}: the pins do not line up (same x or same y)`);
    const sorted = [...tips].sort((a, b) => (sameY ? a.x - b.x : a.y - b.y));
    for (let k = 1; k < sorted.length; k++) wire(sorted[k - 1]!, sorted[k]!);
  });
  // KiCad draws a dot where three or more connections meet (a pin counts as one).
  for (const [k, { at, n }] of wireEnds) if (n + (tipsAt.has(k) ? 1 : 0) >= 3) addJunction(root, at);

  for (const note of spec.notes) {
    const size = note.heading ? 2.032 : 1.27;
    const text = list(
      "text",
      str(note.text),
      list("exclude_from_sim", "no"),
      list("at", note.at[0], note.at[1], 0),
      list("effects", list("font", list("size", size, size), ...(note.heading ? ["bold"] : [])), list("justify", "left", "bottom")),
      list("uuid", str(newUuid())),
    );
    insertAt(root, root.children.length, format(text, "\t"), "");
  }
  return stableUuids(serialize(doc), spec.id);
}

/**
 * KiCad needs a UUID on everything, but random ones would make every rebuild
 * of the library a diff. Replace them, in order of first appearance, with ones
 * derived from the block id. (A small pure-JS hash: this package also runs in
 * the browser, where node:crypto is not available.)
 */
export function stableUuids(text: string, seed: string): string {
  const seen = new Map<string, string>();
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (found) => {
    let id = seen.get(found);
    if (!id) {
      const [a, b, c, d] = hash128(`${seed}:${seen.size}`);
      const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
      const h = hex(a!) + hex(b!) + hex(c!) + hex(d!);
      // Version 4 / variant bits, so it is a well-formed UUID.
      id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16]!, 16) & 3]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
      seen.set(found, id);
    }
    return id;
  });
}

/** cyrb128: four well-mixed 32-bit words from a string. */
function hash128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface BlockProblem {
  kind: "net-mismatch" | "missing-pin" | "unknown-part";
  message: string;
}

/**
 * Compare a generated schematic with its spec: every net the spec names must
 * connect exactly the pins the spec lists (as KiCad's connectivity rules see
 * the schematic), and nothing else may be on it.
 */
export function verifyBlock(spec: BlockSpec, schematicText: string, symbols: SymbolLibraryText): BlockProblem[] {
  const problems: BlockProblem[] = [];
  const file = "block.kicad_sch";
  const schematic = loadSchematic(file, (f) => (f === file ? schematicText : ""));
  const netlist = buildNetlist(schematic);

  // Expected: net → set of "REF.pin"; pins marked no-connect each sit alone on an "unconnected-…" net.
  const expected = new Map<string, Set<string>>();
  const noConnect = new Set<string>();
  for (const part of spec.parts) {
    const [lib, name] = part.symbol.split(":");
    const pins = libPins(resolveLibrarySymbol(symbols(lib!), lib!, name!), part.unit ?? 1);
    const used = new Set<string>();
    for (const [key, net] of Object.entries(part.pins)) {
      const matches = pins.filter((p) => p.number === key);
      for (const pin of matches.length ? matches : pins.filter((p) => p.name === key)) {
        used.add(pin.number);
        (expected.get(net) ?? expected.set(net, new Set()).get(net)!).add(`${part.ref}.${pin.number}`);
      }
    }
    if (part.otherPins === "label") {
      for (const pin of pins) if (!used.has(pin.number)) (expected.get(pin.name) ?? expected.set(pin.name, new Set()).get(pin.name)!).add(`${part.ref}.${pin.number}`);
    }
    if (part.otherPins === "no_connect") {
      for (const pin of pins) if (!used.has(pin.number)) noConnect.add(`${part.ref}.${pin.number}`);
    }
  }

  const actual = new Map<string, Set<string>>();
  for (const net of netlist.nets) {
    const pins = net.nodes.filter((n) => !n.reference.startsWith("#")).map((n) => `${n.reference}.${n.pin}`);
    if (!pins.length) continue;
    actual.set(net.name.replace(/^\//, ""), new Set(pins));
  }
  for (const [net, want] of expected) {
    const got = actual.get(net);
    if (!got) {
      problems.push({ kind: "missing-pin", message: `Net ${net} not found in the schematic (expected ${[...want].join(", ")})` });
      continue;
    }
    const missing = [...want].filter((p) => !got.has(p));
    const extra = [...got].filter((p) => !want.has(p));
    if (missing.length || extra.length) {
      problems.push({ kind: "net-mismatch", message: `Net ${net}: missing ${missing.join(", ") || "none"}; unexpected ${extra.join(", ") || "none"}` });
    }
  }
  for (const [net, got] of actual) {
    if (net.startsWith("unconnected-") && got.size === 1 && noConnect.has([...got][0]!)) continue;
    if (!expected.has(net)) problems.push({ kind: "net-mismatch", message: `Unexpected net ${net} with ${[...got].join(", ")}` });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Library files
// ---------------------------------------------------------------------------

/** KiCad's own `<name>.json` for a block (read by KiCad's design block chooser). */
export function kicadBlockJson(spec: BlockSpec): string {
  return JSON.stringify({ description: spec.description, keywords: spec.keywords.join(" "), fields: {} }, null, 2) + "\n";
}

/** What Crossprobe adds next to the KiCad files: provenance, review status and the checklist. */
/** One connected pin, as the public page lists it. */
export interface ManifestPin {
  ref: string;
  number: string;
  /** The pin's name in the KiCad symbol ("" when it has none). */
  name: string;
  net: string;
}

export interface BlockManifest {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  category: string;
  status: BlockSpec["status"];
  reviewedBy?: string;
  reviewedAt?: string;
  license: string;
  seo?: BlockSpec["seo"];
  sources: BlockSourceDoc[];
  parts: Array<Pick<BlockPart, "ref" | "symbol" | "value" | "footprint" | "dnp" | "basis" | "source" | "note">>;
  /** Present when the block has a PCB layout: how many tracks and vias, and the layout rules it assumes. */
  layout?: { footprints: number; tracks: number; vias: number; routed: boolean; rules: BlockCheckItem[] };
  /** Every pin the circuit connects, and the nets those make (power nets first). */
  pins: ManifestPin[];
  nets: Array<{ name: string; pins: string[] }>;
  checklist: BlockCheckItem[];
}

export function blockManifest(spec: BlockSpec, symbols?: SymbolLibraryText): BlockManifest {
  // Pin numbers and names come from the KiCad symbols (when given); a spec may address pins by name.
  const pins: ManifestPin[] = [];
  for (const part of spec.parts) {
    const [lib, name] = part.symbol.split(":");
    const geom = symbols ? libPins(resolveLibrarySymbol(symbols(lib!), lib!, name!), part.unit ?? 1) : [];
    for (const [key, net] of Object.entries(part.pins)) {
      const byNumber = geom.filter((p) => p.number === key);
      const found = byNumber.length ? byNumber : geom.filter((p) => p.name === key);
      if (!found.length) pins.push({ ref: part.ref, number: key, name: "", net });
      for (const p of found) pins.push({ ref: part.ref, number: p.number, name: p.name, net });
    }
  }
  const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
  pins.sort((a, b) => natural(a.ref, b.ref) || natural(a.number, b.number));
  const byNet = new Map<string, string[]>();
  for (const p of pins) (byNet.get(p.net) ?? byNet.set(p.net, []).get(p.net)!).push(`${p.ref}.${p.number}`);
  const powerOrder = Object.keys(spec.power);
  const nets = [...byNet]
    .map(([name, list]) => ({ name, pins: list.sort(natural) }))
    .sort((a, b) => {
      const ia = powerOrder.indexOf(a.name);
      const ib = powerOrder.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || natural(a.name, b.name);
    });
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    keywords: spec.keywords,
    category: spec.category,
    status: spec.status,
    ...(spec.reviewedBy ? { reviewedBy: spec.reviewedBy } : {}),
    ...(spec.reviewedAt ? { reviewedAt: spec.reviewedAt } : {}),
    license: spec.license,
    ...(spec.seo ? { seo: spec.seo } : {}),
    sources: spec.sources,
    ...(spec.layout
      ? { layout: { footprints: Object.keys(spec.layout.parts).length, tracks: spec.layout.tracks?.length ?? 0, vias: spec.layout.vias?.length ?? 0, routed: spec.layout.routed !== false, rules: spec.layout.rules ?? [] } }
      : {}),
    pins,
    nets,
    parts: spec.parts.map(({ ref, symbol, value, footprint, dnp, basis, source, note }) => ({ ref, symbol, value, footprint, dnp, basis, source, note })),
    checklist: spec.checklist,
  };
}

/** Check a spec for the things a reviewer must be able to rely on: every citation points at a listed document. */
export function checkSpecCitations(spec: BlockSpec): string[] {
  const docs = new Set(spec.sources.map((s) => s.id));
  const problems: string[] = [];
  for (const p of spec.parts) {
    if (p.basis !== "convention" && !p.source) problems.push(`${p.ref}: basis "${p.basis}" needs a source`);
    if (p.source && !docs.has(p.source.doc)) problems.push(`${p.ref}: unknown source document "${p.source.doc}"`);
  }
  for (const c of spec.checklist) {
    if (c.basis !== "convention" && !c.source) problems.push(`Checklist "${c.text.slice(0, 40)}…": basis "${c.basis}" needs a source`);
    if (c.source && !docs.has(c.source.doc)) problems.push(`Checklist "${c.text.slice(0, 40)}…": unknown source document "${c.source.doc}"`);
  }
  if (spec.status === "reviewed" && (!spec.reviewedBy || !spec.reviewedAt)) problems.push("status is reviewed, but reviewedBy/reviewedAt are missing");
  return problems;
}

// ---------------------------------------------------------------------------
// Inserting a block into a design
// ---------------------------------------------------------------------------

const BLOCK_ITEMS = new Set(["symbol", "wire", "bus", "bus_entry", "junction", "no_connect", "label", "global_label", "hierarchical_label", "text", "text_box", "table"]);
const GRID = 1.27;

/** An item's id as findItem takes it: its UUID, or for a KiCad 9 table (none of its own) its first cell's. */
function itemId(item: List): string | undefined {
  const own = findChild(item, "uuid");
  if (own) return String(arg(own, 0));
  if (headOf(item) !== "table") return undefined;
  const cell = findChild(findChild(item, "cells") ?? item, "table_cell");
  const u = cell && findChild(cell, "uuid");
  return u ? `${TABLE_BY_CELL}${String(arg(u, 0))}` : undefined;
}

/** The points that place an item: a wire's ends, a table's cells (both corners, so it is clear of what's below), else its anchor. */
function itemPoints(item: List): Point[] {
  const xy = (n: List | undefined) => (n ? [{ x: Number(arg(n, 0)), y: Number(arg(n, 1)) }] : []);
  if (headOf(item) === "wire" || headOf(item) === "bus") return findChildren(findChild(item, "pts")!, "xy").flatMap(xy);
  if (headOf(item) === "table")
    return findChildren(findChild(item, "cells") ?? item, "table_cell").flatMap((c) => {
      const [at] = xy(findChild(c, "at"));
      const size = findChild(c, "size");
      return at ? [at, { x: at.x + Number(arg(size, 0) ?? 0), y: at.y + Number(arg(size, 1) ?? 0) }] : [];
    });
  return xy(findChild(item, "at"));
}

export interface InsertedBlock {
  /** UUIDs of the new items in the target sheet, in the block's order. */
  uuids: string[];
  /** The new symbols' UUIDs (parts and power symbols); their references end in "?" until annotated. */
  symbolUuids: string[];
  /** Which block symbol became which new one, with the block's own reference (to match its footprint). */
  symbols: Array<{ blockUuid: string; uuid: string; blockReference: string }>;
  /** The area the block now occupies, in the sheet (mm). */
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * Copy a block's schematic into `target` so its top-left corner lands at
 * `at` (snapped to the 50 mil grid, so every pin stays on it). Library
 * symbols come along, new symbols get references like "C?" and instance data
 * for `sheetPaths` in `projectName`: annotate afterwards (planAnnotation with
 * mode "unannotated") to number them. With `keepReferences` they keep the
 * block's own designators (C1, R1, …): right for an empty project, where
 * nothing can clash and the numbers then match the block's page and datasheet.
 */
export function insertBlock(target: List, blockText: string, at: Point, sheetPaths: string[], projectName: string, keepReferences = false): InsertedBlock {
  const source = sheetRoot(parse(blockText));
  const items = source.children.filter((c): c is List => isList(c) && BLOCK_ITEMS.has(headOf(c) ?? "") && !!itemId(c));
  const points = items.flatMap(itemPoints);
  if (!points.length) return { uuids: [], symbolUuids: [], symbols: [], bounds: { x: at.x, y: at.y, width: 0, height: 0 } };
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const dx = Math.round((at.x - minX) / GRID) * GRID;
  const dy = Math.round((at.y - minY) / GRID) * GRID;

  const references: Record<string, string> = {};
  const sourceIds = items.map((i) => itemId(i)!);
  if (!keepReferences) items.forEach((item, i) => {
    if (headOf(item) !== "symbol") return;
    const ref = String(arg(findChildren(item, "property").find((p) => arg(p, 0) === "Reference"), 1) ?? "U");
    references[sourceIds[i]!] = `${ref.replace(/[0-9?]+$/, "") || "U"}?`;
  });
  const uuids = duplicateItems(source, target, sourceIds, dx, dy, references, sheetPaths, projectName);
  const symbolUuids = uuids.filter((_, i) => headOf(items[i]!) === "symbol");
  const symbols = items.flatMap((item, i) =>
    headOf(item) === "symbol"
      ? [{ blockUuid: sourceIds[i]!, uuid: uuids[i]!, blockReference: String(arg(findChildren(item, "property").find((p) => arg(p, 0) === "Reference"), 1) ?? "") }]
      : [],
  );
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(...points.map((p) => p.y));
  return { uuids, symbolUuids, symbols, bounds: { x: round(minX + dx), y: round(minY + dy), width: round(maxX - minX), height: round(maxY - minY) } };
}

/**
 * A spot with nothing around it: below everything on the sheet, aligned with
 * its left edge. Items that touch an existing wire or pin join its net, so
 * a block should not land on top of other content.
 */
export function findFreeSpot(sheet: List, margin = 12.7): Point {
  let minX = Infinity;
  let maxY = -Infinity;
  for (const item of sheet.children) {
    if (!isList(item) || !BLOCK_ITEMS.has(headOf(item) ?? "")) continue;
    for (const { x, y } of itemPoints(item)) {
      minX = Math.min(minX, x);
      maxY = Math.max(maxY, y);
    }
  }
  // Symbols are larger than their anchor: leave room for the biggest part's height.
  const room = maxY === -Infinity ? 0 : 30;
  if (maxY === -Infinity) return { x: 25.4, y: 25.4 };
  return { x: Math.round(minX / GRID) * GRID, y: Math.round((maxY + room + margin) / GRID) * GRID };
}

/**
 * Save a selection as a design block (KiCad's "Save Selection as Design Block"): the selected
 * items of a sheet, where they are and with their references, in a sheet of their own with the
 * library symbols they use. Returns the block's .kicad_sch text.
 */
export function blockFromSelection(source: List, uuids: string[], projectName = "", sheetPath?: string): string {
  const id = newUuid();
  const doc = parse(newSheetFile(id));
  const target = sheetRoot(doc);
  // A sheet symbol names a sub-sheet file the block wouldn't carry: KiCad would find it missing.
  if (uuids.some((u) => { const n = findItem(source, u); return !!n && headOf(n) === "sheet"; }))
    throw new Error("A design block can't hold sheet symbols: leave them out of the selection");
  // References as seen on the sheet instance being viewed (a sheet used twice has R101 and R201).
  const references: Record<string, string> = {};
  if (sheetPath) {
    for (const u of uuids) {
      const n = findItem(source, u);
      if (!n || headOf(n) !== "symbol") continue;
      for (const project of findChildren(findChild(n, "instances") ?? n, "project")) {
        const p = findChildren(project, "path").find((x) => arg(x, 0) === sheetPath);
        const ref = p && arg(findChild(p, "reference"), 0);
        if (ref !== undefined) references[u] = String(ref);
      }
    }
  }
  duplicateItems(source, target, uuids, 0, 0, references, [`/${id}`], projectName);
  return serialize(doc);
}

/** A block's .json, as KiCad writes it: its description and space-separated keywords. */
export function blockMetadataJson(description: string, keywords: string[] = []): string {
  return JSON.stringify({ description, keywords: keywords.join(" "), fields: {} }, null, 2) + "\n";
}

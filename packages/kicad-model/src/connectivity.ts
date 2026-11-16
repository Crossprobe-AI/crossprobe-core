/**
 * Schematic connectivity: turns geometry (wires, pins, labels, sheets) into
 * nets.
 *
 * It works in two stages, the same way KiCad does:
 *  1. Per sheet instance, items that touch geometrically form *subgraphs*.
 *  2. Subgraphs are merged across the design by name: local labels within a
 *     sheet, global labels and power symbols everywhere, and hierarchical
 *     labels with the matching pin on the parent's sheet symbol.
 * Each merged net is then named after its strongest driver, using KiCad's
 * priority order.
 */
import { onSegment, pointKey, transformLibPoint, type Point } from "./geometry.js";
import { compareRefs, unitPins, type Schematic, type SheetInstance } from "./project.js";
import type { Label, LibPin, PinType } from "./sheet.js";
import { UnionFind } from "./unionfind.js";
import { busShape, type BusShape } from "./bus.js";

export interface NetNode {
  reference: string;
  /** Reference plus unit letter for multi-unit parts ("U1A"); used in net names. */
  unitReference: string;
  pin: string;
  pinName: string;
  pinType: PinType;
}

export interface Net {
  name: string;
  nodes: NetNode[];
  /** Sheet instances (name paths) the net appears on. */
  sheets: string[];
  /** Every name attached to the net (labels, power symbols, sheet pins), strongest first. */
  aliases: string[];
}

export interface Netlist {
  nets: Net[];
  /**
   * Per sheet instance path: the net name of each wire and label, by index
   * into that sheet file's `wires` / `labels`. Used for highlighting a net
   * in a schematic view.
   */
  sheetItems: Map<string, { wires: Array<string | undefined>; labels: Array<string | undefined> }>;
  /** Present when built with `{ detail: true }`. */
  detail?: ConnectivityDetail;
  warnings: string[];
}

// Driver priorities, lowest to highest (mirrors KiCad's ordering).
const enum Priority {
  None = 0,
  Pin = 1,
  SheetPin = 2,
  HierLabel = 3,
  LocalLabel = 4,
  LocalPower = 5,
  GlobalPower = 6,
  Global = 7,
}

/**
 * Rank of the member names of a bus that is only named by a hierarchical
 * label: above a plain hierarchical label, below a local label.
 */
const HIER_BUS_MEMBER = 3.5 as Priority;

interface Driver {
  priority: Priority;
  name: string;
  depth: number;
}

interface Subgraph {
  sheet: SheetInstance;
  nodes: NetNode[];
  drivers: Driver[];
  /** Name keys this subgraph joins: L|… local, G|… global, H|… hierarchical. */
  keys: string[];
  /**
   * Bus subgraphs carry no pins. `members` are the net keys of the bus's
   * canonical members; `ports` are its sheet pins / hierarchical labels,
   * which link to the bus on the other side of the hierarchy. A port's
   * `map` gives, for each member of the port's own name, the index of the
   * canonical member it stands for (if any).
   */
  bus?: { members: string[]; ports: Array<{ key: string; map: Array<number | undefined> }>; memberPriority: Priority };
  hasNoConnect: boolean;
  /** Indices of the sheet's wires and labels in this subgraph. */
  wireIndices?: number[];
  labelIndices?: number[];
  /** Every pin in the subgraph, power symbols included (for ERC). */
  pins?: SchematicPin[];
  noConnects?: Point[];
  sheetPinCount?: number;
}

/** A placed pin with what ERC needs to know about it. */
export interface SchematicPin {
  reference: string;
  number: string;
  name: string;
  type: PinType;
  hidden: boolean;
  /** Sheet position (mm). */
  at: Point;
  symbolUuid: string;
  /** Pin of a power symbol or PWR_FLAG (reference starting with #). */
  powerSymbol: boolean;
  /** For power symbols: the net they name (their Value). */
  powerName?: string;
  /** Load order across the design (sheet, then file order), for stable tie-breaks. */
  order: number;
}

/** One sheet-local connected piece of a net, as ERC sees it. */
export interface SubgraphDetail {
  sheet: SheetInstance;
  pins: SchematicPin[];
  /** Indices into the sheet file's `labels`. */
  labels: number[];
  wires: number[];
  noConnects: Point[];
  sheetPins: number;
  drivers: Array<{ name: string; priority: number }>;
  /** Joined to a bus as one of its members (by label name). */
  busMember: boolean;
}

/** Connectivity detail: every net (named or not) with its sheet-local pieces. */
export interface ConnectivityDetail {
  groups: Array<{ name: string | undefined; subgraphs: SubgraphDetail[] }>;
}

type LocalItem =
  | { kind: "wire"; a: Point; b: Point }
  | {
      kind: "pin";
      at: Point;
      node: NetNode;
      /** The other pads of a stacked pin ("[1-4]" is pads 1 to 4 on one pin). */
      stacked?: NetNode[];
      /** Jumper keys: pins of one part sharing a key are one net. */
      jumpers?: string[];
      erc: SchematicPin;
      /** Pins of power symbols (incl. PWR_FLAG) are never netlist nodes. */
      powerSymbol: boolean;
      implicitNet?: string;
      power?: { kind: "global" | "local"; name: string };
    }
  | { kind: "label"; at: Point; label: Label; /** The label's text with variables resolved. */ text: string; index: number }
  | { kind: "sheetpin"; at: Point; sheetUuid: string; name: string }
  | { kind: "junction"; at: Point }
  | { kind: "nc"; at: Point };

export function buildNetlist(schematic: Schematic, options: { detail?: boolean } = {}): Netlist {
  const warnings: string[] = [];
  const subgraphs: Subgraph[] = [];

  for (const sheet of schematic.sheets) {
    subgraphs.push(...sheetSubgraphs(sheet, schematic, warnings));
  }

  // Stage 2: merge subgraphs that share a name key.
  const uf = new UnionFind();
  for (let i = 0; i < subgraphs.length; i++) uf.add();
  const byKey = new Map<string, number>();
  const join = (key: string, i: number) => {
    const j = byKey.get(key);
    if (j === undefined) byKey.set(key, i);
    else uf.union(i, j);
  };
  subgraphs.forEach((sg, i) => sg.keys.forEach((k) => join(k, i)));

  // Buses: a bus subgraph connects its members positionally to the other
  // bus subgraphs it touches through sheet pins / hierarchical labels.
  const weakMembers = linkBuses(subgraphs, byKey, uf);

  // KiCad names a bus member's net after the bus. A local label that is a
  // member of a bus without a label of its own (one named only by a sheet
  // pin or a hierarchical label) ranks no higher than that bus's name.
  for (const sg of subgraphs) {
    if (sg.bus) continue;
    let rank: Priority | undefined;
    for (const k of sg.keys) {
      const r = weakMembers.get(k);
      if (r !== undefined && (rank === undefined || r > rank)) rank = r;
    }
    if (rank === undefined) continue;
    for (const d of sg.drivers) if (d.priority === Priority.LocalLabel) d.priority = rank;
  }

  const groups = new Map<number, Subgraph[]>();
  subgraphs.forEach((sg, i) => {
    if (sg.bus) return;
    const r = uf.find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(sg);
  });

  const nets: Net[] = [];
  const sheetItems: Netlist["sheetItems"] = new Map();
  for (const sheet of schematic.sheets) {
    sheetItems.set(sheet.path, { wires: new Array(sheet.data.wires.length), labels: new Array(sheet.data.labels.length) });
  }
  const detail: ConnectivityDetail | undefined = options.detail ? { groups: [] } : undefined;
  const memberKeys = new Set(subgraphs.flatMap((sg) => sg.bus?.members ?? []));
  for (const group of groups.values()) {
    const seen = new Set<string>();
    const nodes: NetNode[] = [];
    for (const sg of group) {
      for (const n of sg.nodes) {
        const k = `${n.reference}\0${n.pin}`;
        if (!seen.has(k)) {
          seen.add(k);
          nodes.push(n);
        }
      }
    }
    const name = netName(group, nodes, group.flatMap((g) => g.nodes));
    detail?.groups.push({
      name,
      subgraphs: group.map((sg) => ({
        sheet: sg.sheet,
        pins: sg.pins ?? [],
        labels: sg.labelIndices ?? [],
        wires: sg.wireIndices ?? [],
        noConnects: sg.noConnects ?? [],
        sheetPins: sg.sheetPinCount ?? 0,
        drivers: sg.drivers.map((d) => ({ name: d.name, priority: d.priority })),
        busMember: sg.keys.some((k) => memberKeys.has(k)),
      })),
    });
    for (const sg of group) {
      const items = sheetItems.get(sg.sheet.path)!;
      for (const w of sg.wireIndices ?? []) items.wires[w] = name;
      for (const l of sg.labelIndices ?? []) items.labels[l] = name;
    }
    if (nodes.length === 0) continue;
    nodes.sort((a, b) => compareRefs(a.reference, b.reference) || compareRefs(a.pin, b.pin));
    const aliases = [...new Set(group.flatMap((g) => g.drivers).sort((a, b) => b.priority - a.priority).map((d) => d.name))];
    nets.push({
      aliases,
      name,
      nodes,
      sheets: [...new Set(group.map((g) => g.sheet.namePath))],
    });
  }
  nets.sort((a, b) => a.name.localeCompare(b.name));
  return { nets, sheetItems, detail, warnings };
}

function netName(group: Subgraph[], nodes: NetNode[], allNodes: NetNode[]): string {
  let best: Driver | undefined;
  for (const sg of group) {
    for (const d of sg.drivers) {
      if (
        !best ||
        d.priority > best.priority ||
        (d.priority === best.priority && (d.depth < best.depth || (d.depth === best.depth && d.name < best.name)))
      ) {
        best = d;
      }
    }
  }
  if (best) return best.name;
  // Unnamed nets are named after one of their pins. KiCad's rule is
  // string-based: names without "-Pad" win, then the lexically smallest.
  // `allNodes` keeps duplicates of shared pins so every unit is a candidate.
  const unconnected = nodes.filter((n) => !stackedExtras.has(n)).length === 1 || group.some((g) => g.hasNoConnect);
  let chosen: string | undefined;
  let chosenNamed = false;
  for (const n of allNodes) {
    if (stackedExtras.has(n)) continue;
    const name = defaultNetName(n, unconnected);
    const named = !name.includes("-Pad");
    if (chosen === undefined || (named && !chosenNamed) || (named === chosenNamed && name < chosen)) {
      chosen = name;
      chosenNamed = named;
    }
  }
  return chosen!;
}

interface NamingHint {
  /** Pin name as shown, or "" when it is empty, "~", or equal to the number. */
  shownName: string;
  /** Another pin of the same unit has the same name (e.g. several GND pins). */
  sharedName: boolean;
}
const namingHints = new WeakMap<NetNode, NamingHint>();
/** Pads of a stacked pin after the first; the net is named after the first only. */
const stackedExtras = new WeakSet<NetNode>();

/**
 * Pads of a stacked pin number: "[1-3,7]" is pads 1, 2, 3 and 7. A range
 * counts up over the trailing digits of two names with the same prefix
 * ("A1-A3"). Anything else is an ordinary pin number (undefined).
 */
export function stackedPinNumbers(number: string): string[] | undefined {
  if (!number.startsWith("[") || !number.endsWith("]")) return undefined;
  const out: string[] = [];
  for (const part of number.slice(1, -1).split(",")) {
    if (!part) continue;
    if (/\s/.test(part)) return undefined;
    if (!part.includes("-")) {
      out.push(part);
      continue;
    }
    const m = /^([^-]*?)(\d+)-([^-]*?)(\d+)$/.exec(part);
    if (!m || m[1] !== m[3] || Number(m[2]) > Number(m[4])) return undefined;
    for (let i = Number(m[2]); i <= Number(m[4]); i++) out.push(m[1]! + i);
  }
  return out.length ? out : undefined;
}

/** KiCad's default name for a net driven only by this pin. */
function defaultNetName(n: NetNode, unconnected: boolean): string {
  const hint = namingHints.get(n) ?? { shownName: "", sharedName: false };
  const nc = unconnected || n.pinType === "no_connect";
  let name = nc ? "unconnected-(" : "Net-(";
  name += hint.shownName ? n.unitReference : n.reference;
  if (hint.shownName) name += "-" + escapeNetName(hint.shownName);
  if (!hint.shownName || nc || hint.sharedName) name += "-Pad" + escapeNetName(n.pin);
  return name + ")";
}

// ---------------------------------------------------------------------------
// Stage 1: geometric connectivity within one sheet instance
// ---------------------------------------------------------------------------

function sheetSubgraphs(sheet: SheetInstance, schematic: Schematic, warnings: string[]): Subgraph[] {
  const data = sheet.data;
  const depth = sheet.namePath.split("/").length - 2;
  const items: LocalItem[] = [];
  const names = resolvedNames(sheet, schematic);

  for (const w of data.wires) items.push({ kind: "wire", a: w.a, b: w.b });
  for (const j of data.junctions) items.push({ kind: "junction", at: j });
  for (const p of data.noConnects) items.push({ kind: "nc", at: p });
  data.labels.forEach((l, index) => items.push({ kind: "label", at: l.at, label: l, text: names.labels[index]!, index }));
  data.sheets.forEach((s, si) => s.pins.forEach((p, pi) => items.push({ kind: "sheetpin", at: p.at, sheetUuid: s.uuid, name: names.sheetPins[si]![pi]! })));

  for (const pl of schematic.placements) {
    if (pl.sheet !== sheet || !pl.lib) continue;
    const { symbol, lib } = pl;
    const pins = unitPins(lib, pl.unit, symbol.bodyStyle);
    const nameCount = new Map<string, Set<string>>();
    for (const p of pins) {
      let set = nameCount.get(p.name);
      if (!set) nameCount.set(p.name, (set = new Set()));
      set.add(p.number);
    }
    for (const pin of pins) {
      const at = transformLibPoint(pin.at, symbol, symbol.at);
      const numbers = stackedPinNumbers(pin.number) ?? [pin.number];
      // A pin switched to an alternate function takes that function's electrical type.
      const alternate = symbol.pinAlternates?.[pin.number];
      const type = (alternate !== undefined && pin.alternates?.[alternate]) || pin.type;
      const nodeFor = (number: string): NetNode => ({
        reference: pl.reference,
        unitReference: lib.unitCount > 1 ? pl.reference + unitLetter(pl.unit) : pl.reference,
        pin: number,
        pinName: pin.name,
        pinType: type,
      });
      const item: LocalItem = {
        kind: "pin",
        at,
        node: nodeFor(numbers[0]!),
        erc: {
          reference: pl.reference,
          number: pin.number,
          name: pin.name,
          type,
          hidden: pin.hidden,
          at,
          symbolUuid: symbol.uuid,
          powerSymbol: !!lib.power || pl.reference.startsWith("#"),
          powerName: lib.power ? resolveText(powerNetName(pl, pin), sheet, schematic) : undefined,
          order: pinOrder++,
        },
        // Like KiCad's netlist, skip power symbols and parts excluded from the board.
        powerSymbol: !!lib.power || pl.reference.startsWith("#") || !symbol.onBoard,
      };
      const shown = pin.name && pin.name !== "~" && pin.name !== pin.number ? pin.name : "";
      namingHints.set(item.node, { shownName: shown, sharedName: (nameCount.get(pin.name)?.size ?? 0) > 1 });
      if (numbers.length > 1) {
        item.stacked = numbers.slice(1).map(nodeFor);
        for (const n of item.stacked) stackedExtras.add(n);
      }
      // Jumpers: pins in one jumper group, or (when the symbol says so) pins
      // with the same number, are connected inside the part.
      const jumpers: string[] = [];
      for (const number of numbers) {
        if (lib.duplicatePinsAreJumpers) jumpers.push(`J|${pl.sheet.path}|${pl.reference}|n|${number}`);
        lib.jumperGroups?.forEach((g, gi) => g.includes(number) && jumpers.push(`J|${pl.sheet.path}|${pl.reference}|g|${gi}`));
      }
      if (jumpers.length) item.jumpers = jumpers;
      if (lib.power && pin.type === "power_in") {
        item.power = { kind: lib.power, name: resolveText(powerNetName(pl, pin), sheet, schematic) };
      } else if (!lib.power && isImplicitPowerPin(pin)) {
        // Legacy behaviour: hidden power-input pins join the global net named
        // after the pin, without a wire.
        item.implicitNet = pin.name;
      }
      items.push(item);
    }
  }

  const uf = new UnionFind();
  items.forEach(() => uf.add());

  // Items sharing a connection point connect.
  const atPoint = new Map<string, number[]>();
  const addPoint = (p: Point, i: number) => {
    const k = pointKey(p);
    let list = atPoint.get(k);
    if (!list) atPoint.set(k, (list = []));
    list.push(i);
  };
  items.forEach((it, i) => {
    if (it.kind === "wire") {
      addPoint(it.a, i);
      addPoint(it.b, i);
    } else {
      addPoint(it.at, i);
    }
  });
  for (const list of atPoint.values()) for (let i = 1; i < list.length; i++) uf.union(list[0]!, list[i]!);

  // Some items also connect to the interior of a wire.
  const wires = new WireIndex(items);
  items.forEach((it, i) => {
    const pts = it.kind === "wire" ? [it.a, it.b] : interiorConnects(it) ? [it.at] : [];
    for (const p of pts) for (const w of wires.hits(p)) uf.union(i, w);
  });

  // Collect subgraphs.
  const byRoot = new Map<number, Subgraph>();
  const get = (i: number) => {
    const r = uf.find(i);
    let sg = byRoot.get(r);
    if (!sg) byRoot.set(r, (sg = { sheet, nodes: [], drivers: [], keys: [], hasNoConnect: false }));
    return sg;
  };

  const isolated: Subgraph[] = [];
  items.forEach((it, i) => {
    const sg = get(i);
    switch (it.kind) {
      case "wire":
        (sg.wireIndices ??= []).push(i); // wires are the first items, so i is the wire index
        break;
      case "pin":
        (sg.pins ??= []).push(it.erc);
        if (it.power) {
          if (it.power.kind === "global") {
            // A power symbol also joins same-named local labels on its sheet.
            sg.keys.push(`G|${it.power.name}`, `L|${sheet.path}|${it.power.name}`);
            sg.drivers.push({ priority: Priority.GlobalPower, name: escapeNetName(it.power.name), depth });
          } else {
            sg.keys.push(`L|${sheet.path}|${it.power.name}`);
            sg.drivers.push({ priority: Priority.LocalPower, name: sheet.namePath + escapeNetName(it.power.name), depth });
          }
        } else {
          if (!it.powerSymbol) {
            if (it.node.pinType === "no_connect") {
              // A pin of the no-connect type is never part of a net, whatever touches it.
              isolated.push({ sheet, nodes: [it.node, ...(it.stacked ?? [])], drivers: [], keys: [], hasNoConnect: true });
            } else {
              sg.nodes.push(it.node, ...(it.stacked ?? []));
              if (it.jumpers) sg.keys.push(...it.jumpers);
            }
          }
          if (it.implicitNet) {
            sg.keys.push(`G|${it.implicitNet}`);
            sg.drivers.push({ priority: Priority.GlobalPower, name: escapeNetName(it.implicitNet), depth });
          }
        }
        break;
      case "label": {
        (sg.labelIndices ??= []).push(it.index);
        // Names are compared in escaped form: "A/B" and "A{slash}B" are the same net.
        const t = escapeNetName(it.text);
        if (it.label.kind === "local") {
          sg.keys.push(`L|${sheet.path}|${t}`);
          sg.drivers.push({ priority: Priority.LocalLabel, name: sheet.namePath + t, depth });
        } else if (it.label.kind === "global") {
          // A global label also joins same-named local labels on its sheet.
          sg.keys.push(`G|${t}`, `L|${sheet.path}|${t}`);
          sg.drivers.push({ priority: Priority.Global, name: t, depth });
        } else {
          // A hierarchical label also joins same-named local labels on its sheet.
          sg.keys.push(`H|${sheet.path}|${t}`, `L|${sheet.path}|${t}`);
          sg.drivers.push({ priority: Priority.HierLabel, name: sheet.namePath + t, depth });
        }
        break;
      }
      case "sheetpin":
        sg.sheetPinCount = (sg.sheetPinCount ?? 0) + 1;
        sg.keys.push(`H|${sheet.path}/${it.sheetUuid}|${it.name}`);
        sg.drivers.push({ priority: Priority.SheetPin, name: sheet.namePath + escapeNetName(it.name), depth });
        break;
      case "nc":
        sg.hasNoConnect = true;
        (sg.noConnects ??= []).push(it.at);
        break;
    }
  });

  const result = [...byRoot.values(), ...isolated];
  result.push(...busSubgraphs(sheet, names));
  return result;
}

let pinOrder = 0;

/** A sheet's label texts and sheet pin names, with text variables resolved. */
interface ResolvedNames {
  labels: string[];
  /** Per sheet symbol, per pin. */
  sheetPins: string[][];
}

function resolvedNames(sheet: SheetInstance, schematic: Schematic): ResolvedNames {
  return {
    labels: sheet.data.labels.map((l) => resolveText(l.text, sheet, schematic)),
    // A sheet pin speaks for the sheet it leads into: its variables are that sheet's.
    sheetPins: sheet.data.sheets.map((s) => {
      const child = schematic.sheets.find((c) => c.parent === sheet && c.ref === s);
      return s.pins.map((p) => (child ? resolveText(p.name, child, schematic) : p.name));
    }),
  };
}

/**
 * Replace the text variables KiCad resolves in net names: ${#} (page), ${##}
 * (page count), sheet name / path / file, the fields of the sheet symbol,
 * and the project's variables. Unknown variables stay as written.
 */
export function resolveText(text: string, sheet: SheetInstance, schematic: Schematic): string {
  if (!text.includes("${")) return text;
  return text.replace(/\$\{([^{}]+)\}/g, (all, key: string) => {
    switch (key) {
      case "#":
        return sheet.pageNumber ?? all;
      case "##":
        return String(schematic.sheets.length);
      case "SHEETNAME":
        return sheet.ref?.name ?? "";
      case "SHEETPATH":
        return sheet.namePath;
      case "SHEETFILE":
        return sheet.file.split("/").pop()!;
      case "FILENAME":
        // KiCad gives the root file here, whichever sheet asks.
        return schematic.root.file.split("/").pop()!;
      case "PROJECTNAME":
        return schematic.root.file.split("/").pop()!.replace(/\.kicad_sch$/, "");
      case "CURRENT_DATE":
        return new Date().toISOString().slice(0, 10);
    }
    const fields = sheet.ref?.properties;
    if (fields && Object.hasOwn(fields, key) && !/^Sheet ?(name|file)$/.test(key)) return fields[key]!;
    const vars = schematic.textVariables;
    if (vars && Object.hasOwn(vars, key)) return String(vars[key]);
    return all;
  });
}

/** KiCad's net-name escaping: "/" is the hierarchy separator, so it is spelled {slash}. */
export function escapeNetName(name: string): string {
  return name.replace(/\//g, "{slash}").replace(/\n/g, "{return}");
}

/** What KiCad's files spell as {name}, and the character each stands for. */
const ESCAPES: Record<string, string> = {
  slash: "/",
  backslash: "\\",
  dblquote: '"',
  quote: "'",
  lt: "<",
  gt: ">",
  bar: "|",
  comma: ",",
  colon: ":",
  space: " ",
  dollar: "$",
  tab: "\t",
  return: "\n",
  brace: "{",
};

/**
 * A net, pin or label name as people read it: the file escapes undone, so
 * "VPP{slash}MCLR" reads "VPP/MCLR". Names are stored and compared escaped
 * (see escapeNetName); this is for showing them. Text markup (~{…}) and
 * variables (${…}) are left alone.
 */
export function displayName(name: string): string {
  return name.replace(/(?<![~^_$])\{([a-z]+)\}/g, (all, key: string) => ESCAPES[key] ?? all);
}

/** Unit letters as KiCad assigns them: A…Z, then AA, AB, … */
export function unitLetter(unit: number): string {
  let s = "";
  for (let u = unit; u > 0; u = Math.floor((u - 1) / 26)) s = String.fromCharCode(65 + ((u - 1) % 26)) + s;
  return s;
}

/** Hidden power-input pins on ordinary symbols are implicitly global nets. */
/**
 * The net a power symbol's pin names. It is the symbol's value, except in files from before
 * KiCad 7 (20230221), where KiCad still takes a hidden pin's own name.
 */
function powerNetName(pl: Schematic["placements"][number], pin: LibPin): string {
  if (pin.hidden && pl.sheet.data.version < 20230221) return pin.name;
  return pl.value ?? pl.symbol.properties["Value"] ?? pin.name;
}

function isImplicitPowerPin(pin: LibPin): boolean {
  return pin.type === "power_in" && pin.hidden;
}

/** Junctions and labels attach anywhere along a wire, not only at its ends. */
function interiorConnects(it: LocalItem): boolean {
  return it.kind === "junction" || it.kind === "label";
}

/** Spatial index over wire segments for point-on-segment queries. */
class WireIndex {
  private horizontal = new Map<number, number[]>();
  private vertical = new Map<number, number[]>();
  private diagonal: number[] = [];

  constructor(private items: LocalItem[]) {
    items.forEach((it, i) => {
      if (it.kind !== "wire") return;
      if (Math.abs(it.a.y - it.b.y) < 1e-6) push(this.horizontal, q(it.a.y), i);
      else if (Math.abs(it.a.x - it.b.x) < 1e-6) push(this.vertical, q(it.a.x), i);
      else this.diagonal.push(i);
    });
  }

  hits(p: Point): number[] {
    const out: number[] = [];
    const test = (i: number) => {
      const w = this.items[i] as Extract<LocalItem, { kind: "wire" }>;
      if (onSegment(p, w.a, w.b)) out.push(i);
    };
    this.horizontal.get(q(p.y))?.forEach(test);
    this.vertical.get(q(p.x))?.forEach(test);
    this.diagonal.forEach(test);
    return out;
  }
}

const q = (v: number) => Math.round(v * 10000);
function push(m: Map<number, number[]>, k: number, v: number) {
  let l = m.get(k);
  if (!l) m.set(k, (l = []));
  l.push(v);
}

// ---------------------------------------------------------------------------
// Buses
// ---------------------------------------------------------------------------

/**
 * Bus connectivity: bus segments, the labels on them, and bus-typed sheet
 * pins / hierarchical labels. Bus entries carry no connectivity of their own;
 * wires leaving a bus join nets through their labels.
 *
 * Members are identified by name within a sheet: a label "D[0..7]" on a bus
 * means the local nets D0..D7. A sheet pin or hierarchical label on a bus
 * with a different name is paired with the bus's members by KiCad's rules
 * (see portMap), so a parent bus "IO[8..15]" can feed a child port "IO[0..7]".
 */
function busSubgraphs(sheet: SheetInstance, names: ResolvedNames): Subgraph[] {
  const data = sheet.data;
  const aliases = data.busAliases;

  type Item =
    | { kind: "bus"; a: Point; b: Point }
    | { kind: "label"; at: Point; label: Label; text: string; shape: BusShape }
    | { kind: "sheetpin"; at: Point; sheetUuid: string; name: string; shape: BusShape };
  const items: Item[] = data.buses.map((b) => ({ kind: "bus" as const, a: b.a, b: b.b }));
  data.labels.forEach((l, li) => {
    const text = names.labels[li]!;
    const shape = busShape(text, aliases);
    if (shape) items.push({ kind: "label", at: l.at, label: l, text, shape });
  });
  data.sheets.forEach((s, si) => {
    s.pins.forEach((p, pi) => {
      const name = names.sheetPins[si]![pi]!;
      const shape = busShape(name, aliases);
      if (shape) items.push({ kind: "sheetpin", at: p.at, sheetUuid: s.uuid, name, shape });
    });
  });
  if (items.length === 0) return [];

  const uf = new UnionFind();
  items.forEach(() => uf.add());
  const buses: number[] = [];
  items.forEach((it, i) => it.kind === "bus" && buses.push(i));
  // A bus label placed straight on a sheet pin (or another label) connects without a bus segment.
  const atPoint = new Map<string, number>();
  items.forEach((it, i) => {
    const pts = it.kind === "bus" ? [it.a, it.b] : [it.at];
    for (const p of pts) {
      for (const j of buses) {
        const b = items[j] as Extract<Item, { kind: "bus" }>;
        if (j !== i && onSegment(p, b.a, b.b)) uf.union(i, j);
      }
      if (it.kind === "bus") continue;
      const first = atPoint.get(pointKey(p));
      if (first === undefined) atPoint.set(pointKey(p), i);
      else uf.union(i, first);
    }
  });

  const groups = new Map<number, Array<Exclude<Item, { kind: "bus" }>>>();
  items.forEach((it, i) => {
    if (it.kind === "bus") return;
    const r = uf.find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(it);
  });

  const out: Subgraph[] = [];
  for (const group of groups.values()) {
    // Canonical members come from the strongest label on the bus. A bus
    // with only sheet pins takes the (alphabetically first) pin's names, in
    // this sheet's namespace, so same-named local labels on wires join it.
    const rank = (it: (typeof group)[number]) =>
      it.kind === "sheetpin" ? 0 : it.label.kind === "global" ? 3 : it.label.kind === "local" ? 2 : 1;
    const nameOf = (it: (typeof group)[number]) => (it.kind === "sheetpin" ? it.name : it.text);
    const best = [...group].sort((a, b) => rank(b) - rank(a) || nameOf(a).localeCompare(nameOf(b)))[0]!;
    const ns = best.kind === "label" && best.label.kind === "global" ? "G|" : `L|${sheet.path}|`;
    const members = best.shape.members.map((m) => ns + escapeNetName(m.name));
    const ports: NonNullable<Subgraph["bus"]>["ports"] = [];
    for (const it of group) {
      const map = nameOf(it) === nameOf(best) ? it.shape.members.map((_, i) => i) : portMap(it.shape, best.shape);
      if (it.kind === "sheetpin") ports.push({ key: `H|${sheet.path}/${it.sheetUuid}|${it.name}`, map });
      else if (it.label.kind === "hierarchical") ports.push({ key: `H|${sheet.path}|${it.text}`, map });
    }
    // The members of a global bus are global nets, and like a global label
    // each also joins the same-named local labels on this sheet.
    if (ns === "G|") {
      for (const m of best.shape.members) {
        const name = escapeNetName(m.name);
        out.push({ sheet, nodes: [], drivers: [{ priority: Priority.Global, name, depth: 0 }], keys: [`G|${name}`, `L|${sheet.path}|${name}`], hasNoConnect: false });
      }
    }
    const memberPriority =
      best.kind === "sheetpin" ? Priority.SheetPin : best.label.kind === "global" ? Priority.Global : best.label.kind === "local" ? Priority.LocalLabel : HIER_BUS_MEMBER;
    out.push({ sheet, nodes: [], drivers: [], keys: [], hasNoConnect: false, bus: { members, ports, memberPriority } });
  }
  return out;
}

/**
 * Which member of a bus each member of a differently named sheet pin or
 * hierarchical label on it stands for. KiCad's rules, found by experiment:
 *  - a vector member takes the bus member at its own position in its vector
 *    (counted from the lowest index), whatever the names are;
 *  - a plain name on a vector bus takes the first member;
 *  - between two group buses, members pair when they are written the same
 *    (bus prefixes aside): "SDA" with "SDA", the members of "D[0..7]" with
 *    those of "D[0..7]", but not with "D[7..0]" or a plain "D0".
 */
function portMap(port: BusShape, bus: BusShape): Array<number | undefined> {
  const inRange = (i: number) => (i < bus.members.length ? i : undefined);
  if (port.vector || bus.vector) return port.members.map((m) => inRange(m.index));
  return port.members.map((m) => {
    const i = bus.members.findIndex((b) => b.token === m.token && b.index === m.index);
    return i < 0 ? undefined : i;
  });
}

/** Link bus members across the hierarchy through the ports two buses share. */
function linkBuses(subgraphs: Subgraph[], byKey: Map<string, number>, uf: UnionFind): Map<string, Priority> {
  const weak = new Map<string, Priority>();
  // Bus members are nets in their own right, named like a label would be.
  const sheetsByPath = new Map(subgraphs.map((sg) => [sg.sheet.path, sg.sheet]));
  const memberNode = (key: string, priority: Priority): number => {
    let i = byKey.get(key);
    if (i === undefined) {
      i = uf.add();
      const [kind, a, b] = key.split("|");
      const sheet = (kind === "L" ? sheetsByPath.get(a!) : undefined) ?? subgraphs[0]!.sheet;
      const drivers: Driver[] =
        kind === "G"
          ? [{ priority, name: a!, depth: 0 }]
          : kind === "L"
            ? [{ priority, name: sheet.namePath + b!, depth: sheet.namePath.split("/").length - 2 }]
            : [];
      subgraphs.push({ sheet, nodes: [], drivers, keys: [key], hasNoConnect: false });
      byKey.set(key, i);
    }
    return i;
  };

  type Bus = NonNullable<Subgraph["bus"]>;
  const byPort = new Map<string, Array<{ bus: Bus; map: Array<number | undefined> }>>();
  for (const sg of subgraphs) {
    if (!sg.bus) continue;
    for (const port of sg.bus.ports) {
      let list = byPort.get(port.key);
      if (!list) byPort.set(port.key, (list = []));
      list.push({ bus: sg.bus, map: port.map });
    }
  }
  for (const list of byPort.values()) {
    const a = list[0]!;
    for (let i = 1; i < list.length; i++) {
      const b = list[i]!;
      for (let m = 0; m < Math.min(a.map.length, b.map.length); m++) {
        const ia = a.map[m];
        const ib = b.map[m];
        if (ia === undefined || ib === undefined) continue;
        uf.union(memberNode(a.bus.members[ia]!, a.bus.memberPriority), memberNode(b.bus.members[ib]!, b.bus.memberPriority));
      }
    }
    for (const { bus } of list) {
      if (bus.memberPriority >= Priority.LocalLabel) continue;
      for (const k of bus.members) weak.set(k, Math.max(weak.get(k) ?? 0, bus.memberPriority));
    }
  }
  return weak;
}

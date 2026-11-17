/**
 * Electrical rules check (ERC), following KiCad's checks so results line up
 * with `kicad-cli sch erc`:
 *
 *  - pin_to_pin            pin type conflicts on a net (KiCad's pin matrix)
 *  - pin_not_driven        input pins with nothing driving them
 *  - power_pin_not_driven  power inputs with no power output on the net
 *  - pin_not_connected     a pin connected to nothing
 *  - no_connect_connected  a no-connect flag on a net that has other pins
 *  - no_connect_dangling   a no-connect flag not on any pin
 *  - label_dangling        a label not attached to anything
 *  - isolated_pin_label    a local label that only reaches one pin
 *  - wire_dangling         wires connected to nothing
 *  - unconnected_wire_endpoint
 *  - endpoint_off_grid     wire ends / pins off the connection grid
 *  - multiple_net_names    differently named labels on the same wire
 *  - similar_labels, similar_label_and_power, similar_power: names differing only by case
 *  - duplicate_reference   the same designator on two symbols
 *
 * Library checks (lib_symbol_issues, footprint_link_issues) need the symbol
 * and footprint libraries and are out of scope here.
 */
import { onSegment, pointKey, transformLibPoint, type Point } from "./geometry.js";
import { expandBusMembers } from "./bus.js";
import { escapeNetName, shownText, unitLetter, type Netlist, type SchematicPin, type SubgraphDetail } from "./connectivity.js";
import { unitPins, type Schematic, type SheetInstance } from "./project.js";
import type { PinType } from "./sheet.js";
import type { Severity } from "./parity.js";

export type ErcType =
  | "pin_to_pin"
  | "pin_not_driven"
  | "power_pin_not_driven"
  | "pin_not_connected"
  | "no_connect_connected"
  | "no_connect_dangling"
  | "label_dangling"
  | "isolated_pin_label"
  | "label_multiple_wires"
  | "wire_dangling"
  | "unconnected_wire_endpoint"
  | "endpoint_off_grid"
  | "multiple_net_names"
  | "similar_labels"
  | "hier_label_mismatch"
  | "missing_unit"
  | "missing_input_pin"
  | "missing_bidi_pin"
  | "missing_power_pin"
  | "different_unit_footprint"
  | "duplicate_sheet_names"
  | "same_local_global_label"
  | "unresolved_variable"
  | "single_global_label"
  | "field_name_whitespace"
  | "similar_label_and_power"
  | "similar_power"
  | "undefined_netclass"
  | "ground_pin_not_ground"
  | "bus_to_net_conflict"
  | "net_not_bus_member"
  | "different_unit_net"
  | "duplicate_reference";

export interface ErcItem {
  description: string;
  /** Sheet position in mm. */
  at: Point;
  /** The item's UUID in the file, where it has one (pins, labels). */
  uuid?: string;
  reference?: string;
  pin?: string;
}

export interface ErcViolation {
  type: ErcType;
  severity: "error" | "warning";
  message: string;
  /** Sheet instance path (UUIDs) and its human name path. */
  sheet: string;
  sheetName: string;
  /** The sheet kicad-cli files this under, when different (it files screen-level checks under the root). */
  kicadSheetName?: string;
  items: ErcItem[];
  /** Where KiCad puts the marker, when not at the first item (a wire's loose end): exclusions name it. */
  at?: Point;
}

export interface ErcOptions {
  severities?: Partial<Record<string, Severity>>;
  /** 12×12 matrix of 0 (ok), 1 (warning), 2 (error), in KiCad's pin type order. */
  pinMap?: number[][];
  /** Connection grid in mm (KiCad's default is 50 mil = 1.27 mm). */
  gridMm?: number;
  /** The project's net classes (names); a directive naming another is an error. Unknown: not checked. */
  netClasses?: string[];
  /** Findings accepted on purpose (the project's erc_exclusions): KiCad's entry and its comment. */
  exclusions?: Array<{ entry: string; comment: string }>;
}

// KiCad's pin type order for the conflict matrix.
const PIN_ORDER: PinType[] = [
  "input", "output", "bidirectional", "tri_state", "passive", "free",
  "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect",
];

const O = 0, W = 1, E = 2;
/** KiCad's default pin conflict matrix. */
export const DEFAULT_PIN_MAP: number[][] = [
  /* input  */ [O, O, O, O, O, O, W, O, O, O, O, E],
  /* output */ [O, E, O, W, O, O, W, O, E, E, E, E],
  /* bidi   */ [O, O, O, O, O, O, W, O, W, O, W, E],
  /* 3state */ [O, W, O, O, O, O, W, W, E, W, W, E],
  /* passive*/ [O, O, O, O, O, O, W, O, O, O, O, E],
  /* free   */ [O, O, O, O, O, O, O, O, O, O, O, O],
  /* unspec */ [W, W, W, W, W, O, W, W, W, W, W, E],
  /* pwr in */ [O, O, O, W, O, O, W, O, O, O, O, E],
  /* pwr out*/ [O, E, W, E, O, O, W, O, E, E, E, E],
  /* opencol*/ [O, E, O, W, O, O, W, O, E, O, O, E],
  /* openemi*/ [O, E, W, W, O, O, W, O, E, O, O, E],
  /* nc     */ [E, E, E, E, E, O, E, E, E, E, E, E],
];

const TYPE_LABEL: Record<PinType, string> = {
  input: "Input", output: "Output", bidirectional: "Bidirectional", tri_state: "Tri-state",
  passive: "Passive", free: "Free", unspecified: "Unspecified", power_in: "Power input",
  power_out: "Power output", open_collector: "Open collector", open_emitter: "Open emitter", no_connect: "Unconnected",
};

/** KiCad's names for pin shapes, as its ERC items describe pins. */
const SHAPE_LABEL: Record<string, string> = {
  line: "Line", inverted: "Inverted", clock: "Clock", inverted_clock: "Inverted clock", input_low: "Input low",
  clock_low: "Clock low", output_low: "Output low", edge_clock_high: "Falling edge clock", non_logic: "NonLogic",
};

const DEFAULT_SEVERITY: Record<ErcType, "error" | "warning"> = {
  pin_to_pin: "warning", pin_not_driven: "error", power_pin_not_driven: "error", pin_not_connected: "error",
  no_connect_connected: "warning", no_connect_dangling: "warning", label_dangling: "error", isolated_pin_label: "warning",
  label_multiple_wires: "warning", wire_dangling: "error", unconnected_wire_endpoint: "warning", endpoint_off_grid: "warning",
  multiple_net_names: "warning", similar_labels: "warning", duplicate_reference: "error", hier_label_mismatch: "error",
  missing_unit: "warning", missing_input_pin: "warning", missing_bidi_pin: "warning", missing_power_pin: "error", different_unit_footprint: "error",
  duplicate_sheet_names: "error", same_local_global_label: "warning", unresolved_variable: "error",
  single_global_label: "warning", field_name_whitespace: "warning", similar_label_and_power: "warning", similar_power: "warning", undefined_netclass: "error", ground_pin_not_ground: "warning", different_unit_net: "error", bus_to_net_conflict: "error", net_not_bus_member: "warning",
};

/** ERC settings from a .kicad_pro: rule severities, pin map, connection grid. */
export function projectErcSettings(kicadPro: string): ErcOptions {
  try {
    const json = JSON.parse(kicadPro) as {
      erc?: { rule_severities?: Record<string, Severity>; pin_map?: number[][]; erc_exclusions?: unknown[] };
      schematic?: { connection_grid_size?: number };
      net_settings?: { classes?: Array<{ name?: string }> };
    };
    const grid = json.schematic?.connection_grid_size;
    return {
      severities: json.erc?.rule_severities,
      pinMap: json.erc?.pin_map?.length === 12 ? json.erc.pin_map : undefined,
      gridMm: grid ? grid * 0.0254 : undefined,
      exclusions: (json.erc?.erc_exclusions ?? []).map((e) => (Array.isArray(e) ? { entry: String(e[0]), comment: String(e[1] ?? "") } : { entry: String(e), comment: "" })),
      netClasses: Array.isArray(json.net_settings?.classes) ? json.net_settings.classes.map((c) => String(c?.name ?? "")).filter(Boolean) : undefined,
    };
  } catch {
    return {};
  }
}

const DRIVEN: PinType[] = ["input", "power_in"];
const DRIVING: PinType[] = ["output", "power_out", "passive", "tri_state", "bidirectional"];

const pinDesc = (p: SchematicPin) =>
  `Symbol ${p.reference} ${p.hidden ? "Hidden pin" : "Pin"} ${p.number} [${p.name && p.name !== "~" ? `${p.name}, ` : ""}${TYPE_LABEL[p.type]}, ${SHAPE_LABEL[p.shape] ?? "Line"}]`;
const pinItem = (p: SchematicPin): ErcItem => ({ description: pinDesc(p), at: p.at, reference: p.reference, pin: p.number, ...(p.uuid && { uuid: p.uuid }) });
/** Stacked pins (same symbol, position and type) count as one. */
const stacked = (a: SchematicPin, b: SchematicPin) =>
  a.symbolUuid === b.symbolUuid && a.type === b.type && pointKey(a.at) === pointKey(b.at);
const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

export function runErc(schematic: Schematic, netlist: Netlist, options: ErcOptions = {}): ErcViolation[] {
  if (!netlist.detail) throw new Error("runErc needs a netlist built with { detail: true }");
  const out: ErcViolation[] = [];
  const pinMap = options.pinMap ?? DEFAULT_PIN_MAP;
  const report: Report = (type, sheet, message, items, severity, kicadSheet, markerAt) => {
    const configured = options.severities?.[type];
    if (configured === "ignore") return;
    out.push({
      type,
      severity: configured === "error" || configured === "warning" ? configured : (severity ?? DEFAULT_SEVERITY[type]),
      message,
      sheet: sheet.path,
      sheetName: sheet.namePath,
      kicadSheetName: kicadSheet && kicadSheet !== sheet ? kicadSheet.namePath : undefined,
      items,
      ...(markerAt && { at: markerAt }),
    });
  };

  for (const group of netlist.detail.groups) {
    checkNet(group.subgraphs, pinMap, report);
    const netPins = uniquePins(group.subgraphs.flatMap((s) => s.pins));
    for (const sg of group.subgraphs) checkSubgraph(sg, group.subgraphs, netPins, report);
  }
  checkDanglingWires(netlist, report);
  // Screen-level checks run once per sheet file. kicad-cli files them under
  // the root sheet, so we do the same to stay comparable.
  const files = new Set<string>();
  for (const sheet of schematic.sheets) {
    if (files.has(sheet.file)) continue;
    files.add(sheet.file);
    const asRoot: Report = (type, sheet, message, items, severity) => report(type, sheet, message, items, severity, schematic.root);
    checkSheetGeometry(sheet, schematic, options.gridMm ?? 1.27, asRoot);
  }
  checkSheetPins(schematic, report);
  checkUnits(schematic, report);
  checkSheetContents(schematic, report);
  checkSingleGlobalLabels(schematic, report);
  checkSimilarNames(schematic, netlist, report);
  checkFieldNames(schematic, report);
  checkPinNets(schematic, netlist, report);
  checkBuses(schematic, netlist, report);
  if (options.netClasses) checkNetClassNames(schematic, new Set([...options.netClasses, "Default"]), report);
  checkDuplicateReferences(schematic, report);
  return out;
}

type Report = (
  type: ErcType,
  sheet: SheetInstance,
  message: string,
  items: ErcItem[],
  severity?: "error" | "warning",
  kicadSheet?: SheetInstance,
  /** The marker's place, when not at the first item. */
  markerAt?: Point,
) => void;

// ---------------------------------------------------------------------------
// Per net: pin conflicts and drivers
// ---------------------------------------------------------------------------

function checkNet(subgraphs: SubgraphDetail[], pinMap: number[][], report: Report) {
  const pins = subgraphs.flatMap((sg) => sg.pins.map((pin) => ({ pin, sheet: sg.sheet })));
  if (!pins.length) return;
  pins.sort((a, b) => natural(a.pin.reference, b.pin.reference) || natural(a.pin.number, b.pin.number));
  const hasNoConnect = subgraphs.some((sg) => sg.noConnects.length > 0);
  const powerNet = pins.some((p) => p.pin.type === "power_in");

  let needsDriver: (typeof pins)[number] | undefined;
  let hasDriver = false;
  // Precompute per-pin keys: this is O(n²) on big power nets.
  const typeIdx = pins.map((p) => PIN_ORDER.indexOf(p.pin.type));
  const stackKey = pins.map((p) => `${p.pin.symbolUuid}|${p.pin.type}|${pointKey(p.pin.at)}|${p.sheet.path}`);
  const level = (a: number, b: number) => {
    const l = pinMap[typeIdx[a]!]?.[typeIdx[b]!] ?? 0;
    return l && stackKey[a] === stackKey[b] ? 0 : l;
  };
  const count = new Array<number>(pins.length).fill(0);
  pins.forEach((ref, i) => {
    const t = ref.pin.type;
    if (DRIVEN.includes(t)) {
      // Report the most useful pin: a visible one, and a power input on power nets.
      const nt = needsDriver?.pin.type;
      // A power symbol's pin counts as visible even though it is drawn hidden.
      const hidden = (q: SchematicPin) => q.hidden && !q.powerSymbol;
      if (!needsDriver || (hidden(needsDriver.pin) && !hidden(ref.pin)) || (powerNet !== (nt === "power_in") && powerNet === (t === "power_in"))) {
        needsDriver = ref;
      }
    }
    hasDriver ||= powerNet ? t === "power_out" : DRIVING.includes(t);
    for (let j = i + 1; j < pins.length; j++) {
      if (level(i, j) !== 0) {
        count[i]!++;
        count[j]!++;
      }
    }
  });

  // Report conflicts the way kicad-cli does: visit pins with the most
  // conflicts first and report each against its nearest conflicting pin that
  // hasn't been reported yet. A pin whose partners were all reported before
  // it (e.g. a GND symbol next to many parts) gets no report of its own.
  const order = pins.map((_, i) => i).filter((i) => count[i]! > 0).sort((a, b) => count[b]! - count[a]! || typeIdx[b]! - typeIdx[a]! || a - b);
  const done = new Set<number>();
  for (const p of order) {
    if (done.has(p)) continue;
    const self = pins[p]!;
    let nearest = -1;
    let best = Infinity;
    for (let q = 0; q < pins.length; q++) {
      if (q === p || done.has(q) || !level(p, q)) continue;
      const o = pins[q]!;
      const d = o.sheet === self.sheet ? Math.hypot(o.pin.at.x - self.pin.at.x, o.pin.at.y - self.pin.at.y) : 1e9;
      if (d < best) [best, nearest] = [d, q];
    }
    if (nearest < 0) continue;
    const other = pins[nearest]!;
    report(
      "pin_to_pin",
      self.sheet,
      `Pins of type ${TYPE_LABEL[self.pin.type]} and ${TYPE_LABEL[other.pin.type]} are connected`,
      [pinItem(self.pin), pinItem(other.pin)],
      level(p, nearest) === 2 ? "error" : "warning",
    );
    done.add(p);
  }

  if (needsDriver && !hasDriver && !hasNoConnect) {
    const power = needsDriver.pin.type === "power_in";
    report(
      power ? "power_pin_not_driven" : "pin_not_driven",
      needsDriver.sheet,
      power ? "Input Power pin not driven by any Output Power pins" : "Input pin not driven by any Output pins",
      [pinItem(needsDriver.pin)],
    );
  }
}

// ---------------------------------------------------------------------------
// Per sheet-local subgraph: connections, no-connects, labels, names
// ---------------------------------------------------------------------------

function uniquePins(pins: SchematicPin[]): SchematicPin[] {
  const seen = new Set<string>();
  return pins.filter((p) => {
    const k = `${p.symbolUuid}|${p.type}|${pointKey(p.at)}`;
    return !seen.has(k) && !!seen.add(k);
  });
}

function checkSubgraph(sg: SubgraphDetail, net: SubgraphDetail[], netPins: SchematicPin[], report: Report) {
  const sheet = sg.sheet;
  const labels = sg.labels.map((i) => sheet.data.labels[i]!);

  if (sg.noConnects.length) {
    const nc = sg.noConnects[0]!;
    if (netPins.length > 1) {
      // Name the pin under the flag when there is one.
      const first =
        sg.pins.find((p) => p.powerSymbol) ?? sg.pins.find((p) => pointKey(p.at) === pointKey(nc)) ?? sg.pins[0] ?? netPins[0]!;
      report("no_connect_connected", sheet, 'A pin with a "no connection" flag is connected', [pinItem(first), { description: "No Connect", at: nc }]);
    } else if (!sg.pins.length && !labels.length && !sg.sheetPins) {
      report("no_connect_dangling", sheet, 'Unconnected "no connection" flag', [{ description: "No Connect", at: nc }]);
    }
  } else if (sg.pins.length) {
    // Other connections: a second (non-stacked) pin, or anything that names the net.
    const pins = sg.pins;
    let other = labels.length > 0 || sg.sheetPins > 0;
    for (let i = 1; i < pins.length && !other; i++) if (!stacked(pins[i]!, pins[0]!)) other = true;
    const pin = pins.find((p) => p.type === "power_in" && !p.powerSymbol) ?? pins[0]!;
    // Hidden power inputs connect by name, without a wire.
    const implicit = pin.type === "power_in" && pin.hidden && !pin.powerSymbol;
    if (!other && !implicit && pin.type !== "no_connect" && pin.type !== "free") {
      report("pin_not_connected", sheet, "Pin not connected", [pinItem(pin)]);
    }
  }

  // Labels.
  const busLabel = (text: string) => !!expandBusMembers(text, sheet.data.busAliases);
  // A bus label on wires: a bus name where a net belongs (KiCad reports the first wire and that label).
  const firstBusLabel = labels.find((l) => busLabel(l.text));
  if (firstBusLabel && sg.wires.length) {
    const w = sheet.data.wires[sg.wires[0]!]!;
    report("bus_to_net_conflict", sheet, "Invalid connection between bus and net items", [{ description: wireDesc(w), at: w.a, ...(w.uuid && { uuid: w.uuid }) }, { description: labelDesc(firstBusLabel), at: firstBusLabel.at, ...(firstBusLabel.uuid && { uuid: firstBusLabel.uuid }) }]);
  }
  // A label sitting on a bus belongs to the bus (see checkBuses), not loose.
  const onBus = (p: Point) => sheet.data.buses.some((b) => onSegment(p, b.a, b.b));
  for (const [k, label] of labels.entries()) {
    if (busLabel(label.text)) continue;
    const item: ErcItem = { description: `${label.kind === "local" ? "Label" : label.kind === "global" ? "Global Label" : "Hierarchical Label"} '${label.text}'`, at: label.at, ...(label.uuid && { uuid: label.uuid }) };
    const alone = !sg.wires.length && !sg.pins.length && !sg.sheetPins && labels.length === 1 && !sg.noConnects.length && !onBus(label.at);
    if (alone) report("label_dangling", sheet, "Label not connected", [item]);
    else if (label.kind === "local" && k === 0) {
      const nonPowerPins = netPins.filter((p) => !p.powerSymbol);
      const sameName = net.reduce((n, s) => n + s.labels.filter((i) => s.sheet.data.labels[i]!.text === label.text).length, 0);
      // Bus members connect through the bus, so they are never "isolated".
      // Observed in kicad-cli: this check only fires on the root sheet.
      if (sheet.parent === undefined && !sg.busMember && nonPowerPins.length === 1 && sameName === 1 && netPins.length === 1) report("isolated_pin_label", sheet, "Label connected to only one pin", [item]);
    }
  }

  // Differently named labels / power symbols on the same wire.
  const names = new Map<string, { priority: number; item: ErcItem }>();
  const prio = { global: 7, local: 4, hierarchical: 3 } as const;
  for (const label of labels) {
    if (busLabel(label.text)) continue;
    const key = escapeNetName(label.text);
    const p = prio[label.kind];
    if (!names.has(key) || names.get(key)!.priority < p) names.set(key, { priority: p, item: { description: `Label '${label.text}'`, at: label.at, ...(label.uuid && { uuid: label.uuid }) } });
  }
  for (const pin of sg.pins) {
    if (!pin.powerSymbol || !pin.powerName || pin.type !== "power_in") continue;
    const key = escapeNetName(pin.powerName);
    if (!names.has(key) || names.get(key)!.priority < 6) names.set(key, { priority: 6, item: { ...pinItem(pin), description: `Symbol ${pin.reference} Pin ${pin.number} [${TYPE_LABEL[pin.type]}]` } });
  }
  // Bus members get their name from the bus, so a second label isn't a conflict.
  if (names.size > 1 && !sg.busMember) {
    const ranked = [...names.entries()].sort((a, b) => b[1].priority - a[1].priority || (a[0] < b[0] ? -1 : 1));
    const [chosen, second] = [ranked[0]!, ranked[1]!];
    report(
      "multiple_net_names",
      sheet,
      `Both ${chosen[0]} and ${second[0]} are attached to the same items; ${chosen[0]} will be used in the netlist`,
      [chosen[1].item, second[1].item],
    );
  }
}

// ---------------------------------------------------------------------------
// Per sheet file: wires, grid
// ---------------------------------------------------------------------------

function checkSheetGeometry(sheet: SheetInstance, schematic: Schematic, grid: number, report: Report) {
  const data = sheet.data;
  const points = new Map<string, number>();
  const add = (p: Point) => points.set(pointKey(p), (points.get(pointKey(p)) ?? 0) + 1);
  for (const w of data.wires) [w.a, w.b].forEach(add);
  for (const e of data.busEntries) [e.a, e.b].forEach(add);
  for (const b of data.buses) [b.a, b.b].forEach(add);
  for (const j of data.junctions) add(j);
  for (const l of data.labels) add(l.at);
  for (const n of data.noConnects) add(n);
  for (const s of data.sheets) for (const p of s.pins) add(p.at);
  const pinPoints: Array<{ at: Point; reference: string; number: string; symbol: string; uuid?: string }> = [];
  for (const pl of schematic.placements) {
    if (pl.sheet !== sheet || !pl.lib) continue;
    for (const pin of unitPins(pl.lib, pl.unit, pl.symbol.bodyStyle)) {
      const at = transformLibPoint(pin.at, pl.symbol, pl.symbol.at);
      add(at);
      // No-connect pins are never wired, so their grid position doesn't matter.
      if (pin.type !== "no_connect") pinPoints.push({ at, reference: pl.reference, number: pin.number, symbol: pl.symbol.uuid, uuid: pl.symbol.pinUuids[pin.number] });
    }
  }

  data.wires.forEach((w, i) => {
    // An end is connected when something else is there, or it lands on another wire or bus.
    const connected = (p: Point) =>
      (points.get(pointKey(p)) ?? 0) > 1 ||
      data.wires.some((o, j) => j !== i && onSegment(p, o.a, o.b));
    // One report per loose end, as KiCad does.
    for (const end of [w.a, w.b]) {
      if (!connected(end)) report("unconnected_wire_endpoint", sheet, "Unconnected wire endpoint", [{ description: wireDesc(w), at: w.a, ...(w.uuid && { uuid: w.uuid }) }], undefined, undefined, end);
    }
  });

  // Off-grid: in KiCad's 100 nm units, so the test is exact.
  const g = Math.round(grid * 1e4);
  const off = (p: Point) => Math.round(p.x * 1e4) % g !== 0 || Math.round(p.y * 1e4) % g !== 0;
  for (const w of data.wires) if (off(w.a) || off(w.b)) report("endpoint_off_grid", sheet, "Symbol pin or wire end off connection grid", [{ description: wireDesc(w), at: w.a, ...(w.uuid && { uuid: w.uuid }) }]);
  for (const b of data.buses) if (off(b.a) || off(b.b)) report("endpoint_off_grid", sheet, "Symbol pin or wire end off connection grid", [{ description: "Bus", at: b.a, ...(b.uuid && { uuid: b.uuid }) }]);
  for (const e of data.busEntries) for (const end of [e.a, e.b]) if (off(end)) report("endpoint_off_grid", sheet, "Symbol pin or wire end off connection grid", [{ description: "Bus to wire entry", at: e.a, ...(e.uuid && { uuid: e.uuid }) }]);
  // One report per symbol, at its first off-grid pin.
  const reported = new Set<string>();
  for (const p of pinPoints) if (off(p.at) && !reported.has(p.symbol) && reported.add(p.symbol)) report("endpoint_off_grid", sheet, "Symbol pin or wire end off connection grid", [{ description: `Symbol ${p.reference} Pin ${p.number}`, at: p.at, reference: p.reference, pin: p.number, ...(p.uuid && { uuid: p.uuid }) }]);

  // A label that is the only thing joining wires: wires ending at the label
  // already connect to each other, but each wire it sits in the middle of is
  // joined only through the label.
  for (const l of data.labels) {
    const wires = data.wires.filter((w) => onSegment(l.at, w.a, w.b));
    const k = pointKey(l.at);
    const ends = wires.filter((w) => pointKey(w.a) === k || pointKey(w.b) === k).length;
    const pieces = wires.length - ends + (ends > 0 ? 1 : 0);
    if (pieces > 1 && !data.junctions.some((j) => pointKey(j) === k)) {
      report("label_multiple_wires", sheet, "Label connects more than one wire", [{ description: `Label '${l.text}'`, at: l.at, ...(l.uuid && { uuid: l.uuid }) }, { description: wireDesc(wires[0]!), at: wires[0]!.a, ...(wires[0]!.uuid && { uuid: wires[0]!.uuid }) }]);
    }
  }
}

/** Wires with no connection to anything (no pins, labels or sheet pins in their subgraph). */
function checkDanglingWires(netlist: Netlist, report: Report) {
  for (const group of netlist.detail!.groups) {
    for (const sg of group.subgraphs) {
      if (!sg.wires.length || sg.pins.length || sg.labels.length || sg.sheetPins || sg.noConnects.length) continue;
      const w = sg.sheet.data.wires[sg.wires[0]!]!;
      report("wire_dangling", sg.sheet, "Wires not connected to anything", [{ description: "Wire", at: w.a, ...(w.uuid && { uuid: w.uuid }) }]);
    }
  }
}

// ---------------------------------------------------------------------------
// Design-wide checks
// ---------------------------------------------------------------------------


/** A sheet symbol's pins and the hierarchical labels inside its sheet go in pairs, by name. */
function checkSheetPins(schematic: Schematic, report: Report) {
  for (const sheet of schematic.sheets) {
    if (!sheet.ref || !sheet.parent) continue;
    const labels = sheet.data.labels.filter((l) => l.kind === "hierarchical");
    const pins = new Set(sheet.ref.pins.map((p) => p.name));
    const names = new Set(labels.map((l) => l.text));
    for (const pin of sheet.ref.pins) {
      if (names.has(pin.name)) continue;
      report("hier_label_mismatch", sheet.parent, `Sheet pin ${pin.name} has no matching hierarchical label inside the sheet`, [{ description: `Hierarchical Sheet Pin '${pin.name}'`, at: pin.at, ...(pin.uuid && { uuid: pin.uuid }) }]);
    }
    for (const label of labels) {
      if (pins.has(label.text)) continue;
      report("hier_label_mismatch", sheet, `Hierarchical label ${label.text} has no matching sheet pin in the parent sheet`, [{ description: `Hierarchical Label '${label.text}'`, at: label.at, ...(label.uuid && { uuid: label.uuid }) }]);
    }
  }
}

/** Parts with several units: every unit placed, and all with one footprint. */
function checkUnits(schematic: Schematic, report: Report) {
  for (const c of schematic.components) {
    const lib = c.lib;
    if (!lib || lib.unitCount < 2) continue;
    const units = [...c.units].sort((a, b) => a.unit - b.unit);
    const first = units[0]!;
    const name = c.libId.slice(c.libId.indexOf(":") + 1);
    const item = (u: (typeof units)[number]): ErcItem => ({ description: `Symbol ${c.reference} [${name}]`, at: u.symbol.at, reference: c.reference });
    const placed = new Set(units.map((u) => u.unit));
    const missing = Array.from({ length: lib.unitCount }, (_, i) => i + 1).filter((u) => !placed.has(u));
    const letters = (list: number[]) => `[ ${list.map(unitLetter).join(", ")} ]`;
    if (missing.length) {
      report("missing_unit", first.sheet, `Symbol ${c.reference} has unplaced units ${letters(missing)}`, [item(first)]);
      // What the missing units leave open: their inputs, supply pins and bidirectional pins (KiCad counts the pins all units share, too).
      const withPins = (types: string[]) => missing.filter((u) => lib.pins.some((p) => (p.unit === u || p.unit === 0) && types.includes(p.type)));
      const inputs = withPins(["input"]);
      const power = withPins(["power_in"]);
      const bidi = withPins(["bidirectional"]);
      if (inputs.length) report("missing_input_pin", first.sheet, `Symbol ${c.reference} has input pins in units ${letters(inputs)} that are not placed`, [item(first)]);
      if (power.length) report("missing_power_pin", first.sheet, `Symbol ${c.reference} has input power pins in units ${letters(power)} that are not placed`, [item(first)]);
      if (bidi.length) report("missing_bidi_pin", first.sheet, `Symbol ${c.reference} has bidirectional pins in units ${letters(bidi)} that are not placed`, [item(first)]);
    }
    const footprint = first.symbol.properties["Footprint"] ?? "";
    for (const u of units.slice(1)) {
      if ((u.symbol.properties["Footprint"] ?? "") === footprint) continue;
      report("different_unit_footprint", first.sheet, `Different footprints assigned to ${c.reference}${unitLetter(first.unit)} and ${c.reference}${unitLetter(u.unit)}`, [item(first), item(u)]);
    }
  }
}

/** What is on each sheet: sheet symbols with one name, a local label named like a global one, texts with a variable that names nothing. */
function checkSheetContents(schematic: Schematic, report: Report) {
  const files = new Set<string>();
  const globals = new Map<string, { sheet: SheetInstance; at: Point }>();
  for (const sheet of schematic.sheets) for (const l of sheet.data.labels) if (l.kind === "global" && !globals.has(l.text)) globals.set(l.text, { sheet, at: l.at, ...(l.uuid && { uuid: l.uuid }) });
  for (const sheet of schematic.sheets) {
    // Once per file, as KiCad checks its screens.
    if (files.has(sheet.file)) continue;
    files.add(sheet.file);
    const byName = new Map<string, typeof sheet.data.sheets>();
    for (const s of sheet.data.sheets) byName.set(s.name.toLowerCase(), [...(byName.get(s.name.toLowerCase()) ?? []), s]);
    for (const same of byName.values()) {
      if (same.length < 2) continue;
      const sorted = [...same].sort((a, b) => a.at.x - b.at.x || a.at.y - b.at.y);
      report("duplicate_sheet_names", sheet, "Duplicate sheet names within a given sheet", sorted.slice(0, 2).map((s) => ({ description: `Hierarchical Sheet '${s.name}'`, at: s.at })));
    }
    for (const l of sheet.data.labels) {
      const global = l.kind === "local" ? globals.get(l.text) : undefined;
      if (global) report("same_local_global_label", global.sheet, "Local and global labels have same name", [{ description: `Global Label '${l.text}'`, at: global.at }, { description: `Label '${l.text}'`, at: l.at, ...(l.uuid && { uuid: l.uuid }) }]);
    }
    for (const t of sheet.data.texts) {
      const shown = shownText(t.text, sheet, schematic);
      if (/\$\{[^{}]+\}/.test(shown)) report("unresolved_variable", sheet, "Unresolved text variable", [{ description: `Graphic Text '${shown}'`, at: t.at }]);
    }
  }
}

/** A global label with no other of its name. */
function checkSingleGlobalLabels(schematic: Schematic, report: Report) {
  const count = new Map<string, number>();
  for (const sheet of schematic.sheets) for (const l of sheet.data.labels) if (l.kind === "global") count.set(shownText(l.text, sheet, schematic), (count.get(shownText(l.text, sheet, schematic)) ?? 0) + 1);
  const files = new Set<string>();
  for (const sheet of schematic.sheets) {
    if (files.has(sheet.file)) continue;
    files.add(sheet.file);
    for (const l of sheet.data.labels) {
      if (l.kind === "global" && count.get(shownText(l.text, sheet, schematic)) === 1) report("single_global_label", sheet, "Global label only appears once in the schematic", [{ description: `Global Label '${l.text}'`, at: l.at, ...(l.uuid && { uuid: l.uuid }) }]);
    }
  }
}

/**
 * Names that differ only in case, as KiCad finds them in one pass: every label and power pin on
 * a net, grouped by its name in lower case and ordered by sheet path and UUID; each pair with
 * different spellings is reported once (two local labels on different sheets are fine) as
 * similar labels, a similar label and power net, or similar power nets.
 */
function checkSimilarNames(schematic: Schematic, netlist: Netlist, report: Report) {
  type Entry = { text: string; sheet: SheetInstance; uuid: string; item: ErcItem; kind: "label" | "local" | "power" };
  const groups = new Map<string, Entry[]>();
  const add = (e: Entry) => groups.set(e.text.toLowerCase(), [...(groups.get(e.text.toLowerCase()) ?? []), e]);
  for (const group of netlist.detail!.groups) {
    for (const sg of group.subgraphs) {
      for (const i of sg.labels) {
        const l = sg.sheet.data.labels[i]!;
        const text = shownText(l.text, sg.sheet, schematic);
        const kind = l.kind === "global" ? "Global Label" : l.kind === "hierarchical" ? "Hierarchical Label" : "Label";
        add({ text, sheet: sg.sheet, uuid: l.uuid ?? "", item: { description: `${kind} '${l.text}'`, at: l.at, ...(l.uuid && { uuid: l.uuid }) }, kind: l.kind === "local" ? "local" : "label" });
      }
      for (const p of sg.pins) if (p.powerName !== undefined) add({ text: p.powerName, sheet: sg.sheet, uuid: p.uuid ?? "", item: pinItem(p), kind: "power" });
    }
  }
  for (const key of [...groups.keys()].sort()) {
    const entries = groups.get(key)!.sort((a, b) => (a.sheet.path !== b.sheet.path ? (a.sheet.path < b.sheet.path ? -1 : 1) : a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]!;
        const b = entries[j]!;
        if (a.text === b.text) continue;
        if (a.kind === "local" && b.kind === "local" && a.sheet !== b.sheet) continue;
        const powers = Number(a.kind === "power") + Number(b.kind === "power");
        if (powers === 2) report("similar_power", a.sheet, "Power pins are similar (lower/upper case difference only)", [a.item, b.item]);
        else if (powers === 1) report("similar_label_and_power", a.sheet, "Power pin and label are similar (lower/upper case difference only)", [a.item, b.item]);
        else report("similar_labels", a.sheet, "Labels are similar (lower/upper case difference only)", [a.item, b.item]);
      }
    }
  }
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** Schematic positions in KiCad's internal units (100 nm). */
const iu = (mm: number) => Math.round(mm * 1e4);

/**
 * A finding as KiCad writes it in erc_exclusions: check|x|y|main item|other item|sheet|main
 * item's sheet|other item's sheet. Items whose UUID isn't known here are written as nil.
 */
export function ercExclusionEntry(v: ErcViolation): string {
  const at = v.at ?? v.items[0]?.at ?? { x: 0, y: 0 };
  return [v.type, iu(at.x), iu(at.y), v.items[0]?.uuid ?? NIL_UUID, v.items[1]?.uuid ?? NIL_UUID, v.sheet, v.sheet, v.items[1] ? v.sheet : ""].join("|");
}

/**
 * Is a finding excluded? KiCad matches its whole string; this file doesn't know every item's
 * UUID, so a finding matches an entry of the same check at the same place on the same sheet
 * (an entry naming no sheet matches any).
 */
export function isErcExcluded(v: ErcViolation, entries: string[]): boolean {
  const at = v.at ?? v.items[0]?.at;
  if (!at) return false;
  const sheet = v.kicadSheetName ? undefined : v.sheet;
  return entries.some((e) => {
    const [type, x, y, , , specific, mainPath] = e.split("|");
    if (type !== v.type || Number(x) !== iu(at.x) || Number(y) !== iu(at.y)) return false;
    const paths = [specific, mainPath].filter(Boolean);
    return !paths.length || !sheet || paths.includes(sheet);
  });
}

/**
 * Two checks on the nets of a part's pins. A part with a supply pin on a ground net whose other
 * supply pin is named like ground (GND, AGND, PGND…) but isn't on one (ground_pin_not_ground);
 * the same pin of a multi-unit part (a supply pin shared by all units) on different nets in
 * different units (different_unit_net).
 */
function checkPinNets(schematic: Schematic, netlist: Netlist, report: Report) {
  const isGround = (t: string) => {
    const u = t.toUpperCase();
    // Only names with GND, as KiCad: VSS is the negative rail on dual-supply parts, which have a GND pin of their own.
    return u.includes("GND");
  };
  // Every pin with its net, sheet and symbol.
  type At = { pin: SchematicPin; net: string; sheet: SheetInstance };
  const all: At[] = [];
  for (const group of netlist.detail!.groups) for (const sg of group.subgraphs) for (const pin of sg.pins) all.push({ pin, net: group.name ?? "", sheet: sg.sheet });
  const bySymbol = new Map<string, At[]>();
  for (const a of all) {
    if (a.pin.powerSymbol) continue;
    const k = `${a.sheet.path}|${a.pin.symbolUuid}`;
    bySymbol.set(k, [...(bySymbol.get(k) ?? []), a]);
  }
  for (const pins of bySymbol.values()) {
    const power = pins.filter((a) => a.pin.type === "power_in" || a.pin.type === "power_out");
    if (!power.some((a) => isGround(a.net))) continue;
    for (const a of power) {
      if (isGround(a.pin.name) && !isGround(a.net)) report("ground_pin_not_ground", a.sheet, `Pin ${a.pin.name} not connected to ground net`, [pinItem(a.pin)]);
    }
  }
  const multi = new Set(schematic.placements.filter((p) => (p.lib?.unitCount ?? 1) > 1).map((p) => `${p.sheet.path}|${p.symbol.uuid}`));
  const first = new Map<string, At>();
  for (const a of all) {
    if (!multi.has(`${a.sheet.path}|${a.pin.symbolUuid}`)) continue;
    const k = `${a.pin.reference}:${a.pin.number}`;
    const seen = first.get(k);
    if (!seen) first.set(k, a);
    else if (seen.net !== a.net) report("different_unit_net", a.sheet, `Pin ${a.pin.number} is connected to both ${a.net} and ${seen.net}`, [pinItem(a.pin), pinItem(seen.pin)]);
  }
}

/** A subgraph driver's priority from a global power symbol up (connectivity's Priority.GlobalPower). */
const GLOBAL_POWER_PRIORITY = 6;

/** "Horizontal Wire, length 50.8 mm", as KiCad describes a wire or bus segment. */
function wireDesc(w: { a: Point; b: Point }, kind = "Wire"): string {
  const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  const dir = Math.abs(w.a.x - w.b.x) < 1e-6 ? "Vertical" : Math.abs(w.a.y - w.b.y) < 1e-6 ? "Horizontal" : "";
  return `${dir ? dir + " " : ""}${kind}, length ${len.toFixed(4).replace(/\.?0+$/, "")} mm`;
}
const labelDesc = (l: { kind: string; text: string }) => `${l.kind === "global" ? "Global Label" : l.kind === "hierarchical" ? "Hierarchical Label" : "Label"} '${l.text}'`;

/**
 * Per sheet, each bus (its connected segments) and what sits on it: a label with a plain net
 * name (bus_to_net_conflict), differently named labels (multiple_net_names), and wires through a
 * bus entry whose net isn't one of the bus's members (net_not_bus_member).
 */
function checkBuses(schematic: Schematic, netlist: Netlist, report: Report) {
  for (const sheet of schematic.sheets) {
    const { buses, labels, busEntries } = sheet.data;
    if (!buses.length) continue;
    const isBusName = (t: string) => !!expandBusMembers(shownText(t, sheet, schematic), sheet.data.busAliases);
    // Connected segments: one touching another's end, or sharing one.
    const group = buses.map((_, i) => i);
    const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i]!)));
    buses.forEach((a, i) => buses.forEach((b, j) => {
      if (j > i && [a.a, a.b].some((p) => onSegment(p, b.a, b.b)) || (j > i && [b.a, b.b].some((p) => onSegment(p, a.a, a.b)))) group[find(i)] = find(j);
    }));
    const groups = new Map<number, number[]>();
    buses.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
    // Wire ends: the name given to the wires there on this sheet (their strongest label), if any.
    const netAt = new Map<string, { name: string; priority: number }>();
    for (const g of netlist.detail!.groups) {
      for (const sg of g.subgraphs) {
        if (sg.sheet !== sheet || !sg.drivers.length) continue;
        const driver = [...sg.drivers].sort((a, b) => b.priority - a.priority)[0]!;
        for (const w of sg.wires) for (const p of [sheet.data.wires[w]!.a, sheet.data.wires[w]!.b]) netAt.set(pointKey(p), driver);
      }
    }
    for (const segs of groups.values()) {
      const on = labels.filter((l) => segs.some((i) => onSegment(l.at, buses[i]!.a, buses[i]!.b)));
      const first = buses[segs[0]!]!;
      const busItem: ErcItem = { description: wireDesc(first, "Bus"), at: first.a, ...(first.uuid && { uuid: first.uuid }) };
      const net = on.find((l) => !isBusName(l.text));
      if (net) report("bus_to_net_conflict", sheet, "Invalid connection between bus and net items", [{ description: labelDesc(net), at: net.at, ...(net.uuid && { uuid: net.uuid }) }, busItem]);
      const prio = { global: 7, local: 4, hierarchical: 3 } as const;
      const names = new Map<string, { priority: number; label: (typeof on)[number] }>();
      for (const l of on) {
        const key = escapeNetName(shownText(l.text, sheet, schematic));
        if (!names.has(key) || names.get(key)!.priority < prio[l.kind]) names.set(key, { priority: prio[l.kind], label: l });
      }
      if (names.size > 1) {
        const [chosen, second] = [...names.entries()].sort((a, b) => b[1].priority - a[1].priority || (a[0] < b[0] ? -1 : 1));
        report("multiple_net_names", sheet, `Both ${chosen![0]} and ${second![0]} are attached to the same items; ${chosen![0]} will be used in the netlist`, [
          { description: `Label '${chosen![1].label.text}'`, at: chosen![1].label.at, ...(chosen![1].label.uuid && { uuid: chosen![1].label.uuid }) },
          { description: `Label '${second![1].label.text}'`, at: second![1].label.at, ...(second![1].label.uuid && { uuid: second![1].label.uuid }) },
        ]);
      }
      // Wires through an entry must carry one of the bus's members.
      const busLabel = on.filter((l) => isBusName(l.text)).sort((a, b) => prio[b.kind] - prio[a.kind] || (a.text < b.text ? -1 : 1))[0];
      if (!busLabel) continue;
      const members = new Set(expandBusMembers(shownText(busLabel.text, sheet, schematic), sheet.data.busAliases) ?? []);
      for (const e of busEntries) {
        const [busEnd, wireEnd] = segs.some((i) => onSegment(e.a, buses[i]!.a, buses[i]!.b)) ? [e.a, e.b] : segs.some((i) => onSegment(e.b, buses[i]!.a, buses[i]!.b)) ? [e.b, e.a] : [];
        if (!busEnd) continue;
        const driver = netAt.get(pointKey(wireEnd!));
        // A net named by a power symbol or a global label overrides the bus (KiCad: priority ≥ global power).
        if (!driver || driver.priority >= GLOBAL_POWER_PRIORITY) continue;
        const netName = driver.name;
        const local = netName.startsWith(sheet.namePath) ? netName.slice(sheet.namePath.length) : netName.replace(/^\//, "");
        if (members.has(local) || members.has(netName)) continue;
        report("net_not_bus_member", sheet, `Net ${netName} is graphically connected to bus ${sheet.namePath}${busLabel.text} but is not a member of that bus`, [{ description: "Bus to wire entry", at: e.a, ...(e.uuid && { uuid: e.uuid }) }, busItem]);
      }
    }
  }
}

/** Directives and labels naming a net class the project doesn't have. */
function checkNetClassNames(schematic: Schematic, known: Set<string>, report: Report) {
  const names = (fields?: Record<string, string>) => (fields?.["Netclass"] ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const files = new Set<string>();
  for (const sheet of schematic.sheets) {
    if (files.has(sheet.file)) continue;
    files.add(sheet.file);
    for (const d of sheet.data.directives) {
      for (const n of names(d.fields)) if (!known.has(n)) report("undefined_netclass", sheet, `Netclass ${n} is not defined`, [{ description: `Directive Label [Net Class ${n}]`, at: d.at }]);
    }
    for (const l of sheet.data.labels) {
      const kind = l.kind === "global" ? "Global Label" : l.kind === "hierarchical" ? "Hierarchical Label" : "Label";
      for (const n of names(l.fields)) if (!known.has(n)) report("undefined_netclass", sheet, `Netclass ${n} is not defined`, [{ description: `${kind} '${l.text}'`, at: l.at, ...(l.uuid && { uuid: l.uuid }) }]);
    }
  }
}

/** Field names with spaces before or after them. */
function checkFieldNames(schematic: Schematic, report: Report) {
  const files = new Set<string>();
  for (const sheet of schematic.sheets) {
    if (files.has(sheet.file)) continue;
    files.add(sheet.file);
    for (const pl of schematic.placements.filter((p) => p.sheet === sheet)) {
      for (const name of Object.keys(pl.symbol.properties)) {
        if (name === name.trim()) continue;
        const value = pl.symbol.properties[name]!;
        report("field_name_whitespace", sheet, `Field name has leading or trailing whitespace: '${name}'`, [
          { description: `Symbol ${pl.reference} [${pl.symbol.libId.slice(pl.symbol.libId.indexOf(":") + 1)}]`, at: pl.symbol.at, reference: pl.reference },
          { description: `Field ${name} '${value}'`, at: pl.symbol.fieldAt[name] ?? pl.symbol.at },
        ]);
      }
    }
  }
}

function checkDuplicateReferences(schematic: Schematic, report: Report) {
  const seen = new Map<string, { uuid: string; unit: number }[]>();
  for (const pl of schematic.placements) {
    if (pl.reference.startsWith("#") || pl.reference.endsWith("?")) continue;
    const list = seen.get(pl.reference) ?? [];
    if (list.some((o) => o.uuid !== pl.symbol.uuid && o.unit === pl.unit)) {
      report("duplicate_reference", pl.sheet, `Duplicate reference designator ${pl.reference}`, [{ description: `Symbol ${pl.reference}`, at: pl.symbol.at, reference: pl.reference }]);
    }
    list.push({ uuid: pl.symbol.uuid, unit: pl.unit });
    seen.set(pl.reference, list);
  }
}

/**
 * Schematic ↔ board parity: does the board still match the schematic?
 *
 * The finding types and messages follow KiCad's own "schematic parity" DRC,
 * so engineers see familiar wording and results can be compared with
 * `kicad-cli pcb drc --schematic-parity`.
 */
import type { Board, Footprint } from "./board.js";
import type { Netlist } from "./connectivity.js";
import type { Component, Schematic } from "./project.js";

export type ParityType =
  | "missing_footprint"
  | "extra_footprint"
  | "duplicate_footprints"
  | "footprint_symbol_mismatch"
  | "footprint_symbol_field_mismatch"
  | "net_conflict";

export type Severity = "error" | "warning" | "ignore";

export interface ParityFinding {
  type: ParityType;
  severity: Severity;
  reference: string;
  message: string;
  pad?: string;
}

export interface ParityOptions {
  /** Per-check severities from the project's DRC settings (see `projectRuleSeverities`). */
  severities?: Partial<Record<string, Severity>>;
  /** Include findings whose severity is "ignore" (default false, as in KiCad). */
  includeIgnored?: boolean;
}

/** Rule severities from a .kicad_pro file (board.design_settings.rule_severities). */
export function projectRuleSeverities(kicadPro: string): Partial<Record<string, Severity>> {
  try {
    const json = JSON.parse(kicadPro) as { board?: { design_settings?: { rule_severities?: Record<string, Severity> } } };
    return json.board?.design_settings?.rule_severities ?? {};
  } catch {
    return {};
  }
}

/** Fields that are compared through dedicated checks, or are KiCad-internal. */
const SKIPPED_FIELDS = new Set(["Reference", "Value", "Footprint"]);
const isInternalField = (name: string) => name.startsWith("ki_");

export function checkParity(schematic: Schematic, netlist: Netlist, board: Board, options: ParityOptions = {}): ParityFinding[] {
  const findings: ParityFinding[] = [];
  const severities = options.severities ?? {};
  const push = (type: ParityType, reference: string, message: string, pad?: string) => {
    const severity = severities[type] ?? "warning";
    if (severity !== "ignore" || options.includeIgnored) findings.push({ type, severity, reference, message, pad });
  };

  // Net of every schematic pin, by "REF\0PIN".
  const pinNet = new Map<string, string>();
  for (const net of netlist.nets) for (const n of net.nodes) pinNet.set(`${n.reference}\0${n.pin}`, net.name);

  const components = schematic.components.filter((c) => c.onBoard);
  const byPath = new Map<string, Component>();
  const byRef = new Map<string, Component>();
  for (const c of components) {
    byRef.set(c.reference, c);
    for (const u of c.units) byPath.set(symbolPath(u.sheet.path, u.symbol.uuid), c);
  }

  // Footprint → component, by symbol path first, then by reference.
  const matched = new Map<Component, Footprint[]>();
  for (const fp of board.footprints) {
    const comp = (fp.path && byPath.get(fp.path)) || byRef.get(fp.reference);
    if (!comp) {
      // Board-only items (logos, fiducials marked so) and unnamed graphics are expected.
      if (!fp.attributes.boardOnly && fp.reference) push("extra_footprint", fp.reference, "Extra footprint");
      continue;
    }
    let list = matched.get(comp);
    if (!list) matched.set(comp, (list = []));
    list.push(fp);
  }
  for (const [comp, fps] of matched) {
    if (fps.length > 1) push("duplicate_footprints", comp.reference, `${fps.length} footprints for symbol ${comp.reference}`);
  }

  for (const comp of components) {
    const fps = matched.get(comp);
    if (!fps) {
      push("missing_footprint", comp.reference, `Missing footprint ${comp.reference} (${comp.value})`);
      continue;
    }
    for (const fp of fps) {
      compareFootprint(comp, fp, push);
      compareNets(comp, fp, pinNet, push);
    }
  }
  return findings;
}

/** Footprints store the symbol path without the root sheet's UUID. */
function symbolPath(sheetPath: string, symbolUuid: string): string {
  const parts = sheetPath.split("/").filter(Boolean).slice(1);
  return "/" + [...parts, symbolUuid].join("/");
}

type Push = (type: ParityType, reference: string, message: string, pad?: string) => void;

function compareFootprint(comp: Component, fp: Footprint, push: Push): void {
  const ref = comp.reference;
  if (fp.reference !== ref) push("footprint_symbol_mismatch", ref, `Reference differs (PCB: '${fp.reference}', Schematic: '${ref}')`);
  if (fp.value !== comp.value) push("footprint_symbol_mismatch", ref, `Value differs (PCB: '${fp.value}', Schematic: '${comp.value}')`);
  if (comp.footprint && fp.libId !== comp.footprint) {
    push("footprint_symbol_mismatch", ref, `${fp.libId} doesn't match footprint given by symbol (${comp.footprint})`);
  }

  const attrs: Array<[string, boolean, boolean]> = [
    ["Do not populate", fp.attributes.dnp, comp.dnp],
    ["Exclude from bill of materials", fp.attributes.excludeFromBom, !comp.inBom],
  ];
  for (const [label, pcb, sch] of attrs) {
    if (pcb !== sch) push("footprint_symbol_mismatch", ref, `Footprint attributes don't match symbol: '${label}' settings differ`);
  }

  // Only the symbol's fields are compared; extra board-side fields are fine.
  // "~" is KiCad's spelling of empty, and KiCad trims the symbol description.
  // Field names are case-insensitive: a later "DESCRIPTION" overrides "Description".
  const fields = new Map<string, [string, string]>();
  for (const [name, value] of Object.entries({ Datasheet: "", Description: "", ...comp.properties })) {
    fields.set(name.toLowerCase(), [fields.get(name.toLowerCase())?.[0] ?? name, value]);
  }
  const pcbFields = new Map(Object.entries(fp.properties).map(([k, v]) => [k.toLowerCase(), v]));
  for (const [key, [name, raw]] of fields) {
    if (SKIPPED_FIELDS.has(name) || isInternalField(name)) continue;
    const value = key === "description" ? raw.trim() : raw;
    const sch = value === "~" ? "" : value;
    const pcb = fp.properties[name] ?? pcbFields.get(key) ?? "";
    if (pcb !== sch) push("footprint_symbol_field_mismatch", ref, `Field '${name}' differs (PCB: '${pcb}', Schematic: '${sch}')`);
  }
}

function compareNets(comp: Component, fp: Footprint, pinNet: Map<string, string>, push: Push): void {
  const ref = comp.reference;
  const padNumbers = new Set<string>();
  for (const pad of fp.pads) {
    if (!pad.number) continue; // unnamed mechanical pads
    padNumbers.add(pad.number);
    const sch = pinNet.get(`${ref}\0${pad.number}`);
    if (sch === undefined) {
      if (pad.net) push("net_conflict", ref, `No corresponding pin found in schematic for pad ${pad.number} (${pad.net})`, pad.number);
    } else if (pad.net !== sch && !(sch.startsWith("unconnected-") && pad.net.startsWith(sch))) {
      // Pads sharing a number get unique "unconnected-(…)_1" names on the board.
      push("net_conflict", ref, `Pad net (${pad.net}) doesn't match net given by schematic (${sch})`, pad.number);
    }
  }
  for (const [key, net] of pinNet) {
    const [r, pin] = key.split("\0") as [string, string];
    if (r === ref && !padNumbers.has(pin)) push("net_conflict", ref, `No pad found for pin ${pin} (${net}) in schematic`, pin);
  }
}

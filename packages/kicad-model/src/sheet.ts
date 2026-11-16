/**
 * Reading a single .kicad_sch file into plain typed records.
 *
 * This layer knows the file format but nothing about hierarchy or
 * connectivity; `project.ts` and `connectivity.ts` build on it.
 */
import {
  arg,
  atomText,
  findChild,
  findChildren,
  headOf,
  isAtom,
  isList,
  parse,
  type List,
} from "@crossprobe/kicad-sexpr";
import type { Point } from "./geometry.js";

export type PinType =
  | "input"
  | "output"
  | "bidirectional"
  | "tri_state"
  | "passive"
  | "free"
  | "unspecified"
  | "power_in"
  | "power_out"
  | "open_collector"
  | "open_emitter"
  | "no_connect";

export interface LibPin {
  number: string;
  name: string;
  type: PinType;
  /** Connection point (the pin tip) in library coordinates, Y up. */
  at: Point;
  hidden: boolean;
  /** 0 = shared by all units. */
  unit: number;
  /** 0 = shared by all body styles (normal / De Morgan). */
  bodyStyle: number;
}

export type PowerKind = "global" | "local";

export interface LibSymbol {
  id: string;
  /** Number of units (gates); >1 means references get a unit letter (U1A). */
  unitCount: number;
  power?: PowerKind;
  pins: LibPin[];
  properties: Record<string, string>;
}

export interface SymbolInstance {
  /** Sheet instance path, e.g. "/<root-uuid>/<sheet-uuid>". */
  path: string;
  reference: string;
  unit: number;
}

export interface PlacedSymbol {
  uuid: string;
  libId: string;
  at: Point;
  rotation: number;
  mirrorX: boolean;
  mirrorY: boolean;
  unit: number;
  bodyStyle: number;
  properties: Record<string, string>;
  inBom: boolean;
  onBoard: boolean;
  dnp: boolean;
  excludeFromSim: boolean;
  instances: SymbolInstance[];
}

export interface Segment {
  a: Point;
  b: Point;
}

export type LabelKind = "local" | "global" | "hierarchical";

export interface Label {
  kind: LabelKind;
  text: string;
  at: Point;
  /** For global/hierarchical labels: input, output, bidirectional, tri_state, passive. */
  shape?: string;
}

export interface SheetPin {
  name: string;
  shape: string;
  at: Point;
}

export interface SheetRef {
  uuid: string;
  name: string;
  file: string;
  at: Point;
  size: Point;
  pins: SheetPin[];
}

export interface BusEntry {
  a: Point;
  b: Point;
}

export interface SheetFile {
  uuid: string;
  version: number;
  libSymbols: Map<string, LibSymbol>;
  symbols: PlacedSymbol[];
  wires: Segment[];
  buses: Segment[];
  busEntries: BusEntry[];
  junctions: Point[];
  noConnects: Point[];
  labels: Label[];
  sheets: SheetRef[];
  busAliases: Map<string, string[]>;
}

// ---------------------------------------------------------------------------

function point(node: List | undefined): Point {
  return { x: Number(arg(node, 0) ?? 0), y: Number(arg(node, 1) ?? 0) };
}

function text(node: List | undefined, index = 0): string {
  return String(arg(node, index) ?? "");
}

function flag(node: List | undefined, fallback: boolean): boolean {
  if (!node) return fallback;
  const v = arg(node, 0);
  return v === undefined ? true : v === "yes";
}

/** `(hide yes)` in v7+ files, a bare `hide` symbol in older ones. */
function isHidden(node: List): boolean {
  for (const c of node.children) {
    if (isAtom(c) && c.kind === "symbol" && c.raw === "hide") return true;
    if (headOf(c) === "hide") return flag(c as List, true);
  }
  return false;
}

function properties(node: List): Record<string, string> {
  const props: Record<string, string> = {};
  for (const p of findChildren(node, "property")) props[text(p, 0)] = text(p, 1);
  return props;
}

function parseLibSymbol(node: List): LibSymbol {
  const id = text(node, 0);
  const powerNode = findChild(node, "power");
  const power: PowerKind | undefined = powerNode ? (arg(powerNode, 0) === "local" ? "local" : "global") : undefined;
  const pins: LibPin[] = [];
  let unitCount = 1;
  for (const sub of findChildren(node, "symbol")) {
    // Unit sub-symbols are named "<name>_<unit>_<bodyStyle>".
    const m = /_(\d+)_(\d+)$/.exec(text(sub, 0));
    const unit = m ? Number(m[1]) : 0;
    const bodyStyle = m ? Number(m[2]) : 0;
    unitCount = Math.max(unitCount, unit);
    for (const pin of findChildren(sub, "pin")) {
      const type = (arg(pin, 0) as PinType) ?? "unspecified";
      pins.push({
        number: text(findChild(pin, "number")),
        name: text(findChild(pin, "name")),
        type,
        at: point(findChild(pin, "at")),
        hidden: isHidden(pin),
        unit,
        bodyStyle,
      });
    }
  }
  return { id, unitCount, power, pins, properties: properties(node) };
}

function parsePlacedSymbol(node: List): PlacedSymbol {
  const atNode = findChild(node, "at");
  const mirror = findChild(node, "mirror");
  const mirrorAxis = mirror ? text(mirror) : "";
  const instances: SymbolInstance[] = [];
  const inst = findChild(node, "instances");
  if (inst) {
    for (const project of findChildren(inst, "project")) {
      for (const path of findChildren(project, "path")) {
        instances.push({
          path: text(path),
          reference: text(findChild(path, "reference")),
          unit: Number(arg(findChild(path, "unit"), 0) ?? 1),
        });
      }
    }
  }
  return {
    uuid: text(findChild(node, "uuid")),
    // `lib_name` overrides which embedded library symbol is used.
    libId: text(findChild(node, "lib_name")) || text(findChild(node, "lib_id")),
    at: point(atNode),
    rotation: Number(arg(atNode, 2) ?? 0),
    mirrorX: mirrorAxis === "x",
    mirrorY: mirrorAxis === "y",
    unit: Number(arg(findChild(node, "unit"), 0) ?? 1),
    bodyStyle: Number(arg(findChild(node, "body_style") ?? findChild(node, "convert"), 0) ?? 1),
    properties: properties(node),
    inBom: flag(findChild(node, "in_bom"), true),
    onBoard: flag(findChild(node, "on_board"), true),
    dnp: flag(findChild(node, "dnp"), false),
    excludeFromSim: flag(findChild(node, "exclude_from_sim"), false),
    instances,
  };
}

function segment(node: List): Segment {
  const xy = findChildren(findChild(node, "pts")!, "xy");
  return { a: point(xy[0]), b: point(xy[1]) };
}

export function parseSheetFile(source: string): SheetFile {
  const doc = parse(source, { recover: true });
  const root = doc.children.find(isList);
  if (!root || headOf(root) !== "kicad_sch") throw new Error("Not a KiCad schematic");

  const sheet: SheetFile = {
    uuid: text(findChild(root, "uuid")),
    version: Number(arg(findChild(root, "version"), 0) ?? 0),
    libSymbols: new Map(),
    symbols: [],
    wires: [],
    buses: [],
    busEntries: [],
    junctions: [],
    noConnects: [],
    labels: [],
    sheets: [],
    busAliases: new Map(),
  };

  // As for boards: forms after a stray ")" still belong to the sheet.
  const forms = [...root.children, ...doc.children.filter((c) => isList(c) && c !== root)];
  for (const node of forms) {
    if (!isList(node)) continue;
    switch (headOf(node)) {
      case "lib_symbols":
        for (const s of findChildren(node, "symbol")) {
          const lib = parseLibSymbol(s);
          sheet.libSymbols.set(lib.id, lib);
        }
        break;
      case "symbol":
        sheet.symbols.push(parsePlacedSymbol(node));
        break;
      case "wire":
        sheet.wires.push(segment(node));
        break;
      case "bus":
        sheet.buses.push(segment(node));
        break;
      case "bus_entry": {
        const a = point(findChild(node, "at"));
        const size = point(findChild(node, "size"));
        sheet.busEntries.push({ a, b: { x: a.x + size.x, y: a.y + size.y } });
        break;
      }
      case "junction":
        sheet.junctions.push(point(findChild(node, "at")));
        break;
      case "no_connect":
        sheet.noConnects.push(point(findChild(node, "at")));
        break;
      case "label":
      case "global_label":
      case "hierarchical_label": {
        const h = headOf(node)!;
        sheet.labels.push({
          kind: h === "label" ? "local" : h === "global_label" ? "global" : "hierarchical",
          text: atomText(node.children[1] as never),
          at: point(findChild(node, "at")),
          shape: findChild(node, "shape") ? text(findChild(node, "shape")) : undefined,
        });
        break;
      }
      case "sheet": {
        const props = properties(node);
        sheet.sheets.push({
          uuid: text(findChild(node, "uuid")),
          name: props["Sheetname"] ?? props["Sheet name"] ?? "",
          file: props["Sheetfile"] ?? props["Sheet file"] ?? "",
          at: point(findChild(node, "at")),
          size: point(findChild(node, "size")),
          pins: findChildren(node, "pin").map((p) => ({
            name: text(p, 0),
            shape: text(p, 1),
            at: point(findChild(p, "at")),
          })),
        });
        break;
      }
      case "bus_alias": {
        const members = findChild(node, "members");
        sheet.busAliases.set(text(node, 0), members ? members.children.slice(1).filter(isAtom).map(atomText) : []);
        break;
      }
    }
  }
  return sheet;
}

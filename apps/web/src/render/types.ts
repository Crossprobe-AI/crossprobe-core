/** Display-list types shared by the analysis worker and the views. */
import type { Board, ErcViolation, ParityFinding, Unconnected } from "@crossprobe/kicad-model";

export type Role =
  | "wire"
  | "bus"
  | "junction"
  | "noconnect"
  | "body"
  | "bodyFill"
  | "pin"
  | "pinName"
  | "pinNumber"
  | "reference"
  | "value"
  | "field"
  | "labelLocal"
  | "labelGlobal"
  | "labelHier"
  | "labelPower"
  | "sheet"
  | "sheetName"
  | "sheetFile"
  | "sheetPin"
  | "note"
  | "frame";

export type Prim =
  | { t: "path"; d: string; role: Role; w?: number; fill?: boolean; dash?: boolean }
  | { t: "circle"; cx: number; cy: number; r: number; role: Role; fill?: boolean; w?: number }
  | {
      t: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      /** Reading angle in degrees, 0 or 90 (bottom-to-top). */
      angle: number;
      anchor: "start" | "middle" | "end";
      baseline: "top" | "middle" | "bottom";
      role: Role;
      bold?: boolean;
      italic?: boolean;
    }
  | { t: "image"; x: number; y: number; w: number; h: number; href: string };

export interface SchItem {
  kind: "wire" | "bus" | "junction" | "noconnect" | "symbol" | "field" | "pin" | "label" | "sheet" | "text" | "graphic";
  prims: Prim[];
  /** Net this item belongs to (wires, labels, pins). */
  net?: string;
  /** Component reference (symbols and pins). */
  ref?: string;
  /** Pin number (pins). */
  pin?: string;
  /** Pins: direction away from the symbol body (KiCad degrees), so a label placed there reads outward. */
  outward?: number;
  /** Child sheet instance path (sheets), for navigation. */
  sheetPath?: string;
  /** Extent in sheet mm, for zoom-to-selection. */
  bbox?: { x: number; y: number; w: number; h: number };
  /** UUID of the file node this came from (pins: their symbol's), for editing. */
  uuid?: string;
  /** Fields: the field's name and the UUID of the symbol it belongs to (their own `uuid` is "<symbol>#<name>"). */
  field?: string;
  owner?: string;
  /** Labels, texts, text boxes and fields: the text as the file has it (what is drawn has its variables replaced). */
  text?: string;
  /** Global and hierarchical labels: the shape (input, output, bidirectional, tri_state, passive). */
  shape?: string;
  /** Symbols: the reference as stored (also for power symbols). */
  reference?: string;
  /** Connection points: pin tip, wire ends, label / junction / no-connect anchor. */
  points?: Array<{ x: number; y: number }>;
}

export interface SheetView {
  path: string;
  namePath: string;
  name: string;
  file: string;
  page?: string;
  paper: { w: number; h: number };
  title: Record<string, string>;
  items: SchItem[];
  /** Sub-sheet paths in order, for the hierarchy tree. */
  children: string[];
}

export interface ComponentInfo {
  reference: string;
  value: string;
  footprint: string;
  datasheet: string;
  description: string;
  libId: string;
  sheets: string[];
  /** Placed units, for editing: file, symbol UUID and sheet instance path. */
  units: Array<{ file: string; uuid: string; sheet: string; unit: number }>;
  /** Units (gates) the symbol has; the placed ones are in `units`. */
  unitCount: number;
  properties: Record<string, string>;
  dnp: boolean;
  inBom: boolean;
  onBoard: boolean;
  excludeFromSim: boolean;
  /** Fields not shown on the sheet (as on the first placed unit). */
  hiddenFields: string[];
  /** The body style the part is drawn in (1 = the first), and the names of the styles the symbol has (one name: no choice). */
  bodyStyle: number;
  bodyStyles: string[];
  /** Pins that have alternate functions: what they can be, and what each is switched to (unset: its own function). */
  pinAlternates: Array<{ pin: string; name: string; alternates: string[]; current?: string }>;
  /** The library symbol's footprint filters (ki_fp_filters), e.g. ["R_*"]. */
  fpFilters: string[];
  /** Distinct pin numbers of the symbol (all units), for matching footprint pad counts. */
  pinCount: number;
}

export interface NetInfo {
  name: string;
  aliases: string[];
  sheets: string[];
  nodes: Array<{ reference: string; pin: string; pinName: string; pinType: string }>;
}

export interface ProjectView {
  name: string;
  /** Datasheet evidence the engineer pinned (project sidecar file). */
  evidence: import("../datasheet/evidence").PinnedEvidence[];
  /** Where that sidecar lives (it may not exist yet). */
  evidenceFile: string;
  /** The engineer's structured requirements (project sidecar file). */
  requirements: import("../requirements/requirements").Requirement[];
  /** Where that sidecar lives (it may not exist yet). */
  requirementsFile: string;
  rootSheet?: string;
  sheets: SheetView[];
  components: ComponentInfo[];
  nets: NetInfo[];
  board?: Board;
  parity: ParityFinding[];
  erc: ErcViolation[];
  /** Missing connections on the board (ratsnest). */
  unconnected: Unconnected[];
  /** Every symbol definition embedded in the project's sheets: the parts available to place. */
  libraries: Array<{ libId: string; file: string; name: string; description: string; prefix: string; power: boolean; pins: number }>;
  /** Copper clearance violations on the board (KiCad's clearance/short checks). */
  clearance: import("@crossprobe/kicad-model").ClearanceViolation[];
  /** Other board checks (hole sizes, annular rings, dangling tracks and vias, courtyards, holes), as KiCad's DRC. */
  boardChecks: import("@crossprobe/kicad-model").BoardViolation[];
  /** DRC findings the designer excluded (kept in the project file as KiCad does): shown apart, can be included again. */
  drcExcluded: Array<{ type: string; message: string; at: { x: number; y: number }; items: string[]; key: string }>;
  /** The project has custom design rules (.kicad_dru); clearance rules are applied. */
  customRules: boolean;
  /** Constraint types in those rules that the DRC doesn't check yet (e.g. track_width, length). */
  unsupportedRules: string[];
  /** Net class values per board net ("" = no net): routing defaults and clearances. */
  netClasses: Record<string, { name: string; clearance: number; trackWidth: number; viaDiameter: number; viaDrill: number }>;
  /** The project's design rules in plain form (for checks in the view, e.g. while routing). */
  /** Board setup minimums (mm), as the DRC applies them. */
  boardSetup: { minClearance: number; minTrackWidth: number; minViaDiameter: number; minViaAnnular: number; minHoleSize: number; minHoleToHole: number; holeClearance: number; copperEdgeClearance: number; minTextHeight: number };
  designRules: { minClearance: number; copperEdgeClearance?: number; holeClearance?: number; custom?: import("@crossprobe/kicad-model").DruRule[]; classes: import("@crossprobe/kicad-model").NetClass[]; patterns: Array<{ pattern: string; netclass: string }>; assignments: Record<string, string> };
  /** Project-relative path of the board file, when there is one. */
  boardFile?: string;
  /** Project-relative path of the .kicad_pro. */
  projectFile: string;
  /** What Update PCB from Schematic would change (schematic and board both present). */
  boardUpdate?: import("@crossprobe/kicad-model").BoardUpdatePlan;
  /** Update Schematic from PCB: what the board changed, per part (all kinds; the dialog picks). */
  schematicUpdate?: { updates: import("@crossprobe/kicad-model").SchematicUpdate[]; unmatched: string[] };
  /** Footprints of the project's own libraries (fp-lib-table, `${KIPRJMOD}` folders): "Lib:Name", its file and text. */
  projectFootprints: Array<{ libId: string; lib: string; name: string; file: string; text: string; pads: number; description: string }>;
  /** The project's own symbol libraries (sym-lib-table): file → nickname and text, for the symbol editor. */
  projectSymbolLibraries: Record<string, { lib: string; text: string }>;
  /** Symbols of the project's own libraries (sym-lib-table); `file` is the .kicad_sym. */
  projectSymbols: Array<{ library: string; name: string; file: string; description: string; keywords: string; prefix: string; power: boolean; pins: number }>;
  /** Every reference in use (power symbols included), for numbering new parts. */
  references: string[];
  warnings: string[];
  stats: { files: number; parseMs: number };
}

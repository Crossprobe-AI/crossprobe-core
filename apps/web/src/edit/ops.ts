/**
 * Edit operations sent from the UI to the analysis worker. They are plain
 * data (structured-clone friendly) and name items by UUID within a sheet
 * file. Editing a sheet file affects every instance of that sheet, as in KiCad.
 */
import { applyEvidence } from "../datasheet/evidence";
import { serializeRequirements } from "../requirements/requirements";
import { arg, findChild, findChildren, format, headOf, insertAt, isList, parse, removeChild, serialize, type Document, type List } from "@crossprobe/kicad-sexpr";
import {
  createBoardArray,
  addTextBox,
  type NewTextBox,
  addGroup,
  removeGroup,
  pruneGroups,
  setGroupLocked,
  type ArrayOptions,
  type ZoneProps,
  addJunction,
  addLabel,
  addNoConnect,
  addWire,
  addBus,
  addBusEntry,
  addSchText,
  addSchTextBox,
  addSchGraphic,
  setItemText,
  type SchGraphic,
  deleteItem,
  tuneNetLength,
  addDimension,
  pasteBoardItems,
  setLocked,
  setPadProps,
  setPadNet,
  computeTeardrops,
  addTeardropZone,
  removeTeardrops,
  duplicateItems,
  findFreeSpot,
  findItem,
  insertBlock,
  insertBlockBoard,
  buildNetlist,
  moveWirePoint,
  placeSymbol,
  addSheet,
  addSheetPin,
  newSheetFile,
  planAnnotation,
  netclassAssignments,
  loadSchematic,
  mirrorSymbol,
  moveItem,
  rotateItem,
  setSymbolField,
  setSymbolAttributes,
  setSymbolBodyStyle,
  setPinAlternate,
  setFieldVisible,
  setLabelShape,
  moveField,
  rotateField,
  setSheetName,
  blockFromSelection,
  blockMetadataJson,
  addImage,
  addTable,
  setHyperlink,
  sheetFeatureCounts,
  requireSheetFeatures,
  setImageScale,
  setSheetPinName,
  addDirective,
  addRuleArea,
  planReplace,
  type FindOptions,
  type FindTarget,
  setSheetPage,
  setLegacySheetPage,
  syncSheetPins,
  type LabelShape,
  resolveLibrarySymbol,
  sheetRoot,
  type NewLabelKind,
  type BoardUpdatePlan,
  addTrack,
  addVia,
  addBoardShape,
  addZone,
  setZoneProps,
  setGraphicPoints,
  setPolygonPoints,
  addBoardText,
  autorouteAll,
  stitchToPours,
  newBoardUuid,
  addSymPin,
  setSymPin,
  moveSymPins,
  deleteSymPins,
  addSymGraphic,
  newPowerSymbol,
  setDeMorgan,
  setBodyStyles,
  setJumpers,
  setPinUnit,
  setUnitCount,
  setUnitName,
  setUnitsLocked,
  moveSymGraphics,
  deleteSymGraphics,
  setSymFields,
  layoutSymbol,
  describeSymbol,
  findLibSymbol,
  symbolLibRoot,
  updateSchematicLibSymbol,
  type NewPin,
  type NewSymGraphic,
  type SymbolFields,
  type PinType,
  updateFootprintFromLibrary,
  footprintNode,
  addFpPad,
  addFpPadArray,
  setFpPad,
  moveFpItems,
  deleteFpItems,
  addFpGraphic,
  setFpProps,
  setFpCourtyard,
  addFpPasteWindows,
  rotateFpItems,
  setFpField,
  setPageSettings,
  type PageSettings,
  mirrorFpItems,
  renumberFpPads,
  addFpCustomPad,
  setFpModel,
  type FpModel,
  withLibTableEntry,
  type NewPad,
  type NewGraphic,
  setCopperLayerCount,
  setStackup,
  STACKUPS,
  exclusionKey,
  fanoutPours,
  routeWithVias,
  copperItems,
  netClassOf,
  setBoardText,
  type NewBoardText,
  type NewBoardShape,
  type NewZone,
  applyFootprintUpdate,
  boardRoot,
  deleteBoardItem,
  findBoardItem,
  flipFootprint,
  moveBoardItem,
  moveFootprintText,
  moveTrackEnd,
  placeFootprint,
  rotateBoardItem,
  setFootprintField,
  setTrackProps,
  setViaProps,
  setZoneFills,
  fillZones,
  fracture,
  parseBoard,
  projectDesignRules,
  type Point,
} from "@crossprobe/kicad-model";

/** Where a placed symbol's definition comes from. */
export type SymbolSource =
  /** Already embedded in a sheet's lib_symbols. */
  | { kind: "embedded"; file: string; libId: string }
  /** A .kicad_sym file in the project. */
  | { kind: "library"; file: string; library: string; name: string }
  /** A resolved definition (e.g. from KiCad's installed libraries), named "Lib:Name". */
  | { kind: "text"; text: string };

/** The symbol editor's actions on one library symbol: pins by number, graphics by index. */
/** Pin edits name a unit when the symbol has several (its pins, and the shared unit 0's). */
export type SymbolEdit =
  | { kind: "addPin"; pin: NewPin; unit?: number }
  | { kind: "setPin"; number: string; props: Partial<Omit<NewPin, "at">>; unit?: number }
  | { kind: "movePins"; numbers: string[]; d: Point; unit?: number }
  | { kind: "deletePins"; numbers: string[]; unit?: number }
  | { kind: "addGraphic"; graphic: NewSymGraphic; scope?: { unit: number; style: number } }
  | { kind: "units"; count: number }
  | { kind: "deMorgan"; on: boolean }
  /** One body style (null), De Morgan, or named styles. */
  | { kind: "bodyStyles"; styles: { demorgan: true } | { names: string[] } | null }
  | { kind: "jumpers"; duplicate?: boolean; groups?: string[][] }
  | { kind: "unitName"; unit: number; name: string }
  | { kind: "unitsLocked"; locked: boolean }
  | { kind: "pinUnit"; numbers: string[]; unit: number }
  /** Make it a power symbol (KiCad's template, named after the symbol): a supply arrow or a ground. */
  | { kind: "power"; style: "supply" | "ground" }
  | { kind: "moveGraphics"; indexes: number[]; d: Point }
  | { kind: "deleteGraphics"; indexes: number[] }
  | { kind: "setFields"; fields: SymbolFields & { inBom?: boolean; onBoard?: boolean } }
  /** Draw the box symbol again from a pin list, keeping the fields. */
  | { kind: "layout"; pins: Array<{ number: string; name: string; type: PinType; side?: "left" | "right" | "top" | "bottom" }> };

/** The footprint editor's actions, by item UUID. */
export type FootprintEdit =
  | { kind: "addPad"; pad: NewPad }
  | { kind: "addPadArray"; base: Omit<NewPad, "number" | "at">; first: number; columns: number; rows: number; pitch: Point; origin: Point }
  | { kind: "setPad"; uuid: string; props: Partial<Omit<NewPad, "at">> }
  | { kind: "move"; uuids: string[]; d: Point }
  | { kind: "delete"; uuids: string[] }
  | { kind: "addGraphic"; graphic: NewGraphic }
  | { kind: "setProps"; props: { name?: string; description?: string; tags?: string; attr?: "smd" | "through_hole" | "unspecified"; excludeFromBom?: boolean } }
  | { kind: "courtyard"; excess?: number }
  | { kind: "pasteWindows"; uuid: string; columns: number; rows: number; coverage: number }
  | { kind: "rotate"; uuids: string[]; center: Point; deg: number }
  | { kind: "setField"; name: string; value: string }
  | { kind: "mirror"; uuids: string[]; at: number; axis: "x" | "y" }
  | { kind: "renumber"; uuids: string[]; first: number; step?: number; prefix?: string }
  | { kind: "addCustomPad"; pad: { number: string; type: "smd" | "thru_hole"; at: Point; polygon: Point[]; drill?: number } }
  | { kind: "model"; model: FpModel | null };

export type EditOp =
  | { op: "move"; file: string; uuids: string[]; dx: number; dy: number }
  | { op: "rotate"; file: string; uuids: string[] }
  | { op: "mirror"; file: string; uuids: string[]; axis: "x" | "y" }
  | { op: "delete"; file: string; uuids: string[] }
  | { op: "setField"; file: string; uuid: string; name: string; value: string; sheetPath?: string }
  | { op: "setSymbolAttributes"; file: string; uuid: string; dnp?: boolean; inBom?: boolean; onBoard?: boolean; excludeFromSim?: boolean }
  /** Which body style a placed symbol is drawn in (1 = the first; 2 = De Morgan or the second named style). */
  | { op: "setBodyStyle"; file: string; uuid: string; style: number }
  /** Switch a placed symbol's pin to one of its alternate functions (`null`: back to its own). */
  | { op: "setPinAlternate"; file: string; uuid: string; pin: string; alternate: string | null }
  /** Move one field of a placed symbol, or turn it between horizontal and vertical. */
  | { op: "moveField"; file: string; uuid: string; name: string; dx: number; dy: number }
  | { op: "rotateField"; file: string; uuid: string; name: string }
  /** Show or hide a field of a placed symbol on the sheet. */
  | { op: "setFieldVisible"; file: string; uuid: string; name: string; visible: boolean }
  /** The shape (signal direction) of a global or hierarchical label. */
  | { op: "setLabelShape"; file: string; uuid: string; shape: LabelShape }
  /** Cleanup Tracks & Vias: what planCleanup found, applied as one edit. */
  | { op: "cleanupTracks"; file: string; remove: string[]; reshape: Array<{ uuid: string; start: Point; end: Point }> }
  /** Paper and title block of a schematic sheet file or the board. */
  | { op: "setPageSettings"; file: string; settings: PageSettings }
  | { op: "addWire"; file: string; points: Point[]; bus?: boolean }
  | { op: "addBusEntry"; file: string; at: Point; size: Point }
  | { op: "addSchText"; file: string; text: string; at: Point; size?: number }
  | { op: "addSchTextBox"; file: string; text: string; a: Point; b: Point }
  | { op: "addSchGraphic"; file: string; graphic: SchGraphic; dash?: boolean }
  /** New text for a label, text or text box. */
  | { op: "setText"; file: string; uuid: string; text: string }
  | { op: "addLabel"; file: string; kind: NewLabelKind; text: string; at: Point; angle?: number; shape?: LabelShape }
  | { op: "addJunction"; file: string; at: Point }
  /** A text's or label's link (a web address, or "#2" for page 2); empty takes it off. */
  | { op: "setHyperlink"; file: string; uuid: string; href: string }
  /** A table of rows × columns, its top-left corner at `at`. */
  | { op: "addTable"; file: string; at: Point; rows: number; cols: number }
  /** An image (PNG as base64) centred on `at`. */
  | { op: "addImage"; file: string; at: Point; png: string; scale?: number }
  | { op: "setImageScale"; file: string; uuid: string; scale: number }
  /** A net class directive on a wire (or a rule area's outline). */
  | { op: "addDirective"; file: string; at: Point; netclass: string; angle?: number }
  /** A rule area (closed outline), with a directive for `netclass` on its first corner when given. */
  | { op: "addRuleArea"; file: string; points: Point[]; netclass?: string }
  | { op: "addNoConnect"; file: string; at: Point }
  | { op: "moveWirePoint"; file: string; uuid: string; index: 0 | 1; to: Point }
  /** Copy items from `source` into `file`, offset, with new references for symbols. */
  | { op: "duplicate"; source: string; file: string; uuids: string[]; dx: number; dy: number; references: Record<string, string>; sheetPaths: string[] }
  /** Place a new symbol; its library definition comes from `source`. */
  | { op: "placeSymbol"; file: string; source: SymbolSource; at: Point; reference: string; sheetPaths: string[]; projectName: string; unit?: number }
  /**
   * Insert a design block (its .kicad_sch text) at `at`, or in free space below the sheet's
   * content, and number the new parts. Copies the block's library symbols.
   */
  | { op: "insertBlock"; file: string; blockText: string; at: Point | "free"; sheetPaths: string[]; projectName: string; keepReferences?: boolean; blockPcb?: string }
  /** A new hierarchical sheet; creates `newFile` (relative to the project) if it doesn't exist. */
  | { op: "addSheet"; file: string; newFile: string; name: string; at: Point; size: Point; parentPaths: string[]; projectName: string; page: number }
  /** A sheet pin; also adds the matching hierarchical label in the child sheet's file. */
  | { op: "addSheetPin"; file: string; sheetUuid: string; childFile: string; name: string; shape: string; at: Point }
  /** A sheet symbol's name, and the page number of the instance drawn on the sheet at `path`. */
  | { op: "setSheetProps"; file: string; uuid: string; name?: string; page?: { path: string; number: string } }
  /** Rename one pin of a sheet symbol. */
  | { op: "setSheetPinName"; file: string; uuid: string; pin: string; name: string }
  /** Pins for the child sheet's hierarchical labels that have none, and labels in it for the pins that have none. */
  | { op: "syncSheetPins"; file: string; sheetUuid: string; childFile: string }
  /** Replace every match of `find` in these sheet files (expanded into setText, setField and setSheetProps ops). */
  | { op: "replaceAll"; file: string; files: string[]; find: string; replace: string; options: FindOptions }
  /** Renumber references across the design (expanded into setField ops). */
  | { op: "annotate"; file: string; mode: "all" | "unannotated" | "clear"; order?: "x" | "y"; sheetPath?: string; startAfter?: number; sheetMultiplier?: 100 | 1000 }
  // Board (.kicad_pcb) operations; items are named by UUID.
  | { op: "boardMove"; file: string; uuids: string[]; dx: number; dy: number }
  /** Align or distribute: each item its own move (`label` names it for undo, as KiCad's commit does). */
  | { op: "boardArrange"; file: string; label: string; moves: Array<{ uuid: string; dx: number; dy: number }> }
  | { op: "moveFootprintText"; file: string; footprint: string; text: string; dx: number; dy: number }
  /** Rotate by `deg` (CCW); around `center`, or each footprint's own anchor when omitted. */
  | { op: "boardRotate"; file: string; uuids: string[]; deg: number; center?: Point }
  /** Flip footprints to the other side, mirrored around `centerX` (default: in place). */
  | { op: "boardFlip"; file: string; uuids: string[]; centerX?: number }
  | { op: "boardDelete"; file: string; uuids: string[] }
  /** KiCad's Group (Ctrl+G): a new group of these top-level items or groups. */
  | { op: "boardGroup"; file: string; members: string[]; name?: string; uuid?: string }
  /** KiCad's Ungroup (Ctrl+Shift+G). */
  | { op: "boardUngroup"; file: string; groups: string[] }
  | { op: "addTrack"; file: string; points: Point[]; width: number; layer: string; net: string }
  | { op: "addVia"; file: string; at: Point; size: number; drill: number; layers: [string, string]; net: string; type?: "blind" | "buried" | "micro" }
  /** A board graphic: the Edge.Cuts outline, silkscreen or drawing shapes. */
  | { op: "addBoardShape"; file: string; shape: NewBoardShape }
  | ({ op: "setZoneProps"; file: string; uuids: string[] } & ZoneProps)
  | { op: "setGraphicPoints"; file: string; uuid: string; points: Point[]; label?: string }
  /** A zone's outline corners (KiCad's point editor: drag, add or remove a corner). */
  | { op: "setZoneOutline"; file: string; uuid: string; points: Point[]; label?: string }
  /** Route connections with the grid router, one after another (each sees the ones before); unroutable ones are skipped. */
  /** `deadline` (a `Date.now()` time): connections not started by then are left unrouted. */
  | { op: "autoroute"; file: string; connections: Array<{ from: Point; to: Point; net: string }>; deadline?: number }
  /** A footprint's pad on the board: size, shape, drill, net (KiCad's pad properties). */
  | { op: "setPadProps"; file: string; footprint: string; pad: string; size?: { x: number; y: number }; shape?: string; drill?: number; net?: string }
  /** Lock or unlock footprints, tracks and vias (KiCad's (locked yes)). */
  | { op: "setLocked"; file: string; uuids: string[]; locked: boolean }
  /** Copies of board items `uuids`, moved by (dx, dy); `fresh[i]` is the new UUID of copy i. */
  | { op: "boardDuplicate"; file: string; uuids: string[]; fresh: string[]; dx: number; dy: number }
  /** KiCad's Create Array: copies in a grid or circle (references renumbered unless kept), or the items themselves laid out. */
  | { op: "boardArray"; file: string; uuids: string[]; options: ArrayOptions; reannotate: boolean; arrange: boolean }
  /** A dimension (aligned, or orthogonal: horizontal unless `vertical`) between two points, `height` from them. */
  | { op: "addDimension"; file: string; start: Point; end: Point; height: number; layer: string; orthogonal?: boolean; vertical?: boolean }
  /** Teardrops at every track-to-pad/via joint (replacing any there were), or none with `remove`; follow with refillZones. */
  | { op: "teardrops"; file: string; remove?: boolean }
  /** Lengthen `net` to `target` mm with meanders, on track `prefer` first. */
  | { op: "tuneLength"; file: string; net: string; target: number; prefer?: string }
  /**
   * Board setup in the .kicad_pro: design-rule minimums (board.design_settings.rules,
   * KiCad's key names, mm) and fields of one net class (net_settings.classes).
   */
  | { op: "setEvidence"; file: string; change: import("../datasheet/evidence").EvidenceOp }
  | { op: "setRequirements"; file: string; requirements: import("../requirements/requirements").Requirement[] }
  | {
      op: "setProjectRules";
      file: string;
      rules?: Record<string, number>;
      netClass?: { name: string; fields: Record<string, number> };
      /** Exclude a DRC finding (KiCad's drc_exclusions entry, with an optional comment). */
      exclude?: { entry: string; comment?: string };
      /** Include an excluded finding again: drop the exclusions with this key (see exclusionKey). */
      include?: string;
      /** The nets of a class, as KiCad's net class patterns (wildcards * and ?), replacing its old ones. */
      classPatterns?: { name: string; patterns: string[] };
      /** Delete a net class (and its patterns); its nets fall back to the others or Default. */
      removeClass?: string;
    }
  /** ERC exclusions in the project file (erc.erc_exclusions): add one with its comment, or take entries out. */
  | { op: "setErcExclusions"; file: string; exclude?: { entry: string; comment: string }; include?: string[] }
  /** The project file's schematic formatting (schematic.drawing), KiCad's key names. */
  | { op: "setSchematicDrawing"; file: string; drawing: Record<string, boolean | string | number> }
  | { op: "addBoardText"; file: string; text: NewBoardText }
  | { op: "addTextBox"; file: string; box: NewTextBox }
  | { op: "setBoardText"; file: string; uuids: string[]; text?: string; size?: number; layer?: string }
  /** A copper zone outline; follow with refillZones to compute its copper. */
  | { op: "addZone"; file: string; zone: NewZone }
  | { op: "moveTrackEnd"; file: string; uuid: string; index: 0 | 1; to: Point }
  | { op: "setFootprintField"; file: string; uuid: string; name: string; value: string }
  | { op: "setTrackProps"; file: string; uuids: string[]; width?: number; layer?: string }
  | { op: "setViaProps"; file: string; uuids: string[]; size?: number; drill?: number }
  /** Place a library footprint (its .kicad_mod text) on its own, e.g. a mounting hole. */
  /** Refill every copper zone (KiCad's B), using the project's design rules. */
  | { op: "refillZones"; file: string }
  /** The board's number of copper layers (2, 4, 6 …): inner layers In1.Cu … between F.Cu and B.Cu. */
  | { op: "setCopperLayers"; file: string; count: number }
  /** Write a footprint file (new, or a library footprint copied in to edit) and list its library in fp-lib-table. */
  | { op: "fpWrite"; file: string; text: string; libTable: string; lib: string; libDir: string }
  /**
   * Save items of the sheet `file` as a design block in the project's block library: `dir` is the
   * project folder ("" or "name/"), the block goes in `<lib>.kicad_blocks/<name>.kicad_block/`.
   */
  | { op: "saveBlock"; file: string; uuids: string[]; dir: string; lib: string; name: string; description: string; keywords: string[]; projectName: string; sheetPath?: string }
  /** One footprint editor action on a .kicad_mod file (see footprint-edit.ts). */
  | { op: "footprint"; file: string; edit: FootprintEdit }
  /** Write a symbol library (a new symbol, or one copied in to edit) and list it in sym-lib-table. */
  | { op: "symWrite"; file: string; text: string; libTable: string; lib: string; libFile: string }
  /** One symbol editor action on a symbol of a project library. */
  | { op: "symbol"; file: string; name: string; edit: SymbolEdit }
  /** Sheets' cached copies of a library symbol replaced by its current version (KiCad's Update Symbols from Library). */
  | { op: "updateSchematicSymbols"; file: string; sheets: string[]; libFile: string; lib: string; name: string }
  /** Placed footprints brought up to their library's current version (KiCad's Update Footprint from Library). */
  | { op: "updateFootprints"; file: string; updates: Array<{ uuid: string; text: string }> }
  /** A fab's published stackup (see STACKUPS), written as the board's physical stackup. */
  | { op: "setStackup"; file: string; name: string }
  /** Vias from pads the pours don't reach down to a pour of their net on another layer; follow with refillZones. */
  | { op: "stitchPours"; file: string; fanout?: boolean }
  | { op: "placeFootprint"; file: string; text: string; libId: string; at: Point; reference: string; value: string; layer?: "F.Cu" | "B.Cu" }
  /**
   * Update PCB from Schematic: apply `plan` (from the analysis), placing
   * missing footprints from `footprints` (lib id → .kicad_mod text) at `places`.
   */
  | { op: "updateBoard"; file: string; plan: BoardUpdatePlan; footprints: Record<string, string>; places: Record<string, Point>; deleteExtra?: boolean };

/**
 * Whether the zone fills are out of date after `ops`, given whether they were before.
 * A refill makes them current; any other edit to the board makes them stale, except
 * those that can't change copper (silkscreen text, dimensions, locking, fields, groups).
 */
export function zonesStaleAfter(ops: EditOp[], stale: boolean): boolean {
  if (ops.some((o) => o.op === "refillZones")) return false;
  const copperNeutral = (o: EditOp) =>
    (o.op === "addBoardText" && !o.text.layer.endsWith(".Cu")) ||
    (o.op === "addTextBox" && !o.box.layer.endsWith(".Cu")) ||
    o.op === "moveFootprintText" ||
    o.op === "addDimension" ||
    o.op === "setLocked" ||
    o.op === "setFootprintField" ||
    // Grouping changes no geometry.
    o.op === "boardGroup" ||
    o.op === "boardUngroup";
  return stale || ops.some((o) => o.file.endsWith(".kicad_pcb") && !copperNeutral(o));
}

/** Schematic edits that can't change a net or its classes: no need to recompute the project's net classes after them. */
const KEEPS_NETS = new Set<EditOp["op"]>([
  "moveField", "rotateField", "setFieldVisible", "setLabelShape", "setPageSettings", "addSchText", "addSchTextBox", "addSchGraphic",
  "setHyperlink", "addTable", "addImage", "setImageScale",
]);

/**
 * The project file keeps the net classes the schematic gives each net (KiCad writes them on
 * save, and the board's rules read them): bring them in line after a schematic edit. Only for
 * projects that use net class directives, Netclass fields or rule areas, or have such entries.
 */
function syncNetclassAssignments(rootFile: string, changed: Record<string, string>, files: Record<string, string>) {
  const proFile = rootFile.replace(/\.kicad_sch$/, ".kicad_pro");
  const proText = changed[proFile] ?? files[proFile];
  if (proText === undefined) return;
  const read = (f: string) => {
    const t = changed[f] ?? files[f];
    if (t === undefined) throw new Error(`missing ${f}`);
    return t;
  };
  let pro: { net_settings?: { netclass_assignments?: Record<string, string[]> | null } };
  try {
    pro = JSON.parse(proText);
  } catch {
    return;
  }
  const had = pro.net_settings?.netclass_assignments ?? {};
  // Design blocks' sheets aren't part of the design.
  const sheets = Object.keys({ ...files, ...changed }).filter((f) => f.endsWith(".kicad_sch") && !/\.kicad_blocks\//.test(f));
  const uses = sheets.some((f) => /\((netclass_flag|directive_label|rule_area)\b|\(property "Netclass"/.test(read(f)));
  if (!uses && !Object.keys(had).length) return;
  let next: Record<string, string[]>;
  try {
    const netlist = buildNetlist(loadSchematic(rootFile, read));
    // Entries for names that aren't nets here (buses, nets that went away) are left as they are.
    const known = new Set(netlist.nets.map((n) => n.name));
    const all: Record<string, string[]> = { ...Object.fromEntries(Object.entries(had).filter(([n]) => !known.has(n))), ...netclassAssignments(netlist) };
    next = Object.fromEntries(Object.keys(all).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, all[k]!]));
  } catch {
    return;
  }
  if (JSON.stringify(next) === JSON.stringify(had)) return;
  pro.net_settings ??= {};
  pro.net_settings.netclass_assignments = next;
  changed[proFile] = JSON.stringify(pro, null, 2) + "\n";
}

/** The edit that gives a found item new text. */
export function replaceOp(t: FindTarget, to: string): EditOp {
  if (t.kind === "field") return { op: "setField", file: t.file, uuid: t.uuid, name: t.field, value: to, sheetPath: t.sheetPath };
  if (t.kind === "sheet") return { op: "setSheetProps", file: t.file, uuid: t.uuid, name: to };
  if (t.kind === "sheetpin") return { op: "setSheetPinName", file: t.file, uuid: t.uuid, pin: t.pin, name: to };
  return { op: "setText", file: t.file, uuid: t.uuid, text: to };
}

/** Human-readable name for the undo history. */
export function describeOp(op: EditOp): string {
  switch (op.op) {
    case "move": return `Move ${op.uuids.length} item${op.uuids.length > 1 ? "s" : ""}`;
    case "rotate": return "Rotate";
    case "mirror": return `Mirror ${op.axis.toUpperCase()}`;
    case "delete": return `Delete ${op.uuids.length} item${op.uuids.length > 1 ? "s" : ""}`;
    case "setField": return `Set ${op.name}`;
    case "setPageSettings": return "Page settings";
    case "cleanupTracks": return "Cleanup tracks & vias";
    case "setSymbolAttributes":
      if (op.dnp !== undefined) return op.dnp ? "Do not populate" : "Populate";
      if (op.inBom !== undefined) return op.inBom ? "Include in BOM" : "Exclude from BOM";
      if (op.onBoard !== undefined) return op.onBoard ? "Include on board" : "Exclude from board";
      return op.excludeFromSim ? "Exclude from simulation" : "Include in simulation";
    case "setBodyStyle": return "Body style";
    case "setPinAlternate": return op.alternate === null ? `Pin ${op.pin}: own function` : `Pin ${op.pin}: ${op.alternate}`;
    case "setFieldVisible": return `${op.visible ? "Show" : "Hide"} ${op.name}`;
    case "setLabelShape": return "Label shape";
    case "moveField": return `Move ${op.name}`;
    case "rotateField": return `Rotate ${op.name}`;
    case "addWire": return op.bus ? "Add bus" : "Add wire";
    case "addBusEntry": return "Add bus entry";
    case "addSchText": return "Add text";
    case "addSchTextBox": return "Add text box";
    case "addSchGraphic": return `Add ${op.graphic.kind === "polyline" ? "lines" : op.graphic.kind}`;
    case "setText": return `Text: ${op.text}`;
    case "addLabel": return `Add label ${op.text}`;
    case "addImage": return "Add image";
    case "addTable": return `Add ${op.rows} × ${op.cols} table`;
    case "setHyperlink": return op.href ? "Link" : "Remove link";
    case "setImageScale": return "Image size";
    case "addDirective": return `Net class ${op.netclass}`;
    case "addRuleArea": return op.netclass ? `Rule area for ${op.netclass}` : "Rule area";
    case "addJunction": return "Add junction";
    case "addNoConnect": return "Add no-connect";
    case "moveWirePoint": return "Drag wire";
    case "duplicate": return `Paste ${op.uuids.length} item${op.uuids.length > 1 ? "s" : ""}`;
    case "placeSymbol": return `Place ${op.reference}${op.unit && op.unit > 1 ? ` unit ${String.fromCharCode(64 + op.unit)}` : ""}`;
    case "insertBlock": return "Insert design block";
    case "replaceAll": return `Replace "${op.find}" with "${op.replace}"`;
    case "annotate": return op.mode === "all" ? "Annotate all" : op.mode === "clear" ? "Clear annotation" : "Annotate new parts";
    case "addSheet": return `Add sheet ${op.name}`;
    case "addSheetPin": return `Add sheet pin ${op.name}`;
    case "setSheetProps": return op.name !== undefined ? `Rename sheet to ${op.name}` : "Sheet page number";
    case "syncSheetPins": return "Synchronize sheet pins";
    case "setSheetPinName": return `Sheet pin: ${op.name}`;
    case "boardMove": return `Move ${op.uuids.length} item${op.uuids.length > 1 ? "s" : ""}`;
    case "boardArrange": return op.label;
    case "moveFootprintText": return "Move footprint text";
    case "boardRotate": return "Rotate";
    case "boardFlip": return "Flip";
    case "boardDelete": return `Delete ${op.uuids.length} item${op.uuids.length > 1 ? "s" : ""}`;
    case "boardGroup": return "Group";
    case "boardUngroup": return "Ungroup";
    case "addTrack": return "Route track";
    case "addVia": return op.type ? `Add ${op.type} via` : "Add via";
    case "addBoardShape": return op.shape.layer === "Edge.Cuts" ? "Draw board outline" : `Draw ${op.shape.kind} on ${op.shape.layer}`;
    case "addZone": return `Add ${op.zone.net || "no-net"} zone`;
    case "setGraphicPoints": return op.label ?? "Resize shape";
    case "setZoneOutline": return op.label ?? "Edit zone outline";
    case "autoroute": return op.connections.length === 1 ? `Autoroute ${op.connections[0]!.net}` : `Autoroute ${op.connections.length} connections`;
    case "setProjectRules": return op.exclude ? "Exclude DRC finding" : op.include ? "Include DRC finding" : op.removeClass ? `Remove net class ${op.removeClass}` : op.classPatterns ? `Nets of ${op.classPatterns.name}` : "Board setup";
    case "setSchematicDrawing": return "Schematic formatting";
    case "setErcExclusions": return op.exclude ? "Exclude ERC finding" : "Include ERC finding";
    case "tuneLength": return `Tune ${op.net} to ${op.target} mm`;
    case "teardrops": return op.remove ? "Remove teardrops" : "Teardrops";
    case "addDimension": return "Add dimension";
    case "setLocked": return op.locked ? "Lock" : "Unlock";
    case "setPadProps": return `Pad ${op.pad} properties`;
    case "boardArray": return op.arrange ? "Arrange selection" : "Create array";
    case "boardDuplicate": return `Duplicate ${op.uuids.length} item${op.uuids.length > 1 ? "s" : ""}`;
    case "setEvidence": return "Datasheet evidence";
    case "setRequirements": return "Requirements";
    case "addBoardText": return `Add text "${op.text.text}"`;
    case "addTextBox": return "Add text box";
    case "setBoardText": return op.text !== undefined ? `Text "${op.text}"` : op.size !== undefined ? `Text size ${op.size} mm` : `Text layer ${op.layer}`;
    case "setZoneProps": return op.net !== undefined ? `Zone net ${op.net || "(none)"}` : op.connect !== undefined ? "Zone pad connection" : op.layer !== undefined ? `Zone layer ${op.layer}` : "Zone properties";
    case "moveTrackEnd": return "Drag track";
    case "setFootprintField": return `Set ${op.name}`;
    case "setTrackProps": return op.width !== undefined ? `Track width ${op.width} mm` : `Track layer ${op.layer}`;
    case "setViaProps": return "Via size";
    case "placeFootprint": return `Place ${op.reference}`;
    case "refillZones": return "Refill zones";
    case "setCopperLayers": return `${op.count} copper layers`;
    case "updateFootprints": return `Update ${op.updates.length} footprint${op.updates.length > 1 ? "s" : ""} from library`;
    case "symWrite": return `Symbol library ${op.lib}`;
    case "symbol": return { addPin: "Add pin", setPin: "Pin properties", units: "Units", deMorgan: "De Morgan body style", bodyStyles: "Body styles", jumpers: "Jumper pins", unitName: "Unit name", unitsLocked: "Unit lock", pinUnit: "Pin unit", power: "Power symbol", movePins: "Move pins", deletePins: "Delete pins", addGraphic: "Add graphic", moveGraphics: "Move", deleteGraphics: "Delete", setFields: "Symbol properties", layout: "Lay out pins" }[op.edit.kind];
    case "updateSchematicSymbols": return `Update ${op.name} on the schematic`;
    case "fpWrite": return `Footprint ${op.file.split("/").pop()?.replace(/\.kicad_mod$/, "")}`;
    case "saveBlock": return `Save block ${op.name}`;
    case "footprint": return { addPad: "Add pad", addPadArray: "Add pads", pasteWindows: "Paste windows", rotate: "Rotate", setPad: "Pad properties", move: "Move", delete: "Delete", addGraphic: "Add graphic", setProps: "Footprint properties", courtyard: "Courtyard", setField: "Footprint field", mirror: "Mirror", renumber: "Renumber pads", addCustomPad: "Add custom pad", model: "3D model" }[op.edit.kind];
    case "setStackup": return `Stackup ${op.name}`;
    case "stitchPours": return "Stitch to pours";
    case "updateBoard": return "Update PCB from schematic";
  }
}

/**
 * Apply operations to file texts. Returns the new texts of the files that
 * changed. Parsed trees are cached per text so repeated edits stay cheap.
 */
export class Editor {
  private docs = new Map<string, { text: string; doc: Document }>();

  /** @param root the root schematic's file name, for design-wide operations. */
  apply(files: Record<string, string>, ops: EditOp[], root?: string): Record<string, string> {
    try {
      return this.applyAll(files, this.expand(files, ops, root), root);
    } catch (e) {
      // A failed batch may have half-modified a cached tree: forget them all.
      this.docs.clear();
      throw e;
    }
  }

  /** Turn design-wide operations into per-file ones. */
  private expand(files: Record<string, string>, ops: EditOp[], root?: string): EditOp[] {
    return ops.flatMap((op): EditOp[] => {
      if (op.op === "replaceAll") {
        const sheets = op.files.map((file) => {
          const text = files[file];
          if (text === undefined) throw new Error(`missing ${file}`);
          return { file, root: sheetRoot(parse(text)) };
        });
        return planReplace(sheets, op.find, op.replace, op.options).map((t): EditOp => replaceOp(t, t.to));
      }
      if (op.op !== "annotate") return [op];
      if (!root) throw new Error("Annotation needs the root schematic");
      const schematic = loadSchematic(root, (f) => {
        const t = files[f];
        if (t === undefined) throw new Error(`missing ${f}`);
        return t;
      });
      return planAnnotation(schematic, op).map((a) => ({
        op: "setField" as const,
        file: a.file,
        uuid: a.symbolUuid,
        name: "Reference",
        value: a.reference,
        sheetPath: a.sheetPath,
      }));
    });
  }

  private applyAll(files: Record<string, string>, ops: EditOp[], rootFile?: string): Record<string, string> {
    const changed: Record<string, string> = {};
    const load = (file: string) => {
      const text = changed[file] ?? files[file];
      if (text === undefined) throw new Error(`No such file: ${file}`);
      let cached = this.docs.get(file);
      if (!cached || cached.text !== text) {
        cached = { text, doc: parse(text, { recover: true }) };
        this.docs.set(file, cached);
      }
      return cached;
    };
    for (const op of ops) {
      if (op.op === "setEvidence") {
        // A JSON sidecar next to the project; created on first use.
        changed[op.file] = applyEvidence(changed[op.file] ?? files[op.file], op.change);
        continue;
      }
      if (op.op === "setRequirements") {
        changed[op.file] = serializeRequirements(op.requirements);
        continue;
      }
      if (op.op === "setErcExclusions") {
        const text = changed[op.file] ?? files[op.file];
        if (text === undefined) throw new Error(`No such file: ${op.file}`);
        const pro = JSON.parse(text) as { erc?: { erc_exclusions?: unknown[] } };
        pro.erc ??= {};
        const entryOf = (e: unknown) => String(Array.isArray(e) ? e[0] : e);
        let list = (pro.erc.erc_exclusions ?? []).filter((e) => !op.include?.includes(entryOf(e)));
        if (op.exclude && !list.some((e) => entryOf(e) === op.exclude!.entry)) list = [...list, [op.exclude.entry, op.exclude.comment]];
        pro.erc.erc_exclusions = list;
        changed[op.file] = JSON.stringify(pro, null, 2) + "\n";
        continue;
      }
      if (op.op === "setSchematicDrawing") {
        const text = changed[op.file] ?? files[op.file];
        if (text === undefined) throw new Error(`No such file: ${op.file}`);
        const pro = JSON.parse(text) as { schematic?: { drawing?: Record<string, unknown> } };
        pro.schematic ??= {};
        pro.schematic.drawing = { ...(pro.schematic.drawing ?? {}), ...op.drawing };
        changed[op.file] = JSON.stringify(pro, null, 2) + "\n";
        continue;
      }
      if (op.op === "setProjectRules") {
        // The project file is JSON (KiCad writes it with 2-space indents).
        const text = changed[op.file] ?? files[op.file];
        if (text === undefined) throw new Error(`No such file: ${op.file}`);
        const pro = JSON.parse(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        if (op.rules) {
          pro.board ??= {};
          pro.board.design_settings ??= {};
          pro.board.design_settings.rules = { ...(pro.board.design_settings.rules ?? {}), ...op.rules };
        }
        if (op.exclude || op.include) {
          pro.board ??= {};
          pro.board.design_settings ??= {};
          const list: unknown[] = Array.isArray(pro.board.design_settings.drc_exclusions) ? pro.board.design_settings.drc_exclusions : [];
          const entryOf = (e: unknown) => String(Array.isArray(e) ? e[0] : e);
          const keyOf = (e: unknown) => {
            const [type, , , ...uuids] = entryOf(e).split("|");
            return exclusionKey(type ?? "", uuids.map((uuid) => ({ uuid })));
          };
          let next = op.include ? list.filter((e) => keyOf(e) !== op.include) : list;
          if (op.exclude && !next.some((e) => keyOf(e) === keyOf(op.exclude!.entry))) next = [...next, [op.exclude.entry, op.exclude.comment ?? ""]];
          pro.board.design_settings.drc_exclusions = next;
        }
        if (op.netClass) {
          pro.net_settings ??= { classes: [] };
          pro.net_settings.classes ??= [];
          let cls = pro.net_settings.classes.find((c: { name?: string }) => c.name === op.netClass!.name);
          if (!cls) {
            // A new class starts as a copy of Default, ranked after the classes there are (KiCad's priority).
            const base = pro.net_settings.classes.find((c: { name?: string }) => c.name === "Default") ?? {};
            const others = pro.net_settings.classes.filter((c: { name?: string }) => c.name !== "Default").length;
            pro.net_settings.classes.push((cls = { ...base, name: op.netClass.name, priority: others }));
          }
          Object.assign(cls, op.netClass.fields);
        }
        if (op.classPatterns) {
          pro.net_settings ??= { classes: [] };
          const keep = (pro.net_settings.netclass_patterns ?? []).filter((p: { netclass?: string }) => p.netclass !== op.classPatterns!.name);
          pro.net_settings.netclass_patterns = [...keep, ...op.classPatterns.patterns.map((pattern) => ({ netclass: op.classPatterns!.name, pattern }))];
        }
        if (op.removeClass && op.removeClass !== "Default" && pro.net_settings) {
          pro.net_settings.classes = (pro.net_settings.classes ?? []).filter((c: { name?: string }) => c.name !== op.removeClass);
          pro.net_settings.netclass_patterns = (pro.net_settings.netclass_patterns ?? []).filter((p: { netclass?: string }) => p.netclass !== op.removeClass);
        }
        changed[op.file] = JSON.stringify(pro, null, 2) + "\n";
        continue;
      }
      if (op.op === "symWrite") {
        changed[op.file] = op.text;
        this.docs.delete(op.file);
        const table = changed[op.libTable] ?? files[op.libTable];
        const next = withLibTableEntry(table, "sym", op.lib, `\${KIPRJMOD}/${op.libFile}`);
        if (next !== table) changed[op.libTable] = next;
        continue;
      }
      if (op.op === "updateSchematicSymbols") {
        const libText = changed[op.libFile] ?? files[op.libFile];
        if (libText === undefined) throw new Error(`No such library: ${op.libFile}`);
        const def = resolveLibrarySymbol(libText, op.lib, op.name);
        for (const sheet of op.sheets) {
          const c = load(sheet);
          if (updateSchematicLibSymbol(sheetRoot(c.doc), def, newBoardUuid)) {
            const out = serialize(c.doc);
            this.docs.set(sheet, { text: out, doc: c.doc });
            changed[sheet] = out;
          }
        }
        continue;
      }
      if (op.op === "symbol") {
        const c = load(op.file);
        const lib = symbolLibRoot(c.doc);
        const sym = findLibSymbol(lib, op.name);
        if (!sym) throw new Error(`No symbol ${op.name} in ${op.file}`);
        applySymbolEdit(lib, sym, op.edit);
        const out = serialize(c.doc);
        this.docs.set(op.file, { text: out, doc: c.doc });
        changed[op.file] = out;
        continue;
      }
      if (op.op === "saveBlock") {
        const source = sheetRoot(load(op.file).doc);
        const base = `${op.dir}${op.lib}.kicad_blocks/${op.name}.kicad_block/${op.name}`;
        changed[`${base}.kicad_sch`] = blockFromSelection(source, op.uuids, op.projectName, op.sheetPath);
        changed[`${base}.json`] = blockMetadataJson(op.description, op.keywords);
        const tableFile = `${op.dir}design-block-lib-table`;
        const table = changed[tableFile] ?? files[tableFile];
        const next = withLibTableEntry(table, "design_block", op.lib, `\${KIPRJMOD}/${op.lib}.kicad_blocks`);
        if (next !== table) changed[tableFile] = next;
        continue;
      }
      if (op.op === "fpWrite") {
        changed[op.file] = op.text;
        this.docs.delete(op.file);
        const table = changed[op.libTable] ?? files[op.libTable];
        const next = withLibTableEntry(table, "fp", op.lib, `\${KIPRJMOD}/${op.libDir}`);
        if (next !== table) changed[op.libTable] = next;
        continue;
      }
      const cached = load(op.file);
      if (op.file.endsWith(".kicad_mod")) {
        if (op.op !== "footprint") throw new Error(`${op.op} doesn't apply to a footprint`);
        applyFootprintEdit(footprintNode(cached.doc), op.edit);
        const out = serialize(cached.doc);
        this.docs.set(op.file, { text: out, doc: cached.doc });
        changed[op.file] = out;
        continue;
      }
      if (op.file.endsWith(".kicad_pcb")) {
        applyBoardOp(boardRoot(cached.doc), op, cached.doc, (f) => changed[f] ?? files[f]);
        const out = serialize(cached.doc);
        this.docs.set(op.file, { text: out, doc: cached.doc });
        changed[op.file] = out;
        continue;
      }
      const root = sheetRoot(cached.doc);
      const each = (uuids: string[], f: (n: NonNullable<ReturnType<typeof findItem>>) => void) => {
        for (const id of uuids) {
          const n = findItem(root, id);
          if (n) f(n);
        }
      };
      // Items a sheet's file version can't hold are refused, however they arrive.
      const features = sheetFeatureCounts(root);
      switch (op.op) {
        case "move": each(op.uuids, (n) => moveItem(n, op.dx, op.dy)); break;
        case "rotate": each(op.uuids, (n) => rotateItem(n)); break;
        case "mirror": each(op.uuids, (n) => mirrorSymbol(n, op.axis)); break;
        case "delete": for (const id of op.uuids) deleteItem(root, id); break;
        case "setField": each([op.uuid], (n) => setSymbolField(n, op.name, op.value, op.sheetPath)); break;
        case "setSymbolAttributes": each([op.uuid], (n) => setSymbolAttributes(n, op)); break;
        case "setBodyStyle": each([op.uuid], (n) => setSymbolBodyStyle(n, op.style, Number(arg(findChild(root, "version"), 0) ?? Infinity))); break;
        case "setPinAlternate": each([op.uuid], (n) => setPinAlternate(n, op.pin, op.alternate ?? undefined)); break;
        case "setFieldVisible": each([op.uuid], (n) => setFieldVisible(n, op.name, op.visible)); break;
        case "setLabelShape": each([op.uuid], (n) => setLabelShape(n, op.shape)); break;
        case "moveField": each([op.uuid], (n) => moveField(n, op.name, op.dx, op.dy)); break;
        case "rotateField": each([op.uuid], (n) => rotateField(n, op.name)); break;
        case "setPageSettings": setPageSettings(root, op.settings); break;
        case "addWire": if (op.bus) addBus(root, op.points); else addWire(root, op.points); break;
        case "addBusEntry": addBusEntry(root, op.at, op.size); break;
        case "addSchText": addSchText(root, op.text, op.at, { size: op.size }); break;
        case "addSchTextBox": addSchTextBox(root, op.text, op.a, op.b); break;
        case "addSchGraphic": addSchGraphic(root, op.graphic, { dash: op.dash }); break;
        case "setText": each([op.uuid], (n) => setItemText(n, op.text)); break;
        case "addLabel": addLabel(root, op.kind, op.text, op.at, op.angle ?? 0, op.shape); break;
        case "addJunction": addJunction(root, op.at); break;
        case "addImage": addImage(root, op.at, op.png, op.scale ?? 1); break;
        case "addTable": addTable(root, op.at, op.rows, op.cols); break;
        case "setHyperlink": each([op.uuid], (n) => setHyperlink(n, op.href.trim() || undefined)); break;
        case "setImageScale": each([op.uuid], (n) => setImageScale(n, op.scale)); break;
        case "addDirective": addDirective(root, op.at, op.netclass, op.angle ?? 0); break;
        case "addRuleArea":
          addRuleArea(root, op.points);
          if (op.netclass) addDirective(root, op.points[0]!, op.netclass, 0);
          break;
        case "addNoConnect": addNoConnect(root, op.at); break;
        case "moveWirePoint": moveWirePoint(root, op.uuid, op.index, op.to); break;
        case "duplicate": {
          const source = op.source === op.file ? root : sheetRoot(load(op.source).doc);
          duplicateItems(source, root, op.uuids, op.dx, op.dy, op.references, op.sheetPaths);
          break;
        }
        case "annotate": break; // expanded above
        case "addSheet": {
          // The new file sits in this sheet's folder; its Sheetfile is relative to that folder.
          const dir = op.file.slice(0, op.file.lastIndexOf("/") + 1);
          addSheet(root, { ...op, file: op.newFile.startsWith(dir) ? op.newFile.slice(dir.length) : op.newFile });
          if (files[op.newFile] === undefined && changed[op.newFile] === undefined) changed[op.newFile] = newSheetFile();
          break;
        }
        case "addSheetPin": {
          const sheet = findItem(root, op.sheetUuid);
          if (!sheet) throw new Error("Sheet not found");
          addSheetPin(sheet, op.name, op.shape, op.at);
          // The matching label inside the child, stacked down its left margin.
          const child = load(op.childFile);
          const childRoot = sheetRoot(child.doc);
          const hier = childRoot.children.filter((c): c is List => headOf(c) === "hierarchical_label");
          if (!hier.some((l) => arg(l, 0) === op.name)) {
            const count = hier.length;
            addLabel(childRoot, "hierarchical_label", op.name, { x: 25.4, y: 25.4 + 5.08 * count }, 180);
            const t = serialize(child.doc);
            this.docs.set(op.childFile, { text: t, doc: child.doc });
            changed[op.childFile] = t;
          }
          break;
        }
        case "setSheetProps":
          each([op.uuid], (n) => {
            if (op.name !== undefined) setSheetName(n, op.name);
            if (!op.page) return;
            if (findChild(n, "instances") || !rootFile) return setSheetPage(n, op.page.path, op.page.number);
            // KiCad 6 keeps page numbers in the root file, by the path below the root sheet.
            const own = rootFile === op.file;
            const top = own ? root : sheetRoot(load(rootFile).doc);
            const rootPath = `/${String(arg(findChild(top, "uuid"), 0) ?? "")}`;
            const below = op.page.path.startsWith(rootPath) ? op.page.path.slice(rootPath.length) : op.page.path;
            setLegacySheetPage(top, `${below}/${op.uuid}`, op.page.number);
            if (!own) {
              const doc = load(rootFile).doc;
              const t = serialize(doc);
              this.docs.set(rootFile, { text: t, doc });
              changed[rootFile] = t;
            }
          });
          break;
        case "setSheetPinName": each([op.uuid], (n) => setSheetPinName(n, op.pin, op.name)); break;
        case "syncSheetPins": {
          const sheet = findItem(root, op.sheetUuid);
          if (!sheet) throw new Error("Sheet not found");
          const child = load(op.childFile);
          if (syncSheetPins(sheet, sheetRoot(child.doc)).labels.length) {
            const t = serialize(child.doc);
            this.docs.set(op.childFile, { text: t, doc: child.doc });
            changed[op.childFile] = t;
          }
          break;
        }
        case "insertBlock": {
          const inserted = insertBlock(root, op.blockText, op.at === "free" ? findFreeSpot(root) : op.at, op.sheetPaths, op.projectName, op.keepReferences);
          // Number the new parts now, so one undo step takes the whole block back out.
          if (rootFile && inserted.symbolUuids.length && !op.keepReferences) {
            const text = serialize(cached.doc);
            this.docs.set(op.file, { text, doc: cached.doc });
            changed[op.file] = text;
            const schematic = loadSchematic(rootFile, (f) => {
              const t = changed[f] ?? files[f];
              if (t === undefined) throw new Error(`missing ${f}`);
              return t;
            });
            const fresh = new Set(inserted.symbolUuids);
            for (const a of planAnnotation(schematic, { mode: "unannotated" })) {
              if (!fresh.has(a.symbolUuid)) continue; // leave the user's own unnumbered parts alone
              const n = findItem(root, a.symbolUuid);
              if (n) setSymbolField(n, "Reference", a.reference, a.sheetPath);
            }
          }
          // The block's board, if it has one and the project has a board: footprints linked to the new
          // symbols, copper on the nets the schematic now has.
          const pcbFile = rootFile?.replace(/\.kicad_sch$/, ".kicad_pcb");
          if (op.blockPcb && rootFile && pcbFile && (changed[pcbFile] ?? files[pcbFile]) !== undefined) {
            const text = serialize(cached.doc);
            this.docs.set(op.file, { text, doc: cached.doc });
            changed[op.file] = text;
            const schematic = loadSchematic(rootFile, (f) => {
              const t = changed[f] ?? files[f];
              if (t === undefined) throw new Error(`missing ${f}`);
              return t;
            });
            const padNet = new Map<string, string>();
            for (const net of buildNetlist(schematic).nets) for (const n of net.nodes) padNet.set(`${n.reference}.${n.pin}`, net.name);
            const finalRef = new Map<string, string>();
            for (const s of inserted.symbols) {
              const n = findItem(root, s.uuid);
              const p = n && findChildren(n, "property").find((q) => arg(q, 0) === "Reference");
              if (p) finalRef.set(s.blockReference, String(arg(p, 1)));
            }
            const board = load(pcbFile);
            insertBlockBoard(boardRoot(board.doc), op.blockPcb, {
              symbols: inserted.symbols,
              sheetPath: op.sheetPaths[0] ?? "/",
              reference: (r) => finalRef.get(r) ?? r,
              netOf: (r, pad) => padNet.get(`${r}.${pad}`),
            });
            const out = serialize(board.doc);
            this.docs.set(pcbFile, { text: out, doc: board.doc });
            changed[pcbFile] = out;
          }
          break;
        }
        case "placeSymbol": {
          const s = op.source;
          let def: List | undefined;
          if (s.kind === "embedded") {
            const src = s.file === op.file ? root : sheetRoot(load(s.file).doc);
            const libs = findChild(src, "lib_symbols");
            def = libs && findChildren(libs, "symbol").find((d) => arg(d, 0) === s.libId);
            if (!def) throw new Error(`Library symbol ${s.libId} not found`);
          } else if (s.kind === "library") {
            const text = changed[s.file] ?? files[s.file];
            if (text === undefined) throw new Error(`No such library: ${s.file}`);
            def = resolveLibrarySymbol(text, s.library, s.name);
          } else {
            def = parse(s.text).children.find((c): c is List => isList(c) && headOf(c) === "symbol");
            if (!def) throw new Error("Invalid symbol definition");
          }
          placeSymbol(root, def, { at: op.at, reference: op.reference, unit: op.unit, sheetPaths: op.sheetPaths, projectName: op.projectName });
          break;
        }
      }
      requireSheetFeatures(root, features);
      const out = serialize(cached.doc);
      this.docs.set(op.file, { text: out, doc: cached.doc });
      changed[op.file] = out;
    }
    if (rootFile && ops.some((op) => op.file.endsWith(".kicad_sch") && !KEEPS_NETS.has(op.op))) syncNetclassAssignments(rootFile, changed, files);
    return changed;
  }
}

/** Apply one board operation to a parsed .kicad_pcb root. */
function applyBoardOp(root: List, op: EditOp, doc: Document, read: (file: string) => string | undefined): void {
  const items = (uuids: string[]) => uuids.map((u) => findBoardItem(root, u)).filter((n): n is List => !!n);
  switch (op.op) {
    case "setPageSettings":
      setPageSettings(root, op.settings);
      break;
    case "cleanupTracks":
      for (const u of op.remove) deleteBoardItem(root, u);
      pruneGroups(root, op.remove);
      for (const r of op.reshape) {
        const n = findBoardItem(root, r.uuid);
        if (n) {
          moveTrackEnd(n, 0, r.start);
          moveTrackEnd(n, 1, r.end);
        }
      }
      break;
    case "boardMove":
      for (const n of items(op.uuids)) moveBoardItem(n, op.dx, op.dy);
      break;
    case "boardArrange":
      for (const m of op.moves) {
        const n = findBoardItem(root, m.uuid);
        if (n) moveBoardItem(n, m.dx, m.dy);
      }
      break;
    case "moveFootprintText":
      moveFootprintText(root, op.footprint, op.text, op.dx, op.dy);
      break;
    case "boardRotate":
      for (const n of items(op.uuids)) rotateBoardItem(n, op.deg, op.center);
      break;
    case "boardFlip":
      for (const n of items(op.uuids)) if (headOf(n) === "footprint") flipFootprint(n, op.centerX);
      break;
    case "boardDelete":
      for (const u of op.uuids) deleteBoardItem(root, u);
      // Deleted items leave their groups; groups left empty go (KiCad's commit).
      pruneGroups(root, op.uuids);
      break;
    case "boardGroup":
      addGroup(root, op.members, op.name ?? "", op.uuid);
      break;
    case "boardUngroup":
      for (const g of op.groups) removeGroup(root, g);
      break;
    case "addTrack":
      for (let i = 1; i < op.points.length; i++) {
        const a = op.points[i - 1]!;
        const b = op.points[i]!;
        if (a.x !== b.x || a.y !== b.y) addTrack(root, { start: a, end: b, width: op.width, layer: op.layer, net: op.net });
      }
      break;
    case "addVia":
      addVia(root, { type: op.type, at: op.at, size: op.size, drill: op.drill, layers: op.layers, net: op.net });
      break;
    case "addBoardShape":
      addBoardShape(root, op.shape);
      break;
    case "addZone":
      addZone(root, op.zone);
      break;
    case "addBoardText":
      addBoardText(root, op.text);
      break;
    case "addTextBox":
      addTextBox(root, op.box);
      break;
    case "setBoardText":
      for (const n of items(op.uuids)) if (headOf(n) === "gr_text" || headOf(n) === "gr_text_box") setBoardText(n, op);
      break;
    case "autoroute": {
      const rules = projectDesignRules(read(op.file.replace(/\.kicad_pcb$/, ".kicad_pro")));
      const board = parseBoard(serialize(doc));
      const span: [string, string] = [board.copperLayers[0]!, board.copperLayers[board.copperLayers.length - 1]!];
      autorouteAll(board, rules, op.connections, op.deadline).forEach((r, i) => {
        const net = op.connections[i]!.net;
        if (!r) return;
        const cls = netClassOf(rules, net);
        for (const run of r.runs) for (let k = 1; k < run.points.length; k++) addTrack(root, { start: run.points[k - 1]!, end: run.points[k]!, width: cls.trackWidth, layer: run.layer, net });
        for (const v of r.vias) addVia(root, { at: v, size: cls.viaDiameter, drill: cls.viaDrill, layers: span, net });
      });
      break;
    }
    case "addDimension":
      addDimension(root, op);
      break;
    case "setLocked":
      for (const u of op.uuids) {
        const n = findBoardItem(root, u);
        if (n && headOf(n) === "group") setGroupLocked(root, u, op.locked);
        else if (n) setLocked(n, op.locked);
      }
      break;
    case "setPadProps": {
      const fp = findBoardItem(root, op.footprint);
      if (!fp) break;
      setPadProps(fp, op.pad, op);
      if (op.net !== undefined) setPadNet(root, fp, op.pad, op.net);
      break;
    }
    case "boardArray":
      createBoardArray(root, op.uuids, op.options, { reannotate: op.reannotate, arrange: op.arrange });
      break;
    case "boardDuplicate": {
      const copies = op.uuids.flatMap((u, i) => {
        const n = findBoardItem(root, u);
        return n ? [{ text: serialize(n), uuid: op.fresh[i]! }] : [];
      });
      pasteBoardItems(root, copies, op.dx, op.dy);
      break;
    }
    case "teardrops": {
      removeTeardrops(root);
      if (op.remove) break;
      const rules = projectDesignRules(read(op.file.replace(/\.kicad_pcb$/, ".kicad_pro")));
      const board = parseBoard(serialize(doc));
      computeTeardrops(board, rules, copperItems(board)).forEach((t, i) => addTeardropZone(root, { ...t, priority: 30000 + i }));
      break;
    }
    case "tuneLength": {
      const rules = projectDesignRules(read(op.file.replace(/\.kicad_pcb$/, ".kicad_pro")));
      const board = parseBoard(serialize(doc));
      const r = tuneNetLength(board, rules, copperItems(board), op.net, op.target, op.prefer);
      // The replaced tracks leave their groups (KiCad's meander is a new item, outside them).
      pruneGroups(root, r.replace.map((t) => t.uuid));
      for (const t of r.replace) {
        deleteBoardItem(root, t.uuid);
        for (let k = 1; k < t.points.length; k++) addTrack(root, { start: t.points[k - 1]!, end: t.points[k]!, width: t.width, layer: t.layer, net: op.net });
      }
      break;
    }
    case "setZoneOutline": {
      const n = findBoardItem(root, op.uuid);
      if (n) setPolygonPoints(n, op.points);
      break;
    }
    case "setGraphicPoints": {
      const n = findBoardItem(root, op.uuid);
      if (n) setGraphicPoints(n, op.points);
      break;
    }
    case "setZoneProps":
      for (const n of items(op.uuids)) if (headOf(n) === "zone") setZoneProps(root, n, op);
      break;
    case "moveTrackEnd": {
      const n = findBoardItem(root, op.uuid);
      if (n) moveTrackEnd(n, op.index, op.to);
      break;
    }
    case "setFootprintField": {
      const n = findBoardItem(root, op.uuid);
      if (n) setFootprintField(n, op.name, op.value);
      break;
    }
    case "setTrackProps":
      for (const n of items(op.uuids)) setTrackProps(n, op);
      break;
    case "setViaProps":
      for (const n of items(op.uuids)) setViaProps(n, op);
      break;
    case "updateFootprints":
      for (const u of op.updates) updateFootprintFromLibrary(root, u.uuid, u.text);
      break;
    case "setStackup": {
      const spec = STACKUPS[op.name];
      const err = spec ? setStackup(root, spec) : `No stackup ${op.name}`;
      if (err) throw new Error(err);
      break;
    }
    case "setCopperLayers": {
      const err = setCopperLayerCount(root, op.count);
      if (err) throw new Error(err);
      break;
    }
    case "stitchPours": {
      const board = parseBoard(serialize(doc));
      const rules = projectDesignRules(read(op.file.replace(/\.kicad_pcb$/, ".kicad_pro")));
      const span: [string, string] = [board.copperLayers[0]!, board.copperLayers[board.copperLayers.length - 1]!];
      for (const net of new Set(board.zones.filter((z) => !z.keepout && z.net).map((z) => z.net))) {
        const cls = netClassOf(rules, net);
        for (const st of op.fanout ? fanoutPours(board, rules, net) : stitchToPours(board, rules, net)) {
          for (const run of st.runs) for (let k = 1; k < run.points.length; k++) addTrack(root, { start: run.points[k - 1]!, end: run.points[k]!, width: cls.trackWidth, layer: run.layer, net });
          for (const v of st.vias) addVia(root, { at: v, size: cls.viaDiameter, drill: cls.viaDrill, layers: span, net });
        }
      }
      break;
    }
    case "refillZones": {
      const board = parseBoard(serialize(doc));
      const rules = projectDesignRules(read(op.file.replace(/\.kicad_pcb$/, ".kicad_pro")));
      const byZone = new Map<string, Array<{ layer: string; polygons: Point[][] }>>();
      for (const f of fillZones(board, rules)) {
        const list = byZone.get(f.zone.uuid) ?? [];
        list.push({ layer: f.layer, polygons: fracture(f.paths) });
        byZone.set(f.zone.uuid, list);
      }
      for (const [uuid, fills] of byZone) {
        // Zones after a stray ")" sit beside the root (KiCad tolerates that).
        const node =
          findBoardItem(root, uuid) ??
          doc.children.find((c): c is List => isList(c) && headOf(c) === "zone" && String(arg(findChild(c, "uuid"), 0)) === uuid);
        if (node) setZoneFills(node, fills);
      }
      break;
    }
    case "placeFootprint":
      // Placed on the board alone: not part of the schematic.
      placeFootprint(root, op.text, { at: op.at, reference: op.reference, value: op.value, libId: op.libId, layer: op.layer, boardOnly: true });
      break;
    case "updateBoard": {
      for (const u of op.plan.updates) applyFootprintUpdate(root, u);
      for (const m of op.plan.missing) {
        const text = op.footprints[m.footprint];
        const at = op.places[m.reference];
        if (!text || !at) continue;
        placeFootprint(root, text, { ...m, libId: m.footprint, at });
      }
      if (op.deleteExtra) {
        for (const e of op.plan.extra) deleteBoardItem(root, e.uuid);
        pruneGroups(root, op.plan.extra.map((e) => e.uuid));
      }
      break;
    }
    default:
      throw new Error(`${op.op} is not a board operation`);
  }
}

function applyFootprintEdit(fp: ReturnType<typeof footprintNode>, e: FootprintEdit): void {
  switch (e.kind) {
    case "addPad": addFpPad(fp, e.pad); break;
    case "addPadArray": addFpPadArray(fp, e.base, e); break;
    case "setPad": setFpPad(fp, e.uuid, e.props); break;
    case "move": moveFpItems(fp, e.uuids, e.d); break;
    case "delete": deleteFpItems(fp, e.uuids); break;
    case "addGraphic": addFpGraphic(fp, e.graphic); break;
    case "setProps": setFpProps(fp, e.props); break;
    case "courtyard": setFpCourtyard(fp, e.excess); break;
    case "pasteWindows": addFpPasteWindows(fp, e.uuid, e); break;
    case "rotate": rotateFpItems(fp, e.uuids, e.center, e.deg); break;
    case "setField": setFpField(fp, e.name, e.value); break;
    case "mirror": mirrorFpItems(fp, e.uuids, e.at, e.axis); break;
    case "renumber": renumberFpPads(fp, e.uuids, { first: e.first, step: e.step, prefix: e.prefix }); break;
    case "addCustomPad": addFpCustomPad(fp, e.pad); break;
    case "model": setFpModel(fp, e.model); break;
  }
}

function applySymbolEdit(lib: List, s: List, e: SymbolEdit): void {
  switch (e.kind) {
    case "addPin": addSymPin(s, e.pin, e.unit); break;
    case "setPin": setSymPin(s, e.number, e.props, e.unit); break;
    case "movePins": moveSymPins(s, e.numbers, e.d, e.unit); break;
    case "deletePins": deleteSymPins(s, e.numbers, e.unit); break;
    case "addGraphic": addSymGraphic(s, e.graphic, e.scope); break;
    case "units": setUnitCount(s, e.count); break;
    case "deMorgan": setDeMorgan(s, e.on); break;
    case "bodyStyles": setBodyStyles(s, e.styles); break;
    case "jumpers": setJumpers(s, e); break;
    case "unitName": setUnitName(s, e.unit, e.name); break;
    case "unitsLocked": setUnitsLocked(s, e.locked); break;
    case "pinUnit": setPinUnit(s, e.numbers, e.unit); break;
    case "power": {
      const at = lib.children.indexOf(s);
      removeChild(lib, s);
      insertAt(lib, at, format(newPowerSymbol(String(arg(s, 0)), e.style), "\t"));
      break;
    }
    case "moveGraphics": moveSymGraphics(s, e.indexes, e.d); break;
    case "deleteGraphics": deleteSymGraphics(s, e.indexes); break;
    case "setFields": setSymFields(s, e.fields); break;
    case "layout": {
      const v = describeSymbol(s);
      const fresh = layoutSymbol(v.name, e.pins, { reference: v.fields.Reference, value: v.fields.Value, footprint: v.fields.Footprint, datasheet: v.fields.Datasheet, description: v.fields.Description, keywords: v.fields.ki_keywords, fpFilters: v.fields.ki_fp_filters });
      const at = lib.children.indexOf(s);
      removeChild(lib, s);
      insertAt(lib, at, format(fresh, "\t"));
      break;
    }
  }
}

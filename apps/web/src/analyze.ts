/**
 * Turns a set of project files into everything the UI shows: schematic sheet
 * display lists, components, nets, the board and parity findings. Runs in a
 * web worker (see worker.ts) so large projects don't block the page.
 */
import { headOf, isList, parse, type List } from "@crossprobe/kicad-sexpr";
import {
  buildNetlist,
  checkParity,
  findUnconnected,
  checkClearance,
  checkBoard,
  clearanceCheckType,
  excludedKeys,
  exclusionKey,
  type BoardViolation,
  netClassOf,
  parseDru,
  projectDesignRules,
  type ClearanceViolation,
  planBoardUpdate,
  planSchematicUpdate,
  type BoardUpdatePlan,
  indexLibrary,
  parseLibTable,
  type Unconnected,
  loadSchematic,
  parseBoard,
  projectErcSettings,
  projectRuleSeverities,
  runErc,
  type ErcViolation,
  type Board,
  type ParityFinding,
  unitPins,
  isErcExcluded,
  parseDrawingSheet,
} from "@crossprobe/kicad-model";
import { evidenceFileName, parseEvidence } from "./datasheet/evidence";
import { parseRequirements, requirementsFileName } from "./requirements/requirements";
import { renderSheet } from "./render/schematic";
import type { ProjectView, SheetView } from "./render/types";

export interface ProjectFiles {
  /** Path of the .kicad_pro, relative to the project folder. */
  project: string;
  /** Project-relative path → file text. */
  files: Record<string, string>;
}

export function analyze({ project, files }: ProjectFiles): ProjectView {
  const t0 = performance.now();
  const base = project.replace(/\.kicad_pro$/, "");
  const name = base.split("/").pop() ?? base;
  const warnings: string[] = [];
  const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "";
  const read = (rel: string) => {
    const text = files[dir + rel];
    if (text === undefined) throw new Error(`missing file ${rel}`);
    return text;
  };

  let sheets: SheetView[] = [];
  let components: ProjectView["components"] = [];
  let nets: ProjectView["nets"] = [];
  let parity: ParityFinding[] = [];
  let erc: ErcViolation[] = [];
  let unconnected: Unconnected[] = [];
  let libraries: ProjectView["libraries"] = [];
  let references: string[] = [];
  const projectSymbols: ProjectView["projectSymbols"] = [];
  const projectSymbolLibraries: ProjectView["projectSymbolLibraries"] = {};
  let board: Board | undefined;
  let boardUpdate: BoardUpdatePlan | undefined;
  let schematicUpdate: ProjectView["schematicUpdate"];
  let clearance: ClearanceViolation[] = [];
  let boardChecks: BoardViolation[] = [];
  const drcExcluded: ProjectView["drcExcluded"] = [];
  const ercExcluded: ProjectView["ercExcluded"] = [];
  const netClasses: ProjectView["netClasses"] = {};
  const rules = projectDesignRules(files[project]);
  const druText = files[`${base}.kicad_dru`];
  if (druText !== undefined) {
    try {
      rules.custom = parseDru(druText);
    } catch (e) {
      warnings.push(`custom rules: ${(e as Error).message}`);
    }
  }
  // Custom constraints this DRC doesn't check yet (it applies clearance rules).
  const unsupportedRules = [...new Set((rules.custom ?? []).flatMap((r) => r.constraints.map((c) => c.type)).filter((t) => !["clearance", "hole_size", "annular_width", "track_width", "via_diameter", "length", "skew", "diff_pair_gap", "diff_pair_uncoupled"].includes(t)))];
  let rootSheet: string | undefined;
  // Design blocks saved in the project's own block libraries (<lib>.kicad_blocks/<name>.kicad_block/).
  const projectBlocks: ProjectView["projectBlocks"] = [];
  for (const [path, text] of Object.entries(files)) {
    const m = /(?:^|\/)([^/]+)\.kicad_blocks\/([^/]+)\.kicad_block\/([^/]+)\.kicad_sch$/.exec(path);
    if (!m || m[2] !== m[3]) continue;
    let meta: { description?: string; keywords?: string } = {};
    try {
      meta = JSON.parse(files[path.replace(/\.kicad_sch$/, ".json")] ?? "{}");
    } catch {
      // No metadata: the name is enough.
    }
    projectBlocks.push({ id: path, lib: m[1]!, name: m[2]!, description: meta.description ?? "", keywords: (meta.keywords ?? "").split(/\s+/).filter(Boolean), text });
  }
  let intersheetRefs: ProjectView["intersheetRefs"];

  const schFile = `${name}.kicad_sch`;
  const pcbText = files[`${base}.kicad_pcb`];
  if (pcbText !== undefined) {
    try {
      board = parseBoard(pcbText);
      warnings.push(...board.warnings.map((w) => `board: ${w}`));
      unconnected = findUnconnected(board);
      // The designer's exclusions are set apart (both checkers), so they can be reviewed and undone.
      const excluded = excludedKeys(rules);
      for (const v of checkClearance(board, rules)) {
        const key = exclusionKey(clearanceCheckType(v.type), v.items);
        if (!excluded.has(key)) clearance.push(v);
        else drcExcluded.push({ type: clearanceCheckType(v.type), message: v.type === "short" ? "Short" : `${v.actual.toFixed(3)} < ${v.required.toFixed(3)} mm`, at: v.at, items: v.items.map((i) => i.description), key });
      }
      for (const v of checkBoard(board, { ...rules, exclusions: [] })) {
        const key = exclusionKey(v.type, v.items);
        if (!excluded.has(key)) boardChecks.push(v);
        else drcExcluded.push({ type: v.type, message: v.message, at: v.at, items: v.items.map((i) => i.description), key });
      }
      for (const net of ["", ...board.nets]) {
        const c = netClassOf(rules, net);
        netClasses[net] = { name: c.name, clearance: c.clearance, trackWidth: c.trackWidth, viaDiameter: c.viaDiameter, viaDrill: c.viaDrill };
      }
    } catch (e) {
      warnings.push(`board: ${(e as Error).message}`);
    }
  }

  if (files[dir + schFile] !== undefined) {
    const schematic = loadSchematic(schFile, read);
    const netlist = buildNetlist(schematic, { detail: true });
    warnings.push(...schematic.warnings, ...netlist.warnings);
    rootSheet = schematic.root.path;
    intersheetRefs = schematic.intersheetRefs;

    const pinNets = new Map<string, string>();
    for (const n of netlist.nets) for (const node of n.nodes) pinNets.set(`${node.reference}\0${node.pin}`, n.name);

    const trees = new Map<string, List>();
    const tree = (file: string) => {
      let t = trees.get(file);
      if (!t) {
        const doc = parse(read(file), { recover: true });
        t = doc.children.find((c): c is List => isList(c) && headOf(c) === "kicad_sch")!;
        trees.set(file, t);
      }
      return t;
    };
    // The project's drawing sheet (KiCad's Page Settings › Drawing sheet), relative to the project.
    let drawingSheet: ReturnType<typeof parseDrawingSheet> | undefined;
    try {
      const wks = String(JSON.parse(files[project] ?? "{}")?.schematic?.page_layout_descr_file ?? "").replace(/^\$\{KIPRJMOD\}\//, "");
      if (wks && files[dir + wks] !== undefined) drawingSheet = parseDrawingSheet(files[dir + wks]!);
      else if (wks) warnings.push(`drawing sheet ${wks} not found: the default frame is drawn`);
    } catch {
      // An unreadable project file leaves the default frame.
    }
    sheets = schematic.sheets.map((s) => renderSheet(s, tree(s.file), schematic, netlist, pinNets, drawingSheet));

    components = schematic.components.map((c) => ({
      reference: c.reference,
      value: c.value,
      footprint: c.footprint,
      datasheet: c.datasheet,
      description: c.properties["Description"] || c.lib?.properties["Description"] || "",
      libId: c.libId,
      sheets: [...new Set(c.units.map((u) => u.sheet.path))],
      units: c.units.map((u) => ({ file: dir + u.sheet.file, uuid: u.symbol.uuid, sheet: u.sheet.path, unit: u.unit })),
      unitCount: c.lib?.unitCount ?? 1,
      properties: c.properties,
      dnp: c.dnp,
      inBom: c.inBom,
      onBoard: c.onBoard,
      excludeFromSim: c.units.some((u) => u.symbol.excludeFromSim),
      hiddenFields: c.units[0]?.symbol.hiddenFields ?? [],
      bodyStyle: c.units[0]?.symbol.bodyStyle ?? 1,
      bodyStyles: c.lib?.bodyStyleNames ?? (c.lib?.bodyStyles === 2 ? ["Standard", "De Morgan"] : Array.from({ length: c.lib?.bodyStyles ?? 1 }, (_, i) => `Style ${i + 1}`)),
      pinAlternates: c.units.flatMap((u) =>
        (c.lib ? unitPins(c.lib, u.unit, u.symbol.bodyStyle) : [])
          .filter((p) => p.alternates)
          .map((p) => ({ pin: p.number, name: p.name, alternates: Object.keys(p.alternates!), current: u.symbol.pinAlternates?.[p.number] })),
      ),
      fpFilters: (c.lib?.properties["ki_fp_filters"] ?? c.properties["ki_fp_filters"] ?? "").split(/\s+/).filter(Boolean),
      pinCount: new Set((c.lib?.pins ?? []).map((p) => p.number).filter(Boolean)).size,
    }));
    nets = netlist.nets.map((n) => ({
      name: n.name,
      aliases: n.aliases,
      // Sheet instance paths (not name paths) so the UI can navigate.
      sheets: schematic.sheets.filter((s) => n.sheets.includes(s.namePath)).map((s) => s.path),
      nodes: n.nodes.map((x) => ({ reference: x.reference, pin: x.pin, pinName: x.pinName, pinType: x.pinType })),
    }));

    // Parts available to place: every library symbol embedded in any sheet.
    const seenLib = new Map<string, ProjectView["libraries"][number]>();
    for (const s of schematic.sheets) {
      for (const [libId, lib] of s.data.libSymbols) {
        if (seenLib.has(libId)) continue;
        const ref = lib.properties["Reference"] ?? "U";
        seenLib.set(libId, {
          libId,
          file: dir + s.file,
          name: libId.includes(":") ? libId.slice(libId.indexOf(":") + 1) : libId,
          description: lib.properties["Description"] ?? "",
          prefix: ref.replace(/[0-9?]+$/, "") || "U",
          power: !!lib.power,
          pins: lib.pins.length,
        });
      }
    }
    libraries = [...seenLib.values()].sort((a, b) => a.name.localeCompare(b.name));
    references = schematic.placements.map((p) => p.reference);

    const pro = files[project];
    try {
      const settings = pro ? projectErcSettings(pro) : {};
      const entries = (settings.exclusions ?? []).map((x) => x.entry);
      for (const v of runErc(schematic, netlist, settings)) {
        if (!isErcExcluded(v, entries)) erc.push(v);
        else ercExcluded.push({ ...v, entries: entries.filter((e) => isErcExcluded(v, [e])), comment: settings.exclusions!.find((x) => isErcExcluded(v, [x.entry]))?.comment ?? "" });
      }
    } catch (e) {
      warnings.push(`ERC: ${(e as Error).message}`);
    }
    // The detail is only needed for ERC; don't ship it to the page.
    netlist.detail = undefined;

    if (board) {
      parity = checkParity(schematic, netlist, board, { severities: pro ? projectRuleSeverities(pro) : {} });
      try {
        boardUpdate = planBoardUpdate(schematic, netlist, board);
        schematicUpdate = planSchematicUpdate(schematic, board);
      } catch (e) {
        warnings.push(`board update: ${(e as Error).message}`);
      }
    }
  }

  // Project footprint libraries listed in fp-lib-table (${KIPRJMOD}-relative .pretty folders).
  const projectFootprints: ProjectView["projectFootprints"] = [];
  const fpTable = files[dir + "fp-lib-table"];
  if (fpTable !== undefined) {
    for (const lib of parseLibTable(fpTable)) {
      const rel = lib.uri.replace(/^\$\{KIPRJMOD\}\/?/, "").replace(/\/$/, "");
      if (rel === lib.uri && /^(\/|[A-Za-z]:|\$\{)/.test(lib.uri)) continue; // outside the project
      const prefix = `${dir}${rel}/`;
      for (const [path, text] of Object.entries(files)) {
        if (!path.startsWith(prefix) || !path.endsWith(".kicad_mod") || path.slice(prefix.length).includes("/")) continue;
        const name = path.slice(prefix.length, -".kicad_mod".length);
        const pads = new Set([...text.matchAll(/\(pad "([^"]*)"/g)].map((m) => m[1]).filter(Boolean)).size;
        projectFootprints.push({ libId: `${lib.name}:${name}`, lib: lib.name, name, file: path, text, pads, description: /\(descr "((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? "" });
      }
    }
  }

  // Project symbol libraries listed in sym-lib-table (${KIPRJMOD}-relative files).
  const table = files[dir + "sym-lib-table"];
  if (table !== undefined) {
    for (const lib of parseLibTable(table)) {
      const rel = lib.uri.replace(/^\$\{KIPRJMOD\}\/?/, "");
      if (rel === lib.uri && /^(\/|[A-Za-z]:|\$\{)/.test(lib.uri)) continue; // outside the project
      const text = files[dir + rel];
      if (text === undefined) {
        warnings.push(`symbol library ${lib.name}: ${rel} not found`);
        continue;
      }
      try {
        for (const e of indexLibrary(text, lib.name)) projectSymbols.push({ ...e, file: dir + rel });
        projectSymbolLibraries[dir + rel] = { lib: lib.name, text };
      } catch (e) {
        warnings.push(`symbol library ${lib.name}: ${(e as Error).message}`);
      }
    }
  }

  return {
    name,
    evidence: parseEvidence(files[evidenceFileName(base)]),
    evidenceFile: evidenceFileName(base),
    requirements: parseRequirements(files[requirementsFileName(base)]),
    requirementsFile: requirementsFileName(base),
    rootSheet,
    intersheetRefs,
    projectBlocks,
    sheets,
    components,
    nets,
    board,
    boardFile: board ? `${base}.kicad_pcb` : undefined,
    projectFile: project,
    clearance,
    boardChecks,
    drcExcluded,
    ercExcluded,
    customRules: druText !== undefined,
    unsupportedRules,
    netClasses,
    designRules: { minClearance: rules.minClearance, copperEdgeClearance: rules.copperEdgeClearance, holeClearance: rules.holeClearance, custom: rules.custom, classes: [...rules.classes.values()], patterns: rules.patterns, assignments: Object.fromEntries(rules.assignments) },
    boardSetup: {
      minClearance: rules.minClearance,
      minTrackWidth: rules.minTrackWidth ?? 0,
      minViaDiameter: rules.minViaDiameter ?? 0.5,
      minViaAnnular: rules.minViaAnnular ?? 0.1,
      minHoleSize: rules.minHoleSize ?? 0.3,
      minHoleToHole: rules.minHoleToHole ?? 0.25,
      holeClearance: rules.holeClearance ?? 0,
      copperEdgeClearance: rules.copperEdgeClearance ?? 0,
      minTextHeight: rules.minTextHeight ?? 0.8,
    },
    boardUpdate,
    schematicUpdate,
    parity,
    erc,
    unconnected,
    libraries,
    projectSymbols,
    projectSymbolLibraries,
    projectFootprints,
    references,
    warnings,
    stats: { files: Object.keys(files).length, parseMs: Math.round(performance.now() - t0) },
  };
}

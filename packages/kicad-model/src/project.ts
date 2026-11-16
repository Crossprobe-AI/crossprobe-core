/**
 * Schematic hierarchy: resolves sheet files into sheet *instances* (a sheet
 * file used twice appears twice, with its own path and reference designators)
 * and groups placed symbol units into components.
 */
import { parseSheetFile, type LibPin, type LibSymbol, type PlacedSymbol, type SheetFile, type SheetRef } from "./sheet.js";

/** Synchronous file access, relative to the root schematic's directory. */
export type ReadFile = (relativePath: string) => string;

export interface SheetInstance {
  /** UUID path, e.g. "/<root>/<sheet>"; matches symbol `instances` paths. */
  path: string;
  /** Human path used as the net-name prefix, e.g. "/" or "/Power/". */
  namePath: string;
  file: string;
  data: SheetFile;
  parent?: SheetInstance;
  /** The sheet symbol in the parent that instantiates this sheet. */
  ref?: SheetRef;
  pageNumber?: string;
}

export interface ComponentUnit {
  sheet: SheetInstance;
  symbol: PlacedSymbol;
  unit: number;
}

export interface Component {
  reference: string;
  value: string;
  footprint: string;
  datasheet: string;
  libId: string;
  lib?: LibSymbol;
  properties: Record<string, string>;
  units: ComponentUnit[];
  inBom: boolean;
  onBoard: boolean;
  dnp: boolean;
}

export interface Schematic {
  root: SheetInstance;
  sheets: SheetInstance[];
  /** Real components (power symbols and other `#`-references excluded). */
  components: Component[];
  /** Every placed symbol unit per sheet instance, power symbols included. */
  /** Text variables of the project (from the .kicad_pro next to the root sheet). */
  textVariables?: Record<string, string>;
  placements: Array<{ sheet: SheetInstance; symbol: PlacedSymbol; reference: string; unit: number; lib?: LibSymbol; /** The value, where the file keeps it per instance (KiCad 6). */ value?: string }>;
  warnings: string[];
}

export function loadSchematic(rootFile: string, read: ReadFile): Schematic {
  const cache = new Map<string, SheetFile>();
  const warnings: string[] = [];
  const load = (file: string): SheetFile | undefined => {
    let data = cache.get(file);
    if (!data) {
      try {
        data = parseSheetFile(read(file));
      } catch (e) {
        warnings.push(`Cannot load sheet ${file}: ${(e as Error).message}`);
        return undefined;
      }
      cache.set(file, data);
    }
    return data;
  };

  const rootData = load(rootFile);
  if (!rootData) throw new Error(warnings[0]);
  const root: SheetInstance = { path: `/${rootData.uuid}`, namePath: "/", file: rootFile, data: rootData, pageNumber: rootData.sheetPages?.get("/") };
  const sheets: SheetInstance[] = [];

  const visit = (inst: SheetInstance, depth: number) => {
    sheets.push(inst);
    if (depth > 64) {
      warnings.push(`Sheet recursion too deep at ${inst.namePath}`);
      return;
    }
    for (const ref of inst.data.sheets) {
      // A sheet that (directly or indirectly) contains itself would recurse forever.
      let cyclic = false;
      for (let a: SheetInstance | undefined = inst; a; a = a.parent) if (a.file === ref.file) cyclic = true;
      if (cyclic) {
        warnings.push(`${inst.namePath}: sheet "${ref.name}" refers back to ${ref.file}; skipped`);
        continue;
      }
      const data = load(ref.file);
      if (!data) continue;
      visit(
        {
          path: `${inst.path}/${ref.uuid}`,
          namePath: `${inst.namePath}${ref.name}/`,
          file: ref.file,
          data,
          parent: inst,
          ref,
          // KiCad 7+ keeps the page on the sheet symbol, KiCad 6 in the root file.
          pageNumber:
            ref.pages?.find((p) => p.path === inst.path)?.page ?? rootData.sheetPages?.get(`${inst.path.slice(root.path.length)}/${ref.uuid}`),
        },
        depth + 1,
      );
    }
  };
  visit(root, 0);

  let project: { text_variables?: Record<string, string>; schematic?: { bus_aliases?: Record<string, string[]> } } | undefined;
  try {
    project = JSON.parse(read(rootFile.replace(/\.kicad_sch$/, ".kicad_pro")));
  } catch {
    // No project file: no project variables or aliases.
  }

  // Bus aliases are project-wide: KiCad 9+ keeps them in the project file,
  // earlier versions in one of the sheet files.
  const aliases = new Map<string, string[]>();
  const projectAliases = project?.schematic?.bus_aliases;
  if (projectAliases && typeof projectAliases === "object") {
    for (const [k, v] of Object.entries(projectAliases)) if (Array.isArray(v)) aliases.set(k, v.map(String));
  }
  for (const data of cache.values()) for (const [k, v] of data.busAliases) if (!aliases.has(k)) aliases.set(k, v);
  for (const data of cache.values()) data.busAliases = aliases;

  const placements: Schematic["placements"] = [];
  const byRef = new Map<string, Component>();
  for (const sheet of sheets) {
    for (const symbol of sheet.data.symbols) {
      // KiCad 7+ stores per-instance references; the symbol's own Reference
      // property is only a fallback for files without instance data.
      // KiCad 6 (before 20221002) keeps them in the root file instead, with the value and
      // footprint, under the symbol's path below the root sheet.
      const legacy = rootData.version >= 20221002 ? undefined : rootData.legacyInstances.get(`${sheet.path.slice(root.path.length)}/${symbol.uuid}`);
      const inst = symbol.instances.find((i) => i.path === sheet.path) ?? legacy;
      const reference = inst?.reference ?? symbol.properties["Reference"] ?? "?";
      const unit = inst?.unit ?? symbol.unit;
      const lib = sheet.data.libSymbols.get(symbol.libId);
      if (!lib) warnings.push(`${sheet.namePath}: missing library symbol ${symbol.libId} for ${reference}`);
      placements.push({ sheet, symbol, reference, unit, lib, value: legacy?.value || undefined });

      if (reference.startsWith("#") || lib?.power) continue;
      let comp = byRef.get(reference);
      if (!comp) {
        comp = {
          reference,
          value: legacy?.value || (symbol.properties["Value"] ?? ""),
          footprint: legacy?.footprint || (symbol.properties["Footprint"] ?? ""),
          datasheet: symbol.properties["Datasheet"] ?? "",
          libId: symbol.libId,
          lib,
          properties: { ...symbol.properties },
          units: [],
          inBom: symbol.inBom,
          onBoard: symbol.onBoard,
          dnp: symbol.dnp,
        };
        byRef.set(reference, comp);
      }
      comp.units.push({ sheet, symbol, unit });
    }
  }

  const components = [...byRef.values()].sort((a, b) => compareRefs(a.reference, b.reference));
  const vars = project?.text_variables;
  const textVariables = vars && typeof vars === "object" ? vars : undefined;
  return { root, sheets, components, placements, warnings, textVariables };
}

/** Pins of a library symbol that belong to a given unit and body style. */
export function unitPins(lib: LibSymbol, unit: number, bodyStyle: number): LibPin[] {
  return lib.pins.filter(
    (p) => (p.unit === 0 || p.unit === unit) && (p.bodyStyle === 0 || p.bodyStyle === bodyStyle),
  );
}

/** Natural ordering for reference designators: R2 < R10. */
export function compareRefs(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

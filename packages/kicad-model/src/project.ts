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
  /** How global labels list the pages they are on (the project's Schematic Setup › Formatting). */
  intersheetRefs?: IntersheetRefSettings;
  /** Text variables of the project (from the .kicad_pro next to the root sheet). */
  textVariables?: Record<string, string>;
  /** Every placed symbol unit per sheet instance, power symbols included. */
  placements: Array<{ sheet: SheetInstance; symbol: PlacedSymbol; reference: string; unit: number; lib?: LibSymbol; /** The value, where the file keeps it per instance (KiCad 6). */ value?: string }>;
  warnings: string[];
}

export interface IntersheetRefSettings {
  /** Shown next to each global label. */
  show: boolean;
  /** The page the label is on is listed too. */
  ownPage: boolean;
  /** "2..5" for more than two pages. */
  short: boolean;
  prefix: string;
  suffix: string;
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
      // KiCad finds a sheet's file next to the sheet that uses it; files from older layouts
      // name it from the project folder, which is the same for sheets there.
      let file = sheetFilePath(inst.file, ref.file);
      if (file !== ref.file && !cache.has(file)) {
        try {
          read(file);
        } catch {
          file = ref.file;
        }
      }
      // A sheet that (directly or indirectly) contains itself would recurse forever.
      let cyclic = false;
      for (let a: SheetInstance | undefined = inst; a; a = a.parent) if (a.file === file) cyclic = true;
      if (cyclic) {
        warnings.push(`${inst.namePath}: sheet "${ref.name}" refers back to ${file}; skipped`);
        continue;
      }
      const data = load(file);
      if (!data) continue;
      visit(
        {
          path: `${inst.path}/${ref.uuid}`,
          namePath: `${inst.namePath}${ref.name}/`,
          file,
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

  let project: { text_variables?: Record<string, string>; schematic?: { bus_aliases?: Record<string, string[]>; drawing?: Record<string, unknown> } } | undefined;
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

      // Power symbols and flags have references starting with #; KiCad lists any other part.
      if (reference.startsWith("#")) continue;
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
  const drawing = project?.schematic?.drawing ?? {};
  const intersheetRefs: IntersheetRefSettings = {
    show: drawing["intersheets_ref_show"] === true,
    ownPage: drawing["intersheets_ref_own_page"] === true,
    short: drawing["intersheets_ref_short"] === true,
    prefix: typeof drawing["intersheets_ref_prefix"] === "string" ? drawing["intersheets_ref_prefix"] : "",
    suffix: typeof drawing["intersheets_ref_suffix"] === "string" ? drawing["intersheets_ref_suffix"] : "",
  };
  return { root, sheets, components, placements, warnings, textVariables, intersheetRefs };
}

/**
 * A sheet file named in `parent` (a path from the project folder), as a path from the project
 * folder: relative to the parent's folder, as KiCad resolves it ("../x" and "./x" included).
 */
export function sheetFilePath(parent: string, name: string): string {
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[A-Za-z]:\//.test(n) || n.includes("${")) return name;
  const parts = parent.split("/").slice(0, -1);
  for (const seg of n.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** Pins of a library symbol that belong to a given unit and body style. */
export function unitPins(lib: LibSymbol, unit: number, bodyStyle: number): LibPin[] {
  return lib.pins.filter(
    (p) => (p.unit === 0 || p.unit === unit) && (p.bodyStyle === 0 || p.bodyStyle === bodyStyle),
  );
}

/**
 * The sheets in the order KiCad numbers them: by page number (as numbers where both are,
 * else as text), the hierarchy's order between equal ones.
 */
export function sheetsByPage(schematic: Schematic): SheetInstance[] {
  const page = (s: SheetInstance) => s.pageNumber ?? "";
  return [...schematic.sheets].sort((a, b) => {
    const [pa, pb] = [page(a), page(b)];
    const [na, nb] = [Number(pa), Number(pb)];
    if (pa !== "" && pb !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
}

/** Natural ordering for reference designators: R2 < R10. */
export function compareRefs(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

/**
 * Symbol libraries (.kicad_sym): indexing for search, and resolving a symbol
 * to the flattened, prefixed form a schematic embeds in its lib_symbols.
 * Derived symbols (`extends`) inherit their parent's graphics and pins,
 * with the child's fields taking precedence.
 */
import { arg, findChild, findChildren, headOf, insertAt, isList, parse, removeChild, serialize, setArg, str, type List } from "@crossprobe/kicad-sexpr";

export interface LibrarySymbolEntry {
  /** Library nickname, e.g. "Device". */
  library: string;
  name: string;
  description: string;
  keywords: string;
  /** Reference prefix, e.g. "R" or "#PWR". */
  prefix: string;
  power: boolean;
  pins: number;
}

function libRoot(text: string): List {
  const root = parse(text, { recover: true }).children.find((c): c is List => isList(c) && headOf(c) === "kicad_symbol_lib");
  if (!root) throw new Error("Not a KiCad symbol library");
  return root;
}

const prop = (sym: List, name: string) => {
  const p = findChildren(sym, "property").find((q) => arg(q, 0) === name);
  return p ? String(arg(p, 1) ?? "") : undefined;
};

const pinCount = (sym: List) => findChildren(sym, "symbol").reduce((n, u) => n + findChildren(u, "pin").length, 0);

/** Index every symbol of a library for searching. */
export function indexLibrary(text: string, library: string): LibrarySymbolEntry[] {
  const root = libRoot(text);
  const byName = new Map(findChildren(root, "symbol").map((s) => [String(arg(s, 0)), s]));
  const out: LibrarySymbolEntry[] = [];
  for (const [name, sym] of byName) {
    const parentName = findChild(sym, "extends") ? String(arg(findChild(sym, "extends"), 0)) : undefined;
    const parent = parentName ? byName.get(parentName) : undefined;
    const ref = prop(sym, "Reference") ?? (parent && prop(parent, "Reference")) ?? "U";
    out.push({
      library,
      name,
      description: prop(sym, "Description") ?? prop(sym, "ki_description") ?? "",
      keywords: prop(sym, "ki_keywords") ?? "",
      prefix: ref.replace(/[0-9?]+$/, "") || "U",
      power: !!findChild(sym, "power") || (!!parent && !!findChild(parent, "power")),
      pins: pinCount(parent ?? sym),
    });
  }
  return out;
}

/**
 * A library symbol in embeddable form: named "Library:Name", with any
 * `extends` resolved into a standalone definition.
 */
export function resolveLibrarySymbol(text: string, library: string, name: string): List {
  const root = libRoot(text);
  const symbols = findChildren(root, "symbol");
  const sym = symbols.find((s) => arg(s, 0) === name);
  if (!sym) throw new Error(`${library}:${name} not found`);
  let def = parse(serialize(sym)).children[0] as List;

  const ext = findChild(def, "extends");
  if (ext) {
    const parentName = String(arg(ext, 0));
    const parentSym = symbols.find((s) => arg(s, 0) === parentName);
    if (!parentSym) throw new Error(`${library}:${name} extends missing ${parentName}`);
    const parent = parse(serialize(parentSym)).children[0] as List;
    // Start from the parent: its units (renamed to the child) and flags…
    for (const unit of findChildren(parent, "symbol")) {
      setArg(unit, 0, str(String(arg(unit, 0)).replace(parentName, name)));
    }
    // …then the child's fields override the parent's, field by field.
    const childProps = new Map(findChildren(def, "property").map((p) => [String(arg(p, 0)), p]));
    for (const p of findChildren(parent, "property")) {
      const c = childProps.get(String(arg(p, 0)));
      if (c) parent.children[parent.children.indexOf(p)] = c;
    }
    for (const [k, c] of childProps) {
      if (!findChildren(parent, "property").some((p) => arg(p, 0) === k)) {
        const last = findChildren(parent, "property").pop();
        insertAt(parent, last ? parent.children.indexOf(last) + 1 : 1, c);
      }
    }
    setArg(parent, 0, str(name));
    def = parse(serialize(parent)).children[0] as List;
    const leftover = findChild(def, "extends");
    if (leftover) removeChild(def, leftover);
  }
  setArg(def, 0, str(`${library}:${name}`));
  return def;
}

/** Library nicknames and file paths from a sym-lib-table (paths may contain ${KIPRJMOD}). */
export function parseLibTable(text: string): Array<{ name: string; uri: string }> {
  const root = parse(text, { recover: true }).children.find((c): c is List => isList(c));
  if (!root) return [];
  return findChildren(root, "lib").map((l) => ({
    name: String(arg(findChild(l, "name"), 0) ?? ""),
    uri: String(arg(findChild(l, "uri"), 0) ?? ""),
  }));
}

/**
 * A library table (fp-lib-table / sym-lib-table) with `name` → `uri` in it, as KiCad writes the
 * table: the text unchanged when the library is there already.
 */
export function withLibTableEntry(text: string | undefined, kind: "fp" | "sym" | "design_block", name: string, uri: string, descr = ""): string {
  const head = kind === "fp" ? "fp_lib_table" : kind === "sym" ? "sym_lib_table" : "design_block_lib_table";
  const libs = text ? parseLibTable(text) : [];
  if (libs.some((l) => l.name === name)) return text!;
  const entry = `\t(lib (name "${name}")(type "KiCad")(uri "${uri}")(options "")(descr "${descr.replace(/["\\]/g, "'")}"))\n`;
  if (!text || !text.includes(`(${head}`)) return `(${head}\n\t(version 7)\n${entry})\n`;
  const end = text.lastIndexOf(")");
  return text.slice(0, end).replace(/\s*$/, "\n") + entry + text.slice(end);
}
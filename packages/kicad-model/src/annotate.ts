/**
 * Annotation: assign reference designators the way KiCad's "Annotate
 * Schematic" does. Sheets are visited in hierarchy order, and parts on each
 * sheet are sorted by position (X then Y, or Y then X). Numbers continue
 * across sheets per prefix. Units of one multi-unit part keep a shared
 * reference, and every instance of a reused sheet gets its own numbers.
 */
import type { Schematic } from "./project.js";

export interface AnnotationOptions {
  /** "all" renumbers everything; "unannotated" only fills in references ending in "?". */
  mode: "all" | "unannotated";
  /** Sort by X then Y (KiCad's default) or Y then X. */
  order?: "x" | "y";
}

export interface Assignment {
  /** Sheet file and symbol UUID to edit, and the sheet instance the reference is for. */
  file: string;
  symbolUuid: string;
  sheetPath: string;
  from: string;
  reference: string;
}

const prefixOf = (ref: string) => ref.replace(/[0-9?]+$/, "") || "U";
const numberOf = (ref: string) => {
  const m = /(\d+)$/.exec(ref);
  return m ? Number(m[1]) : undefined;
};

export function planAnnotation(schematic: Schematic, options: AnnotationOptions): Assignment[] {
  const order = options.order ?? "x";
  // Group placed units into parts: per sheet instance, by existing reference
  // (annotated parts) or by symbol (unannotated ones are each their own part).
  type Part = { key: string; prefix: string; ref: string; sheetIndex: number; x: number; y: number; units: Schematic["placements"] };
  const parts = new Map<string, Part>();
  const sheetIndex = new Map(schematic.sheets.map((s, i) => [s, i]));
  for (const pl of schematic.placements) {
    const unannotated = pl.reference.endsWith("?");
    const key = unannotated ? `${pl.sheet.path}|${pl.symbol.uuid}` : `${pl.reference}`;
    let p = parts.get(key);
    if (!p) {
      p = { key, prefix: prefixOf(pl.reference), ref: pl.reference, sheetIndex: sheetIndex.get(pl.sheet) ?? 0, x: pl.symbol.at.x, y: pl.symbol.at.y, units: [] };
      parts.set(key, p);
    }
    p.units.push(pl);
  }

  // Positions rounded to the 50 mil grid so near-aligned parts sort as KiCad does.
  const g = (v: number) => Math.round(v / 1.27);
  const sorted = [...parts.values()].sort(
    (a, b) =>
      a.sheetIndex - b.sheetIndex ||
      (order === "x" ? g(a.x) - g(b.x) || g(a.y) - g(b.y) : g(a.y) - g(b.y) || g(a.x) - g(b.x)) ||
      a.ref.localeCompare(b.ref, "en", { numeric: true }),
  );

  // Numbers in use, per prefix (only kept ones in "unannotated" mode).
  const used = new Map<string, Set<number>>();
  const take = (prefix: string, n: number) => {
    let s = used.get(prefix);
    if (!s) used.set(prefix, (s = new Set()));
    s.add(n);
  };
  if (options.mode === "unannotated") {
    for (const p of sorted) {
      const n = numberOf(p.ref);
      if (!p.ref.endsWith("?") && n !== undefined) take(p.prefix, n);
    }
  }
  const nextFree = (prefix: string) => {
    const s = used.get(prefix) ?? new Set<number>();
    let n = 1;
    while (s.has(n)) n++;
    take(prefix, n);
    return n;
  };

  const out: Assignment[] = [];
  for (const p of sorted) {
    if (options.mode === "unannotated" && !p.ref.endsWith("?")) continue;
    const reference = `${p.prefix}${nextFree(p.prefix)}`;
    for (const u of p.units) {
      if (u.reference === reference) continue;
      out.push({ file: u.sheet.file, symbolUuid: u.symbol.uuid, sheetPath: u.sheet.path, from: u.reference, reference });
    }
  }
  return out;
}

/**
 * Find and Replace in a schematic, as KiCad's dialog does it: in texts, text boxes,
 * labels, sheet names and pins, and the fields of placed symbols (references only when asked,
 * as they are renumbered by annotation). Match case, whole words, or wildcards
 * (`*` and `?`, matching the whole text, which a replacement then replaces).
 */
import { arg, findChild, findChildren, headOf, isAtom, isList, type List } from "@crossprobe/kicad-sexpr";

export interface FindOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
  /** `*` and `?` as wildcards; the pattern then matches a whole text. */
  wildcards?: boolean;
  /** Look in reference designators too. */
  references?: boolean;
  /** Look in fields that are not shown on the sheet. */
  hiddenFields?: boolean;
}

/** The pattern for a search; undefined for an empty one. */
export function findPattern(find: string, o: FindOptions = {}): RegExp | undefined {
  if (!find) return undefined;
  const escape = (s: string) => s.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
  const flags = o.matchCase ? "g" : "gi";
  if (o.wildcards) return new RegExp(`^${find.split("").map((c) => (c === "*" ? "[\\s\\S]*" : c === "?" ? "[\\s\\S]" : escape(c))).join("")}$`, flags);
  const body = escape(find);
  // A word is letters, digits and underscores, as in KiCad's whole-word search.
  return new RegExp(o.wholeWord ? `(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])` : body, flags);
}

/** Does the text contain a match? */
export function textMatches(text: string, find: string, o: FindOptions = {}): boolean {
  const re = findPattern(find, o);
  if (!re) return false;
  re.lastIndex = 0;
  return re.test(text);
}

/** The text with every match replaced; undefined when nothing matches. */
export function replaceInText(text: string, find: string, replacement: string, o: FindOptions = {}): string | undefined {
  const re = findPattern(find, o);
  if (!re || !textMatches(text, find, o)) return undefined;
  re.lastIndex = 0;
  return text.replace(re, () => replacement);
}

export type FindTarget =
  /** A text, text box or label (by its UUID). */
  | { kind: "text" | "label"; file: string; uuid: string; text: string }
  /** A field of a placed symbol; a reference is per sheet instance (`sheetPath`). */
  | { kind: "field"; file: string; uuid: string; field: string; text: string; sheetPath?: string }
  /** A sheet symbol's name. */
  | { kind: "sheet"; file: string; uuid: string; text: string }
  /** A pin of a sheet symbol (`uuid` is the sheet's, `pin` the pin's). */
  | { kind: "sheetpin"; file: string; uuid: string; pin: string; text: string };

const uuidOf = (n: List) => String(arg(findChild(n, "uuid"), 0) ?? "");
const hidden = (prop: List) => {
  const effects = findChild(prop, "effects");
  return (!!effects && (effects.children.some((c) => isAtom(c) && c.raw === "hide") || arg(findChild(effects, "hide"), 0) === "yes")) || arg(findChild(prop, "hide"), 0) === "yes";
};

/** Everything in these sheet files that Find looks at, matching or not. */
export function searchableItems(sheets: Array<{ file: string; root: List }>, o: FindOptions = {}): FindTarget[] {
  const out: FindTarget[] = [];
  for (const { file, root } of sheets) {
    for (const node of root.children) {
      if (!isList(node)) continue;
      const head = headOf(node);
      const uuid = uuidOf(node);
      if (head === "text" || head === "text_box") out.push({ kind: "text", file, uuid, text: String(arg(node, 0) ?? "") });
      else if (head === "label" || head === "global_label" || head === "hierarchical_label") out.push({ kind: "label", file, uuid, text: String(arg(node, 0) ?? "") });
      else if (head === "sheet") {
        const name = findChildren(node, "property").find((p) => /^Sheet ?name$/.test(String(arg(p, 0))));
        if (name) out.push({ kind: "sheet", file, uuid, text: String(arg(name, 1) ?? "") });
        for (const pin of findChildren(node, "pin")) out.push({ kind: "sheetpin", file, uuid, pin: uuidOf(pin), text: String(arg(pin, 0) ?? "") });
      } else if (head === "symbol") {
        for (const prop of findChildren(node, "property")) {
          const field = String(arg(prop, 0));
          if (field.startsWith("ki_") || (!o.hiddenFields && hidden(prop))) continue;
          if (field === "Reference") {
            if (!o.references) continue;
            // References live per sheet instance.
            const paths = findChildren(findChild(node, "instances") ?? node, "project").flatMap((p) => findChildren(p, "path"));
            for (const p of paths) out.push({ kind: "field", file, uuid, field, text: String(arg(findChild(p, "reference"), 0) ?? ""), sheetPath: String(arg(p, 0)) });
            if (!paths.length) out.push({ kind: "field", file, uuid, field, text: String(arg(prop, 1) ?? "") });
          } else out.push({ kind: "field", file, uuid, field, text: String(arg(prop, 1) ?? "") });
        }
      }
    }
  }
  return out;
}

/** What Find finds. */
export function findInSheets(sheets: Array<{ file: string; root: List }>, find: string, o: FindOptions = {}): FindTarget[] {
  return searchableItems(sheets, o).filter((t) => textMatches(t.text, find, o));
}

/** Replace all: each match and its new text. */
export function planReplace(sheets: Array<{ file: string; root: List }>, find: string, replacement: string, o: FindOptions = {}): Array<FindTarget & { to: string }> {
  const out: Array<FindTarget & { to: string }> = [];
  for (const t of findInSheets(sheets, find, o)) {
    const to = replaceInText(t.text, find, replacement, o);
    if (to !== undefined && to !== t.text) out.push({ ...t, to });
  }
  return out;
}

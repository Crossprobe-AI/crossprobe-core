/**
 * Concrete syntax tree for KiCad S-expression files.
 *
 * The tree is lossless: every byte of the source lives either in an atom's
 * `raw` text or in a whitespace/comment "trivia" string. Serializing an
 * unmodified tree reproduces the input exactly, so edits produce minimal
 * diffs in version control.
 */

export type AtomKind = "symbol" | "string" | "number";

export interface Atom {
  type: "atom";
  kind: AtomKind;
  /** Exact source text, including quotes and escapes for strings. */
  raw: string;
}

export interface List {
  type: "list";
  children: Node[];
  /** `trivia[i]` is the whitespace/comments that precede `children[i]`. */
  trivia: string[];
  /** Whitespace/comments between the last child and the closing paren. */
  closeTrivia: string;
  /** Set by recovering parses when the file ended before this list closed. */
  unterminated?: boolean;
  /** Set by recovering parses for a list whose "(" is missing in the source. */
  implicitOpen?: boolean;
}

export type Node = Atom | List;

export interface Document {
  type: "document";
  /** Top-level forms. KiCad design files have one; .kicad_dru has many. */
  children: Node[];
  trivia: string[];
  /** Everything after the last top-level form (usually a final newline). */
  trailing: string;
  /** Problems found by a recovering parse (empty for well-formed input). */
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  message: string;
  offset: number;
  line: number;
  column: number;
}

export function isList(n: Node | undefined): n is List {
  return n !== undefined && n.type === "list";
}

export function isAtom(n: Node | undefined): n is Atom {
  return n !== undefined && n.type === "atom";
}

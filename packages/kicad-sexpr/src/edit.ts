import { isAtom, isList, type Atom, type List, type Node } from "./ast.js";

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function sym(name: string): Atom {
  return { type: "atom", kind: "symbol", raw: name };
}

export function num(value: number | string): Atom {
  return { type: "atom", kind: "number", raw: typeof value === "number" ? formatNumber(value) : value };
}

export function str(value: string): Atom {
  return { type: "atom", kind: "string", raw: quote(value) };
}

/** Build a list. Plain JS strings become symbols, numbers become number atoms. */
export function list(head: string, ...items: Array<Node | string | number>): List {
  const children: Node[] = [sym(head)];
  for (const item of items) {
    children.push(typeof item === "string" ? sym(item) : typeof item === "number" ? num(item) : item);
  }
  // Single-line spacing by default; `format` lays out nested lists when the node is attached.
  return { type: "list", children, trivia: children.map((_, i) => (i ? " " : "")), closeTrivia: "" };
}

/** KiCad writes numbers with up to 6 decimals, no trailing zeros, no exponent. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`Cannot serialize ${n}`);
  let s = n.toFixed(6).replace(/\.?0+$/, "");
  if (s === "-0") s = "0";
  return s;
}

export function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

export function unquote(raw: string): string {
  return raw.slice(1, -1).replace(/\\(.)/g, (_, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return c;
    }
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Decoded value of an atom: strings are unquoted, numbers parsed. */
export function atomValue(atom: Atom): string | number {
  switch (atom.kind) {
    case "string":
      return unquote(atom.raw);
    case "number":
      return Number(atom.raw);
    default:
      return atom.raw;
  }
}

/** Text value of an atom (numbers keep their source spelling). */
export function atomText(atom: Atom): string {
  return atom.kind === "string" ? unquote(atom.raw) : atom.raw;
}

/** The head symbol of a list, e.g. `footprint` for `(footprint ...)`. */
export function headOf(node: Node | undefined): string | undefined {
  if (!isList(node)) return undefined;
  const h = node.children[0];
  return isAtom(h) && h.kind === "symbol" ? h.raw : undefined;
}

export function findChild(parent: List, head: string): List | undefined {
  for (const c of parent.children) if (headOf(c) === head) return c as List;
  return undefined;
}

export function findChildren(parent: List, head: string): List[] {
  return parent.children.filter((c): c is List => headOf(c) === head);
}

/** Atom arguments of a list (everything after the head that is an atom). */
export function args(node: List): Atom[] {
  return node.children.slice(1).filter(isAtom);
}

/** Decoded value of the i-th argument, e.g. `arg(at, 0)` → x coordinate. */
export function arg(node: List | undefined, index: number): string | number | undefined {
  if (!node) return undefined;
  const a = node.children[index + 1];
  return isAtom(a) ? atomValue(a) : undefined;
}

/** Depth-first walk over all lists. Return `false` from the visitor to skip a subtree. */
export function walk(root: Node, visit: (node: List, parents: List[]) => boolean | void): void {
  const stack: Array<{ node: List; parents: List[] }> = [];
  if (isList(root)) stack.push({ node: root, parents: [] });
  while (stack.length > 0) {
    const { node, parents } = stack.pop()!;
    if (visit(node, parents) === false) continue;
    const next = [...parents, node];
    for (let i = node.children.length - 1; i >= 0; i--) {
      const c = node.children[i];
      if (isList(c)) stack.push({ node: c, parents: next });
    }
  }
}

// ---------------------------------------------------------------------------
// Editing (formatting-preserving)
// ---------------------------------------------------------------------------

/** Replace the i-th argument of a list in place, keeping surrounding whitespace. */
export function setArg(node: List, index: number, value: Atom | string | number): void {
  const atom = typeof value === "string" ? str(value) : typeof value === "number" ? num(value) : value;
  const i = index + 1;
  if (i < node.children.length) {
    node.children[i] = atom;
  } else {
    while (node.children.length < i) insertAt(node, node.children.length, sym("_"));
    insertAt(node, i, atom);
  }
}

/** Indentation (the whitespace after the last newline) of a trivia string. */
function indentOf(trivia: string): string | undefined {
  const nl = trivia.lastIndexOf("\n");
  return nl === -1 ? undefined : trivia.slice(nl + 1);
}

/**
 * Indentation used for children of `parent`, inferred from existing siblings,
 * falling back to `parentIndent` + one tab (KiCad's style since v8).
 */
function childIndent(parent: List, parentIndent: string): string {
  for (let i = parent.trivia.length - 1; i >= 0; i--) {
    const ind = indentOf(parent.trivia[i]!);
    if (ind !== undefined) return ind;
  }
  return parentIndent + "\t";
}

/**
 * Insert a child at `index`, choosing whitespace to match KiCad's layout:
 * lists go on their own line at the sibling indentation, atoms inline.
 * `parentIndent` is the indentation of the line where `parent` starts.
 */
export function insertAt(parent: List, index: number, child: Node, parentIndent?: string): void {
  const pIndent = parentIndent ?? inferParentIndent(parent);
  let trivia = " ";
  if (isList(child) && index > 0) {
    const ind = childIndent(parent, pIndent);
    trivia = "\n" + ind;
    format(child, ind);
    // A parent that was all on one line now needs its close paren on a new line.
    if (indentOf(parent.closeTrivia) === undefined && index === parent.children.length) {
      parent.closeTrivia = "\n" + pIndent;
    }
  } else if (index === 0) {
    trivia = "";
  }
  parent.children.splice(index, 0, child);
  parent.trivia.splice(index, 0, trivia);
}

export function appendChild(parent: List, child: Node, parentIndent?: string): void {
  insertAt(parent, parent.children.length, child, parentIndent);
}

export function removeChild(parent: List, child: Node): boolean {
  const i = parent.children.indexOf(child);
  if (i === -1) return false;
  parent.children.splice(i, 1);
  parent.trivia.splice(i, 1);
  return true;
}

function inferParentIndent(parent: List): string {
  const ind = indentOf(parent.closeTrivia);
  if (ind !== undefined) return ind;
  // Child indent minus one level.
  for (const t of parent.trivia) {
    const ci = indentOf(t);
    if (ci !== undefined) return ci.slice(0, -1);
  }
  return "";
}

/**
 * Lay out a freshly built subtree in KiCad style: atoms inline, nested lists
 * on their own lines one tab deeper, close paren aligned with the opener.
 * `(pts (xy ..) (xy ..))` keeps its points on a single line as KiCad does.
 */
export function format(node: List, indent = ""): List {
  const inner = indent + "\t";
  const head = headOf(node);
  const hasListChild = node.children.some((c, i) => i > 0 && isList(c));
  node.trivia = node.children.map((c, i) => {
    if (i === 0) return "";
    if (!isList(c)) return " ";
    if (head === "pts") return i === 1 ? "\n" + inner : " ";
    format(c, inner);
    return "\n" + inner;
  });
  node.closeTrivia = hasListChild ? "\n" + indent : "";
  return node;
}

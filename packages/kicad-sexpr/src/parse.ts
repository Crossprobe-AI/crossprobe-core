import type { Atom, AtomKind, Diagnostic, Document, List, Node } from "./ast.js";

export interface ParseOptions {
  /**
   * Treat `#` at the start of a token as a line comment. KiCad's design-rule
   * files (.kicad_dru) allow these; design files do not, and `#` can begin a
   * bare symbol there, so this is off by default.
   */
  comments?: boolean;
  /**
   * Keep going on malformed input instead of throwing. Real-world files
   * sometimes contain stray parens that KiCad tolerates. Stray `)` at the top
   * level are kept as trivia, unclosed lists are marked `unterminated`, and
   * each problem is recorded in `document.diagnostics`. Like KiCad's own
   * parser, a keyword glued to a preceding ")" inside a list of lists
   * (`(a 1)b 2)`) is read as a list with a missing "(", which restores the
   * intended nesting. Round-tripping stays byte-exact.
   */
  recover?: boolean;
}

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly offset: number,
    public readonly line: number,
    public readonly column: number,
  ) {
    super(`${message} at ${line}:${column}`);
    this.name = "ParseError";
  }
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/** Characters that end a bare (unquoted) token. */
function isDelimiter(c: number): boolean {
  return isWhitespace(c) || c === 0x28 /* ( */ || c === 0x29 /* ) */ || c === 0x22 /* " */;
}

/** A list like `(teardrops (a 1) (b 2))`: a head followed only by lists. */
function isListOfLists(list: List): boolean {
  return list.children.length > 1 && list.children.slice(1).every((c) => c.type === "list");
}

export function parse(text: string, options: ParseOptions = {}): Document {
  const comments = options.comments ?? false;
  const len = text.length;
  let pos = 0;

  const recover = options.recover ?? false;
  const locate = (msg: string, at: number): Diagnostic => {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < at; i++) {
      if (text.charCodeAt(i) === 0x0a) {
        line++;
        lineStart = i + 1;
      }
    }
    return { message: msg, offset: at, line, column: at - lineStart + 1 };
  };
  const fail = (msg: string, at = pos): never => {
    const d = locate(msg, at);
    throw new ParseError(msg, at, d.line, d.column);
  };

  const readTrivia = (): string => {
    const start = pos;
    for (;;) {
      while (pos < len && isWhitespace(text.charCodeAt(pos))) pos++;
      if (comments && pos < len && text.charCodeAt(pos) === 0x23 /* # */) {
        while (pos < len && text.charCodeAt(pos) !== 0x0a) pos++;
        continue;
      }
      break;
    }
    return text.slice(start, pos);
  };

  const readString = (): Atom => {
    const start = pos;
    pos++; // opening quote
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 0x5c /* \ */) {
        pos += 2;
        continue;
      }
      if (c === 0x22) {
        pos++;
        return { type: "atom", kind: "string", raw: text.slice(start, pos) };
      }
      pos++;
    }
    return fail("Unterminated string", start);
  };

  const readBare = (): Atom => {
    const start = pos;
    while (pos < len && !isDelimiter(text.charCodeAt(pos))) pos++;
    const raw = text.slice(start, pos);
    const kind: AtomKind = NUMBER_RE.test(raw) ? "number" : "symbol";
    return { type: "atom", kind, raw };
  };

  // Iterative parse with an explicit stack: board files nest deeply enough
  // and are large enough that recursion is not worth the risk.
  const doc: Document = { type: "document", children: [], trivia: [], trailing: "", diagnostics: [] };
  // Trivia carried forward when a stray ')' is absorbed in recovery mode.
  let pendingTrivia = "";
  const stack: List[] = [];
  const openPositions: number[] = [];

  const push = (node: Node, trivia: string) => {
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(node);
      parent.trivia.push(trivia);
    } else {
      doc.children.push(node);
      doc.trivia.push(trivia);
    }
  };

  let afterClose = false;
  for (;;) {
    const trivia = pendingTrivia + readTrivia();
    pendingTrivia = "";
    const glued = afterClose && trivia === "";
    afterClose = false;
    if (pos >= len) {
      if (stack.length > 0) {
        if (!recover) fail("Unclosed list", openPositions[openPositions.length - 1]);
        doc.diagnostics.push(locate("Unclosed list", openPositions[openPositions.length - 1]!));
        stack[stack.length - 1]!.closeTrivia = trivia;
        for (const l of stack) l.unterminated = true;
        return doc;
      }
      doc.trailing = trivia;
      return doc;
    }
    const c = text.charCodeAt(pos);
    if (c === 0x28) {
      const list: List = { type: "list", children: [], trivia: [], closeTrivia: "" };
      push(list, trivia);
      stack.push(list);
      openPositions.push(pos);
      pos++;
    } else if (c === 0x29) {
      const list = stack.pop();
      openPositions.pop();
      if (!list) {
        if (!recover) fail("Unexpected ')'");
        doc.diagnostics.push(locate("Unexpected ')'", pos));
        pos++;
        pendingTrivia = trivia + ")";
        continue;
      }
      list.closeTrivia = trivia;
      pos++;
      afterClose = true;
    } else if (c === 0x22) {
      push(readString(), trivia);
    } else {
      const atom = readBare();
      const parent = stack[stack.length - 1];
      if (recover && glued && atom.kind === "symbol" && parent && isListOfLists(parent)) {
        doc.diagnostics.push(locate("Missing '('", pos - atom.raw.length));
        const list: List = { type: "list", children: [atom], trivia: [""], closeTrivia: "", implicitOpen: true };
        push(list, trivia);
        stack.push(list);
        openPositions.push(pos - atom.raw.length);
      } else {
        push(atom, trivia);
      }
    }
  }
}

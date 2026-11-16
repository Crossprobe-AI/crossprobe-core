import type { Document, Node } from "./ast.js";

/** Serialize a node or document back to text, byte-for-byte for unmodified trees. */
export function serialize(node: Node | Document): string {
  const out: string[] = [];
  write(node, out);
  return out.join("");
}

function write(node: Node | Document, out: string[]): void {
  // Explicit stack to mirror the parser and avoid deep recursion.
  type Frame = { node: Node | Document; i: number };
  const stack: Frame[] = [{ node, i: -1 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const n = frame.node;
    if (n.type === "atom") {
      out.push(n.raw);
      stack.pop();
      continue;
    }
    if (frame.i === -1 && n.type === "list" && !n.implicitOpen) out.push("(");
    frame.i++;
    if (frame.i < n.children.length) {
      out.push(n.trivia[frame.i] ?? " ");
      stack.push({ node: n.children[frame.i]!, i: -1 });
    } else {
      out.push(n.type === "list" ? n.closeTrivia + (n.unterminated ? "" : ")") : n.trailing);
      stack.pop();
    }
  }
}

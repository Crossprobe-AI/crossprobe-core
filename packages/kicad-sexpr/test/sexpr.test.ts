import { describe, expect, it } from "vitest";
import {
  appendChild,
  arg,
  findChild,
  findChildren,
  list,
  parse,
  ParseError,
  serialize,
  setArg,
  str,
  unquote,
  quote,
  formatNumber,
  type List,
} from "../src/index.js";

const SAMPLE = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(symbol
\t\t(lib_id "Device:R")
\t\t(at 100.33 50.8 0)
\t\t(property "Reference" "R1"
\t\t\t(at 102.87 49.53 0)
\t\t)
\t)
)
`;

describe("parse/serialize", () => {
  it("round-trips byte for byte", () => {
    expect(serialize(parse(SAMPLE))).toBe(SAMPLE);
  });

  it("classifies atoms", () => {
    const doc = parse(`(a sym "s t" 1.5 -2 1e3 .5 F.Cu 0x1)`);
    const kinds = (doc.children[0] as List).children.map((c) => (c.type === "atom" ? c.kind : "list"));
    expect(kinds).toEqual(["symbol", "symbol", "string", "number", "number", "number", "number", "symbol", "symbol"]);
  });

  it("handles escaped quotes and newlines in strings", () => {
    const text = `(p "a \\"b\\" c\\nd")`;
    const doc = parse(text);
    expect(serialize(doc)).toBe(text);
    const atom = (doc.children[0] as List).children[1]!;
    expect(atom.type === "atom" && unquote(atom.raw)).toBe('a "b" c\nd');
  });

  it("parses multiple top-level forms with comments when enabled", () => {
    const text = `(version 1)\n# a comment (with parens)\n(rule "x"\n\t(layer outer))\n`;
    const doc = parse(text, { comments: true });
    expect(doc.children).toHaveLength(2);
    expect(serialize(doc)).toBe(text);
  });

  it("treats # as a symbol char when comments are disabled", () => {
    const doc = parse(`(ref #PWR01)`);
    expect(serialize(doc)).toBe(`(ref #PWR01)`);
  });

  it("reports errors with positions", () => {
    expect(() => parse(`(a\n  (b "x)`)).toThrow(ParseError);
    expect(() => parse(`(a))`)).toThrow(/Unexpected '\)' at 1:4/);
    expect(() => parse(`(a (b)`)).toThrow(/Unclosed list at 1:1/);
  });

  it("recovers from malformed input without losing bytes", () => {
    for (const text of [`(a (b))) (c)\n`, `(a\n\t(b 1)`, `(a (b "x"`]) {
      const doc = parse(text, { recover: true });
      expect(serialize(doc)).toBe(text);
      expect(doc.diagnostics).toHaveLength(1);
    }
    expect(parse(`(a (b)))`, { recover: true }).diagnostics[0]).toMatchObject({ message: "Unexpected ')'", line: 1, column: 8 });
    // KiCad-style recovery of a missing "(": the nesting is restored.
    const glued = `(p (t (x no)y 0.9) (z 1)) (q 2))`;
    const doc = parse(glued, { recover: true });
    expect(serialize(doc)).toBe(glued);
    expect(doc.children).toHaveLength(1);
    expect(doc.diagnostics.map((d) => d.message)).toEqual(["Missing '('"]);
  });
});

describe("query and edit", () => {
  it("reads values", () => {
    const root = parse(SAMPLE).children[0] as List;
    const symbol = findChild(root, "symbol")!;
    expect(arg(findChild(symbol, "lib_id"), 0)).toBe("Device:R");
    expect(arg(findChild(symbol, "at"), 1)).toBe(50.8);
    expect(findChildren(symbol, "property")).toHaveLength(1);
  });

  it("edits a value with a minimal diff", () => {
    const doc = parse(SAMPLE);
    const prop = findChild(findChild(doc.children[0] as List, "symbol")!, "property")!;
    setArg(prop, 1, "R42");
    expect(serialize(doc)).toBe(SAMPLE.replace('"R1"', '"R42"'));
  });

  it("appends a new list using KiCad indentation", () => {
    const doc = parse(SAMPLE);
    const symbol = findChild(doc.children[0] as List, "symbol")!;
    appendChild(
      symbol,
      list("property", str("Value"), str("10k"), list("at", 100, 52, 0), list("effects", list("font", list("size", 1.27, 1.27)))),
    );
    const expected = SAMPLE.replace(
      "\t\t)\n\t)\n)",
      [
        "\t\t)",
        '\t\t(property "Value" "10k"',
        "\t\t\t(at 100 52 0)",
        "\t\t\t(effects",
        "\t\t\t\t(font",
        "\t\t\t\t\t(size 1.27 1.27)",
        "\t\t\t\t)",
        "\t\t\t)",
        "\t\t)",
        "\t)",
        ")",
      ].join("\n"),
    );
    expect(serialize(doc)).toBe(expected);
  });

  it("formats numbers and strings like KiCad", () => {
    expect(formatNumber(1.27)).toBe("1.27");
    expect(formatNumber(100)).toBe("100");
    expect(formatNumber(-0.0000001)).toBe("0");
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(quote('say "hi"\n')).toBe('"say \\"hi\\"\\n"');
  });
});

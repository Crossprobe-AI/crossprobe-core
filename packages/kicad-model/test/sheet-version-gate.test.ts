/**
 * Items an older KiCad can't read are refused on its sheets. A sheet keeps its `(version …)` when
 * edited here, and KiCad refuses a file with an item newer than its format: rule areas came with
 * KiCad 9's format (20240417), net class directives with KiCad 7's (20220124).
 */
import { describe, expect, it } from "vitest";
import { parse } from "@crossprobe/kicad-sexpr";
import { addDirective, addRuleArea, sheetRoot } from "../src/index.js";

const sheet = (version: number) => sheetRoot(parse(`(kicad_sch (version ${version}) (generator "eeschema") (uuid "00000000-0000-0000-0000-000000000001") (paper "A4"))`));
const area = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];

describe("file version gates", () => {
  it("refuses rule areas before KiCad 9 and directives before KiCad 7", () => {
    expect(() => addRuleArea(sheet(20231120), area)).toThrow(/KiCad 9/);
    expect(() => addDirective(sheet(20231120), { x: 0, y: 0 }, "Power")).not.toThrow();
    expect(() => addDirective(sheet(20211123), { x: 0, y: 0 }, "Power")).toThrow(/KiCad 7/);
    expect(() => addRuleArea(sheet(20250114), area)).not.toThrow();
  });
});

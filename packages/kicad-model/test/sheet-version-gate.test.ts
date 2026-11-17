/**
 * Items an older KiCad can't read are refused on its sheets. A sheet keeps its `(version …)` when
 * edited here, and KiCad refuses a file with an item newer than its format: rule areas came with
 * KiCad 9's format (20240417), net class directives with KiCad 7's (20220124).
 */
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, parse } from "@crossprobe/kicad-sexpr";
import { addDirective, addRuleArea, addSchText, addTable, findItem, moveItem, requireSheetFeatures, setHyperlink, sheetFeatureCounts, sheetRoot, TABLE_BY_CELL } from "../src/index.js";

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

describe("tables and links by file version", () => {
  it("refuses tables before KiCad 9 and links before KiCad 7, however they arrive", () => {
    expect(() => addTable(sheet(20231120), { x: 0, y: 0 }, 2, 2)).toThrow(/KiCad 9/);
    // A link added to a KiCad 6 sheet (as a paste or an edit would): caught after the edit.
    const old = sheet(20211123);
    const before = sheetFeatureCounts(old);
    setHyperlink(findItem(old, addSchText(old, "see", { x: 0, y: 0 }))!, "https://example.com");
    expect(() => requireSheetFeatures(old, before)).toThrow(/KiCad 7/);
    // On a KiCad 9 sheet, links and tables are fine.
    const nine = sheet(20250114);
    const b9 = sheetFeatureCounts(nine);
    addTable(nine, { x: 0, y: 0 }, 2, 2);
    setHyperlink(findItem(nine, addSchText(nine, "see", { x: 0, y: 20 }))!, "#2");
    expect(() => requireSheetFeatures(nine, b9)).not.toThrow();
  });

  it("gives KiCad 9 tables no UUID, and finds them by their first cell", () => {
    const nine = sheet(20250114);
    const id = addTable(nine, { x: 10, y: 10 }, 2, 2);
    expect(id.startsWith(TABLE_BY_CELL)).toBe(true);
    const table = findItem(nine, id)!;
    expect(findChild(table, "uuid")).toBeUndefined();
    moveItem(table, 5, 0);
    const xs = findChildren(findChild(table, "cells")!, "table_cell").map((c) => Number(arg(findChild(c, "at"), 0)));
    expect(xs).toEqual([15, 37.86, 15, 37.86]);
    // KiCad 10's files keep the table's own UUID.
    const ten = sheet(20250610);
    expect(findChild(findItem(ten, addTable(ten, { x: 0, y: 0 }, 1, 1))!, "uuid")).toBeDefined();
  });
});

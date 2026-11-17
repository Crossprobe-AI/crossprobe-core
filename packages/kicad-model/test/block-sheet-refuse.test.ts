/** Saving a selection as a design block refuses sheet symbols, whose sub-sheet files the block can't carry. */
import { describe, expect, it } from "vitest";
import { parse } from "@crossprobe/kicad-sexpr";
import { addSheet, addWire, blockFromSelection, newSheetFile, sheetRoot } from "../src/index.js";

describe("save a selection as a block", () => {
  it("refuses sheet symbols", () => {
    const root = sheetRoot(parse(newSheetFile()));
    const [wire] = addWire(root, [{ x: 10, y: 10 }, { x: 20, y: 10 }]);
    const sheet = addSheet(root, { at: { x: 30, y: 30 }, size: { x: 20, y: 10 }, name: "power", file: "power.kicad_sch", projectName: "p", parentPaths: ["/x"], page: 2 });
    expect(blockFromSelection(root, [wire!])).toContain("(wire");
    expect(() => blockFromSelection(root, [wire!, sheet])).toThrow(/sheet symbols/);
  });
});

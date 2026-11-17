/** A copied rule area gets a UUID of its own (KiCad keeps a rule area's UUID in its polyline). */
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addRuleArea, duplicateItems, findItem, newSheetFile, sheetRoot } from "../src/index.js";

describe("rule area copies", () => {
  it("get a new UUID that finds the copy", () => {
    const root = sheetRoot(parse(newSheetFile()));
    const id = addRuleArea(root, [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }]);
    const [copy] = duplicateItems(root, root, [id], 25.4, 0, {}, []);
    expect(copy).not.toBe(id);
    expect(findItem(root, copy!)).toBeDefined();
    expect(serialize(root).split(id).length - 1).toBe(1);
  });
});

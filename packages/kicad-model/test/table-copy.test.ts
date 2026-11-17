/** A copied table gets new UUIDs for its cells too, so the copy and the original stay apart (KiCad 9 and 10 tables). */
import { describe, expect, it } from "vitest";
import { findChildren, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import { addTable, duplicateItems, findItem, newSheetFile, sheetRoot } from "../src/index.js";

const cellUuids = (root: List) => [...serialize(root).matchAll(/\(table_cell[\s\S]*?\(uuid "([^"]+)"\)/g)].map((m) => m[1]);

describe("copying a table", () => {
  for (const version of ["20250114", "20250610"]) {
    it(`renews its cells' UUIDs (version ${version})`, () => {
      const root = sheetRoot(parse(newSheetFile().replace("20250114", version)));
      const id = addTable(root, { x: 20, y: 20 }, 2, 2, [["a", "b"], ["c", "d"]]);
      const [copy] = duplicateItems(root, root, [id], 40, 0, {}, []);
      expect(findChildren(root, "table")).toHaveLength(2);
      const uuids = cellUuids(root);
      expect(uuids).toHaveLength(8);
      expect(new Set(uuids).size).toBe(8);
      expect(copy).not.toBe(id);
      expect(findItem(root, copy!)).toBe(findChildren(root, "table")[1]);
      expect(findItem(root, id)).toBe(findChildren(root, "table")[0]);
    });
  }
});

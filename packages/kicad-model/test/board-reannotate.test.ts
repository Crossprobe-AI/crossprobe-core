/**
 * Geographical reannotation of the board, as KiCad's: a 3 × 2 grid of resistors numbered in each
 * direction, the back mirrored, excluded prefixes keeping their numbers (and nobody taking
 * them), a front prefix, and the back carrying on after the front. Then on pic_programmer
 * the result is unique and every part is renumbered once.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBoard, planBoardReannotate, type Board, type Footprint } from "../src/index.js";

/** Footprints at given places; enough of the model for reannotation. */
function board(parts: Array<[string, number, number, "F.Cu" | "B.Cu"?]>): Board {
  return {
    footprints: parts.map(([ref, x, y, layer], i) => ({ uuid: `u${i}`, reference: ref, at: { x, y }, layer: layer ?? "F.Cu", texts: [], attributes: { boardOnly: false } }) as unknown as Footprint),
  } as unknown as Board;
}
const result = (b: Board, o: Parameters<typeof planBoardReannotate>[1]) => {
  const { changes } = planBoardReannotate(b, o);
  const to = new Map(changes.map((c) => [c.uuid, c.to]));
  return b.footprints.map((f) => `${f.at.x},${f.at.y}:${to.get(f.uuid) ?? f.reference}`).join(" ");
};

// R9 R8 R7 / R6 R5 R4, laid out in a grid 10 mm apart.
const grid = () => board([["R9", 0, 0], ["R8", 10, 0], ["R7", 20, 0], ["R6", 0, 10], ["R5", 10, 10], ["R4", 20, 10]]);

describe("board reannotation", () => {
  it("numbers rows or columns in the direction asked", () => {
    expect(result(grid(), { direction: 0 })).toBe("0,0:R1 10,0:R2 20,0:R3 0,10:R4 10,10:R5 20,10:R6");
    expect(result(grid(), { direction: 4 })).toBe("0,0:R1 10,0:R3 20,0:R5 0,10:R2 10,10:R4 20,10:R6");
    expect(result(grid(), { direction: 3 })).toBe("0,0:R6 10,0:R5 20,0:R4 0,10:R3 10,10:R2 20,10:R1");
  });

  it("rounds to the grid, so a slightly offset part stays in its row", () => {
    const b = board([["R3", 0, 0.3], ["R2", 10, -0.2], ["R1", 20, 0]]);
    expect(result(b, { direction: 0, grid: 1.27 })).toBe("0,0.3:R1 10,-0.2:R2 20,0:R3");
  });

  it("mirrors the back, carries its numbers on, and leaves excluded parts alone", () => {
    const b = board([["R5", 0, 0], ["R4", 10, 0], ["R3", 0, 0, "B.Cu"], ["R2", 10, 0, "B.Cu"], ["TP1", 5, 5], ["R1", 30, 30]]);
    // R1 excluded by pattern: keeps R1, and the others skip it.
    const { changes } = planBoardReannotate(b, { direction: 0, exclude: ["R1*", "TP"] });
    const to = Object.fromEntries(changes.map((c) => [c.from, c.to]));
    expect(to).toEqual({ R5: "R2", R4: "R3", R3: "R5", R2: "R4" });
  });

  it("adds a prefix on one side", () => {
    const b = board([["R1", 0, 0], ["R2", 0, 0, "B.Cu"]]);
    const { changes } = planBoardReannotate(b, { backPrefix: "B" });
    expect(changes.map((c) => `${c.from}>${c.to}`)).toEqual(["R2>BR1"]);
  });

  const PIC = "/Library/Application Support/kicad/demos/pic_programmer/pic_programmer.kicad_pcb";
  it.skipIf(!existsSync(PIC))("renumbers a real board to unique references", () => {
    const b = parseBoard(readFileSync(PIC, "utf8"));
    const { changes, duplicates, invalid } = planBoardReannotate(b, {});
    expect(duplicates).toEqual([]);
    expect(invalid).toEqual([]);
    const final = new Map(b.footprints.map((f) => [f.uuid, f.reference]));
    for (const c of changes) final.set(c.uuid, c.to);
    const refs = [...final.values()].filter(Boolean);
    expect(new Set(refs).size).toBe(refs.length);
    expect(changes.length).toBeGreaterThan(10);
  });
});

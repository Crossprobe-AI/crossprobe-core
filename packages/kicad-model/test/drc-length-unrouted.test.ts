/** Length and skew rules leave nets without tracks alone (a board of placed, unrouted parts). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkLengthRules, parseBoard, parseDru, projectDesignRules } from "../src/index.js";

const PCB = new URL("../../../blocks/library/crossprobe.kicad_blocks/rp2040-minimal.kicad_block/rp2040-minimal.kicad_pcb", import.meta.url);

describe("length rules on unrouted nets", () => {
  it("report nothing", () => {
    const board = parseBoard(readFileSync(PCB, "utf8"));
    expect(board.tracks.length).toBe(0);
    const custom = parseDru(`(version 1)
(rule "min length" (condition "A.Type == 'Pad' || A.Type == 'Track' || A.Type == 'Via'") (constraint length (min 0.5mm)))
(rule "skew" (condition "A.Type == 'Pad' || A.Type == 'Track'") (constraint skew (max 0.1mm)))`);
    expect(checkLengthRules(board, projectDesignRules(), custom)).toEqual([]);
  });
});

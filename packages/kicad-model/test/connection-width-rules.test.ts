/** Custom connection_width rules see a pad's footprint reference and areas, as other custom rules do. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkConnectionWidth, parseBoard, parseDru, projectDesignRules } from "../src/index.js";

const PCB = new URL("../../../blocks/library/crossprobe.kicad_blocks/esp32-c3-wroom-02-minimal.kicad_block/esp32-c3-wroom-02-minimal.kicad_pcb", import.meta.url);

describe("connection width with custom rules", () => {
  it("a rule on a part's reference relaxes its necks", () => {
    const board = parseBoard(readFileSync(PCB, "utf8"));
    const rules = { ...projectDesignRules("{}"), minConnection: 0.3 };
    const plain = checkConnectionWidth(board, rules);
    const ref = plain.flatMap((v) => v.items.map((i) => i.reference)).find(Boolean);
    expect(ref, "a finding at a pad").toBeDefined();
    const relaxed = checkConnectionWidth(board, { ...rules, custom: parseDru(`(version 1)\n(rule relax (constraint connection_width (min 0.01mm)) (condition "A.Reference == '${ref}'"))`) });
    expect(relaxed.length).toBeLessThan(plain.length);
    expect(relaxed.some((v) => v.items[0]?.reference === ref)).toBe(false);
  });
});

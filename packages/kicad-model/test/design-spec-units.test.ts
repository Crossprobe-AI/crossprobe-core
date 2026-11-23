/**
 * A design spec with a multi-unit symbol: every unit is drawn on the sheet, each with its own pins,
 * and the schematic connects exactly what the spec lists. Needs KiCad's symbol libraries.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChildren, arg, parse } from "@crossprobe/kicad-sexpr";
import { checkDesignSpec, designBlockSpec, generateBlockSchematic, layoutDesignSheet, resolveLibrarySymbol, sheetRoot, verifyBlock, type DesignSpec } from "../src/index.js";

const SYMBOLS = process.env.KICAD_SYMBOLS!;
const text = (lib: string) => readFileSync(join(SYMBOLS, `${lib}.kicad_sym`), "utf8");
const libs = {
  symbol: (id: string) => {
    const [lib, name] = id.split(":");
    try {
      return resolveLibrarySymbol(text(lib!), lib!, name!);
    } catch {
      return undefined;
    }
  },
  footprint: () => undefined,
};

// A dual op-amp as two followers: unit A (pins 1-3), unit B (5-7), and the supply unit (4, 8).
const spec: DesignSpec = {
  name: "followers",
  board: { width: 30, height: 20 },
  parts: [
    { ref: "U1", symbol: "Amplifier_Operational:LM358", value: "LM358", footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", pins: { "1": "OUT_A", "2": "OUT_A", "3": "IN_A", "5": "IN_B", "6": "OUT_B", "7": "OUT_B", "8": "+5V", "4": "GND" } },
    { ref: "J1", symbol: "Connector_Generic:Conn_01x06", value: "IO", footprint: "", pins: { "1": "+5V", "2": "GND", "3": "IN_A", "4": "OUT_A", "5": "IN_B", "6": "OUT_B" } },
  ],
};

describe.skipIf(!existsSync(SYMBOLS))("a design spec with a multi-unit symbol", () => {
  it("places every unit, each with its own pins, and connects what the spec lists", () => {
    const layout = layoutDesignSheet(spec, libs);
    expect(Object.keys(layout.at).sort()).toEqual(["J1", "U1", "U1:2", "U1:3"]);
    const block = designBlockSpec(spec, libs, layout);
    expect(block.parts.filter((p) => p.ref === "U1").map((p) => [p.unit, p.pins])).toEqual([
      [1, { "1": "OUT_A", "2": "OUT_A", "3": "IN_A" }],
      [2, { "5": "IN_B", "6": "OUT_B", "7": "OUT_B" }],
      [3, { "8": "+5V", "4": "GND" }],
    ]);
    const sch = generateBlockSchematic(block, { resolve: (id) => libs.symbol(id)! });
    const units = findChildren(sheetRoot(parse(sch)), "symbol")
      .filter((s) => String(arg(findChildren(s, "lib_id")[0], 0)) === "Amplifier_Operational:LM358")
      .map((s) => Number(arg(findChildren(s, "unit")[0], 0)));
    expect(units.sort()).toEqual([1, 2, 3]);
    expect(verifyBlock(block, sch, text)).toEqual([]);
  });

  it("reports a part whose symbol is missing once, not again for each of its nets", () => {
    const missing = { ...spec, parts: [{ ...spec.parts[0]!, symbol: "Amplifier_Operational:NoSuchPart" }, spec.parts[1]!] };
    expect(checkDesignSpec(missing, libs).filter((p) => !/footprint/.test(p))).toEqual([expect.stringMatching(/^U1: no symbol "Amplifier_Operational:NoSuchPart"/)]);
  });
});

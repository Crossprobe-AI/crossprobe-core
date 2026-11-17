/**
 * ERC on the nets of a part's pins, against KiCad. A dual op amp's shared pins (8 V+, 4 GND,
 * 5 AGND, in both units) go to different nets in units A and B, and its AGND pin goes to a
 * reference net while GND is on ground. KiCad's ERC and ours report the same ground_pin_not_ground
 * and different_unit_net findings (which of two pins KiCad lists first depends on its internal
 * order, so those pairs are compared as sets).
 *
 * Env: KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import {
  addLabel, addSymGraphic, addSymPin, buildNetlist, loadSchematic, newProject, newSymbolNode, placeSymbol, resolveLibrarySymbol, runErc, setUnitCount, sheetRoot, withLibrarySymbol, withLibTableEntry,
} from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

const TYPES = new Set(["ground_pin_not_ground", "different_unit_net"]);

describe.skipIf(!cli)("ERC on a part's pin nets", () => {
  it("finds what KiCad finds", () => {
    const s = newSymbolNode("DUALAMP", { reference: "U" });
    setUnitCount(s, 2);
    for (const [unit, a, b, o] of [[1, "3", "2", "1"], [2, "9", "6", "7"]] as const) {
      addSymGraphic(s, { kind: "polyline", points: [{ x: -2.54, y: 2.54 }, { x: 2.54, y: 0 }, { x: -2.54, y: -2.54 }, { x: -2.54, y: 2.54 }] }, { unit, style: 1 });
      addSymPin(s, { number: a, name: "+", type: "input", at: { x: -7.62, y: 1.27 }, angle: 0, length: 5.08 }, unit);
      addSymPin(s, { number: b, name: "-", type: "input", at: { x: -7.62, y: -1.27 }, angle: 0, length: 5.08 }, unit);
      addSymPin(s, { number: o, name: "~", type: "output", at: { x: 7.62, y: 0 }, angle: 180, length: 5.08 }, unit);
    }
    // Supply pins shared by both units.
    addSymPin(s, { number: "8", name: "V+", type: "power_in", at: { x: 0, y: 7.62 }, angle: 270 }, 0 as never);
    addSymPin(s, { number: "4", name: "GND", type: "power_in", at: { x: -1.27, y: -7.62 }, angle: 90 }, 0 as never);
    addSymPin(s, { number: "5", name: "AGND", type: "power_in", at: { x: 1.27, y: -7.62 }, angle: 90 }, 0 as never);

    const dir = mkdtempSync(join(tmpdir(), "erc-pins-"));
    const lib = withLibrarySymbol(undefined, s);
    writeFileSync(join(dir, "proj.kicad_sym"), lib);
    const { files } = newProject("proj");
    const schName = Object.keys(files).find((f) => f.endsWith(".kicad_sch"))!;
    const doc = parse(files[schName]!);
    const root = sheetRoot(doc);
    const def = resolveLibrarySymbol(lib, "proj", "DUALAMP");
    const units = [{ unit: 1, x: 101.6 }, { unit: 2, x: 152.4 }];
    for (const u of units) placeSymbol(root, def, { reference: "U1", unit: u.unit, sheetPaths: ["/"], projectName: "proj", at: { x: u.x, y: 101.6 } });
    // Labels on the shared pins' tips (library y points up, the sheet's down).
    const tip = (x: number, px: number, py: number) => ({ x: x + px, y: 101.6 - py });
    addLabel(root, "label", "VDD_A", tip(101.6, 0, 7.62));
    addLabel(root, "label", "VDD_B", tip(152.4, 0, 7.62));
    addLabel(root, "label", "GND", tip(101.6, -1.27, -7.62));
    addLabel(root, "label", "GND", tip(152.4, -1.27, -7.62));
    addLabel(root, "label", "VREF", tip(101.6, 1.27, -7.62));
    addLabel(root, "label", "VREF", tip(152.4, 1.27, -7.62));
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), k === schName ? serialize(doc) : v);
    writeFileSync(join(dir, "sym-lib-table"), withLibTableEntry(undefined, "sym", "proj", "${KIPRJMOD}/proj.kicad_sym"));

    const out = join(dir, "erc.json");
    try {
      execFileSync(KICAD_CLI, ["sch", "erc", "--format", "json", "--severity-all", "-o", out, join(dir, schName)], { stdio: "ignore" });
    } catch {
      // A non-zero exit only says there are findings.
    }
    const at = (x: number, y: number) => `${x.toFixed(2)},${y.toFixed(2)}`;
    const items = (type: string, list: string[]) => (type === "different_unit_net" ? [...list].sort() : list).join(" ; ");
    const report = JSON.parse(readFileSync(out, "utf8")) as { sheets: Array<{ violations: Array<{ type: string; severity: string; description: string; items: Array<{ description: string; pos: { x: number; y: number } }> }> }> };
    const kicad = report.sheets
      .flatMap((sh) => sh.violations.filter((v) => TYPES.has(v.type)).map((v) => `${v.type} ${v.severity} | ${items(v.type, v.items.map((i) => `${i.description} @${at(i.pos.x * 100, i.pos.y * 100)}`))}`))
      .sort();
    const schematic = loadSchematic(schName, (f) => readFileSync(join(dir, f), "utf8"));
    const ours = runErc(schematic, buildNetlist(schematic, { detail: true }))
      .filter((v) => TYPES.has(v.type))
      .map((v) => `${v.type} ${v.severity} | ${items(v.type, v.items.map((i) => `${i.description} @${at(i.at.x, i.at.y)}`))}`)
      .sort();
    expect(ours).toEqual(kicad);
    expect(kicad.some((k) => k.startsWith("ground_pin_not_ground"))).toBe(true);
    expect(kicad.some((k) => k.startsWith("different_unit_net"))).toBe(true);
  });
});

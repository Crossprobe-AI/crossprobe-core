/**
 * Update PCB from Schematic, checked with KiCad: after changing a value and
 * adding a part in the schematic, applying our update must leave KiCad's
 * schematic-parity check with nothing to report for those parts.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import {
  applyFootprintUpdate,
  boardRoot,
  buildNetlist,
  findItem,
  loadSchematic,
  parseBoard,
  placeFootprint,
  placeSymbol,
  planBoardUpdate,
  resolveLibrarySymbol,
  setSymbolField,
  sheetRoot,
} from "../src/index.js";

const SHARED = "/Applications/KiCad/KiCad.app/Contents/SharedSupport";
const DEMO = "/Library/Application Support/kicad/demos/pic_programmer";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
const ok = existsSync(SHARED) && existsSync(DEMO);

describe.skipIf(!ok)("update PCB from schematic", () => {
  it("syncs values, nets and new footprints so KiCad's parity check is clean for them", () => {
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-upd-"));
    cpSync(DEMO, dir, { recursive: true });
    const schFile = join(dir, "pic_programmer.kicad_sch");
    const pcbFile = join(dir, "pic_programmer.kicad_pcb");
    const read = (f: string) => readFileSync(join(dir, f), "utf8");

    // Schematic: change R1's value and add a new resistor R900.
    const sch = parse(readFileSync(schFile, "utf8"));
    const root = sheetRoot(sch);
    const before = loadSchematic("pic_programmer.kicad_sch", read);
    const r1 = before.placements.find((p) => p.reference === "R1")!;
    setSymbolField(findItem(root, r1.symbol.uuid)!, "Value", "22K");
    const def = resolveLibrarySymbol(readFileSync(join(SHARED, "symbols/Device.kicad_sym"), "utf8"), "Device", "R");
    placeSymbol(root, def, { at: { x: 30.48, y: 190.5 }, reference: "R900", sheetPaths: [before.root.path], projectName: "pic_programmer" });
    writeFileSync(schFile, serialize(sch));

    const schematic = loadSchematic("pic_programmer.kicad_sch", read);
    const netlist = buildNetlist(schematic);
    const board = parseBoard(readFileSync(pcbFile, "utf8"));
    const plan = planBoardUpdate(schematic, netlist, board);
    expect(plan.updates.find((u) => u.reference === "R1")?.fields["Value"]).toBe("22K");
    const missing = plan.missing.find((m) => m.reference === "R900")!;
    expect(missing).toBeDefined();

    const pcb = parse(readFileSync(pcbFile, "utf8"), { recover: true });
    const proot = boardRoot(pcb);
    for (const u of plan.updates) applyFootprintUpdate(proot, u);
    const mod = readFileSync(join(SHARED, "footprints/Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod"), "utf8");
    placeFootprint(proot, mod, { ...missing, libId: "Resistor_SMD:R_0603_1608Metric", at: { x: 120, y: 80 }, layer: "B.Cu" });
    writeFileSync(pcbFile, serialize(pcb));

    // Our own view: nothing left to do for R1 / R900.
    const again = planBoardUpdate(schematic, netlist, parseBoard(readFileSync(pcbFile, "utf8")));
    expect(again.updates.filter((u) => ["R1", "R900"].includes(u.reference))).toEqual([]);
    expect(again.missing.map((m) => m.reference)).not.toContain("R900");

    // KiCad's view.
    const out = join(dir, "drc.json");
    execFileSync(KICAD_CLI, ["pcb", "drc", "--schematic-parity", "--format", "json", "-o", out, pcbFile], { stdio: "ignore" });
    const report = JSON.parse(readFileSync(out, "utf8"));
    const parity: Array<{ description: string; items: Array<{ description: string }> }> = report.schematic_parity ?? [];
    const about = (ref: string) => parity.filter((v) => v.items.some((i) => new RegExp(`\\b${ref}\\b`).test(i.description)) || v.description.includes(ref));
    // R900's footprint name differs from the symbol's (empty) Footprint field, which is expected here.
    expect(about("R900").filter((v) => !/footprint given by symbol|doesn't match/.test(v.description + JSON.stringify(v.items)))).toEqual([]);
    expect(about("R1").filter((v) => /Value|net/i.test(JSON.stringify(v)))).toEqual([]);
  });
});

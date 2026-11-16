/**
 * Update Schematic from PCB, against KiCad: on pic_programmer's board a resistor is renumbered,
 * a capacitor gets a new value and footprint, a part an MPN field and DNP. After the plan is
 * applied to the schematic, `kicad-cli pcb drc --schematic-parity` finds nothing of it, and
 * KiCad's netlist carries the new reference, value, footprint and field.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize, str, setArg } from "@crossprobe/kicad-sexpr";
import { boardRoot, findBoardItem, findItem, loadSchematic, parseBoard, planSchematicUpdate, setFootprintAttributes, setFootprintField, setSymbolAttributes, setSymbolField, sheetRoot } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMO = `${process.env.KICAD_DEMOS}/pic_programmer`;
let ok = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  ok = false;
}

const parity = (pcb: string, out: string) => {
  execFileSync(KICAD_CLI, ["pcb", "drc", "--schematic-parity", "--format", "json", "-o", out, pcb], { stdio: "ignore" });
  return (JSON.parse(readFileSync(out, "utf8")) as { schematic_parity: Array<{ type: string; items: Array<{ description: string }> }> }).schematic_parity.map((v) => `${v.type}: ${v.items.map((i) => i.description).join(", ")}`);
};

describe.skipIf(!ok)("back-annotation", () => {
  it("board changes reach the schematic, and KiCad finds the two in step", () => {
    const dir = mkdtempSync(join(tmpdir(), "backann-"));
    cpSync(DEMO, dir, { recursive: true });
    const pcbFile = join(dir, "pic_programmer.kicad_pcb");
    const before = parity(pcbFile, join(dir, "p0.json"));

    // Board edits, as the PCB editor makes them.
    const doc = parse(readFileSync(pcbFile, "utf8"));
    const root = boardRoot(doc);
    const board0 = parseBoard(readFileSync(pcbFile, "utf8"));
    const fp = (ref: string) => findBoardItem(root, board0.footprints.find((f) => f.reference === ref)!.uuid)!;
    const used = new Set(board0.footprints.map((f) => f.reference));
    const newRef = Array.from({ length: 99 }, (_, i) => `R${i + 50}`).find((r) => !used.has(r))!;
    setFootprintField(fp("R1"), "Reference", newRef);
    setFootprintField(fp("C2"), "Value", "330uF");
    setArg(fp("C2"), 0, str("Capacitor_THT:CP_Radial_D8.0mm_P3.50mm"));
    setFootprintField(fp("R2"), "MPN", "CFR-25JB-10K");
    setFootprintAttributes(fp("R3"), { dnp: true, excludeFromBom: true });
    writeFileSync(pcbFile, serialize(doc));
    const after = parity(pcbFile, join(dir, "p1.json"));
    expect(after.length).toBeGreaterThan(before.length);

    // Plan and apply to the schematic.
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    const schematic = loadSchematic("pic_programmer.kicad_sch", read);
    const { updates } = planSchematicUpdate(schematic, parseBoard(readFileSync(pcbFile, "utf8")));
    const byRef = Object.fromEntries(updates.map((u) => [u.reference, u]));
    expect(Object.keys(byRef).sort()).toEqual(["C2", "R1", "R2", "R3"]);
    expect(byRef.R1!.fields).toEqual({ Reference: newRef });
    expect(byRef.C2!.fields).toEqual({ Value: "330uF", Footprint: "Capacitor_THT:CP_Radial_D8.0mm_P3.50mm" });
    expect(byRef.R3).toMatchObject({ dnp: true, inBom: false });
    const docs = new Map<string, ReturnType<typeof parse>>();
    for (const u of updates)
      for (const unit of u.units) {
        const d = docs.get(unit.file) ?? docs.set(unit.file, parse(read(unit.file))).get(unit.file)!;
        const node = findItem(sheetRoot(d), unit.uuid)!;
        for (const [k, v] of Object.entries(u.fields)) setSymbolField(node, k, v, unit.sheet);
        setSymbolAttributes(node, { dnp: u.dnp, inBom: u.inBom });
      }
    for (const [f, d] of docs) writeFileSync(join(dir, f), serialize(d));

    expect(parity(pcbFile, join(dir, "p2.json"))).toEqual(before);
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "-o", join(dir, "x.net"), join(dir, "pic_programmer.kicad_sch")], { stdio: "ignore" });
    const net = readFileSync(join(dir, "x.net"), "utf8");
    expect(net).toContain(`(ref "${newRef}")`);
    expect(net).toMatch(/\(ref "C2"\)\s*\(value "330uF"\)\s*\(footprint "Capacitor_THT:CP_Radial_D8.0mm_P3.50mm"\)/);
    expect(net).toMatch(/\(field\s*\(name "MPN"\)\s*"CFR-25JB-10K"\)/);
    // Nothing left to do.
    expect(planSchematicUpdate(loadSchematic("pic_programmer.kicad_sch", read), parseBoard(readFileSync(pcbFile, "utf8"))).updates).toEqual([]);
  });
});

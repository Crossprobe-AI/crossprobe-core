/**
 * Multi-unit symbols, De Morgan body styles, arcs and power symbols, against KiCad. KiCad reads
 * the library and writes it back (`sym upgrade`) with the same pins and graphics in the same units
 * and body styles, the same unit names and lock. It plots each unit in both body styles. In a schematic, the
 * two placed units give one part with all their pins, and a power symbol names the net it touches.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import {
  addSymGraphic, addSymPin, describeSymbol, findLibSymbol, newPowerSymbol, newProject, newSymbolNode, placeSymbol, resolveLibrarySymbol, setDeMorgan, setPinUnit, setUnitCount,
  setBodyStyles, setJumpers, setUnitName, setUnitsLocked, symbolLibRoot, symbolProblems, withLibrarySymbol, withLibTableEntry,
} from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

/** A dual buffer: units A and B, a power unit, a De Morgan style, an arc. */
function dualBuffer(): List {
  const s = newSymbolNode("DUALBUF", { reference: "U" });
  setUnitCount(s, 3);
  for (const [unit, a, b] of [[1, "1", "2"], [2, "3", "4"]] as const) {
    addSymGraphic(s, { kind: "polyline", points: [{ x: -2.54, y: 2.54 }, { x: 2.54, y: 0 }, { x: -2.54, y: -2.54 }, { x: -2.54, y: 2.54 }], fill: "background" }, { unit, style: 1 });
    addSymPin(s, { number: a, name: "IN", type: "input", at: { x: -7.62, y: 0 }, angle: 0, length: 5.08 }, unit);
    addSymPin(s, { number: b, name: "OUT", type: "output", at: { x: 7.62, y: 0 }, angle: 180, length: 5.08 }, unit);
  }
  addSymGraphic(s, { kind: "rectangle", points: [{ x: -2.54, y: 5.08 }, { x: 2.54, y: -5.08 }], fill: "background" }, { unit: 3, style: 1 });
  addSymPin(s, { number: "8", name: "VCC", type: "power_in", at: { x: 0, y: 7.62 }, angle: 270 }, 1);
  addSymPin(s, { number: "5", name: "GND", type: "power_in", at: { x: 0, y: -7.62 }, angle: 90 }, 3);
  // The supply pin drawn in unit 1 belongs to the power unit.
  setPinUnit(s, ["8"], 3);
  setDeMorgan(s, true);
  // The alternate body of unit 1 gets an arc on top of its copy.
  addSymGraphic(s, { kind: "arc", points: [{ x: -2.54, y: 2.54 }, { x: 0, y: 0 }, { x: -2.54, y: -2.54 }] }, { unit: 1, style: 2 });
  setUnitName(s, 3, "PWR");
  setUnitsLocked(s, true);
  return s;
}

const shape = (s: List) => {
  const v = describeSymbol(s);
  return {
    units: v.units,
    pins: v.pins.map((p) => `${p.unit}/${p.style} ${p.number} ${p.name} ${p.type} ${p.at.x},${p.at.y},${p.angle} ${p.length}`).sort(),
    graphics: v.graphics.map((g) => `${g.unit}/${g.style} ${g.kind} ${g.points.map((q) => `${q.x},${q.y}`).join(" ")} ${g.fill}`).sort(),
    power: v.power,
  };
};

describe.skipIf(!cli)("symbol units and power symbols", () => {
  it("KiCad reads named body styles and jumper pins as made", () => {
    // A three-pad solder jumper: pads 1 and 2 bridged by default, two "1"s joined, three named styles.
    const s = newSymbolNode("JUMPER3", { reference: "JP" });
    for (const [n, x] of [["1", -5.08], ["2", 0], ["3", 5.08], ["1", 7.62]] as const) addSymPin(s, { number: n, name: "~", type: "passive", at: { x, y: -5.08 }, angle: 90 });
    addSymGraphic(s, { kind: "rectangle", points: [{ x: -6.35, y: 1.27 }, { x: 8.89, y: -2.54 }] }, { unit: 0, style: 1 });
    setBodyStyles(s, { names: ["Open", "Bridged", "Small"] });
    setJumpers(s, { duplicate: true, groups: [["1", "2"]] });
    expect(symbolProblems(s)).toEqual([]);
    const lib = withLibrarySymbol(undefined, s);
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-symj-"));
    writeFileSync(join(dir, "j.kicad_sym"), lib);
    writeFileSync(join(dir, "k.kicad_sym"), lib);
    execFileSync(KICAD_CLI, ["sym", "upgrade", "--force", join(dir, "k.kicad_sym")], { stdio: "ignore" });
    const back = findLibSymbol(symbolLibRoot(parse(readFileSync(join(dir, "k.kicad_sym"), "utf8"))), "JUMPER3")!;
    expect(shape(back)).toEqual(shape(s));
    expect(shape(back).units).toMatchObject({ styles: 3, styleNames: ["Open", "Bridged", "Small"], demorgan: false, duplicateJumpers: true, jumperGroups: [["1", "2"]] });
    mkdirSync(join(dir, "svg"));
    execFileSync(KICAD_CLI, ["sym", "export", "svg", "-o", join(dir, "svg"), join(dir, "j.kicad_sym")], { stdio: "ignore" });
    // One plot per body style.
    expect(readdirSync(join(dir, "svg")).length).toBe(3);
  });

  it("KiCad reads units, body styles, arcs and power symbols as made", () => {
    const dual = dualBuffer();
    expect(symbolProblems(dual)).toEqual([]);
    const ours = shape(dual);
    expect(ours.units).toEqual({ count: 3, demorgan: true, styles: 2, styleNames: [], names: { 3: "PWR" }, locked: true, duplicateJumpers: false, jumperGroups: [] });
    // Pins in both body styles; the supply moved to unit 3.
    expect(ours.pins.filter((p) => p.includes(" 8 VCC "))).toEqual(["3/1 8 VCC power_in 0,7.62,270 2.54", "3/2 8 VCC power_in 0,7.62,270 2.54"]);
    const lib = withLibrarySymbol(withLibrarySymbol(withLibrarySymbol(undefined, dual), newPowerSymbol("+3V3", "supply")), newPowerSymbol("GNDA", "ground"));

    const dir = mkdtempSync(join(tmpdir(), "crossprobe-symu-"));
    writeFileSync(join(dir, "proj.kicad_sym"), lib);
    writeFileSync(join(dir, "kicad.kicad_sym"), lib);
    execFileSync(KICAD_CLI, ["sym", "upgrade", "--force", join(dir, "kicad.kicad_sym")], { stdio: "ignore" });
    const back = symbolLibRoot(parse(readFileSync(join(dir, "kicad.kicad_sym"), "utf8")));
    const mine = symbolLibRoot(parse(lib));
    for (const name of ["DUALBUF", "+3V3", "GNDA"]) expect(shape(findLibSymbol(back, name)!), name).toEqual(shape(findLibSymbol(mine, name)!));

    mkdirSync(join(dir, "svg"));
    execFileSync(KICAD_CLI, ["sym", "export", "svg", "-s", "DUALBUF", "-o", join(dir, "svg"), join(dir, "proj.kicad_sym")], { stdio: "ignore" });
    // One plot per unit and body style.
    expect(readdirSync(join(dir, "svg")).sort()).toEqual(["DUALBUF_unit1.svg", "DUALBUF_unit1_demorgan.svg", "DUALBUF_unit2.svg", "DUALBUF_unit2_demorgan.svg", "DUALBUF_unit3.svg", "DUALBUF_unit3_demorgan.svg"]);

    // A schematic: units A and B of U1, and +3V3 on unit A's input.
    const { files } = newProject("proj");
    const schName = Object.keys(files).find((f) => f.endsWith(".kicad_sch"))!;
    const doc = parse(files[schName]!);
    const root = doc.children.find((c) => typeof c === "object" && "children" in c) as List;
    const def = resolveLibrarySymbol(lib, "proj", "DUALBUF");
    const o = { reference: "U1", sheetPaths: ["/"], projectName: "proj" };
    for (const [unit, x] of [[1, 101.6], [2, 127], [3, 152.4]] as const) placeSymbol(root, def, { ...o, unit, at: { x, y: 101.6 } });
    // Unit A's input tip is 7.62 left of it (library y is up, the sheet's down).
    placeSymbol(root, resolveLibrarySymbol(lib, "proj", "+3V3"), { reference: "#PWR01", sheetPaths: ["/"], projectName: "proj", at: { x: 101.6 - 7.62, y: 101.6 } });
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), k === schName ? serialize(doc) : v);
    writeFileSync(join(dir, "sym-lib-table"), withLibTableEntry(undefined, "sym", "proj", "${KIPRJMOD}/proj.kicad_sym"));
    const net = join(dir, "net.net");
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "-o", net, join(dir, schName)], { stdio: "ignore" });
    const text = readFileSync(net, "utf8");
    const pins = [...text.matchAll(/\(node\s*\(ref "U1"\)\s*\(pin "(\d+)"\)/g)].map((m) => m[1]).sort();
    expect(pins).toEqual(["1", "2", "3", "4", "5", "8"]);
    const pwr = /\(net\s+\(code "\d+"\)\s+\(name "([^"]+)"\)[\s\S]*?\(ref "U1"\)\s*\(pin "1"\)/.exec(text.split(/\n\t\t\(net /).map((n) => "(net " + n).find((n) => /\(ref "U1"\)\s*\(pin "1"\)/.test(n)) ?? "");
    expect(pwr?.[1]).toBe("+3V3");
  });
});

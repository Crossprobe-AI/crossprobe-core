/**
 * Symbols made with the symbol editor's edits, against KiCad: the library loads (kicad-cli plots
 * it), a schematic using the symbol from the project library exports a netlist with every pin's
 * number, name and electrical type as made, and ERC finds the placed copy the same as the library's.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addSymPin, deleteSymPins, findLibSymbol, updateSchematicLibSymbol, layoutSymbol, newProject, placeSymbol, resolveLibrarySymbol, setSymPin, symbolLibRoot, symbolProblems, withLibrarySymbol, withLibTableEntry } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

const PINS = [
  { number: "1", name: "VCC", type: "power_in" as const },
  { number: "2", name: "IN+", type: "input" as const },
  { number: "3", name: "IN-", type: "input" as const },
  { number: "4", name: "OUT", type: "output" as const },
  { number: "5", name: "GND", type: "power_in" as const },
  { number: "6", name: "SDA", type: "bidirectional" as const },
];

describe.skipIf(!cli)("symbol editor", () => {
  it("writes symbols KiCad reads as made", () => {
    const s = layoutSymbol("MYAMP", PINS, { reference: "U", description: "Test amplifier", fpFilters: "SOIC*" });
    // Edits on top: a pin added, one retyped and renamed.
    addSymPin(s, { number: "7", name: "EN", type: "input", at: { x: -10.16, y: -5.08 }, angle: 0 });
    setSymPin(s, "6", { type: "open_collector", name: "ALERT", shape: "inverted" });
    expect(symbolProblems(s)).toEqual([]);
    const lib = withLibrarySymbol(undefined, s);
    expect(findLibSymbol(symbolLibRoot(parse(lib)), "MYAMP")).toBeDefined();

    const dir = mkdtempSync(join(tmpdir(), "crossprobe-sym-"));
    writeFileSync(join(dir, "proj.kicad_sym"), lib);
    mkdirSync(join(dir, "svg"));
    execFileSync(KICAD_CLI, ["sym", "export", "svg", "-o", join(dir, "svg"), join(dir, "proj.kicad_sym")], { stdio: "ignore" });
    expect(readdirSync(join(dir, "svg")).length).toBe(1);

    // A schematic with it, from the project library (sym-lib-table with ${KIPRJMOD}).
    const { files } = newProject("proj");
    const schName = Object.keys(files).find((f) => f.endsWith(".kicad_sch"))!;
    const doc = parse(files[schName]!);
    const root = doc.children.find((c) => typeof c === "object" && "children" in c) as never;
    placeSymbol(root, resolveLibrarySymbol(lib, "proj", "MYAMP"), { at: { x: 100.33, y: 100.33 }, reference: "U1", sheetPaths: ["/"], projectName: "proj" });
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), k === schName ? serialize(doc) : v);
    writeFileSync(join(dir, "sym-lib-table"), withLibTableEntry(undefined, "sym", "proj", "${KIPRJMOD}/proj.kicad_sym"));
    const net = join(dir, "net.net");
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "-o", net, join(dir, schName)], { stdio: "ignore" });
    const text = readFileSync(net, "utf8");
    // (Unconnected pins: KiCad's pin function carries the number too, "ALERT_6".)
    const nodes = [...text.matchAll(/\(node\s*\(ref "U1"\)\s*\(pin "(\d+)"\)\s*\(pinfunction "([^"]*)"\)\s*\(pintype "([^"]*)"\)/g)].map((m) => `${m[1]} ${m[2]!.replace(new RegExp(`_${m[1]}$`), "")} ${m[3]}`).sort();
    expect(nodes).toEqual(["1 VCC power_in", "2 IN+ input", "3 IN- input", "4 OUT output", "5 GND power_in", "6 ALERT open_collector", "7 EN input"]);
    const erc = join(dir, "erc.json");
    execFileSync(KICAD_CLI, ["sch", "erc", "--format", "json", "--severity-all", "-o", erc, join(dir, schName)], { stdio: "ignore" });
    const types = JSON.parse(readFileSync(erc, "utf8")).sheets.flatMap((sh: { violations: Array<{ type: string }> }) => sh.violations.map((v) => v.type));
    expect(types.filter((t: string) => /lib_symbol/.test(t))).toEqual([]);
    expect(types.filter((t: string) => t === "pin_not_connected").length).toBe(7);

    // Edit the library symbol (a pin gone, one added) and update the schematic from it.
    const libDoc = parse(lib);
    const ls = findLibSymbol(symbolLibRoot(libDoc), "MYAMP")!;
    deleteSymPins(ls, ["7"]);
    addSymPin(ls, { number: "8", name: "NC", type: "no_connect", at: { x: 10.16, y: -5.08 }, angle: 180 });
    const lib2 = serialize(libDoc);
    writeFileSync(join(dir, "proj.kicad_sym"), lib2);
    let n = 0;
    expect(updateSchematicLibSymbol(root, resolveLibrarySymbol(lib2, "proj", "MYAMP"), () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`)).toBe(1);
    writeFileSync(join(dir, schName), serialize(doc));
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "-o", net, join(dir, schName)], { stdio: "ignore" });
    const text2 = readFileSync(net, "utf8");
    const pins2 = [...text2.matchAll(/\(node\s*\(ref "U1"\)\s*\(pin "(\d+)"\)/g)].map((m) => m[1]).sort();
    expect(pins2).toEqual(["1", "2", "3", "4", "5", "6", "8"]);
    execFileSync(KICAD_CLI, ["sch", "erc", "--format", "json", "--severity-all", "-o", erc, join(dir, schName)], { stdio: "ignore" });
    const types2 = JSON.parse(readFileSync(erc, "utf8")).sheets.flatMap((sh: { violations: Array<{ type: string }> }) => sh.violations.map((v) => v.type));
    expect(types2.filter((t: string) => /lib_symbol/.test(t))).toEqual([]);
  });
});

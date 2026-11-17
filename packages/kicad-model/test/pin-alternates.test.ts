/**
 * Alternate pin functions made in the symbol editor, against KiCad. A GPIO expander's pin 3 gets
 * two alternates (SDA, bidirectional; INT, open collector and inverted), and pin 4 one, added when
 * the pin is made. KiCad reads the library and writes the same alternates back (`sym upgrade`).
 * Placed in a project with pin 3 switched to SDA, KiCad's netlist names the pin SDA with the
 * alternate's type, as ours does; removing an alternate in the editor takes it out of the file.
 *
 * Env: KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import {
  addSymGraphic, addSymPin, buildNetlist, describeSymbol, findItem, findLibSymbol, loadSchematic, newProject, newSymbolNode, placeSymbol, resolveLibrarySymbol, setPinAlternate, setSymPin, sheetRoot,
  symbolLibRoot, withLibrarySymbol, withLibTableEntry,
} from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

const alternates = (s: List) => Object.fromEntries(describeSymbol(s).pins.map((p) => [p.number, p.alternates.map((a) => `${a.name} ${a.type} ${a.shape}`)]));

describe.skipIf(!cli)("alternate pin functions", () => {
  it("KiCad reads them from the library and names a switched pin by them", () => {
    const s = newSymbolNode("EXPANDER", { reference: "U" });
    addSymGraphic(s, { kind: "rectangle", points: [{ x: -5.08, y: 5.08 }, { x: 5.08, y: -5.08 }], fill: "background" }, { unit: 0, style: 1 });
    addSymPin(s, { number: "1", name: "VDD", type: "power_in", at: { x: 0, y: 7.62 }, angle: 270 });
    addSymPin(s, { number: "2", name: "GND", type: "power_in", at: { x: 0, y: -7.62 }, angle: 90 });
    addSymPin(s, { number: "3", name: "GPIO0", type: "bidirectional", at: { x: -7.62, y: 2.54 }, angle: 0 });
    addSymPin(s, { number: "4", name: "GPIO1", type: "bidirectional", at: { x: -7.62, y: -2.54 }, angle: 0, alternates: [{ name: "SCL", type: "input", shape: "clock" }] });
    setSymPin(s, "3", { alternates: [{ name: "SDA", type: "bidirectional", shape: "line" }, { name: "INT", type: "open_collector", shape: "inverted" }] });
    // Kept in KiCad's order, by name.
    expect(alternates(s)).toEqual({ "1": [], "2": [], "3": ["INT open_collector inverted", "SDA bidirectional line"], "4": ["SCL input clock"] });

    const dir = mkdtempSync(join(tmpdir(), "pinalt-"));
    const lib = withLibrarySymbol(undefined, s);
    writeFileSync(join(dir, "proj.kicad_sym"), lib);
    writeFileSync(join(dir, "copy.kicad_sym"), lib);
    execFileSync(KICAD_CLI, ["sym", "upgrade", "--force", join(dir, "copy.kicad_sym")], { stdio: "ignore" });
    expect(alternates(findLibSymbol(symbolLibRoot(parse(readFileSync(join(dir, "copy.kicad_sym"), "utf8"))), "EXPANDER")!)).toEqual(alternates(s));

    // Placed, with pin 3 switched to SDA.
    const { files } = newProject("proj");
    const schName = Object.keys(files).find((f) => f.endsWith(".kicad_sch"))!;
    const doc = parse(files[schName]!);
    const root = sheetRoot(doc);
    const uuid = placeSymbol(root, resolveLibrarySymbol(lib, "proj", "EXPANDER"), { reference: "U1", sheetPaths: ["/"], projectName: "proj", at: { x: 101.6, y: 101.6 } });
    setPinAlternate(findItem(root, uuid)!, "3", "SDA");
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), k === schName ? serialize(doc) : v);
    writeFileSync(join(dir, "sym-lib-table"), withLibTableEntry(undefined, "sym", "proj", "${KIPRJMOD}/proj.kicad_sym"));
    const xml = join(dir, "net.xml");
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadxml", "-o", xml, join(dir, schName)], { stdio: "ignore" });
    expect(/<node ref="U1" pin="3" pinfunction="SDA_3" pintype="bidirectional/.test(readFileSync(xml, "utf8"))).toBe(true);
    const schematic = loadSchematic(schName, (f) => readFileSync(join(dir, f), "utf8"));
    const node = buildNetlist(schematic).nets.flatMap((n) => n.nodes).find((n) => n.reference === "U1" && n.pin === "3")!;
    expect([node.pinName, node.pinType]).toEqual(["SDA", "bidirectional"]);

    // Taking one out.
    setSymPin(s, "3", { alternates: [{ name: "SDA", type: "bidirectional", shape: "line" }] });
    expect(alternates(s)["3"]).toEqual(["SDA bidirectional line"]);
    expect(serialize({ type: "document", children: [s], trivia: [""], trailing: "", diagnostics: [] })).not.toContain('"INT"');
  });
});

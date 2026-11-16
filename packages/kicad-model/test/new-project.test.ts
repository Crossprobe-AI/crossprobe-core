/**
 * A new project built with our edits must be one KiCad accepts: a T-joined
 * wire gets its junction (so the nets match KiCad's netlist), and a board
 * outline plus a GND zone filled by our filler match KiCad's DRC.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addBoardShape, addBoardText, addWire, addZone, boardRoot, fillZones, findBoardItem, fracture, newProject, parseBoard, projectFileName, placeFootprint, projectDesignRules, roundedRectShapes, setBoardText, setZoneFills, sheetRoot } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
let ok = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  ok = false;
}

describe("project file names", () => {
  it("are portable: no commas, brackets, spaces or accents", () => {
    expect(projectFileName("Li-ion charger, 500 mA (MCP73831)")).toBe("Li-ion_charger_500_mA_MCP73831");
    expect(projectFileName("  Säätö: v1.2 / rev B ")).toBe("Saato_v1.2_rev_B");
    expect(projectFileName("***")).toBe("untitled");
    expect(newProject("Li-ion charger, 500 mA (MCP73831)").project).toBe("Li-ion_charger_500_mA_MCP73831.kicad_pro");
  });
});

describe.skipIf(!ok)("new project", () => {
  it("opens cleanly in KiCad, with auto junctions and a valid outline and zone", () => {
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-new-"));
    const p = newProject("New board");
    for (const [f, t] of Object.entries(p.files)) writeFileSync(join(dir, f), t);
    const sch = join(dir, "New_board.kicad_sch");
    const pcb = join(dir, "New_board.kicad_pcb");

    const sdoc = parse(readFileSync(sch, "utf8"));
    addWire(sheetRoot(sdoc), [{ x: 80.01, y: 107.95 }, { x: 125.73, y: 107.95 }]);
    addWire(sheetRoot(sdoc), [{ x: 90.17, y: 113.03 }, { x: 90.17, y: 107.95 }]);
    const schText = serialize(sdoc);
    expect(schText).toContain("(junction");
    writeFileSync(sch, schText);

    const bdoc = parse(readFileSync(pcb, "utf8"));
    addBoardShape(boardRoot(bdoc), { kind: "rect", points: [{ x: 100, y: 100 }, { x: 140, y: 130 }], layer: "Edge.Cuts", width: 0.05 });
    addZone(boardRoot(bdoc), { net: "GND", layers: ["B.Cu"], outline: [{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 140, y: 130 }, { x: 100, y: 130 }] });
    // Fill with our filler; a pour with nothing on its net keeps its copper, as in KiCad.
    const rules = projectDesignRules(p.files["New_board.kicad_pro"]);
    for (const f of fillZones(parseBoard(serialize(bdoc)), rules)) setZoneFills(findBoardItem(boardRoot(bdoc), f.zone.uuid)!, [{ layer: f.layer, polygons: fracture(f.paths) }]);
    writeFileSync(pcb, serialize(bdoc));
    const board = parseBoard(readFileSync(pcb, "utf8"));
    expect(board.zones[0]?.fills.length).toBe(1);
    expect(board.outline).toHaveLength(1);
    expect(board.zones[0]?.net).toBe("GND");

    const erc = join(dir, "erc.json");
    const drc = join(dir, "drc.json");
    execFileSync(KICAD_CLI, ["sch", "erc", "--format", "json", "-o", erc, sch], { stdio: "ignore" });
    execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", drc, pcb], { stdio: "ignore" });
    const d = JSON.parse(readFileSync(drc, "utf8"));
    // KiCad flags the unconnected pour itself, and nothing else.
    expect(d.violations.map((v: { type: string }) => v.type)).toEqual(["isolated_copper"]);
    // The ERC sees only the dangling test wires; the files themselves load.
    expect(JSON.parse(readFileSync(erc, "utf8")).sheets).toHaveLength(1);
  });

  it("rounded outlines, board text and board-only footprints load cleanly in KiCad", () => {
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-new2-"));
    const p = newProject("Polish");
    for (const [f, t] of Object.entries(p.files)) writeFileSync(join(dir, f), t);
    const pcb = join(dir, "Polish.kicad_pcb");
    const bdoc = parse(readFileSync(pcb, "utf8"));
    const root = boardRoot(bdoc);
    for (const shape of roundedRectShapes({ x: 100, y: 100 }, { x: 140, y: 125 }, 2, "Edge.Cuts", 0.05)) addBoardShape(root, shape);
    const front = addBoardText(root, { text: "Crossprobe", at: { x: 120, y: 120 }, layer: "F.SilkS" });
    addBoardText(root, { text: "back", at: { x: 110, y: 120 }, layer: "B.SilkS" });
    setBoardText(findBoardItem(root, front)!, { size: 1.5 });
    const hole = `${process.env.KICAD_FOOTPRINTS}/MountingHole.pretty/MountingHole_3.2mm_M3.kicad_mod`;
    if (existsSync(hole)) placeFootprint(root, readFileSync(hole, "utf8"), { at: { x: 104, y: 104 }, reference: "H1", value: "M3", libId: "MountingHole:MountingHole_3.2mm_M3", boardOnly: true });
    writeFileSync(pcb, serialize(bdoc));

    const board = parseBoard(readFileSync(pcb, "utf8"));
    expect(board.outline.map((o) => o.kind).sort()).toEqual(["arc", "arc", "arc", "arc", "line", "line", "line", "line"]);
    expect(board.texts.find((t) => t.text === "back")?.justify).toContain("mirror");
    expect(board.texts.find((t) => t.text === "Crossprobe")?.size.y).toBe(1.5);

    const drc = join(dir, "drc.json");
    execFileSync(KICAD_CLI, ["pcb", "drc", "--schematic-parity", "--format", "json", "-o", drc, pcb], { stdio: "ignore" });
    const d = JSON.parse(readFileSync(drc, "utf8"));
    // A closed outline, and the hole isn't reported as missing from the schematic.
    expect(d.violations.map((v: { type: string }) => v.type)).not.toContain("invalid_outline");
    expect(d.schematic_parity ?? []).toEqual([]);
  });
});

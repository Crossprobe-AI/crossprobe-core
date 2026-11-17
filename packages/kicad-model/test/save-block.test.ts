/**
 * Saving a selection as a design block, against KiCad. The input supply of KiCad's pic_programmer
 * demo (connector, diode, regulator, capacitors, power symbols and the wires between them, all
 * that lies in one area) is saved as a block. KiCad reads the block's sheet on its own: its
 * netlist has the same nets, with the same pins, as ours, and the parts keep their references.
 * Inserted into an empty project, the block brings the same parts.
 *
 * Env: KICAD_CLI, KICAD_DEMOS.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, headOf, isList, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import { blockFromSelection, blockMetadataJson, buildNetlist, insertBlock, loadSchematic, newProject, sheetRoot, withLibTableEntry } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMO = join(process.env.KICAD_DEMOS!, "pic_programmer");
let cli = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

/** Items of the sheet that lie inside the box (symbols by their place, wires by both ends, labels and junctions by their point). */
function selectBox(root: List, x0: number, y0: number, x1: number, y1: number): string[] {
  const inBox = (n: List | undefined) => !!n && Number(arg(n, 0)) >= x0 && Number(arg(n, 0)) <= x1 && Number(arg(n, 1)) >= y0 && Number(arg(n, 1)) <= y1;
  return root.children
    .filter((c): c is List => isList(c))
    .filter((n) => {
      const h = headOf(n);
      if (h === "wire") return findChildren(findChild(n, "pts")!, "xy").every(inBox);
      if (h === "symbol" || h === "label" || h === "junction" || h === "no_connect") return inBox(findChild(n, "at"));
      return false;
    })
    .map((n) => String(arg(findChild(n, "uuid"), 0)));
}

describe.skipIf(!cli)("save a selection as a design block", () => {
  it("KiCad reads the block with the selection's circuit", () => {
    const dir = mkdtempSync(join(tmpdir(), "saveblock-"));
    const root = sheetRoot(parse(readFileSync(join(DEMO, "pic_programmer.kicad_sch"), "utf8")));
    const uuids = selectBox(root, 15, 160, 115, 190);
    const text = blockFromSelection(root, uuids, "pic_programmer");
    const file = join(dir, "supply.kicad_sch");
    writeFileSync(file, text);
    writeFileSync(join(dir, "supply.json"), blockMetadataJson("8–15 V input with a 7805", ["supply", "7805"]));
    expect(JSON.parse(readFileSync(join(dir, "supply.json"), "utf8"))).toEqual({ description: "8–15 V input with a 7805", keywords: "supply 7805", fields: {} });

    const block = loadSchematic("supply.kicad_sch", (f) => readFileSync(join(dir, f), "utf8"));
    const refs = block.components.map((c) => c.reference).sort();
    // The parts in the area, with their references.
    expect(refs).toEqual(expect.arrayContaining(["C1", "C2", "P1", "U3"]));
    expect(refs.every((r) => /^[A-Z]+\d+$/.test(r))).toBe(true);
    const ours = new Map(buildNetlist(block).nets.map((n) => [n.name, n.nodes.map((x) => `${x.reference}.${x.pin}`).sort().join(" ")]));

    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", join(dir, "n.net"), file], { stdio: "ignore" });
    const net = parse(readFileSync(join(dir, "n.net"), "utf8")).children.find(isList)!;
    const kicad = new Map(findChildren(findChild(net, "nets")!, "net").map((n) => [String(arg(findChild(n, "name"), 0)), findChildren(n, "node").map((x) => `${arg(findChild(x, "ref"), 0)}.${arg(findChild(x, "pin"), 0)}`).sort().join(" ")]));
    expect(ours).toEqual(kicad);
    expect([...kicad.keys()]).toEqual(expect.arrayContaining(["GND", "VCC"]));

    // Back into an empty project: the same parts.
    const { files } = newProject("again");
    const name = Object.keys(files).find((f) => f.endsWith(".kicad_sch"))!;
    const doc = parse(files[name]!);
    insertBlock(sheetRoot(doc), text, { x: 50.8, y: 50.8 }, ["/"], "again", true);
    const placed = findChildren(sheetRoot(doc), "symbol").filter((s) => !String(arg(findChildren(s, "property").find((p) => arg(p, 0) === "Reference"), 1)).startsWith("#"));
    expect(placed.map((s) => String(arg(findChildren(s, "property").find((p) => arg(p, 0) === "Reference"), 1))).sort()).toEqual(refs);
    expect(serialize(doc)).toContain("lib_symbols");

    // The library table lists the project's block library.
    const table = withLibTableEntry(undefined, "design_block", "again", "${KIPRJMOD}/again.kicad_blocks");
    expect(table).toBe('(design_block_lib_table\n\t(version 7)\n\t(lib (name "again")(type "KiCad")(uri "${KIPRJMOD}/again.kicad_blocks")(options "")(descr ""))\n)\n');
  });
});

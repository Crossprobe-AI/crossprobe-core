/**
 * Tables in a schematic, against KiCad. A 3 × 4 table is added to a new project, a cell's text is
 * changed and the table moved: KiCad reads the sheet and writes it back (`sch upgrade`) with the
 * same cells (text, place, size), and its SVG plot shows every cell's text.
 *
 * Env: KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import { addTable, findItem, moveItem, newProject, setItemText, sheetRoot } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

const cells = (root: List) =>
  findChildren(root, "table").flatMap((t) =>
    findChildren(findChild(t, "cells")!, "table_cell").map((c) => `${arg(c, 0)} @${arg(findChild(c, "at"), 0)},${arg(findChild(c, "at"), 1)} ${arg(findChild(c, "size"), 0)}x${arg(findChild(c, "size"), 1)}`),
  );

describe.skipIf(!cli)("schematic tables", () => {
  it("KiCad reads them back as made and plots their text", () => {
    const dir = mkdtempSync(join(tmpdir(), "schtable-"));
    const { files } = newProject("tbl");
    const name = Object.keys(files).find((f) => f.endsWith(".kicad_sch"))!;
    const doc = parse(files[name]!);
    const root = sheetRoot(doc);
    const id = addTable(root, { x: 50.8, y: 50.8 }, 3, 4, [["Rail", "Voltage", "Current", "Notes"], ["VBUS", "5 V", "500 mA"], ["3V3", "3.3 V", "300 mA", "LDO"]]);
    const cell = findChildren(findChild(findItem(root, id)!, "cells")!, "table_cell")[7]!;
    setItemText(findItem(root, String(arg(findChild(cell, "uuid"), 0)))!, "from USB");
    moveItem(findItem(root, id)!, 25.4, 12.7);
    const file = join(dir, name);
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), k === name ? serialize(doc) : v);
    const ours = cells(sheetRoot(parse(readFileSync(file, "utf8"))));
    expect(ours).toHaveLength(12);
    expect(ours[0]).toBe("Rail @76.2,63.5 22.86x5.08");
    expect(ours[7]).toBe("from USB @144.78,68.58 22.86x5.08");
    execFileSync(KICAD_CLI, ["sch", "upgrade", "--force", file], { stdio: "ignore" });
    expect(cells(sheetRoot(parse(readFileSync(file, "utf8"))))).toEqual(ours);
    execFileSync(KICAD_CLI, ["sch", "export", "svg", "-o", join(dir, "svg"), file], { stdio: "ignore" });
    const svg = readdirSync(join(dir, "svg")).map((f) => readFileSync(join(dir, "svg", f), "utf8")).join("");
    for (const t of ["Rail", "Voltage", "Current", "Notes", "VBUS", "5 V", "500 mA", "from USB", "3V3", "3.3 V", "300 mA", "LDO"]) expect(svg, t).toContain(`>${t}<`);
  });
});

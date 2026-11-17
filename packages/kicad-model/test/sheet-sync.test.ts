/**
 * Sheet symbols against KiCad: renaming, page numbers and Synchronize Sheet Pins. On a copy of
 * KiCad's pic_programmer demo a hierarchical label is added inside the sub-sheet and a pin to its
 * symbol, neither with a partner: KiCad's ERC reports both mismatches, and ours the same two. After
 * syncSheetPins both report none, and KiCad reads the new pin, the new label, the sheet's new name and page back
 * (`sch upgrade`).
 *
 * Env: KICAD_CLI, KICAD_DEMOS.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, headOf, isList, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import { addLabel, addSheetPin, buildNetlist, loadSchematic, runErc, setSheetName, setSheetPage, sheetPinMismatch, sheetRoot, syncSheetPins } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMO = join(process.env.KICAD_DEMOS!, "pic_programmer");
let cli = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

describe.skipIf(!cli)("sheet symbols", () => {
  it("pins and labels are brought in line, and KiCad's ERC agrees", () => {
    const dir = mkdtempSync(join(tmpdir(), "sheetsync-"));
    cpSync(DEMO, dir, { recursive: true });
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    const ROOT = "pic_programmer.kicad_sch";
    const CHILD = "pic_sockets.kicad_sch";
    const rootPath = loadSchematic(ROOT, read).root.path;
    const rootDoc = parse(read(ROOT));
    const childDoc = parse(read(CHILD));
    const sheet = sheetRoot(rootDoc).children.find((c): c is List => isList(c) && headOf(c) === "sheet")!;
    const save = () => {
      writeFileSync(join(dir, ROOT), serialize(rootDoc));
      writeFileSync(join(dir, CHILD), serialize(childDoc));
    };
    /** KiCad's findings about sheet pins and hierarchical labels that have no partner. */
    const mismatches = () => {
      const out = join(dir, "erc.json");
      try {
        execFileSync(KICAD_CLI, ["sch", "erc", "--format", "json", "--severity-all", "-o", out, join(dir, ROOT)], { stdio: "ignore" });
      } catch {
        // A non-zero exit only says there are findings.
      }
      const report = JSON.parse(readFileSync(out, "utf8")) as { sheets: Array<{ path: string; violations: Array<{ type: string; description: string; items: Array<{ pos: { x: number; y: number } }> }> }> };
      const kicad = report.sheets.flatMap((s) => s.violations.filter((v) => v.type === "hier_label_mismatch").map((v) => `${s.path} ${v.description} @${(v.items[0]!.pos.x * 100).toFixed(2)},${(v.items[0]!.pos.y * 100).toFixed(2)}`)).sort();
      // Our ERC reports the same ones, on the same sheets, at the same places.
      const schematic = loadSchematic(ROOT, read);
      const ours = runErc(schematic, buildNetlist(schematic, { detail: true }))
        .filter((v) => v.type === "hier_label_mismatch")
        .map((v) => `${v.sheetName} ${v.message} @${v.items[0]!.at.x.toFixed(2)},${v.items[0]!.at.y.toFixed(2)}`)
        .sort();
      expect(ours).toEqual(kicad);
      return kicad.length;
    };
    expect(sheetPinMismatch(sheet, sheetRoot(childDoc))).toEqual({ labels: [], pins: [] });
    save();
    const clean = mismatches();

    // A label inside with no pin, and a pin with no label inside.
    addLabel(sheetRoot(childDoc), "hierarchical_label", "NEW_SIG", { x: 50.8, y: 25.4 }, 180, "output");
    const at = findChild(sheet, "at")!;
    addSheetPin(sheet, "ORPHAN", "input", { x: Number(arg(at, 0)), y: Number(arg(at, 1)) + 2.54 });
    expect(sheetPinMismatch(sheet, sheetRoot(childDoc))).toEqual({ labels: [{ name: "NEW_SIG", shape: "output" }], pins: [{ name: "ORPHAN", shape: "input" }] });
    save();
    expect(mismatches()).toBe(clean + 2);

    const height = Number(arg(findChild(sheet, "size"), 1));
    expect(syncSheetPins(sheet, sheetRoot(childDoc))).toEqual({ pins: ["NEW_SIG"], labels: ["ORPHAN"] });
    expect(sheetPinMismatch(sheet, sheetRoot(childDoc))).toEqual({ labels: [], pins: [] });
    expect(Number(arg(findChild(sheet, "size"), 1))).toBeGreaterThanOrEqual(height);
    setSheetName(sheet, "Sockets");
    setSheetPage(sheet, rootPath, "7");
    save();
    expect(mismatches()).toBe(clean);

    // KiCad reads it all back.
    for (const f of [ROOT, CHILD]) execFileSync(KICAD_CLI, ["sch", "upgrade", "--force", join(dir, f)], { stdio: "ignore" });
    const s = loadSchematic(ROOT, read);
    const child = s.sheets.find((x) => x.file === CHILD)!;
    expect(child.ref!.name).toBe("Sockets");
    expect(child.pageNumber).toBe("7");
    const pin = child.ref!.pins.find((p) => p.name === "NEW_SIG")!;
    expect(pin).toBeDefined();
    // The new pin is on the symbol's left edge, on the 50 mil grid, apart from the others.
    expect(pin.at.x).toBeCloseTo(child.ref!.at.x, 4);
    expect(Math.abs(pin.at.y / 1.27 - Math.round(pin.at.y / 1.27))).toBeLessThan(1e-6);
    expect(child.ref!.pins.filter((p) => Math.abs(p.at.x - pin.at.x) < 1e-6 && Math.abs(p.at.y - pin.at.y) < 1e-6)).toHaveLength(1);
    const labels = findChildren(sheetRoot(parse(read(CHILD))), "hierarchical_label");
    expect(labels.find((l) => arg(l, 0) === "ORPHAN") && String(arg(findChild(labels.find((l) => arg(l, 0) === "ORPHAN")!, "shape"), 0))).toBe("input");
  });
});

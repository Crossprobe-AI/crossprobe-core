/**
 * ERC checks KiCad's demos don't trip, against KiCad. A copy of the pic_programmer demo is broken
 * in known ways: a unit of U2 is deleted (unplaced unit, with its input and supply pins), another
 * unit gets a different footprint, a local label is named like a global one, a text uses a variable
 * that names nothing, and a second sheet symbol takes the first one's name (and has no pins for
 * the labels inside). `kicad-cli sch erc` and runErc report the same findings of these kinds: the
 * same message, on the same sheet, at the same place.
 *
 * Env: KICAD_CLI, KICAD_DEMOS.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addLabel, addSchText, addSheet, buildNetlist, deleteItem, findItem, loadSchematic, runErc, setSymbolField, sheetRoot } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMO = join(process.env.KICAD_DEMOS!, "pic_programmer");
let cli = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

const TYPES = new Set(["missing_unit", "missing_input_pin", "missing_bidi_pin", "missing_power_pin", "different_unit_footprint", "duplicate_sheet_names", "same_local_global_label", "unresolved_variable", "hier_label_mismatch"]);

describe.skipIf(!cli)("ERC on a broken schematic", () => {
  it("finds what KiCad finds", () => {
    const dir = mkdtempSync(join(tmpdir(), "erc-cases-"));
    cpSync(DEMO, dir, { recursive: true });
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    const ROOT = "pic_programmer.kicad_sch";
    const before = loadSchematic(ROOT, read);
    const doc = parse(read(ROOT));
    const root = sheetRoot(doc);
    const u2 = before.components.find((c) => c.reference === "U2")!;
    const unit = (n: number) => u2.units.find((u) => u.unit === n)!.symbol.uuid;
    deleteItem(root, unit(2));
    setSymbolField(findItem(root, unit(3))!, "Footprint", "Package_DIP:DIP-16_W7.62mm");
    addLabel(root, "global_label", "SAME_NAME", { x: 30.48, y: 30.48 }, 0, "input");
    addLabel(root, "label", "SAME_NAME", { x: 30.48, y: 40.64 });
    addSchText(root, "Rev ${NOPE} ${REVISION}", { x: 30.48, y: 50.8 });
    addSheet(root, { at: { x: 30.48, y: 60.96 }, size: { x: 20.32, y: 10.16 }, name: "pic_sockets", file: "pic_sockets.kicad_sch", projectName: "pic_programmer", parentPaths: [before.root.path], page: 3 });
    writeFileSync(join(dir, ROOT), serialize(doc));

    const out = join(dir, "erc.json");
    try {
      execFileSync(KICAD_CLI, ["sch", "erc", "--format", "json", "--severity-all", "-o", out, join(dir, ROOT)], { stdio: "ignore" });
    } catch {
      // A non-zero exit only says there are findings.
    }
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      sheets: Array<{ path: string; violations: Array<{ type: string; severity: string; description: string; items: Array<{ description: string; pos: { x: number; y: number } }> }> }>;
    };
    const at = (x: number, y: number) => `${x.toFixed(2)},${y.toFixed(2)}`;
    const kicad = report.sheets
      .flatMap((s) => s.violations.filter((v) => TYPES.has(v.type)).map((v) => `${v.type} ${v.severity} ${s.path} | ${v.description} | ${v.items.map((i) => `${i.description} @${at(i.pos.x * 100, i.pos.y * 100)}`).join(" ; ")}`))
      .sort();
    const schematic = loadSchematic(ROOT, read);
    const ours = runErc(schematic, buildNetlist(schematic, { detail: true }))
      .filter((v) => TYPES.has(v.type))
      .map((v) => `${v.type} ${v.severity} ${v.sheetName} | ${v.message} | ${v.items.map((i) => `${i.description} @${at(i.at.x, i.at.y)}`).join(" ; ")}`)
      .sort();
    expect(ours).toEqual(kicad);
    // Every kind is there but the bidirectional one (this part has no such pins).
    for (const t of TYPES) if (t !== "missing_bidi_pin") expect(kicad.some((k) => k.startsWith(`${t} `)), t).toBe(true);
  });
});

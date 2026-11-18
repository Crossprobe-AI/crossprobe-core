/**
 * A sheet drawn inside a sub-sheet that lives in a sub-folder: its new file goes next to that
 * sub-sheet, as KiCad looks for it there. Our loader finds it without falling back to the project
 * folder, and KiCad plots its page.
 *
 * Env: KICAD_QA (KiCad's qa/data folder), KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSchematic } from "@crossprobe/kicad-model";
import { Editor } from "../src/edit/ops";

const KICAD_CLI = process.env.KICAD_CLI!;
const DATA = join(process.env.KICAD_QA ?? "", "eeschema/netlists/complex_hierarchy_shared");
let cli = existsSync(DATA);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

const ROOT = "complex_hierarchy.kicad_sch";
const SUB = "ampli_ht/ampli_ht.kicad_sch";
const NEW = "ampli_ht/bias.kicad_sch";

describe.skipIf(!cli)("a sheet added in a sub-folder sheet", () => {
  it("is written next to it", () => {
    const dir = mkdtempSync(join(tmpdir(), "subfolder-sheet-"));
    cpSync(DATA, dir, { recursive: true });
    execFileSync(KICAD_CLI, ["sch", "upgrade", join(dir, ROOT)], { stdio: "ignore" });
    const files: Record<string, string> = {};
    for (const f of [ROOT, SUB]) files[f] = readFileSync(join(dir, f), "utf8");
    const read = (f: string) => files[f] ?? readFileSync(join(dir, f), "utf8");
    const before = loadSchematic(ROOT, read);
    const changed = new Editor().apply(
      files,
      [{ op: "addSheet", file: SUB, newFile: NEW, name: "Bias", at: { x: 50.8, y: 50.8 }, size: { x: 25.4, y: 20.32 }, parentPaths: before.sheets.filter((s) => s.file === SUB).map((s) => s.path), projectName: "complex_hierarchy", page: before.sheets.length + 1 }],
      ROOT,
    );
    expect(Object.keys(changed).sort()).toEqual([NEW, SUB].sort());
    expect(changed[SUB]).toContain('(property "Sheetfile" "bias.kicad_sch"');
    Object.assign(files, changed);
    // No fallback: a file that isn't where KiCad looks isn't found.
    const after = loadSchematic(ROOT, (f) => {
      if (f === "bias.kicad_sch") throw new Error("looked in the project folder");
      return read(f);
    });
    const added = after.sheets.filter((s) => s.file === NEW);
    expect(added.map((s) => s.parent?.path).sort()).toEqual(before.sheets.filter((s) => s.file === SUB).map((s) => s.path).sort());

    for (const [f, t] of Object.entries(changed)) writeFileSync(join(dir, f), t);
    execFileSync(KICAD_CLI, ["sch", "export", "svg", "-o", join(dir, "svg"), join(dir, ROOT)], { stdio: "ignore" });
    // KiCad plots one page per sheet instance: the sheet is used twice, so two new pages.
    const pages = readdirSync(join(dir, "svg")).filter((f) => f.includes("Bias"));
    expect(pages.length).toBe(added.length);
  });
});

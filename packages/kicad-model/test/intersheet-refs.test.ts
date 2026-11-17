/**
 * The pages a global label lists next to it (${INTERSHEET_REFS}), against KiCad's plot. KiCad's
 * complex_hierarchy demo (one sheet used twice) gets global labels on every page, on two, and on
 * one only; with the project's settings varied (own page, short form, prefix and suffix) each
 * sheet's plot holds exactly the page lists intersheetRefs gives for its labels.
 *
 * Env: KICAD_CLI, KICAD_DEMOS.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addLabel, intersheetRefs, loadSchematic, sheetRoot } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMO = join(process.env.KICAD_DEMOS!, "complex_hierarchy");
let cli = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

const VARIANTS: Array<Record<string, unknown>> = [
  {},
  { intersheets_ref_own_page: true, intersheets_ref_prefix: "[", intersheets_ref_suffix: "]" },
  { intersheets_ref_own_page: true, intersheets_ref_short: true, intersheets_ref_prefix: "(p", intersheets_ref_suffix: ")" },
  { intersheets_ref_short: true, intersheets_ref_prefix: "[", intersheets_ref_suffix: "]" },
];

describe.skipIf(!cli)("intersheet references", () => {
  it.each(VARIANTS.map((v) => [JSON.stringify(v), v] as const))("%s", (_, variant) => {
    const dir = mkdtempSync(join(tmpdir(), "isr-"));
    cpSync(DEMO, dir, { recursive: true });
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    const ROOT = "complex_hierarchy.kicad_sch";
    const files = [...new Set(loadSchematic(ROOT, read).sheets.map((s) => s.file))];
    expect(files.length).toBe(2);
    const put = (file: string, labels: string[]) => {
      const doc = parse(read(file));
      labels.forEach((t, i) => addLabel(sheetRoot(doc), "global_label", t, { x: 20.32, y: 20.32 + 5.08 * i }, 0, "input"));
      writeFileSync(join(dir, file), serialize(doc));
    };
    // G_ALL on every page, G_TWO on the root and both instances of the reused sheet, G_ONE on the root only.
    put(files[0]!, ["G_ALL", "G_ONE", "G_TWO"]);
    put(files[1]!, ["G_ALL", "G_TWO"]);
    const pro = JSON.parse(read("complex_hierarchy.kicad_pro"));
    Object.assign(pro.schematic.drawing, { intersheets_ref_show: true }, variant);
    writeFileSync(join(dir, "complex_hierarchy.kicad_pro"), JSON.stringify(pro, null, 2));

    const s = loadSchematic(ROOT, read);
    expect(s.intersheetRefs?.show).toBe(true);
    execFileSync(KICAD_CLI, ["sch", "export", "svg", "-o", join(dir, "svg"), join(dir, ROOT)], { stdio: "ignore" });
    const prefix = String(variant["intersheets_ref_prefix"] ?? "");
    for (const sheet of s.sheets) {
      const name = sheet.namePath === "/" ? "complex_hierarchy.svg" : `complex_hierarchy-${sheet.namePath.split("/").filter(Boolean).join("-")}.svg`;
      expect(readdirSync(join(dir, "svg"))).toContain(name);
      const svg = readFileSync(join(dir, "svg", name), "utf8");
      // The page lists in KiCad's plot: texts made only of the prefix, page numbers, separators and the suffix.
      const pageList = new RegExp(`^${prefix.replace(/[[\](]/g, "\\$&")}[0-9.,?]*${String(variant["intersheets_ref_suffix"] ?? "").replace(/[\])]/g, "\\$&")}$`);
      const kicad = [...svg.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]!).filter((t) => pageList.test(t) && (prefix || /[,.]/.test(t))).sort();
      const ours = sheet.data.labels.filter((l) => l.kind === "global").map((l) => intersheetRefs(s, sheet, l.text)).filter((t) => t !== "" && (prefix || /[,.]/.test(t))).sort();
      expect(ours, sheet.namePath).toEqual(kicad);
    }
  });
});

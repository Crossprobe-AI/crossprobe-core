/**
 * ERC exclusions, against KiCad. On a copy of KiCad's pic_programmer demo with a lone global label
 * and a label whose name differs from a power net's only in case, a finding is excluded the way
 * this app writes it (KiCad's entry format, in the project file's erc.erc_exclusions). KiCad's ERC
 * then reports that finding as excluded and still reports the others; isErcExcluded agrees, and
 * honours an entry KiCad itself wrote for the same finding.
 *
 * Env: KICAD_CLI, KICAD_DEMOS.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addLabel, addWire, buildNetlist, ercExclusionEntry, isErcExcluded, loadSchematic, projectErcSettings, runErc, sheetRoot } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMO = join(process.env.KICAD_DEMOS!, "pic_programmer");
let cli = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

describe.skipIf(!cli)("ERC exclusions", () => {
  it("KiCad honours the entries written here, and ours KiCad's", () => {
    const dir = mkdtempSync(join(tmpdir(), "erc-excl-"));
    cpSync(DEMO, dir, { recursive: true });
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    const ROOT = "pic_programmer.kicad_sch";
    const doc = parse(read(ROOT));
    addLabel(sheetRoot(doc), "global_label", "LONELY", { x: 30.48, y: 30.48 }, 0, "input");
    addLabel(sheetRoot(doc), "global_label", "ALSO_LONELY", { x: 30.48, y: 40.64 }, 0, "input");
    writeFileSync(join(dir, ROOT), serialize(doc));
    const ours = () => {
      const s = loadSchematic(ROOT, read);
      return runErc(s, buildNetlist(s, { detail: true }), projectErcSettings(read("pic_programmer.kicad_pro")));
    };
    const lonely = ours().find((v) => v.type === "single_global_label" && v.items[0]!.description.includes("'LONELY'"))!;
    expect(lonely).toBeDefined();

    // Excluded as this app does it.
    const pro = JSON.parse(read("pic_programmer.kicad_pro"));
    pro.erc.erc_exclusions = [[ercExclusionEntry(lonely), "only one on purpose"]];
    writeFileSync(join(dir, "pic_programmer.kicad_pro"), JSON.stringify(pro, null, 2));
    const out = join(dir, "erc.json");
    try {
      execFileSync(KICAD_CLI, ["sch", "erc", "--format", "json", "--severity-all", "-o", out, join(dir, ROOT)], { stdio: "ignore" });
    } catch {
      // A non-zero exit only says there are findings.
    }
    type V = { type: string; excluded?: boolean; items: Array<{ description: string }> };
    const report = JSON.parse(readFileSync(out, "utf8")) as { sheets: Array<{ violations: V[] }> };
    const single = report.sheets.flatMap((s) => s.violations).filter((v) => v.type === "single_global_label");
    const state = (name: string) => single.find((v) => v.items[0]!.description.includes(`'${name}'`))?.excluded ?? false;
    expect([state("LONELY"), state("ALSO_LONELY")]).toEqual([true, false]);

    // Ours agrees, with our entry and with one KiCad wrote (its UUIDs, its sheet path).
    const entries = projectErcSettings(read("pic_programmer.kicad_pro")).exclusions!.map((e) => e.entry);
    const findings = ours().filter((v) => v.type === "single_global_label");
    expect(findings.map((v) => [v.items[0]!.description, isErcExcluded(v, entries)])).toEqual([
      ["Global Label 'LONELY'", true],
      ["Global Label 'ALSO_LONELY'", false],
    ]);
    const kicadEntry = `single_global_label|304800|304800|0f6b0d1a-1111-4222-8333-444455556666|00000000-0000-0000-0000-000000000000|${lonely.sheet}||`;
    expect(isErcExcluded(lonely, [kicadEntry])).toBe(true);
    expect(isErcExcluded(lonely, [kicadEntry.replace("304800|304800", "304800|406400")])).toBe(false);
  });

  it("KiCad honours entries for labels and wires on a sub-sheet", () => {
    // Items that had no UUID in our findings before: a dangling label, and the wire of a label on two wires.
    const dir = mkdtempSync(join(tmpdir(), "erc-excl2-"));
    cpSync(DEMO, dir, { recursive: true });
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    const ROOT = "pic_programmer.kicad_sch";
    const SUB = "pic_sockets.kicad_sch";
    const doc = parse(read(SUB));
    const root = sheetRoot(doc);
    addLabel(root, "label", "NOWHERE", { x: 30.48, y: 30.48 });
    addWire(root, [{ x: 20.32, y: 50.8 }, { x: 40.64, y: 50.8 }]);
    addWire(root, [{ x: 30.48, y: 40.64 }, { x: 30.48, y: 60.96 }]);
    addLabel(root, "label", "CROSSING", { x: 30.48, y: 50.8 });
    writeFileSync(join(dir, SUB), serialize(doc));
    const s = loadSchematic(ROOT, read);
    const findings = runErc(s, buildNetlist(s, { detail: true }), projectErcSettings(read("pic_programmer.kicad_pro")));
    const picked = findings.filter((v) => (v.type === "label_dangling" && v.items[0]!.description.includes("NOWHERE")) || v.type === "label_multiple_wires");
    expect(picked.map((v) => v.type).sort()).toEqual(["label_dangling", "label_multiple_wires"]);
    for (const v of picked) for (const i of v.items) expect(i.uuid, `${v.type}: ${i.description}`).toBeTruthy();

    const pro = JSON.parse(read("pic_programmer.kicad_pro"));
    pro.erc.erc_exclusions = picked.map((v) => [ercExclusionEntry(v), ""]);
    writeFileSync(join(dir, "pic_programmer.kicad_pro"), JSON.stringify(pro, null, 2));
    const out = join(dir, "erc.json");
    try {
      execFileSync(KICAD_CLI, ["sch", "erc", "--format", "json", "--severity-all", "-o", out, join(dir, ROOT)], { stdio: "ignore" });
    } catch {
      // Findings make a non-zero exit.
    }
    type V = { type: string; excluded?: boolean; items: Array<{ description: string }> };
    const report = JSON.parse(readFileSync(out, "utf8")) as { sheets: Array<{ path: string; violations: V[] }> };
    // kicad-cli also lists a sub-sheet's markers under the root sheet, never as excluded: those are left out.
    const theirs = report.sheets.filter((x) => x.path === "/pic_sockets/").flatMap((x) => x.violations).filter((v) => (v.type === "label_dangling" && v.items[0]!.description.includes("NOWHERE")) || v.type === "label_multiple_wires");
    expect(theirs.map((v) => [v.type, v.excluded ?? false]).sort()).toEqual([["label_dangling", true], ["label_multiple_wires", true]]);
  });
});

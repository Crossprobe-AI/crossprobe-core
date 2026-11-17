/**
 * Differential pair rules (diff_pair_gap, diff_pair_uncoupled) against
 * `kicad-cli pcb drc` on KiCad's vme-wren demo: the same out-of-range gaps
 * (rule, pair and gap) and uncoupled lengths (rule, pair and length) as KiCad,
 * to the micrometre.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDiffPairRules, parseBoard, parseDru, projectDesignRules } from "../src/index.js";

const DEMOS = process.env.KICAD_DEMOS!;
const KICAD_CLI = process.env.KICAD_CLI!;
const PCB = join(DEMOS ?? "", "vme-wren/vme-wren.kicad_pcb");
const CACHE = join(tmpdir(), "crossprobe-length-cache");
mkdirSync(CACHE, { recursive: true });

describe.skipIf(!existsSync(PCB) || !existsSync(KICAD_CLI))("diff pair rules as KiCad's DRC", () => {
  it("vme-wren", () => {
    const report = join(CACHE, `vme-wren-${statSync(PCB).mtimeMs}.json`);
    if (!existsSync(report))
      try {
        execFileSync(KICAD_CLI, ["pcb", "drc", "--severity-all", "--format", "json", "-o", report, PCB], { stdio: "ignore" });
      } catch {
        // kicad-cli exits non-zero when it finds violations.
      }
    const r = JSON.parse(readFileSync(report, "utf8")) as { violations: Array<{ type: string; description: string; items: Array<{ description: string }> }> };
    const kicad = (type: string) =>
      r.violations
        .filter((v) => v.type === type)
        .map((v) => `${/\((\S+) /.exec(v.description)![1]} ${/\[([^\]]+?)[PN+-]?\]/.exec(v.items[0]!.description)![1]} ${Number(/actual ([\d.]+) mm/.exec(v.description)![1]).toFixed(3)}`)
        .sort();
    const board = parseBoard(readFileSync(PCB, "utf8"));
    const rules = projectDesignRules(readFileSync(PCB.replace(/\.kicad_pcb$/, ".kicad_pro"), "utf8"));
    const custom = parseDru(readFileSync(PCB.replace(/\.kicad_pcb$/, ".kicad_dru"), "utf8"));
    const ours = checkDiffPairRules(board, rules, custom);
    const mine = (type: string) => ours.filter((v) => v.type === type).map((v) => `${v.rule} ${v.netP.replace(/[PN+-]$/, "")} ${v.actual.toFixed(3)}`).sort();
    expect(mine("diff_pair_uncoupled_length_too_long")).toEqual(kicad("diff_pair_uncoupled_length_too_long"));
    expect(mine("diff_pair_gap_out_of_range")).toEqual(kicad("diff_pair_gap_out_of_range"));
  });
});

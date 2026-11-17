/**
 * Skew rules with (within_diff_pairs), against `kicad-cli pcb drc`: on a board of two
 * diff pairs of different lengths, KiCad measures skew within each pair (A_N's 0.5 mm
 * against A_P), not across the pairs; without the option, every net is measured
 * against the longest of all.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLengthRules, parseBoard, parseDru, projectDesignRules } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;

const NETS = ["A_P", "A_N", "B_P", "B_N"];
/** Each net one straight track: A_P 10 mm, A_N 10.5 mm, B_P and B_N 30 mm. */
const LENGTHS = [10, 10.5, 30, 30];
const board = () => `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper "A4")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
${NETS.map((n, i) => `  (net ${i + 1} "${n}")`).join("\n")}
${NETS.map((n, i) => `  (segment (start 20 ${20 + i * 5}) (end ${20 + LENGTHS[i]!} ${20 + i * 5}) (width 0.2) (layer "F.Cu") (net ${i + 1}) (uuid "00000000-0000-0000-0000-00000000000${i}"))`).join("\n")}
  (gr_rect (start 10 10) (end 60 50) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "00000000-0000-0000-0000-0000000000aa"))
)
`;
const rules = (within: boolean) => `(version 1)
(rule sk (condition "A.inDiffPair('*')") (constraint skew (max 0.1mm)${within ? " (within_diff_pairs)" : ""}))
`;

describe.skipIf(!existsSync(KICAD_CLI))("skew within diff pairs as KiCad's DRC", () => {
  for (const within of [true, false])
    it(within ? "within_diff_pairs" : "across all nets", () => {
      const dir = mkdtempSync(join(tmpdir(), "crossprobe-skew-"));
      const pcb = join(dir, "skew.kicad_pcb");
      writeFileSync(pcb, board());
      writeFileSync(join(dir, "skew.kicad_pro"), "{}");
      writeFileSync(join(dir, "skew.kicad_dru"), rules(within));
      const report = join(dir, "drc.json");
      try {
        execFileSync(KICAD_CLI, ["pcb", "drc", "--severity-all", "--format", "json", "-o", report, pcb], { stdio: "ignore" });
      } catch {
        // kicad-cli exits non-zero when it finds violations.
      }
      const r = JSON.parse(readFileSync(report, "utf8")) as { violations: Array<{ type: string; items: Array<{ description: string }> }> };
      const net = (d: string) => /\[([^\]]+)\]/.exec(d)![1]!;
      const theirs = r.violations.filter((v) => v.type === "skew_out_of_range").map((v) => net(v.items[0]!.description)).sort();
      const ours = checkLengthRules(parseBoard(board()), projectDesignRules("{}"), parseDru(rules(within)))
        .filter((v) => v.type === "skew_out_of_range")
        .map((v) => v.net)
        .sort();
      expect(theirs).toEqual(within ? ["A_P"] : ["A_N", "A_P"]);
      expect(ours).toEqual(theirs);
    });
});

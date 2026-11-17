/**
 * Skew rules with (within_diff_pairs), against `kicad-cli pcb drc`: on a board of two
 * diff pairs of different lengths, KiCad measures skew within each pair (A_P, 0.5 mm
 * shorter than A_N, is the finding), not across the pairs; without the option, every
 * net is measured against the longest of all. The pairing itself is also checked
 * without KiCad, on boards made up for each case.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLengthRules, parseBoard, parseDru, projectDesignRules } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;

/** Each net one straight track: A_P 10 mm, A_N 10.5 mm, B_P and B_N 30 mm. */
const PAIRS: Record<string, number> = { A_P: 10, A_N: 10.5, B_P: 30, B_N: 30 };
const board = (lengths: Record<string, number> = PAIRS) => {
  const NETS = Object.keys(lengths);
  const LENGTHS = Object.values(lengths);
  return `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0")
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
};
const rules = (within: boolean, condition = "A.inDiffPair('*')") => `(version 1)
(rule sk (condition "${condition}") (constraint skew (max 0.1mm)${within ? " (within_diff_pairs)" : ""}))
`;

/** Our skew findings: net and skew (mm). */
const skews = (lengths: Record<string, number>, within: boolean, condition?: string) =>
  checkLengthRules(parseBoard(board(lengths)), projectDesignRules("{}"), parseDru(rules(within, condition)))
    .filter((v) => v.type === "skew_out_of_range")
    .map((v) => ({ net: v.net, skew: Math.round(v.actual * 1000) / 1000 }))
    .sort((a, b) => a.net.localeCompare(b.net));

describe("skew within diff pairs", () => {
  it("matched pairs of different lengths: nothing", () => {
    expect(skews({ A_P: 10, A_N: 10, B_P: 30, B_N: 30 }, true)).toEqual([]);
  });
  it("a mismatched pair: its shorter net, by the difference", () => {
    expect(skews({ A_P: 10, A_N: 10.5, B_P: 30, B_N: 30 }, true)).toEqual([{ net: "A_P", skew: 0.5 }]);
  });
  it("+ and - names pair", () => {
    expect(skews({ "CLK+": 12, "CLK-": 12.3, "D+": 20, "D-": 20 }, true)).toEqual([{ net: "CLK+", skew: 0.3 }]);
  });
  it("nets without a partner are left out", () => {
    expect(skews({ A_P: 10, A_N: 10, LONE: 40 }, true, "A.NetClass == 'Default'")).toEqual([]);
  });
  it("without the option, every net against the longest", () => {
    expect(skews({ A_P: 10, A_N: 10, B_P: 30, B_N: 30 }, false)).toEqual([
      { net: "A_N", skew: 20 },
      { net: "A_P", skew: 20 },
    ]);
  });
});

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

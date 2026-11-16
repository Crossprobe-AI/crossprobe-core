/**
 * Cleanup Tracks & Vias, checked by KiCad: on demo boards the cleanup (merges, duplicates,
 * tracks in pads, dangling tracks and vias) never leaves kicad-cli's DRC with more unconnected
 * items or violations than before.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { boardRoot, deleteBoardItem, findBoardItem, moveTrackEnd, parseBoard, planCleanup } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
const DEMOS = "/Library/Application Support/kicad/demos";
let cli = existsSync(DEMOS);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}
const BOARDS = ["cm5_minima/CM5_MINIMA_3.kicad_pcb", "multichannel/multichannel_mixer-unrouted.kicad_pcb", "tiny_tapeout/tinytapeout-demo.kicad_pcb", "royalblue54L_feather/nfc_antenna/RoyalBlue54L-NFC-Antenna/RoyalBlue54L-NFC-Antenna.kicad_pcb"];

const drc = (pcb: string) => {
  const out = `${pcb}.json`;
  try {
    execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", out, pcb], { stdio: "ignore" });
  } catch {
    /* violations make it exit non-zero */
  }
  const r = JSON.parse(readFileSync(out, "utf8")) as { unconnected_items: unknown[]; violations: unknown[] };
  return { unconnected: r.unconnected_items.length, violations: r.violations.length };
};

describe.skipIf(!cli)("cleanup tracks and vias", () => {
  it.each(BOARDS)("%s: KiCad's DRC is no worse", { timeout: 120_000 }, (file) => {
    const src = join(DEMOS, file);
    const dir = mkdtempSync(join(tmpdir(), "cleanup-"));
    cpSync(dirname(src), dir, { recursive: true });
    const pcb = join(dir, basename(src));
    const before = drc(pcb);
    const text = readFileSync(pcb, "utf8");
    const plan = planCleanup(parseBoard(text, { recover: true }));
    expect(plan.items.length).toBeGreaterThan(0);
    const doc = parse(text, { recover: true });
    const root = boardRoot(doc);
    for (const u of plan.remove) deleteBoardItem(root, u);
    for (const r of plan.reshape) {
      const n = findBoardItem(root, r.uuid)!;
      moveTrackEnd(n, 0, r.start);
      moveTrackEnd(n, 1, r.end);
    }
    writeFileSync(pcb, serialize(doc));
    const after = drc(pcb);
    expect(after.unconnected).toBeLessThanOrEqual(before.unconnected);
    expect(after.violations).toBeLessThanOrEqual(before.violations);
  });
});

/**
 * Net Inspector numbers against KiCad's own length calculation (pcbnew's GetTrackLength, read
 * through test/net-length.py): track length merged and clipped at vias and pads, plus via
 * lengths through the stackup. Where three or more line ends meet (a branch, or tracks on two
 * layers at a via), KiCad merges lines in pointer order, so its own result varies from run to
 * run. A net (one connected piece) passes when it equals KiCad's in one of several runs, to
 * 0.01 mm (the arc error of KiCad's pad polygons). Nets with such joints that still differ are only
 * reported (`ORACLE_VERBOSE=1`). Arc tracks are held to it: lines merge in KiCad's connectivity
 * order, an arc counts at its true length, and one clipped at a via or pad is cut as KiCad cuts it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { layerDistance, netStats, parseBoard, type Board } from "../src/index.js";

const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3";
const DEMOS = "/Library/Application Support/kicad/demos";
const BOARDS = ["video/video.kicad_pcb", "pic_programmer/pic_programmer.kicad_pcb", "stickhub/StickHub.kicad_pcb", "tiny_tapeout/tinytapeout-demo.kicad_pcb", "royalblue54L_feather/royalblue54L-feather.kicad_pcb"];
const ok = existsSync(PY) && existsSync(DEMOS);
const RUNS = 4;

/** Nets where KiCad's result depends on order: three or more track ends at a point, on any layers (KiCad 10 keys them together). */
function branched(board: Board): Set<string> {
  const ends = new Map<string, number>();
  for (const t of board.tracks) for (const p of [t.start, t.end]) {
    const k = `${t.net}|${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;
    ends.set(k, (ends.get(k) ?? 0) + 1);
  }
  return new Set([...ends].filter(([, n]) => n > 2).map(([k]) => k.split("|")[0]!));
}

describe("net inspector", () => {
  it("layer distances through a stackup", () => {
    const board = { copperLayers: ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"], stackup: [
      { name: "F.Cu", type: "copper", thickness: 0.035 }, { name: "d1", type: "prepreg", thickness: 0.2 },
      { name: "In1.Cu", type: "copper", thickness: 0.035 }, { name: "d2", type: "core", thickness: 1 },
      { name: "In2.Cu", type: "copper", thickness: 0.035 }, { name: "d3", type: "prepreg", thickness: 0.2 },
      { name: "B.Cu", type: "copper", thickness: 0.035 } ] } as unknown as Board;
    expect(layerDistance(board, "F.Cu", "B.Cu")).toBeCloseTo(1.54, 6);
    // Half of an inner start layer, the layers passed through in full.
    expect(layerDistance(board, "In1.Cu", "B.Cu")).toBeCloseTo(0.0175 + 1 + 0.035 + 0.2 + 0.035, 6);
    expect(layerDistance(board, "In1.Cu", "In1.Cu")).toBe(0);
  });

  it.skipIf(!ok)("lengths per net equal KiCad's", { timeout: 300_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "netlen-"));
    let strict = 0;
    for (const file of BOARDS) {
      const path = `${DEMOS}/${file}`;
      const out = join(dir, "k.json");
      // A few runs, for the different results KiCad gives.
      const runs = Array.from({ length: RUNS }, () => {
        execFileSync(PY, [join(import.meta.dirname, "net-length.py"), path, out], { stdio: "ignore" });
        return JSON.parse(readFileSync(out, "utf8")) as Record<string, number[]>;
      });
      const kicad = runs[0]!;
      const board = parseBoard(readFileSync(path, "utf8"));
      const branches = branched(board);
      const ours = new Map(netStats(board).map((s) => [s.net, s.total]));
      const bad: string[] = [];
      const loose: string[] = [];
      for (const [net, clusters] of Object.entries(kicad)) {
        if (clusters.length !== 1) continue;
        const ds = runs.map((r) => (ours.get(net) ?? 0) - (r[net]?.[0] ?? NaN));
        const d = ds.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
        if (Math.abs(d) <= 0.01) continue;
        (branches.has(net) ? loose : bad).push(`${net} ${d > 0 ? "+" : ""}${d.toFixed(3)}`);
      }
      strict += Object.values(kicad).filter((c) => c.length === 1).length - loose.length;
      if (loose.length && process.env.ORACLE_VERBOSE) console.log(`${file}: branch nets off (KiCad varies there): ${loose.join(", ")}`);
      expect(bad, file).toEqual([]);
    }
    if (process.env.ORACLE_VERBOSE) console.log(`${strict} nets matched`);
    expect(strict).toBeGreaterThan(590);
  });
});

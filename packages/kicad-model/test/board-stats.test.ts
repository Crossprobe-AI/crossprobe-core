/**
 * Board statistics against `kicad-cli pcb export stats` on every demo board: footprint counts by
 * mount type and side, pads by type, vias by type, the drill table (as a multiset of rows), the
 * thinnest track, the smallest round drill, and the board's size and area (within 0.1%: KiCad
 * approximates arcs a little differently).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { boardStatistics, parseBoard } from "../src/index.js";

const CORPUS = process.env.KICAD_CORPUS!;
const KICAD_CLI = process.env.KICAD_CLI!;
let cli = existsSync(CORPUS);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}
const boards: string[] = [];
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith(".kicad_pcb")) boards.push(p);
  }
};
if (cli) walk(CORPUS);
const mm = (s: string) => Number(String(s).replace(/ mm.*$/, ""));

describe.skipIf(!cli)("board statistics match kicad-cli", () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-"));
  it.each(boards)("%s", (pcb) => {
    const out = join(dir, basename(pcb) + ".json");
    execFileSync(KICAD_CLI, ["pcb", "export", "stats", "--format", "json", "-o", out, pcb], { stdio: "ignore" });
    const k = JSON.parse(readFileSync(out, "utf8"));
    const s = boardStatistics(parseBoard(readFileSync(pcb, "utf8"), { recover: true }));
    expect(s.pads).toEqual({ throughHole: k.pads.through_hole, smd: k.pads.smd, connector: k.pads.connector, npth: k.pads.npth, castellated: k.pads.castellated, pressFit: k.pads.press_fit });
    expect(s.vias).toEqual(k.vias);
    for (const kind of ["tht", "smd", "unspecified"] as const) expect(s.components[kind], kind).toEqual({ front: k.components[kind].front, back: k.components[kind].back });
    const row = (d: { count: number; shape: string; x: number; y: number; plated: boolean; source: string; start: string; stop: string }) => `${d.count} ${d.shape} ${d.x.toFixed(4)}×${d.y.toFixed(4)} ${d.plated ? "PTH" : "NPTH"} ${d.source} ${d.start}-${d.stop}`;
    expect(s.drills.map(row).sort()).toEqual(k.drill_holes.map((d: Record<string, string & number & boolean>) => row({ ...d, x: mm(d.x_size), y: mm(d.y_size), start: d.start_layer, stop: d.stop_layer })).sort());
    // (No tracks: KiCad reports its largest integer, 2147.48 mm.)
    if (k.board.min_track_width && mm(k.board.min_track_width) < 2000) expect(s.board.minTrackWidth?.toFixed(4)).toBe(mm(k.board.min_track_width).toFixed(4));
    if (k.board.min_drill_diameter && mm(k.board.min_drill_diameter) < 2000) expect(s.board.minDrill?.toFixed(4)).toBe(mm(k.board.min_drill_diameter).toFixed(4));
    expect(s.board.hasOutline).toBe(k.board.has_outline);
    if (k.board.has_outline) {
      expect(Math.abs(s.board.width - mm(k.board.width))).toBeLessThan(0.01);
      expect(Math.abs(s.board.height - mm(k.board.height))).toBeLessThan(0.01);
      expect(Math.abs(s.board.area - mm(k.board.area)) / mm(k.board.area)).toBeLessThan(1e-3);
    }
  });
});

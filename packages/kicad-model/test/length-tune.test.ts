/**
 * Length tuning against KiCad: lengthen a few pic_programmer nets with
 * meanders, then a .kicad_dru length rule per net (target ± 0.01 mm) and
 * kicad-cli's DRC: no length_out_of_range (KiCad measures the same length) and
 * no clearance, short or crossing problems.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addTrack, boardRoot, copperItems, deleteBoardItem, fillZones, findBoardItem, fracture, netLength, parseBoard, projectDesignRules, setZoneFills, trackLength, tuneNetLength } from "../src/index.js";

const DEMO = `${process.env.KICAD_DEMOS}/pic_programmer`;
const KICAD_CLI = process.env.KICAD_CLI!;
let ok = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  ok = false;
}

describe.skipIf(!ok)("length tuning", () => {
  it("adds meanders KiCad measures and accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-tune-"));
    for (const ext of [".kicad_pro", ".kicad_sch"]) copyFileSync(join(DEMO, `pic_programmer${ext}`), join(dir, `pic_programmer${ext}`));
    const rules = projectDesignRules(readFileSync(join(DEMO, "pic_programmer.kicad_pro"), "utf8"));
    const doc = parse(readFileSync(join(DEMO, "pic_programmer.kicad_pcb"), "utf8"));
    const start = parseBoard(serialize(doc));
    // Nets without vias, with a long straight track to meander.
    const nets = [...new Set(start.tracks.filter((t) => t.net && trackLength(t) > 10).map((t) => t.net))]
      .filter((n) => !start.vias.some((v) => v.net === n))
      .sort()
      .slice(0, 6);
    const targets: Record<string, number> = {};
    for (const net of nets) {
      const board = parseBoard(serialize(doc));
      const target = Math.round((netLength(board, net) + 3) * 100) / 100;
      const r = tuneNetLength(board, rules, copperItems(board), net, target);
      if (Math.abs(r.length - target) > 1e-3) continue; // no room here
      for (const t of r.replace) {
        deleteBoardItem(boardRoot(doc), t.uuid);
        for (let k = 1; k < t.points.length; k++) addTrack(boardRoot(doc), { start: t.points[k - 1]!, end: t.points[k]!, width: t.width, layer: t.layer, net });
      }
      expect(netLength(parseBoard(serialize(doc)), net)).toBeCloseTo(target, 3);
      targets[net] = target;
    }
    expect(Object.keys(targets).length).toBeGreaterThanOrEqual(4);
    for (const f of fillZones(parseBoard(serialize(doc)), rules)) setZoneFills(findBoardItem(boardRoot(doc), f.zone.uuid)!, [{ layer: f.layer, polygons: fracture(f.paths) }]);
    const pcb = join(dir, "pic_programmer.kicad_pcb");
    writeFileSync(pcb, serialize(doc));
    const q = (n: string) => n.replace(/'/g, "\\'");
    writeFileSync(
      join(dir, "pic_programmer.kicad_dru"),
      `(version 1)\n${Object.entries(targets)
        .map(([n, t], i) => `(rule "tune${i}" (condition "A.NetName == '${q(n)}'") (constraint length (min ${(t - 0.01).toFixed(3)}mm) (max ${(t + 0.01).toFixed(3)}mm)))`)
        .join("\n")}\n`,
    );
    const out = join(dir, "drc.json");
    execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", out, pcb], { stdio: "ignore" });
    const v = JSON.parse(readFileSync(out, "utf8")).violations as Array<{ type: string; description: string; items: Array<{ description: string }> }>;
    const bad = v.filter((x) => ["length_out_of_range", "clearance", "shorting_items", "tracks_crossing", "copper_edge_clearance"].includes(x.type));
    expect(bad.map((x) => `${x.type}: ${x.description} ${x.items.map((i) => i.description).join(" / ")}`)).toEqual([]);
  }, 180_000);
});

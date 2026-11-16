/**
 * Teardrops against KiCad: add them to a demo board, refill its zones, and
 * kicad-cli must report no more clearance, short, edge, thermal or zone
 * problems than the same board refilled without them. The teardrops must
 * load as KiCad teardrop zones of their nets.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addTeardropZone, boardRoot, computeTeardrops, copperItems, fillZones, findBoardItem, fracture, parseBoard, projectDesignRules, removeTeardrops, setZoneFills } from "../src/index.js";

const DEMOS = process.env.KICAD_DEMOS!;
const KICAD_CLI = process.env.KICAD_CLI!;
let ok = existsSync(DEMOS);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  ok = false;
}
const TYPES = ["clearance", "shorting_items", "tracks_crossing", "copper_edge_clearance", "starved_thermal", "zones_intersect", "unconnected_items", "isolated_copper"];

function drc(dir: string, name: string, text: string): Record<string, number> {
  const pcb = join(dir, `${name}.kicad_pcb`);
  writeFileSync(pcb, text);
  const out = join(dir, "drc.json");
  execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", out, pcb], { stdio: "ignore" });
  const v = JSON.parse(readFileSync(out, "utf8")) as { violations: Array<{ type: string }>; unconnected_items: unknown[] };
  const counts: Record<string, number> = {};
  for (const t of TYPES) counts[t] = v.violations.filter((x) => x.type === t).length;
  counts.unconnected_items = v.unconnected_items.length;
  if (process.env.TD_VERBOSE) for (const x of v.violations as Array<{ type: string; description: string; items: Array<{ description: string; pos: { x: number; y: number } }> }>) if (x.type === "clearance" || x.type === "copper_edge_clearance") console.log("  ", x.description, x.items.map((i) => `${i.description} @${i.pos.x},${i.pos.y}`).join(" / "));
  return counts;
}

describe.skipIf(!ok)("teardrops", () => {
  it.each(["pic_programmer/pic_programmer", "stickhub/StickHub"])("%s: KiCad accepts them", (demo) => {
    const name = demo.split("/")[1]!;
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-td-"));
    for (const ext of [".kicad_pro", ".kicad_sch"]) if (existsSync(join(DEMOS, demo + ext))) copyFileSync(join(DEMOS, demo + ext), join(dir, name + ext));
    const rules = projectDesignRules(readFileSync(join(DEMOS, demo + ".kicad_pro"), "utf8"));
    const refill = (doc: ReturnType<typeof parse>) => {
      for (const f of fillZones(parseBoard(serialize(doc)), rules)) setZoneFills(findBoardItem(boardRoot(doc), f.zone.uuid)!, [{ layer: f.layer, polygons: fracture(f.paths) }]);
    };
    // The baseline: no teardrops, zones refilled the same way.
    const base = parse(readFileSync(join(DEMOS, demo + ".kicad_pcb"), "utf8"));
    removeTeardrops(boardRoot(base));
    refill(base);
    const before = drc(dir, name, serialize(base));

    const doc = parse(serialize(base));
    const board = parseBoard(serialize(doc));
    const tds = computeTeardrops(board, rules, copperItems(board));
    tds.forEach((t, i) => addTeardropZone(boardRoot(doc), { ...t, priority: 30000 + i }));
    refill(doc);
    const after = drc(dir, name, serialize(doc));
    console.log(name, tds.length, "teardrops", { before, after });
    expect(tds.length).toBeGreaterThan(20);
    expect(parseBoard(serialize(doc)).zones.filter((z) => z.teardrop).length).toBe(tds.length);
    for (const t of TYPES) expect(after[t], t).toBeLessThanOrEqual(before[t]!);
  }, 240_000);
});

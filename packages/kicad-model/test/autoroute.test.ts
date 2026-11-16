/**
 * The grid router against KiCad: strip a demo board's tracks, route the first
 * connections one after another, refill, and kicad-cli must find no shorts or
 * clearance violations, with those connections made.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addTrack, addVia, boardRoot, copperItems, deleteBoardItem, fillZones, findBoardItem, findUnconnected, fracture, netClassOf, parseBoard, projectDesignRules, routeConnection, routeWithVias, setZoneFills } from "../src/index.js";

const DEMO = `${process.env.KICAD_DEMOS}/pic_programmer`;
const KICAD_CLI = process.env.KICAD_CLI!;
let ok = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  ok = false;
}

describe.skipIf(!ok)("autorouter", () => {
  it("routes connections KiCad's DRC accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-route-"));
    for (const ext of [".kicad_pro", ".kicad_sch"]) copyFileSync(join(DEMO, `pic_programmer${ext}`), join(dir, `pic_programmer${ext}`));
    const rules = projectDesignRules(readFileSync(join(DEMO, "pic_programmer.kicad_pro"), "utf8"));
    const doc = parse(readFileSync(join(DEMO, "pic_programmer.kicad_pcb"), "utf8"));
    for (const t of parseBoard(serialize(doc)).tracks) deleteBoardItem(boardRoot(doc), t.uuid);
    const todo = findUnconnected(parseBoard(serialize(doc))).slice(0, 20);
    let routed = 0;
    let corners = 0;
    let right = 0;
    for (const u of todo) {
      const board = parseBoard(serialize(doc));
      const items = copperItems(board);
      const width = netClassOf(rules, u.net).trackWidth;
      for (const layer of board.copperLayers) {
        const path = routeConnection(board, rules, { from: u.a.at, to: u.b.at, net: u.net, layer, width }, items);
        if (!path) continue;
        for (let k = 1; k < path.length; k++) addTrack(boardRoot(doc), { start: path[k - 1]!, end: path[k]!, width, layer, net: u.net });
        // Corners between grid segments (the first and last run to the exact pad centre).
        for (let k = 2; k < path.length - 2; k++) {
          const [a, b, c] = [path[k - 1]!, path[k]!, path[k + 1]!];
          const cos = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / Math.hypot(b.x - a.x, b.y - a.y) / Math.hypot(c.x - b.x, c.y - b.y);
          corners++;
          if (cos < 0.5) right++;
        }
        routed++;
        break;
      }
    }
    expect(routed).toBeGreaterThanOrEqual(18);
    // Corners are mitred: 45° bends, right angles only where nothing else fits.
    expect(right).toBeLessThanOrEqual(corners * 0.1);
    const board = parseBoard(serialize(doc));
    for (const f of fillZones(board, rules)) setZoneFills(findBoardItem(boardRoot(doc), f.zone.uuid)!, [{ layer: f.layer, polygons: fracture(f.paths) }]);
    const pcb = join(dir, "pic_programmer.kicad_pcb");
    writeFileSync(pcb, serialize(doc));
    const out = join(dir, "drc.json");
    execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", out, pcb], { stdio: "ignore" });
    const types = (JSON.parse(readFileSync(out, "utf8")).violations as Array<{ type: string }>).map((v) => v.type);
    expect(types.filter((t) => ["clearance", "shorting_items", "tracks_crossing", "copper_edge_clearance", "track_dangling"].includes(t))).toEqual([]);
  }, 180_000);

  it("changes layers through vias when it has to (SMD parts on both sides), KiCad-DRC-clean", () => {
    const demo = `${process.env.KICAD_DEMOS}/stickhub`;
    if (!existsSync(demo)) return;
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-route2-"));
    for (const f of ["StickHub.kicad_pro", "StickHub.kicad_sch"]) copyFileSync(join(demo, f), join(dir, f));
    const rules = projectDesignRules(readFileSync(join(demo, "StickHub.kicad_pro"), "utf8"));
    const doc = parse(readFileSync(join(demo, "StickHub.kicad_pcb"), "utf8"));
    for (const t of parseBoard(serialize(doc)).tracks) deleteBoardItem(boardRoot(doc), t.uuid);
    for (const v of parseBoard(serialize(doc)).vias) deleteBoardItem(boardRoot(doc), v.uuid);
    let vias = 0;
    for (const u of findUnconnected(parseBoard(serialize(doc))).slice(0, 50)) {
      const board = parseBoard(serialize(doc));
      const items = copperItems(board);
      const cls = netClassOf(rules, u.net);
      const m = routeWithVias(board, rules, { from: u.a.at, to: u.b.at, net: u.net, width: cls.trackWidth, via: { size: cls.viaDiameter, drill: cls.viaDrill } }, items);
      if (!m) continue;
      for (const r of m.runs) for (let k = 1; k < r.points.length; k++) addTrack(boardRoot(doc), { start: r.points[k - 1]!, end: r.points[k]!, width: cls.trackWidth, layer: r.layer, net: u.net });
      for (const v of m.vias) addVia(boardRoot(doc), { at: v, size: cls.viaDiameter, drill: cls.viaDrill, layers: [board.copperLayers[0]!, board.copperLayers.at(-1)!], net: u.net });
      vias += m.vias.length;
    }
    expect(vias).toBeGreaterThan(0);
    const board = parseBoard(serialize(doc));
    for (const f of fillZones(board, rules)) setZoneFills(findBoardItem(boardRoot(doc), f.zone.uuid)!, [{ layer: f.layer, polygons: fracture(f.paths) }]);
    const pcb = join(dir, "StickHub.kicad_pcb");
    writeFileSync(pcb, serialize(doc));
    const out = join(dir, "drc.json");
    execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", out, pcb], { stdio: "ignore" });
    const types = (JSON.parse(readFileSync(out, "utf8")).violations as Array<{ type: string }>).map((v) => v.type).filter((t) => t !== "lib_footprint_issues" && t !== "lib_footprint_mismatch");
    expect(types).toEqual([]);
  }, 300_000);
});

/**
 * Shove against KiCad: on pic_programmer, lay new tracks too close alongside
 * existing straight tracks of other nets, let the interactive router push
 * those aside, apply the result, refill, and kicad-cli must find no clearance
 * problems, with every connection the board had still made.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addTrack, boardRoot, copperItems, deleteBoardItem, fillZones, findBoardItem, findUnconnected, fracture, setZoneFills, InteractiveRouter, netClassOf, parseBoard, projectDesignRules, trackConflicts } from "../src/index.js";

const DEMO = `${process.env.KICAD_DEMOS}/pic_programmer`;
const KICAD_CLI = process.env.KICAD_CLI!;
let ok = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  ok = false;
}

describe.skipIf(!ok)("shove", () => {
  it("pushes neighbouring tracks aside, KiCad-DRC-clean and still connected", () => {
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-shove-"));
    for (const ext of [".kicad_pro", ".kicad_sch"]) copyFileSync(join(DEMO, `pic_programmer${ext}`), join(dir, `pic_programmer${ext}`));
    const rules = projectDesignRules(readFileSync(join(DEMO, "pic_programmer.kicad_pro"), "utf8"));
    const doc = parse(readFileSync(join(DEMO, "pic_programmer.kicad_pcb"), "utf8"));
    const start = parseBoard(serialize(doc));
    const unconnected = findUnconnected(start);
    // Long straight tracks, as candidates to crowd.
    const candidates = start.tracks
      .filter((t) => !t.mid && t.net && Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y) > 6)
      .sort((a, b) => a.uuid.localeCompare(b.uuid));
    let shoved = 0;
    const added: string[] = [];
    let tried = 0;
    for (const c of candidates) {
      const board = parseBoard(serialize(doc));
      const t = board.tracks.find((x) => x.uuid === c.uuid);
      if (!t) continue; // already moved by an earlier shove
      const net = board.tracks.find((x) => x.net && x.net !== t.net)!.net;
      const width = netClassOf(rules, net).trackWidth;
      const len = Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
      const n = { x: -(t.end.y - t.start.y) / len, y: (t.end.x - t.start.x) / len };
      // Too close: 0.1 mm short of the clearance.
      const off = t.width / 2 + width / 2 + netClassOf(rules, t.net).clearance - 0.1;
      const at = (f: number) => ({ x: t.start.x + (t.end.x - t.start.x) * f + n.x * off, y: t.start.y + (t.end.y - t.start.y) * f + n.y * off });
      const path = [at(0.35), at(0.65)];
      const items = copperItems(board);
      // Only where nothing but tracks is in the way (pads and vias aren't shoved).
      if (trackConflicts(items, rules, { a: path[0]!, b: path[1]!, width, layer: t.layer, net }).some((h) => h.with.kind !== "track")) continue;
      tried++;
      const r = new InteractiveRouter(board, rules, items, net, width).shove([{ layer: t.layer, points: path }]);
      if (!r) continue;
      expect(r.remove).toContain(t.uuid);
      for (const u of r.remove) deleteBoardItem(boardRoot(doc), u);
      for (const a of r.add) for (let k = 1; k < a.points.length; k++) addTrack(boardRoot(doc), { start: a.points[k - 1]!, end: a.points[k]!, width: a.width, layer: a.layer, net: a.net });
      addTrack(boardRoot(doc), { start: path[0]!, end: path[1]!, width, layer: t.layer, net });
      added.push(net);
      shoved++;
      if (shoved >= 8) break;
    }
    console.log(`shove: ${shoved} of ${tried} tried`);
    expect(shoved).toBeGreaterThanOrEqual(4);
    // Zones are refilled around the moved tracks, as after any routing.
    const filled = parseBoard(serialize(doc));
    for (const f of fillZones(filled, rules)) setZoneFills(findBoardItem(boardRoot(doc), f.zone.uuid)!, [{ layer: f.layer, polygons: fracture(f.paths) }]);
    const pcb = join(dir, "pic_programmer.kicad_pcb");
    writeFileSync(pcb, serialize(doc));
    // The crowding tracks float (their net now has islands): only the other nets count.
    const crowding = new Set(added);
    const lost = findUnconnected(parseBoard(serialize(doc))).filter((u) => !crowding.has(u.net) && !unconnected.some((w) => w.net === u.net));
    expect(lost.map((u) => `${u.net}: ${u.a.description} -> ${u.b.description}`)).toEqual([]);
    const out = join(dir, "drc.json");
    execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", out, pcb], { stdio: "ignore" });
    const v = JSON.parse(readFileSync(out, "utf8")).violations as Array<{ type: string; description: string; items: Array<{ description: string }> }>;
    const bad = v.filter((x) => ["clearance", "shorting_items", "tracks_crossing", "copper_edge_clearance"].includes(x.type));
    expect(bad.map((x) => `${x.type}: ${x.items.map((i) => i.description).join(" / ")}`)).toEqual([]);
  }, 180_000);
});

describe("shove, several deep", () => {
  it("a pushed track pushes the next one", () => {
    const seg = (y: number, net: number, id: string) => `(segment (start 2 ${y}) (end 18 ${y}) (width 0.25) (layer "F.Cu") (net ${net}) (uuid "${id}"))`;
    const text = `(kicad_pcb (version 20240108) (generator "test")
      (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
      (net 0 "") (net 1 "A") (net 2 "B") (net 3 "C") (net 4 "D") (net 5 "E")
      (gr_rect (start 0 0) (end 20 20) (layer "Edge.Cuts") (stroke (width 0.1)))
      ${seg(10, 1, "a0000000-0000-0000-0000-000000000001")} ${seg(10.6, 2, "b0000000-0000-0000-0000-000000000002")} ${seg(11.2, 3, "c0000000-0000-0000-0000-000000000003")}
      ${seg(9.15, 5, "e0000000-0000-0000-0000-000000000005")})`;
    const board = parseBoard(text);
    const rules = projectDesignRules(undefined);
    const items = copperItems(board);
    // D runs just above A, far too close, with E right above it: A has to move down, into B, and B into C.
    const route = [{ layer: "F.Cu", points: [{ x: 6, y: 9.75 }, { x: 14, y: 9.75 }] }];
    const router = new InteractiveRouter(board, rules, items, "D", 0.25);
    const r = router.shove(route);
    expect(router.failure).toBeUndefined();
    expect(r).toBeDefined();
    // A moves, and pushes at least one more net (whichever side has room).
    const nets = new Set(r!.add.map((a) => a.net));
    expect(nets.has("A") && nets.size >= 2, [...nets].join(",")).toBe(true);
    // Everything moved, and the route, clear of each other.
    const after = [
      ...r!.add.flatMap((a) => a.points.slice(1).map((b, k) => ({ a: a.points[k]!, b, net: a.net }))),
      { a: route[0]!.points[0]!, b: route[0]!.points[1]!, net: "D" },
    ];
    for (const x of after)
      for (const y of after) {
        if (x.net === y.net) continue;
        const d = segDistance(x.a, x.b, y.a, y.b) - 0.25;
        expect(d, `${x.net} ↔ ${y.net}`).toBeGreaterThanOrEqual(0.2 - 0.001);
      }
  });
});

function segDistance(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }): number {
  const pt = (p: typeof a, q: typeof a, r: typeof a) => {
    const dx = r.x - q.x, dy = r.y - q.y, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p.x - q.x) * dx + (p.y - q.y) * dy) / l)) : 0;
    return Math.hypot(p.x - q.x - t * dx, p.y - q.y - t * dy);
  };
  const o = (p: typeof a, q: typeof a, r: typeof a) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0;
  return Math.min(pt(a, c, d), pt(b, c, d), pt(c, a, b), pt(d, a, b));
}

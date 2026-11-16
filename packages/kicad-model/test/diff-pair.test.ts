/**
 * Differential pairs against KiCad: on StickHub, strip three USB pairs, route
 * each one's centreline with the interactive router and couple it into two
 * tracks at the net class's pair width and gap. kicad-cli must find no
 * clearance, short or crossing problems, and the coupled run must keep the
 * pair's pitch. One pair changes layers through a pair of vias.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addTrack, addVia, boardRoot, copperItems, coupledPair, coupledRoute, deleteBoardItem, fillZones, findBoardItem, fracture, pairEscape, pairObstacles, routeWithVias, setZoneFills, diffPairSizes, diffPartnerOnBoard, InteractiveRouter, parseBoard, partnerPad, projectDesignRules } from "../src/index.js";

const DEMO = "/Library/Application Support/kicad/demos/stickhub";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
let ok = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  ok = false;
}

/** kicad-cli's clearance, short, crossing and hole problems involving `nets`. */
function kicadProblems(dir: string, doc: ReturnType<typeof parse>, nets: string[]): string[] {
  // Zones are refilled around the new tracks, as after any routing.
  const rules = projectDesignRules(readFileSync(join(DEMO, "StickHub.kicad_pro"), "utf8"));
  for (const f of fillZones(parseBoard(serialize(doc)), rules)) setZoneFills(findBoardItem(boardRoot(doc), f.zone.uuid)!, [{ layer: f.layer, polygons: fracture(f.paths) }]);
  const pcb = join(dir, "StickHub.kicad_pcb");
  writeFileSync(pcb, serialize(doc));
  const out = join(dir, "drc.json");
  execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", out, pcb], { stdio: "ignore" });
  const v = JSON.parse(readFileSync(out, "utf8")).violations as Array<{ type: string; items: Array<{ description: string }> }>;
  return v
    .filter((x) => ["clearance", "shorting_items", "tracks_crossing", "hole_clearance", "hole_to_hole"].includes(x.type) && x.items.some((i) => nets.some((n) => i.description.includes(`[${n}]`))))
    .map((x) => `${x.type}: ${x.items.map((i) => i.description).join(" / ")}`);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "crossprobe-dp-"));
  for (const f of ["StickHub.kicad_pro", "StickHub.kicad_sch"]) copyFileSync(join(DEMO, f), join(dir, f));
  const rules = projectDesignRules(readFileSync(join(DEMO, "StickHub.kicad_pro"), "utf8"));
  const doc = parse(readFileSync(join(DEMO, "StickHub.kicad_pcb"), "utf8"));
  return { dir, rules, doc };
}
const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

describe.skipIf(!ok)("differential pairs", () => {
  it("routes coupled pairs KiCad's DRC accepts", () => {
    const { dir, rules, doc } = setup();
    const nets: string[] = [];
    for (const P of ["/U2D+", "/U7D+", "/U5D+"]) {
      const before = parseBoard(serialize(doc));
      const N = diffPartnerOnBoard(before, P)!;
      expect(N).toBe(P.slice(0, -1) + "-");
      nets.push(P, N);
      for (const t of [...before.tracks, ...before.vias].filter((t) => t.net === P || t.net === N)) deleteBoardItem(boardRoot(doc), t.uuid);
      const board = parseBoard(serialize(doc));
      // Two pair ends on the front: each P pad with the N pad beside it.
      const ends = board.footprints
        .flatMap((f) => f.pads.filter((p) => p.net === P && p.layers.includes("F.Cu")))
        .map((p) => ({ p, n: partnerPad(board, p, N)!.pad }));
      expect(ends.length).toBeGreaterThanOrEqual(2);
      const [s, e] = ends as [(typeof ends)[0], (typeof ends)[0]];
      const { width, gap } = diffPairSizes(rules, P);
      const router = new InteractiveRouter(board, rules, copperItems(board).filter((it) => it.item.net !== N), P, 2 * width + gap);
      const center = router.path(mid(s.p.at, s.n.at), mid(e.p.at, e.n.at), "F.Cu", { maxExpanded: 2_000_000 });
      expect(center).toBeDefined();
      const pair = coupledPair(center!, width, gap, { startP: s.p.at, startN: s.n.at, endP: e.p.at, endN: e.n.at });
      expect(pair.crossed).toBe(false);
      for (const [pts, net] of [[pair.p, P], [pair.n, N]] as const) for (let k = 1; k < pts.length; k++) addTrack(boardRoot(doc), { start: pts[k - 1]!, end: pts[k]!, width, layer: "F.Cu", net });
      // Between the fan-outs the two tracks run at the pitch (width + gap).
      for (let k = 2; k < pair.p.length - 1; k++) {
        const a = pair.p[k - 1]!, b = pair.p[k]!;
        const q = mid(a, b);
        const d = Math.min(...pair.n.slice(1).map((c, i) => {
          const o = pair.n[i]!, dx = c.x - o.x, dy = c.y - o.y, l = dx * dx + dy * dy;
          const t = l ? Math.max(0, Math.min(1, ((q.x - o.x) * dx + (q.y - o.y) * dy) / l)) : 0;
          return Math.hypot(q.x - o.x - t * dx, q.y - o.y - t * dy);
        }));
        expect(d).toBeCloseTo(width + gap, 3);
      }
    }
    expect(kicadProblems(dir, doc, nets)).toEqual([]);
  }, 180_000);

  it("changes layers through a pair of vias", () => {
    // A USB connector on the front to the hub IC on the back, on a board stripped of tracks
    // (this one is too dense to fit the pair's vias around the existing routing). Most of
    // the hub's pairs have passives right where a straight escape would go; U4's doesn't.
    const { dir, rules, doc } = setup();
    const nets: string[] = [];
    for (const t of [...parseBoard(serialize(doc)).tracks, ...parseBoard(serialize(doc)).vias]) deleteBoardItem(boardRoot(doc), t.uuid);
    {
      const P = "/U4D+";
      const before = parseBoard(serialize(doc));
      const N = diffPartnerOnBoard(before, P)!;
      nets.push(P, N);
      const board = before;
      // Pair ends where both pads belong to one part (the connector, the hub).
      const pads = board.footprints.flatMap((f) => f.pads.filter((p) => p.net === P).map((p) => ({ p, n: partnerPad(board, p, N), f }))).map((x) => ({ p: x.p, f: x.f, n: x.n && x.n.footprint === x.f ? x.n.pad : undefined }));
      const s = pads.find((x) => x.p.layers.includes("F.Cu") && x.n)!;
      const e = pads.find((x) => x.p.layers.includes("B.Cu") && x.n)!;
      const sz = diffPairSizes(rules, P);
      const pitch = sz.via.size + sz.viaGap;
      // The centreline's "via" covers both of the pair's vias.
      // Leave and arrive straight out from between the pads.
      const out = pairEscape(s.p, s.n!, s.f, sz.width, sz.gap, e.p.at, rules.classes.get("Default")!.clearance);
      const into = pairEscape(e.p, e.n!, e.f, sz.width, sz.gap, s.p.at, rules.classes.get("Default")!.clearance);
      const route = routeWithVias(board, rules, { from: out.escape, to: into.escape, net: P, width: 2 * sz.width + sz.gap, via: { size: pitch + sz.via.size, drill: sz.via.drill }, fromLayers: ["F.Cu"], toLayers: ["B.Cu"], unchecked: true }, pairObstacles(copperItems(board), P, N, [s.p.uuid, s.n!.uuid, e.p.uuid, e.n!.uuid]));
      expect(route).toBeDefined();
      expect(route!.vias.length).toBeGreaterThanOrEqual(1);
      const runs = route!.runs.map((r) => ({ ...r, points: [...r.points] }));
      runs[0]!.points.unshift(out.mid);
      runs.at(-1)!.points.push(into.mid);
      const pair = coupledRoute(runs, sz.width, sz.gap, pitch, { startP: s.p.at, startN: s.n!.at, endP: e.p.at, endN: e.n!.at });
      expect(pair.crossed).toBe(false);
      for (const t of pair.tracks) for (let k = 1; k < t.points.length; k++) addTrack(boardRoot(doc), { start: t.points[k - 1]!, end: t.points[k]!, width: sz.width, layer: t.layer, net: t.side === "p" ? P : N });
      for (const v of pair.vias) for (const [at, net] of [[v.p, P], [v.n, N]] as const) addVia(boardRoot(doc), { at, size: sz.via.size, drill: sz.via.drill, layers: ["F.Cu", "B.Cu"], net });
    }
    expect(kicadProblems(dir, doc, nets)).toEqual([]);
  }, 180_000);
});

/**
 * Route all routes a differential pair's two nets as one: two tracks at the net class's pair width,
 * the pair's gap apart, from between the pads at one end to between them at the other, with a pair
 * of vias side by side where it changes layers. A pair that can't be routed so (P and N swap sides
 * between the ends) is routed apart, as before. KiCad's DRC accepts the result.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addTrack, addVia, autorouteAll, boardRoot, checkClearance, pairConnections, pairCoupling, parseBoard, projectDesignRules, type MultiLayerRoute } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI;
let kicad = !!KICAD_CLI;
try {
  if (KICAD_CLI) execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  kicad = false;
}

const part = (ref: string, k: number, x: number, y: number, pads: Array<[string, number, number, string]>) =>
  `(footprint "T:${ref}" (layer "F.Cu") (uuid "00000000-0000-4000-8000-00000000000${k}") (at ${x} ${y}) (property "Reference" "${ref}" (at 0 -3 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) ` +
  pads.map(([n, px, py, net], i) => `(pad "${n}" smd rect (at ${px} ${py}) (size 0.6 1.2) (layers "F.Cu" "F.Mask") (net "${net}") (uuid "00000000-0000-4000-8000-0000000001${k}${i}"))`).join(" ") +
  ")";
const pcb = (more = "", nSwapped = false) => `(kicad_pcb (version 20260206) (generator "test") (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  ${part("J1", 1, 20, 30, [["1", -0.5, 0, "D_P"], ["2", 0.5, 0, "D_N"]])}
  ${part("U1", 2, 40, 38, [["1", nSwapped ? 0.5 : -0.5, 0, "D_P"], ["2", nSwapped ? -0.5 : 0.5, 0, "D_N"]])}
  ${more} (gr_rect (start 10 20) (end 50 48) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts")))`;
// A wall of another net across the front, from pad to pad: the pair has to pass it on the back.
const wall = `${part("W1", 3, 30, 22, [["1", 0, 0, "W"]])} ${part("W2", 4, 30, 46, [["1", 0, 0, "W"]])} (segment (start 30 22) (end 30 46) (width 0.3) (layer "F.Cu") (net "W"))`;
const pro = JSON.stringify({
  board: { design_settings: { rules: { min_clearance: 0 } } },
  net_settings: { classes: [{ name: "Default", clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3, diff_pair_width: 0.2, diff_pair_gap: 0.15, diff_pair_via_gap: 0.25 }] },
});
const rules = projectDesignRules(pro);
const connections = (swapped = false) => [
  { from: { x: 19.5, y: 30 }, to: { x: swapped ? 40.5 : 39.5, y: 38 }, net: "D_P" },
  { from: { x: 20.5, y: 30 }, to: { x: swapped ? 39.5 : 40.5, y: 38 }, net: "D_N" },
];

/** The share of P's track length that has N's track one pitch (width + gap) away, on its layer. */
function coupled(p: MultiLayerRoute, n: MultiLayerRoute, pitch: number): number {
  const dist = (q: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(a.x + t * dx - q.x, a.y + t * dy - q.y);
  };
  let total = 0, near = 0;
  for (const run of p.runs)
    for (let k = 1; k < run.points.length; k++) {
      const a = run.points[k - 1]!, b = run.points[k]!, len = Math.hypot(b.x - a.x, b.y - a.y), steps = Math.max(1, Math.round(len / 0.1));
      for (let i = 0; i < steps; i++) {
        const q = { x: a.x + ((b.x - a.x) * (i + 0.5)) / steps, y: a.y + ((b.y - a.y) * (i + 0.5)) / steps };
        total += len / steps;
        if (n.runs.some((m) => m.layer === run.layer && m.points.slice(1).some((e, j) => Math.abs(dist(q, m.points[j]!, e) - pitch) < 0.02))) near += len / steps;
      }
    }
  return near / total;
}

/** The routes on the board, checked by our DRC and, where it is installed, KiCad's. */
function check(text: string, routes: Array<MultiLayerRoute | undefined>, nets: string[]) {
  const doc = parse(text);
  routes.forEach((r, i) => {
    for (const run of r!.runs) for (let k = 1; k < run.points.length; k++) addTrack(boardRoot(doc), { start: run.points[k - 1]!, end: run.points[k]!, width: run.width ?? 0.25, layer: run.layer, net: nets[i]! });
    for (const v of r!.vias) addVia(boardRoot(doc), { at: v, size: 0.6, drill: 0.3, layers: ["F.Cu", "B.Cu"], net: nets[i]! });
  });
  const board = parseBoard(serialize(doc));
  expect(checkClearance(board, rules)).toEqual([]);
  if (!kicad) return board;
  const dir = mkdtempSync(join(tmpdir(), "crossprobe-pair-"));
  writeFileSync(join(dir, "pair.kicad_pcb"), serialize(doc));
  writeFileSync(join(dir, "pair.kicad_pro"), pro);
  execFileSync(KICAD_CLI!, ["pcb", "drc", "--format", "json", "-o", join(dir, "drc.json"), join(dir, "pair.kicad_pcb")], { stdio: "ignore" });
  const drc = JSON.parse(readFileSync(join(dir, "drc.json"), "utf8")) as { violations: Array<{ type: string }>; unconnected_items: unknown[] };
  expect(drc.violations.map((v) => v.type).filter((t) => !t.startsWith("lib_footprint") && !t.startsWith("silk"))).toEqual([]);
  expect(drc.unconnected_items).toEqual([]);
  return board;
}

describe("a differential pair in Route all", () => {
  it("finds the pair's connections, end to end", () => {
    const b = parseBoard(pcb());
    expect(pairConnections(b, connections())).toEqual([{ p: 1, n: 0, flip: false }]);
    // The partner's connection drawn the other way round is turned to match.
    const c = connections();
    c[0] = { from: c[0]!.to, to: c[0]!.from, net: "D_P" };
    expect(pairConnections(b, c)).toEqual([{ p: 1, n: 0, flip: true }]);
  });

  it("routes it as two coupled tracks at the pair's width and gap", () => {
    const text = pcb();
    const [p, n] = autorouteAll(parseBoard(text), rules, connections());
    expect(p!.runs.every((r) => r.width === 0.2) && n!.runs.every((r) => r.width === 0.2)).toBe(true);
    expect(coupled(p!, n!, 0.35)).toBeGreaterThan(0.9);
    // The build report's measure says the same.
    expect(pairCoupling(check(text, [p, n], ["D_P", "D_N"]), rules)).toEqual([{ nets: ["D_N", "D_P"], coupled: expect.any(Number) }]);
    expect(pairCoupling(check(text, [p, n], ["D_P", "D_N"]), rules)[0]!.coupled).toBeGreaterThan(0.9);
  }, 60_000);

  it("changes layers through two vias side by side", () => {
    const text = pcb(wall);
    const [p, n] = autorouteAll(parseBoard(text), rules, connections());
    expect(p!.vias.length).toBeGreaterThan(0);
    expect(p!.vias.length).toBe(n!.vias.length);
    // Each pair of vias the via size and the via gap apart.
    p!.vias.forEach((v, i) => expect(Math.hypot(v.x - n!.vias[i]!.x, v.y - n!.vias[i]!.y)).toBeCloseTo(0.85, 6));
    expect(coupled(p!, n!, 0.35)).toBeGreaterThan(0.8);
    check(text, [p, n], ["D_P", "D_N"]);
  }, 60_000);

  it("routes a pair whose ends are in the other order apart, as before", () => {
    const text = pcb("", true);
    const [p, n] = autorouteAll(parseBoard(text), rules, connections(true));
    expect(p && n).toBeTruthy();
    expect(p!.runs.every((r) => r.width === undefined)).toBe(true);
    expect(pairCoupling(check(text, [p, n], ["D_P", "D_N"]), rules)[0]!.coupled).toBeLessThan(0.5);
  }, 60_000);
});

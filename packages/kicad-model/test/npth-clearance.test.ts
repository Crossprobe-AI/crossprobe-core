/**
 * An unplated hole with a clearance of its own (a module's mounting hole asking for room round the
 * screw head): KiCad keeps other copper that far from the hole, so the DRC reports what comes closer
 * (the distances are kicad-cli's for this board) and the router goes round it. An unplated pad larger
 * than its hole has a ring of copper, on no net: KiCad keeps the clearance from the ring instead.
 */
import { describe, expect, it } from "vitest";
import { checkClearance, parseBoard, projectDesignRules, routeConnection, unplatedCopper } from "../src/index.js";

const hole = (ref: string, x: number, clearance?: number, size = 2.7) =>
  `(footprint "T:Hole" (layer "F.Cu") (at ${x} 30) (property "Reference" "${ref}" (at 0 -4 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) (pad "" np_thru_hole circle (at 0 0) (size ${size} ${size}) (drill 2.7) (layers "*.Cu" "*.Mask")${clearance ? ` (clearance ${clearance})` : ""}))`;
// Short tracks 0.5, 1.0, 1.5 and 1.8 mm from each hole's edge, above and below it.
const tracks = (x: number, net = "A") =>
  [0.5, 1.0, 1.5, 1.8]
    .map((g, k) => {
      const y = k % 2 === 0 ? 30 + 1.35 + g + 0.1 : 30 - 1.35 - g - 0.1;
      return `(segment (start ${x - 1.5 + k * 0.9} ${y}) (end ${x - 1 + k * 0.9} ${y}) (width 0.2) (layer "F.Cu") (net "${net}"))`;
    })
    .join(" ");
const board = (body: string) =>
  parseBoard(`(kicad_pcb (version 20260206) (generator "test") (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
    ${body} (gr_rect (start 5 15) (end 95 45) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts")))`);
const rules = projectDesignRules("{}");

describe("an unplated hole's own clearance", () => {
  it("is the hole clearance the DRC asks of other copper, as in KiCad", () => {
    const found = checkClearance(board(hole("H1", 20, 1.7) + tracks(20) + hole("H2", 80) + tracks(80)), rules).filter((v) => v.type === "hole");
    expect(found.map((v) => [v.items[1]!.description, v.required, v.actual])).toEqual([
      ["NPTH pad of H1", 1.7, 1.002],
      ["NPTH pad of H1", 1.7, 0.7415],
      ["NPTH pad of H1", 1.7, 1.5152],
    ]);
  });

  it("is kept by the router", () => {
    const pad = (ref: string, x: number) => `(footprint "T:Pad" (layer "F.Cu") (at ${x} 30) (property "Reference" "${ref}" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "A")))`;
    const b = board(hole("H1", 50, 1.7) + pad("P1", 40) + pad("P2", 60));
    const route = routeConnection(b, rules, { from: { x: 40, y: 30 }, to: { x: 60, y: 30 }, net: "A", layer: "F.Cu", width: 0.2 })!;
    expect(route).toBeDefined();
    // Every corner and every straight run between them stays 1.7 mm off the hole's edge.
    expect(Math.min(...route.slice(1).map((p, k) => away(route[k]!, p, 1.35)))).toBeGreaterThanOrEqual(1.7 - 1e-6);
  });
});

// How far a track's edge from a to c passes from the edge of a circle of radius r at (50, 30).
const away = (a: { x: number; y: number }, c: { x: number; y: number }, r: number) => {
  const dx = c.x - a.x, dy = c.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((50 - a.x) * dx + (30 - a.y) * dy) / l2)) : 0;
  return Math.hypot(a.x + t * dx - 50, a.y + t * dy - 30) - r - 0.1;
};

describe("an unplated pad with a ring of copper round its hole", () => {
  it("has one unless it is round or oval like its hole, centred on it and no larger, as in KiCad", () => {
    const pad = (shape: string, size: number[], drill: number | number[], offset?: number) => ({ shape, size: { x: size[0]!, y: size[1]! }, ...(typeof drill === "number" ? { drill } : { drill: drill[0], drillSize: { x: drill[0]!, y: drill[1]! } }), ...(offset ? { offset: { x: offset, y: 0 } } : {}) });
    expect([
      pad("circle", [2.7, 2.7], 2.7),
      pad("circle", [3.5, 3.5], 2.7),
      pad("circle", [2.7, 2.7], 2.7, 0.1),
      pad("rect", [2.7, 2.7], 2.7),
      pad("oval", [2.7, 3.5], [2.7, 3.5]),
      pad("oval", [2.7, 3.5], 2.7),
    ].map(unplatedCopper)).toEqual([false, true, true, true, false, true]);
  });

  it("is copper to the DRC, kept by the pad's own clearance, and its hole is not reported as well", () => {
    // kicad-cli reports these four as clearance to the ring, not as hole clearance.
    const found = checkClearance(board(hole("H1", 20, 1.7, 3.5) + tracks(20)), rules);
    expect(found.map((v) => [v.type, v.items.some((i) => i.description === "NPTH pad of H1"), v.required, v.actual]).sort((p, q) => Number(p[3]) - Number(q[3]))).toEqual([
      ["clearance", true, 1.7, 0.3415],
      ["clearance", true, 1.7, 0.602],
      ["clearance", true, 1.7, 1.1152],
      ["clearance", true, 1.7, 1.6145],
    ]);
  });

  it("is on no net, like other copper without one: KiCad counts that as one net", () => {
    // A track 0.05 mm from the ring: on a net it is too close; without one it is on the ring's.
    const by = (net: string) => `(segment (start 49.5 31.9) (end 50.5 31.9) (width 0.2) (layer "F.Cu") (net "${net}"))`;
    expect(checkClearance(board(hole("H1", 50, undefined, 3.5) + by("A")), rules).map((v) => [v.type, v.actual])).toEqual([["clearance", 0.05]]);
    expect(checkClearance(board(hole("H1", 50, undefined, 3.5) + by("")), rules)).toEqual([]);
  });

  it("is kept by the router at the pad's own clearance", () => {
    const pad = (ref: string, x: number) => `(footprint "T:Pad" (layer "F.Cu") (at ${x} 30) (property "Reference" "${ref}" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "A")))`;
    const b = board(hole("H1", 50, 1.7, 3.5) + pad("P1", 40) + pad("P2", 60));
    const route = routeConnection(b, rules, { from: { x: 40, y: 30 }, to: { x: 60, y: 30 }, net: "A", layer: "F.Cu", width: 0.2 })!;
    expect(route).toBeDefined();
    expect(Math.min(...route.slice(1).map((p, k) => away(route[k]!, p, 1.75)))).toBeGreaterThanOrEqual(1.7 - 1e-6);
    expect(checkClearance({ ...b, tracks: route.slice(1).map((p, k) => ({ start: route[k]!, end: p, width: 0.2, layer: "F.Cu", net: "A", uuid: "" })) } as typeof b, rules)).toEqual([]);
  });
});

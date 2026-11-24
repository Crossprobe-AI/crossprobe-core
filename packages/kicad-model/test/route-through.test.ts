/**
 * A route through points chosen by hand (routeThrough), as a person routes in KiCad: through each
 * point in turn, on its layer if it has one, the router finding the way between; or which stretch
 * found no way.
 */
import { describe, expect, it } from "vitest";
import { routeThrough, parseBoard, projectDesignRules } from "../src/index.js";

const pad = (ref: string, x: number, y: number, net: string) =>
  `(footprint "T:P" (layer "F.Cu") (at ${x} ${y}) (property "Reference" "${ref}" (at 0 -2 0) (layer "F.SilkS") (hide yes) (effects (font (size 1 1) (thickness 0.15)))) (pad "1" smd rect (at 0 0) (size 0.8 0.8) (layers "F.Cu") (net "${net}")))`;
const board = parseBoard(`(kicad_pcb (version 20260206) (generator "test") (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  ${pad("A1", 15, 20, "A")} ${pad("A2", 35, 20, "A")} ${pad("B1", 25, 26, "B")}
  (gr_rect (start 10 10) (end 40 30) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts")))`);
const rules = projectDesignRules(JSON.stringify({ net_settings: { classes: [{ name: "Default", clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3 }] } }));
const a1 = { x: 15, y: 20 }, a2 = { x: 35, y: 20 };

describe("a route through chosen points", () => {
  it("passes each point, on its layer when it has one", () => {
    const r = routeThrough(board, rules, "A", [{ at: a1 }, { at: { x: 25, y: 14 } }, { at: a2 }]);
    expect("route" in r).toBe(true);
    const route = (r as { route: { runs: Array<{ layer: string; points: Array<{ x: number; y: number }> }>; vias: unknown[] } }).route;
    const all = route.runs.flatMap((run) => run.points);
    expect(all.some((p) => Math.hypot(p.x - 25, p.y - 14) < 1e-6)).toBe(true);
    // Through a point on the back: down by a via and up again.
    const back = routeThrough(board, rules, "A", [{ at: a1 }, { at: { x: 25, y: 20 }, layer: "B.Cu" }, { at: a2 }]);
    const b = (back as { route: { runs: Array<{ layer: string; points: Array<{ x: number; y: number }> }>; vias: unknown[] } }).route;
    expect(b.runs.some((run) => run.layer === "B.Cu" && run.points.some((p) => Math.hypot(p.x - 25, p.y - 20) < 1e-6))).toBe(true);
    expect(b.vias.length).toBe(2);
  });

  it("says which stretch finds no way", () => {
    // Onto another net's pad on its own layer: the second stretch can't end there.
    expect(routeThrough(board, rules, "A", [{ at: a1 }, { at: { x: 20, y: 20 } }, { at: { x: 25, y: 26 }, layer: "F.Cu" }, { at: a2 }])).toEqual({ failed: 1 });
  });
});

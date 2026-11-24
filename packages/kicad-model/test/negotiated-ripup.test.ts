/**
 * Negotiated rip-up: for a connection Route all couldn't make, crossings() looks for the way it would
 * take if the routes made earlier in the run cost something to cross, and names those it crosses.
 * Here a wall (a rule area that keeps tracks out) has one gap, and another net's route runs through
 * it: that route is the one in the way. As a wall it leaves no way at all, and without it the way is free.
 */
import { describe, expect, it } from "vitest";
import { copperItems, crossings, parseBoard, projectDesignRules } from "../src/index.js";

const wall = (y0: number, y1: number) =>
  `(zone (net 0) (net_name "") (layers "F.Cu") (name "wall") (hatch edge 0.5) (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour allowed) (footprints allowed)) (polygon (pts (xy 19.5 ${y0}) (xy 20.5 ${y0}) (xy 20.5 ${y1}) (xy 19.5 ${y1}))))`;
const pad = (ref: string, x: number, net: string) =>
  `(footprint "T:P" (layer "F.Cu") (at ${x} 15) (property "Reference" "${ref}" (at 0 -2 0) (layer "F.SilkS") (hide yes) (effects (font (size 1 1) (thickness 0.15)))) (pad "1" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net "${net}")))`;
// One copper layer: no way round the wall on the other side. The gap (y 14.6 to 15.4) takes one track.
const pcb = (route: string) => `(kicad_pcb (version 20260206) (generator "test") (general (thickness 1.6)) (layers (0 "F.Cu" signal) (25 "Edge.Cuts" user))
  ${pad("A1", 12, "A")} ${pad("A2", 28, "A")} ${pad("B1", 15, "B")} ${pad("B2", 25, "B")} ${wall(10, 14.6)} ${wall(15.4, 20)} ${route}
  (gr_rect (start 10 10) (end 30 20) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts")))`;
const routeB = `(segment (start 15 15) (end 25 15) (width 0.25) (layer "F.Cu") (net "B"))`;
const rules = projectDesignRules(JSON.stringify({ net_settings: { classes: [{ name: "Default", clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3 }] } }));
const a = { from: { x: 12, y: 15 }, to: { x: 28, y: 15 }, net: "A" };

describe("negotiated rip-up", () => {
  it("names the route in the way, through the one gap", () => {
    const board = parseBoard(pcb(""));
    const b = copperItems(parseBoard(pcb(routeB))).filter((it) => it.item.kind === "track" && it.item.net === "B");
    expect(b).toHaveLength(1);
    const hard = copperItems(board);
    // B's route, made earlier in the run: it costs something to cross, and it is the one in the way.
    const way = crossings(board, rules, a, hard, b.map((it) => ({ it, idx: 7 })), new Map());
    expect(way && [...way.victims]).toEqual([7]);
    expect(way!.cells.length).toBeGreaterThan(0);
    // As a wall it leaves no way at all; and with nothing in the gap, the way is free.
    expect(crossings(board, rules, a, [...hard, ...b], [], new Map())).toBeUndefined();
    expect(crossings(board, rules, a, hard, [], new Map())?.victims.size).toBe(0);
  });
});

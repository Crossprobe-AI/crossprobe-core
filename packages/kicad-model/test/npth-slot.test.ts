/**
 * An unplated slot is a board edge to KiCad: it is milled, as the outline is, so copper keeps the
 * board's edge clearance from it, and silkscreen stays off it. A round hole is drilled and keeps the
 * hole clearance only. The DRC reports what comes closer (the distances are kicad-cli's for this
 * board), the zone fill keeps away, and so does the router.
 */
import { describe, expect, it } from "vitest";
import { checkBoard, checkClearance, fillZones, fracture, holeShape, parseBoard, projectDesignRules, routeConnection, shapeDistance, type Shape } from "../src/index.js";

const fp = (ref: string, k: number, x: number, rot: number, pad: string) =>
  `(footprint "T:Slot" (layer "F.Cu") (uuid "00000000-0000-4000-8000-0000000000${k}0") (at ${x} 15 ${rot}) (property "Reference" "${ref}" (at 0 -5 ${rot}) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) ${pad})`;
const slot = (ref: string, k: number, x: number, rot = 0) => fp(ref, k, x, rot, `(pad "" np_thru_hole oval (at 0 0 ${rot}) (size 2 4) (drill oval 2 4) (layers "*.Cu" "*.Mask"))`);
const round = (ref: string, k: number, x: number) => fp(ref, k, x, 0, `(pad "" np_thru_hole circle (at 0 0) (size 2 2) (drill 2) (layers "*.Cu" "*.Mask"))`);
// Short vertical tracks right of a hole, their edges 0.2, 0.4 and 0.6 mm from its side or end.
const tracks = (x: number, half: number) =>
  [0.2, 0.4, 0.6].map((g, k) => `(segment (start ${x + half + g + 0.1} ${13 + k * 1.5}) (end ${x + half + g + 0.1} ${13.5 + k * 1.5}) (width 0.2) (layer "F.Cu") (net "A"))`).join(" ");
const board = (body: string) =>
  parseBoard(`(kicad_pcb (version 20260206) (generator "test") (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (37 "F.SilkS" user) (25 "Edge.Cuts" user))
    ${body} (gr_rect (start 0 0) (end 60 30) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts")))`);
const rules = projectDesignRules(JSON.stringify({ board: { design_settings: { rules: { min_copper_edge_clearance: 0.5, min_hole_clearance: 0.25, min_silk_clearance: 0 } } } }));

describe("an unplated slot", () => {
  it("is a board edge to the DRC, for copper and silkscreen, as in KiCad; a round hole is not", () => {
    // S2 is turned 90°: its slot lies along x, so the tracks face its end.
    const b = board(slot("S1", 1, 15) + tracks(15, 1) + slot("S2", 2, 30, 90) + tracks(30, 2) + round("H3", 3, 45) + tracks(45, 1) + `(gr_line (start 13 15) (end 17 15) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))`);
    const edge = checkClearance(b, rules).map((v) => [v.type, v.items[1]!.description, v.required, v.actual]);
    expect(edge).toEqual([
      ["edge", "NPTH pad of S1", 0.5, 0.2928],
      ["edge", "NPTH pad of S1", 0.5, 0.4],
      ["edge", "NPTH pad of S2", 0.5, 0.4],
    ]);
    expect(checkBoard(b, rules).filter((v) => v.type === "silk_edge_clearance").map((v) => v.items[0]!.description)).toEqual(["NPTH pad of S1"]);
  });

  it("keeps the zone fill at the edge clearance", () => {
    const zone = `(zone (net "GND") (layer "B.Cu") (uuid "00000000-0000-4000-8000-000000000900") (hatch edge 0.5) (connect_pads (clearance 0.2)) (min_thickness 0.2) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 1 1) (xy 59 1) (xy 59 29) (xy 1 29))))`;
    const b = board(slot("S1", 1, 15) + round("H3", 3, 45) + zone);
    const hole = (ref: string) => holeShape(b.footprints.find((f) => f.reference === ref)!.pads[0]!)!;
    const fill = fillZones(b, rules).flatMap((f) => fracture(f.paths));
    const nearest = (h: Shape) => Math.min(...fill.flatMap((poly) => poly.map((p, k) => shapeDistance({ kind: "seg", a: p, b: poly[(k + 1) % poly.length]!, r: 0 }, h, 1).dist)));
    expect(nearest(hole("S1"))).toBeGreaterThanOrEqual(0.5 - 1e-3);
    // The round hole keeps the hole clearance only.
    expect(nearest(hole("H3"))).toBeLessThan(0.3);
  });

  it("is kept by the router at the edge clearance", () => {
    const pad = (ref: string, x: number) => `(footprint "T:Pad" (layer "F.Cu") (at ${x} 15) (property "Reference" "${ref}" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "A")))`;
    const b = board(slot("S1", 1, 30) + pad("P1", 20) + pad("P2", 40));
    const route = routeConnection(b, rules, { from: { x: 20, y: 15 }, to: { x: 40, y: 15 }, net: "A", layer: "F.Cu", width: 0.2 })!;
    expect(route).toBeDefined();
    const h = holeShape(b.footprints.find((f) => f.reference === "S1")!.pads[0]!)!;
    const away = Math.min(...route.slice(1).map((p, k) => shapeDistance({ kind: "seg", a: route[k]!, b: p, r: 0.1 }, h, 2).dist));
    expect(away).toBeGreaterThanOrEqual(0.5 - 1e-6);
    expect(checkClearance({ ...b, tracks: route.slice(1).map((p, k) => ({ start: route[k]!, end: p, width: 0.2, layer: "F.Cu", net: "A", uuid: "" })) } as typeof b, rules)).toEqual([]);
  });
});

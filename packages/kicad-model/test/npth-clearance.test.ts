/**
 * An unplated hole with a clearance of its own (a module's mounting hole asking for room round the
 * screw head): KiCad keeps other copper that far from the hole, so the DRC reports what comes closer
 * (the distances are kicad-cli's for this board) and the router goes round it.
 */
import { describe, expect, it } from "vitest";
import { checkClearance, parseBoard, projectDesignRules, routeConnection } from "../src/index.js";

const hole = (ref: string, x: number, clearance?: number) =>
  `(footprint "T:Hole" (layer "F.Cu") (at ${x} 30) (property "Reference" "${ref}" (at 0 -4 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) (pad "" np_thru_hole circle (at 0 0) (size 2.7 2.7) (drill 2.7) (layers "*.Cu" "*.Mask")${clearance ? ` (clearance ${clearance})` : ""}))`;
// Short tracks 0.5, 1.0, 1.5 and 1.8 mm from each hole's edge, above and below it.
const tracks = (x: number) =>
  [0.5, 1.0, 1.5, 1.8]
    .map((g, k) => {
      const y = k % 2 === 0 ? 30 + 1.35 + g + 0.1 : 30 - 1.35 - g - 0.1;
      return `(segment (start ${x - 1.5 + k * 0.9} ${y}) (end ${x - 1 + k * 0.9} ${y}) (width 0.2) (layer "F.Cu") (net "A"))`;
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
    const away = (a: { x: number; y: number }, c: { x: number; y: number }) => {
      const dx = c.x - a.x, dy = c.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((50 - a.x) * dx + (30 - a.y) * dy) / l2)) : 0;
      return Math.hypot(a.x + t * dx - 50, a.y + t * dy - 30) - 1.35 - 0.1;
    };
    expect(Math.min(...route.slice(1).map((p, k) => away(route[k]!, p)))).toBeGreaterThanOrEqual(1.7 - 1e-6);
  });
});

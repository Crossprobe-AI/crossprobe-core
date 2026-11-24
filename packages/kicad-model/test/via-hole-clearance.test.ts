/**
 * With a fine net class (0.1 mm tracks and clearance, 0.3/0.15 mm vias), a via's ring is thinner than
 * the board's hole clearance less the copper clearance: a track can keep its copper clearance from a
 * via and still come closer to its hole than KiCad allows. The router keeps the hole clearance from
 * the vias of routes it made earlier in the run (not on the board yet), as it does from the board's
 * own: in its grid, where it places a via, and in what it checks exactly (a corner cut at 45°).
 */
import { describe, expect, it } from "vitest";
import { autorouteAll, checkClearance, parseBoard, projectDesignRules } from "../src/index.js";

const rules = projectDesignRules(
  JSON.stringify({
    board: { design_settings: { rules: { min_hole_clearance: 0.25, min_track_width: 0.1, min_via_diameter: 0.3, min_through_hole_diameter: 0.15, min_via_annular_width: 0.075 } } },
    net_settings: {
      classes: [
        { name: "Default", clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3 },
        { name: "Fine", clearance: 0.1, track_width: 0.1, via_diameter: 0.3, via_drill: 0.15 },
      ],
      netclass_patterns: [{ netclass: "Fine", pattern: "*" }],
    },
  }),
);

/** Six nets on a 10 x 10 mm board, each from a front pad to a pad on the front or the back, placed from a seed. */
function board(seed: number) {
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pad = (ref: string, at: { x: number; y: number }, layer: string, net: string) =>
    `(footprint "T:P" (layer "${layer}") (at ${at.x} ${at.y}) (property "Reference" "${ref}" (at 0 -2 0) (layer "F.SilkS") (hide yes) (effects (font (size 1 1) (thickness 0.15)))) (pad "1" smd rect (at 0 0) (size 0.3 0.3) (layers "${layer}") (net "${net}")))`;
  const parts: string[] = [];
  const connections: Array<{ from: { x: number; y: number }; to: { x: number; y: number }; net: string }> = [];
  for (let i = 0; i < 6; i++) {
    const a = { x: +(41 + rnd() * 8).toFixed(2), y: +(21 + rnd() * 8).toFixed(2) };
    const b = { x: +(41 + rnd() * 8).toFixed(2), y: +(21 + rnd() * 8).toFixed(2) };
    parts.push(pad(`A${i}`, a, "F.Cu", `N${i}`), pad(`B${i}`, b, i % 2 ? "B.Cu" : "F.Cu", `N${i}`));
    connections.push({ from: a, to: b, net: `N${i}` });
  }
  const text = `(kicad_pcb (version 20260206) (generator "test") (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user)) ${parts.join(" ")} (gr_rect (start 40 20) (end 50 30) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts")))`;
  return { board: parseBoard(text), connections };
}

describe("a fine net class's vias", () => {
  // Found by search: before the fix, a corner cut came 0.2286 mm from an earlier route's via hole.
  it("keep the hole clearance from what is routed after them", () => {
    const { board: b, connections } = board(1502789949);
    const routes = autorouteAll(b, rules, connections);
    expect(routes.filter(Boolean)).toHaveLength(6);
    const tracks = routes.flatMap((r, k) => r!.runs.flatMap((run) => run.points.slice(1).map((q, i) => ({ start: run.points[i]!, end: q, width: run.width ?? 0.1, layer: run.layer, net: connections[k]!.net, uuid: "" }))));
    const vias = routes.flatMap((r, k) => r!.vias.map((at) => ({ at, size: 0.3, drill: 0.15, net: connections[k]!.net, layers: ["F.Cu", "B.Cu"], uuid: "" })));
    expect(vias.length).toBeGreaterThan(0);
    const found = checkClearance({ ...b, tracks, vias } as unknown as typeof b, rules);
    expect(found.filter((v) => v.type === "hole")).toEqual([]);
  });
});

/**
 * Stitch to pours, for a poured net's pin on a fine-pitch connector with no pour in reach: the pin is
 * joined to the rest of its net by a route that leaves it by a neck, and the neck is written at its
 * own width, not the net's (which would cross the pin's neighbours).
 */
import { describe, expect, it } from "vitest";
import { checkClearance, parseBoard, projectDesignRules } from "@crossprobe/kicad-model";
import { Editor } from "../src/edit/ops";

const FILE = "board.kicad_pcb";
const uuid = (k: number) => `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const text = (ref: string) => `(property "Reference" "${ref}" (at 0 -3 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))`;
// Nine 0.24 mm pads at 0.5 mm pitch; the middle one is GND, whose tracks are 0.6 mm.
const pads = Array.from({ length: 9 }, (_, k) => `(pad "${k + 1}" smd rect (at ${(k - 4) * 0.5} -1.5) (size 0.24 1) (layers "F.Cu") (net "${k === 4 ? "GND" : `N${k + 1}`}"))`).join(" ");
const pad = (ref: string, x: number, k: number) => `(footprint "T:Pad" (layer "F.Cu") (uuid "${uuid(k)}") (at ${x} 18) ${text(ref)} (pad "1" smd rect (at 0 0) (size 1.5 1.5) (layers "F.Cu") (net "GND")))`;
// The pour is on the front only, so no via from the pin can land in it: the pin is routed to its pads.
const pour = "(pts (xy 22 14) (xy 38 14) (xy 38 22) (xy 22 22))";
const pcb = `(kicad_pcb (version 20260206) (generator "test") (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (footprint "T:Conn" (layer "F.Cu") (uuid "${uuid(1)}") (at 30 30) ${text("J1")} ${pads})
  ${pad("P1", 26, 2)} ${pad("P2", 34, 3)}
  (zone (net "GND") (layer "F.Cu") (uuid "${uuid(4)}") (hatch edge 0.5) (connect_pads yes (clearance 0.2)) (min_thickness 0.2) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon ${pour}) (filled_polygon (layer "F.Cu") ${pour}))
  (gr_rect (start 20 12) (end 40 38) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts")))`;
const pro = JSON.stringify({
  board: { design_settings: { rules: { min_track_width: 0.2 } } },
  net_settings: {
    classes: [
      { name: "Default", clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3 },
      { name: "Power", clearance: 0.2, track_width: 0.6, via_diameter: 0.8, via_drill: 0.4 },
    ],
    netclass_patterns: [{ netclass: "Power", pattern: "GND" }],
  },
});

describe("stitch to pours, at a fine-pitch pin", () => {
  it("writes the neck at its own width", () => {
    const changed = new Editor().apply({ [FILE]: pcb, "board.kicad_pro": pro }, [{ op: "stitchPours", file: FILE }]);
    const board = parseBoard(changed[FILE]!);
    const atPin = (p: { x: number; y: number }) => Math.hypot(p.x - 30, p.y - 28.5) < 1e-6;
    expect(board.tracks.filter((t) => atPin(t.start) || atPin(t.end)).map((t) => t.width)).toEqual([0.35]);
    expect(board.tracks.some((t) => t.width === 0.6)).toBe(true);
    expect(checkClearance(board, projectDesignRules(pro))).toEqual([]);
  });
});

/**
 * A wide net's pin on a fine-pitch connector: the net's track can't leave the pad between its
 * neighbours, so the router leaves it by a neck, at the widest width that fits, and widens once
 * clear, as KiCad's router does. KiCad's DRC accepts the result.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addTrack, autorouteAll, boardRoot, netClassOf, parseBoard, projectDesignRules } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI;
let kicad = !!KICAD_CLI;
try {
  if (KICAD_CLI) execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  kicad = false;
}

const uuid = (k: number) => `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const text = (ref: string) => `(property "Reference" "${ref}" (at 0 -3 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))`;
// Nine 0.24 mm pads at 0.5 mm pitch, 1.5 mm in front of the part's origin; the middle one is +5V.
const pads = Array.from({ length: 9 }, (_, k) => `(pad "${k + 1}" smd rect (at ${(k - 4) * 0.5} -1.5) (size 0.24 1) (layers "F.Cu") (net "${k === 4 ? "+5V" : `N${k + 1}`}"))`).join(" ");
const pcb = `(kicad_pcb (version 20260206) (generator "test") (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (footprint "T:Conn" (layer "F.Cu") (uuid "${uuid(1)}") (at 30 30) ${text("J1")} ${pads})
  (footprint "T:Pad" (layer "F.Cu") (uuid "${uuid(2)}") (at 30 20) ${text("P1")} (pad "1" smd rect (at 0 0) (size 1.5 1.5) (layers "F.Cu") (net "+5V")))
  (gr_rect (start 20 12) (end 40 38) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts")))`;
const pro = JSON.stringify({
  board: { design_settings: { rules: { min_track_width: 0.2, min_clearance: 0 } } },
  net_settings: {
    classes: [
      { name: "Default", clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3 },
      { name: "Power", clearance: 0.2, track_width: 0.6, via_diameter: 0.8, via_drill: 0.4 },
    ],
    netclass_patterns: [{ netclass: "Power", pattern: "+5V" }],
  },
});

describe("a wide net's pin on a fine-pitch connector", () => {
  it("is left by a neck, then the net's width, and KiCad's DRC accepts it", () => {
    const rules = projectDesignRules(pro);
    expect(netClassOf(rules, "+5V").trackWidth).toBe(0.6);
    const board = parseBoard(pcb);
    const [r] = autorouteAll(board, rules, [{ from: { x: 30, y: 28.5 }, to: { x: 30, y: 20 }, net: "+5V" }]);
    expect(r).toBeDefined();
    // 0.38 mm from the pad's centre to its neighbours' edges, less 0.2 mm clearance: 0.36 mm, so 0.35.
    const neck = r!.runs.filter((run) => run.width !== undefined);
    expect(neck).toEqual([{ layer: "F.Cu", points: [{ x: 30, y: 28.5 }, expect.anything()], width: 0.35 }]);
    expect(r!.runs.filter((run) => run.width === undefined).length).toBeGreaterThan(0);

    if (!kicad) return;
    const doc = parse(pcb);
    for (const run of r!.runs) for (let k = 1; k < run.points.length; k++) addTrack(boardRoot(doc), { start: run.points[k - 1]!, end: run.points[k]!, width: run.width ?? 0.6, layer: run.layer, net: "+5V" });
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-neck-"));
    writeFileSync(join(dir, "neck.kicad_pcb"), serialize(doc));
    writeFileSync(join(dir, "neck.kicad_pro"), pro);
    execFileSync(KICAD_CLI!, ["pcb", "drc", "--format", "json", "-o", join(dir, "drc.json"), join(dir, "neck.kicad_pcb")], { stdio: "ignore" });
    const drc = JSON.parse(readFileSync(join(dir, "drc.json"), "utf8")) as { violations: Array<{ type: string }>; unconnected_items: unknown[] };
    expect(drc.violations.map((v) => v.type).filter((t) => !t.startsWith("lib_footprint") && t !== "silk_over_copper" && t !== "silk_overlap")).toEqual([]);
    expect(drc.unconnected_items).toEqual([]);
  }, 60_000);
});

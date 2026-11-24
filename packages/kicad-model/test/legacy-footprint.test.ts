/**
 * Footprints saved by KiCad 5, placed on a board KiCad can load. Their arcs (centre, the point they
 * begin at, and the angle they sweep) are read as the three points KiCad gives them (the values
 * `kicad-cli pcb upgrade` writes for this file) and written in that form; fields added to one,
 * which has texts and no properties, go after its texts.
 */
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { boardRoot, parseBoard, placeFootprint } from "../src/index.js";

const oldBoard = `(kicad_pcb (version 20171130) (host pcbnew 5.1.9)
  (general (thickness 1.6))
  (layers (0 F.Cu signal) (31 B.Cu signal) (37 F.SilkS user) (44 Edge.Cuts user))
  (net 0 "")
  (gr_arc (start 50 50) (end 60 50) (angle 90) (layer Edge.Cuts) (width 0.1))
  (module Test:Arcs (layer F.Cu) (tedit 0) (tstamp 0)
    (at 0 0)
    (fp_text reference REF1 (at 0 0) (layer F.SilkS) (effects (font (size 1 1) (thickness 0.15))))
    (fp_arc (start 0 0) (end 5 0) (angle -90) (layer F.SilkS) (width 0.12))
    (fp_arc (start 1 1) (end 1 4) (angle 45) (layer F.SilkS) (width 0.12))
  )
)`;

const close = (got: Array<{ x: number; y: number }>, want: number[][]) => {
  expect(got).toHaveLength(want.length);
  got.forEach((p, i) => {
    expect(p.x).toBeCloseTo(want[i]![0]!, 5);
    expect(p.y).toBeCloseTo(want[i]![1]!, 5);
  });
};

describe("KiCad 5 arcs", () => {
  it("are read as KiCad reads them: start, mid and end, a negative sweep from its far end", () => {
    const b = parseBoard(oldBoard);
    close(b.drawings.find((d) => d.kind === "arc")!.points, [[60, 50], [57.071068, 57.071068], [50, 60]]);
    const [a, c] = b.footprints[0]!.graphics.filter((g) => g.kind === "arc");
    close(a!.points, [[0, -5], [3.535534, -3.535534], [5, 0]]);
    close(c!.points, [[1, 4], [-0.14805, 3.771639], [-1.12132, 3.12132]]);
  });

  it("are written as start, mid and end when their footprint goes on a board", () => {
    const doc = parse(`(kicad_pcb (version 20240108) (generator "test") (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user)) (net 0 ""))`);
    const mod = `(footprint "Arcs" (layer F.Cu) (fp_arc (start 1 1) (end 1 4) (angle 45) (layer F.SilkS) (width 0.12)))`;
    placeFootprint(boardRoot(doc), mod, { libId: "Test:Arcs", reference: "U1", value: "Arcs", at: { x: 10, y: 10 }, layer: "F.Cu" });
    const text = serialize(doc).replace(/\s+/g, " ");
    expect(text).toContain("(start 1 4) (mid -0.14805 3.771639) (end -1.12132 3.12132)");
    expect(text).not.toContain("angle");
    close(parseBoard(text).footprints[0]!.graphics[0]!.points, [[11, 14], [9.85195, 13.771639], [8.87868, 13.12132]]);
  });

  it("get the fields they are given after their texts, not before their name", () => {
    const doc = parse(`(kicad_pcb (version 20240108) (generator "test") (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user)) (net 0 ""))`);
    const mod = `(footprint "Module" (layer F.Cu) (attr smd) (fp_text reference "REF**" (at 0 -3) (layer F.SilkS) (effects (font (size 1 1) (thickness 0.15)))) (fp_text value "Module" (at 0 3) (layer F.Fab) (effects (font (size 1 1) (thickness 0.15)))) (pad "1" smd rect (at 0 0) (size 1 1) (layers F.Cu)))`;
    placeFootprint(boardRoot(doc), mod, { libId: "Test:Module", reference: "M1", value: "CM4", at: { x: 10, y: 10 }, layer: "F.Cu", fields: { MPN: "X-1" } });
    const fp = parseBoard(serialize(doc)).footprints[0]!;
    expect([fp.libId, fp.reference, fp.value, fp.properties?.["MPN"]]).toEqual(["Test:Module", "M1", "CM4", "X-1"]);
  });
});

/** Flipping a footprint swaps the ends of the arcs in a custom pad, as of its own arcs (KiCad's EDA_SHAPE::flip). */
import { describe, expect, it } from "vitest";
import { findChild, findChildren, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import { flipFootprint } from "../src/index.js";

const FP = `(footprint "T" (layer "F.Cu") (at 10 10)
  (fp_arc (start 0 -1) (mid 1 0) (end 0 1) (stroke (width 0.1) (type solid)) (layer "F.SilkS"))
  (pad "1" smd custom (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask")
    (primitives (gr_arc (start 0 -1) (mid 1 0) (end 0 1) (width 0.2)))))`;

describe("flipping a footprint", () => {
  it("swaps the ends of arcs, in custom pads too", () => {
    const fp = parse(FP).children[0] as List;
    flipFootprint(fp);
    const ends = (arc: List) => serialize(findChild(arc, "start")!) + serialize(findChild(arc, "end")!);
    const own = findChildren(fp, "fp_arc")[0]!;
    const pad = findChildren(findChild(findChildren(fp, "pad")[0]!, "primitives")!, "gr_arc")[0]!;
    // Mirrored in y, then swapped: start (0 -1) -> (0 1) -> end; end (0 1) -> (0 -1) -> start.
    expect(ends(own)).toBe("(start 0 -1)(end 0 1)");
    expect(ends(pad)).toBe(ends(own));
  });
});

/**
 * Duplicating items of a KiCad 6/7 board, whose items carry a `tstamp` rather than a `uuid`: each
 * copy takes the id the app asked for, so the app can select the copies.
 */
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { boardRoot, findBoardItem, pasteBoardItems } from "../src/index.js";

const BOARD = `(kicad_pcb (version 20221018) (generator pcbnew)
  (segment (start 10 10) (end 20 10) (width 0.25) (layer "F.Cu") (net 0) (tstamp 11111111-1111-1111-1111-111111111111))
  (gr_line (start 0 0) (end 5 0) (layer "Edge.Cuts") (width 0.1) (tstamp 22222222-2222-2222-2222-222222222222))
)`;

describe("duplicating KiCad 6/7 items", () => {
  it("copies take the requested ids in their tstamp", () => {
    const root = boardRoot(parse(BOARD));
    const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
    const fresh = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002"];
    pasteBoardItems(root, ids.map((u, i) => ({ text: serialize(findBoardItem(root, u)!), uuid: fresh[i]! })), 1, 1);
    for (const u of fresh) expect(findBoardItem(root, u), u).toBeDefined();
    // The originals stay as they were.
    for (const u of ids) expect(findBoardItem(root, u), u).toBeDefined();
  });
});

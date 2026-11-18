/**
 * Groups in boards from KiCad 6 and 7, which name a group by `(id …)` (KiCad 8
 * writes `(uuid …)`) and lock it with a bare `locked`: each group is found by
 * its own id, and edits keep the file in the form its KiCad reads.
 */
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addGroup, boardRoot, findBoardItem, groupItems, parseBoard, removeGroup, setGroupLocked } from "../src/index.js";

const V7 = `(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (gr_line (start 0 0) (end 10 0) (layer "Edge.Cuts") (width 0.1) (tstamp aaaaaaaa-0000-0000-0000-000000000001))
  (gr_line (start 0 5) (end 10 5) (layer "Edge.Cuts") (width 0.1) (tstamp aaaaaaaa-0000-0000-0000-000000000002))
  (gr_line (start 0 9) (end 10 9) (layer "Edge.Cuts") (width 0.1) (tstamp aaaaaaaa-0000-0000-0000-000000000003))
  (group "A" (id 11111111-0000-0000-0000-000000000001)
    (members aaaaaaaa-0000-0000-0000-000000000001))
  (group "B" (id 22222222-0000-0000-0000-000000000002)
    (members aaaaaaaa-0000-0000-0000-000000000002))
)
`;
const A = "11111111-0000-0000-0000-000000000001";
const B = "22222222-0000-0000-0000-000000000002";

describe("groups in KiCad 6 and 7 boards", () => {
  it("reads each group by its own id", () => {
    const b = parseBoard(V7);
    expect(b.groups.map((g) => [g.name, g.uuid])).toEqual([["A", A], ["B", B]]);
    expect(groupItems(b, A)).toContain("aaaaaaaa-0000-0000-0000-000000000001");
    expect(groupItems(b, A)).not.toContain("aaaaaaaa-0000-0000-0000-000000000002");
  });

  it("ungroups and locks the group asked for, and nothing else", () => {
    const doc = parse(V7);
    const root = boardRoot(doc);
    setGroupLocked(root, B, true);
    expect(removeGroup(root, A)).toBe(true);
    const text = serialize(doc);
    expect(text).not.toContain('(group "A"');
    expect(text).toMatch(/\(group "B" locked \(id 22222222/);
    // The header is untouched.
    expect(text).toContain("(version 20221018)");
    expect(parseBoard(text).groups.map((g) => [g.name, g.locked])).toEqual([["B", true]]);
  });

  it("finds no item by the empty UUID", () => {
    expect(findBoardItem(boardRoot(parse(V7)), "")).toBeUndefined();
  });

  it("writes a new group as KiCad 7 does", () => {
    const doc = parse(V7);
    const id = addGroup(boardRoot(doc), ["aaaaaaaa-0000-0000-0000-000000000003"], "C");
    const text = serialize(doc);
    expect(text).toMatch(new RegExp(`\\(group "C"\\s+\\(id "?${id}"?\\)`));
    expect(text).not.toContain("(uuid");
    expect(parseBoard(text).groups.find((g) => g.name === "C")?.uuid).toBe(id);
  });
});

/**
 * Items deleted by an edit other than Delete (here Cleanup Tracks) leave their groups, so no group
 * keeps a member that is gone, and a group left empty is removed with them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBoard } from "@crossprobe/kicad-model";
import { Editor } from "../src/edit/ops";

const FILE = "board.kicad_pcb";
const text = readFileSync(new URL("../../../blocks/library/crossprobe.kicad_blocks/rp2040-minimal.kicad_block/rp2040-minimal.kicad_pcb", import.meta.url), "utf8");

describe("groups after Cleanup Tracks", () => {
  it("drops removed members and empty groups", () => {
    const [a, b, c] = parseBoard(text).footprints.map((f) => f.uuid);
    const ed = new Editor();
    let files: Record<string, string> = { [FILE]: text };
    files = { ...files, ...ed.apply(files, [{ op: "boardGroup", file: FILE, members: [a!, b!], name: "pair", uuid: "g-pair" }, { op: "boardGroup", file: FILE, members: [c!], name: "single", uuid: "g-single" }]) };
    expect(parseBoard(files[FILE]!).groups.map((g) => g.members.length)).toEqual([2, 1]);
    files = { ...files, ...ed.apply(files, [{ op: "cleanupTracks", file: FILE, remove: [b!, c!], reshape: [] }]) };
    const groups = parseBoard(files[FILE]!).groups;
    expect(groups.map((g) => [g.name, g.members])).toEqual([["pair", [a]]]);
  });
});

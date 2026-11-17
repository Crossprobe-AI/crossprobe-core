/**
 * Groups on the board. Every edit is read back by KiCad's pcbnew: the groups
 * it finds, their names, lock and members, must be ours.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addGroup, boardRoot, groupItems, parseBoard, pruneGroups, removeGroup, setGroupLocked, topGroup, type Board } from "../src/index.js";

const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";
const DEMOS = process.env.KICAD_DEMOS!;
const BOARD = "stickhub/StickHub.kicad_pcb";
const ok = existsSync(PY) && existsSync(join(DEMOS, BOARD));

/** Groups as KiCad reads the text. */
function kicadGroups(text: string): Record<string, { name: string; locked: boolean; members: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "groups-"));
  writeFileSync(join(dir, "g.kicad_pcb"), text);
  try {
    execFileSync(PY, [join(import.meta.dirname, "pcbnew-groups.py"), join(dir, "g.kicad_pcb"), join(dir, "g.json")], { stdio: "ignore" });
  } catch {
    // pcbnew may crash on exit after writing its output.
  }
  return JSON.parse(readFileSync(join(dir, "g.json"), "utf8"));
}
// KiCad's IsLocked: locked itself, or inside a locked group.
const ours = (b: Board) => {
  const parent = new Map(b.groups.flatMap((g) => g.members.map((m) => [m, g] as const)));
  const locked = (g: Board["groups"][number]): boolean => !!g.locked || (parent.has(g.uuid) && locked(parent.get(g.uuid)!));
  return Object.fromEntries(b.groups.map((g) => [g.uuid, { name: g.name, locked: locked(g), members: [...g.members].sort() }]));
};

describe.skipIf(!ok)("groups KiCad reads back", () => {
  const text = ok ? readFileSync(join(DEMOS, BOARD), "utf8") : "";
  const board = ok ? parseBoard(text) : (undefined as unknown as Board);

  it("reads the demo's groups as KiCad does", () => {
    expect(ours(board)).toEqual(kicadGroups(text));
  });

  it("groups, nests, locks, ungroups and prunes as KiCad keeps them", () => {
    const [a, b, c] = board.footprints.slice(0, 3).map((f) => f.uuid);
    const t = board.tracks[0]!.uuid;
    const doc = parse(text);
    const root = boardRoot(doc);
    const inner = addGroup(root, [a!, b!], "pair");
    const outer = addGroup(root, [inner, c!, t], "block");
    setGroupLocked(root, outer, true);
    let after = parseBoard(serialize(doc));
    expect(ours(after)).toEqual(kicadGroups(serialize(doc)));
    expect(topGroup(after, a!)?.uuid).toBe(outer);
    expect(groupItems(after, outer).sort()).toEqual([a!, b!, c!, t].sort());

    // Grouping members of a group: the new group takes their place in it.
    const sub = addGroup(root, [c!, t], "sub");
    after = parseBoard(serialize(doc));
    expect(after.groups.find((g) => g.uuid === outer)!.members.sort()).toEqual([inner, sub].sort());
    expect(ours(after)).toEqual(kicadGroups(serialize(doc)));

    // Ungrouping the inner pair: its members join the outer group.
    removeGroup(root, inner);
    after = parseBoard(serialize(doc));
    expect(after.groups.find((g) => g.uuid === outer)!.members.sort()).toEqual([a!, b!, sub].sort());
    expect(ours(after)).toEqual(kicadGroups(serialize(doc)));

    // Deleting c and the track empties "sub", which goes; the outer group keeps a and b.
    pruneGroups(root, [c!, t]);
    after = parseBoard(serialize(doc));
    expect(after.groups.some((g) => g.uuid === sub)).toBe(false);
    expect(after.groups.find((g) => g.uuid === outer)!.members.sort()).toEqual([a!, b!].sort());
    expect(ours(after)).toEqual(kicadGroups(serialize(doc)));
  });
});

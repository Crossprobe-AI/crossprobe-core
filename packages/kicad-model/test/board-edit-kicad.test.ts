/**
 * Board edits KiCad must read back: locking (KiCad's (locked yes)) and
 * duplicating footprints and tracks (fresh UUIDs, the next free reference,
 * nets kept). kicad-cli loads the edited board and lists the copy.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { boardRoot, findBoardItem, parseBoard, pasteBoardItems, plotGerber, setLocked, setPadNet, setPadProps } from "../src/index.js";
import { area, readGerber, xor } from "./gerber-read.js";

const DEMO = `${process.env.KICAD_DEMOS}/pic_programmer`;
const KICAD_CLI = process.env.KICAD_CLI!;
let ok = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  ok = false;
}

describe.skipIf(!ok)("board edits KiCad reads", () => {
  it("locks, duplicates and edits pads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-edit-"));
    for (const ext of [".kicad_pro", ".kicad_sch"]) copyFileSync(join(DEMO, `pic_programmer${ext}`), join(dir, `pic_programmer${ext}`));
    const doc = parse(readFileSync(join(DEMO, "pic_programmer.kicad_pcb"), "utf8"));
    const root = boardRoot(doc);
    const before = parseBoard(serialize(doc));
    const r10 = before.footprints.find((f) => f.reference === "R10")!;
    const [t1, t2] = before.tracks.filter((t) => t.net);
    setLocked(findBoardItem(root, r10.uuid)!, true);
    setLocked(findBoardItem(root, t1!.uuid)!, true);
    pasteBoardItems(root, [r10.uuid, t1!.uuid, t2!.uuid].map((u, i) => ({ text: serialize(findBoardItem(root, u)!), uuid: `00000000-0000-4000-8000-00000000000${i}` })), 5, 5);
    const after = parseBoard(serialize(doc));
    expect(after.footprints.find((f) => f.uuid === r10.uuid)!.locked).toBe(true);
    expect(after.tracks.find((t) => t.uuid === t1!.uuid)!.locked).toBe(true);
    const copy = after.footprints.find((f) => f.uuid === "00000000-0000-4000-8000-000000000000")!;
    expect(copy.reference).not.toBe("R10");
    expect(copy.reference).toMatch(/^R\d+$/);
    expect(copy.locked).toBeFalsy();
    expect(copy.at.x).toBeCloseTo(r10.at.x + 5, 6);
    expect(copy.pads.map((p) => p.net)).toEqual(r10.pads.map((p) => p.net));
    expect(after.tracks.find((t) => t.uuid === "00000000-0000-4000-8000-000000000002")!.net).toBe(t2!.net);
    // UUIDs stay unique (pads and texts of the copy got new ones).
    const uuids = (serialize(doc).match(/\(uuid "([^"]+)"\)/g) ?? []);
    expect(new Set(uuids).size).toBe(uuids.length);
    // A pad edited as in KiCad's pad properties: bigger, another shape, a new drill and net.
    const u4 = after.footprints.find((f) => f.reference === "U4")!;
    const u4node = findBoardItem(root, u4.uuid)!;
    setPadProps(u4node, "1", { size: { x: 2.2, y: 2.2 }, shape: "roundrect", drill: 0.9 });
    setPadNet(root, u4node, "1", "GND");
    const edited = parseBoard(serialize(doc)).footprints.find((f) => f.reference === "U4")!.pads.find((q) => q.number === "1")!;
    expect([edited.size.x, edited.size.y, edited.shape, edited.drill, edited.net]).toEqual([2.2, 2.2, "roundrect", 0.9, "GND"]);
    const pcb = join(dir, "pic_programmer.kicad_pcb");
    writeFileSync(pcb, serialize(doc));
    // KiCad plots the edited copper as we do.
    const gbr = join(dir, "gbr");
    execFileSync(KICAD_CLI, ["pcb", "export", "gerbers", "--layers", "F.Cu", "--no-protel-ext", "-o", gbr, pcb], { stdio: "ignore" });
    const { readdirSync } = await import("node:fs");
    const theirs = readGerber(readFileSync(join(gbr, readdirSync(gbr).find((f) => f.endsWith(".gbr"))!), "utf8"));
    const ours = readGerber(plotGerber(parseBoard(serialize(doc)), "F.Cu", { name: "pic_programmer" }));
    expect(area(xor(theirs, ours)) / area(theirs)).toBeLessThan(0.01);
    const pos = join(dir, "pos.csv");
    execFileSync(KICAD_CLI, ["pcb", "export", "pos", "--format", "csv", "--units", "mm", "-o", pos, pcb], { stdio: "ignore" });
    expect(readFileSync(pos, "utf8")).toContain(`"${copy.reference}"`);
  }, 60_000);
});

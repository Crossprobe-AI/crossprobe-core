/**
 * Dimensions against KiCad: aligned and orthogonal dimensions written to a
 * new board, plotted (Dwgs.User) by kicad-cli and by us, must match: the
 * extension lines, crossbars and arrows, and the texts (in KiCad's stroke
 * font) where KiCad puts them.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ClipperLib from "clipper-lib";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addDimension, boardRoot, newProject, parseBoard, plotGerber } from "../src/index.js";
import { area, readGerber } from "./gerber-read.js";

const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
let ok = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  ok = false;
}
const S = 1e4; // gerber-read units per mm
const minus = (a: ClipperLib.Paths, b: ClipperLib.Paths) => {
  const c = new ClipperLib.Clipper();
  c.AddPaths(a, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  const o: ClipperLib.Paths = [];
  c.Execute(ClipperLib.ClipType.ctDifference, o, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return o;
};
const box = (ps: ClipperLib.Paths) => {
  const a = ps.flat();
  return { x0: Math.min(...a.map((v) => v.X)) / S, x1: Math.max(...a.map((v) => v.X)) / S, y0: -Math.max(...a.map((v) => v.Y)) / S, y1: -Math.min(...a.map((v) => v.Y)) / S };
};

describe.skipIf(!ok)("dimensions", () => {
  it("plot like KiCad's", () => {
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-dim-"));
    const { files } = newProject("dims");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const pcbName = Object.keys(files).find((f) => f.endsWith(".kicad_pcb"))!;
    const doc = parse(files[pcbName]!);
    const root = boardRoot(doc);
    const L = "Dwgs.User";
    addDimension(root, { start: { x: 100, y: 100 }, end: { x: 130, y: 100 }, height: -5, layer: L });
    addDimension(root, { start: { x: 100, y: 110 }, end: { x: 130, y: 110 }, height: 4, layer: L });
    addDimension(root, { start: { x: 100, y: 120 }, end: { x: 120, y: 135 }, height: 3, layer: L });
    addDimension(root, { start: { x: 140, y: 100 }, end: { x: 140, y: 125 }, height: 6, layer: L });
    addDimension(root, { start: { x: 150, y: 100 }, end: { x: 170, y: 115 }, height: -4, layer: L, orthogonal: true });
    addDimension(root, { start: { x: 150, y: 120 }, end: { x: 165, y: 140 }, height: 5, layer: L, orthogonal: true, vertical: true });
    const text = serialize(doc);
    writeFileSync(join(dir, pcbName), text);
    const out = join(dir, "gbr");
    execFileSync(KICAD_CLI, ["pcb", "export", "gerbers", "--layers", L, "--no-protel-ext", "-o", out, join(dir, pcbName)], { stdio: "ignore" });
    const theirs = readGerber(readFileSync(join(out, readdirSync(out).find((f) => !f.endsWith(".gbrjob"))!), "utf8"));

    const board = parseBoard(text);
    expect(board.drawings.length).toBeGreaterThan(30);
    const ours = readGerber(plotGerber(board, L, { name: "dims" }));
    expect(area(minus(ours, theirs)) + area(minus(theirs, ours))).toBeLessThan(0.01 * area(theirs));
    const lines = readGerber(plotGerber({ ...board, texts: [] }, L, { name: "dims" }));
    expect(area(minus(lines, theirs))).toBeLessThan(0.01);
    // Each text where KiCad has it.
    const theirText = minus(theirs, lines);
    for (const t of board.texts) {
      const mine = readGerber(plotGerber({ ...board, drawings: [], texts: [t] }, L, { name: "dims" }));
      const b = box(mine);
      const near = theirText.filter((q) => q.every((v) => v.X / S > b.x0 - 1 && v.X / S < b.x1 + 1 && -v.Y / S > b.y0 - 1 && -v.Y / S < b.y1 + 1));
      const k = box(near);
      for (const key of ["x0", "x1", "y0", "y1"] as const) expect(Math.abs(b[key] - k[key]), `${t.text} ${key}`).toBeLessThan(0.15);
    }
  }, 60_000);
});

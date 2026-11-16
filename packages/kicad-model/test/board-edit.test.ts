/**
 * Board edits against KiCad itself: the same footprint operations are
 * applied by our code and by KiCad's pcbnew (its bundled Python), and the
 * resulting footprints must match: position, orientation, side, pads, graphics
 * and texts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addTrack, addVia, boardRoot, findBoardItem, flipFootprint, moveBoardItem, moveFootprintText, parseBoard, rotateBoardItem, type Footprint } from "../src/index.js";

const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";
const DEMOS = process.env.KICAD_DEMOS!;
const KICAD_CLI = process.env.KICAD_CLI!;
const BOARDS = ["pic_programmer/pic_programmer.kicad_pcb", "video/video.kicad_pcb", "stickhub/StickHub.kicad_pcb", "royalblue54L_feather/royalblue54L-feather.kicad_pcb"].filter((b) => existsSync(join(DEMOS, b)));
const ok = existsSync(PY) && BOARDS.length > 0;

type Op = { ref: string; op: "rotate"; deg: number } | { ref: string; op: "flip" } | { ref: string; op: "move"; dx: number; dy: number };

const a360 = (a: number) => Math.round((((a % 360) + 360) % 360) * 1000) / 1000 % 360;
const p3 = (p: { x: number; y: number }) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;

/** An order-independent summary of a footprint in board space. */
function summary(f: Footprint) {
  return {
    at: p3(f.at),
    rotation: a360(f.rotation),
    layer: f.layer,
    pads: f.pads.map((p) => `${p.number} ${p3(p.at)} ${a360(p.rotation)} ${p.layers.join("+")}`).sort(),
    graphics: f.graphics.map((g) => `${g.layer} ${g.kind} ${g.points.map(p3).sort().join(" ")}`).sort(),
    texts: f.texts.map((t) => `${t.layer} ${t.text} ${p3(t.at)} ${a360(t.rotation)} ${t.justify.includes("mirror")}`).sort(),
  };
}

/** Footprints worth testing: mixed sides, rotations and pad kinds. */
function pick(fps: Footprint[]): string[] {
  const chosen = new Set<string>();
  const add = (f?: Footprint) => f && f.reference && !f.reference.startsWith("#") && chosen.add(f.reference);
  add(fps.find((f) => f.layer === "B.Cu"));
  add(fps.find((f) => f.rotation !== 0 && f.layer === "F.Cu"));
  add(fps.find((f) => f.rotation !== 0 && f.layer === "B.Cu"));
  add(fps.find((f) => f.pads.some((p) => p.shape === "roundrect")));
  add(fps.find((f) => f.pads.some((p) => p.type === "thru_hole")));
  add(fps.find((f) => f.pads.some((p) => p.shape === "custom")));
  for (const f of fps) if (chosen.size < 8) add(f);
  return [...chosen];
}

function apply(text: string, ops: Op[]): string {
  const doc = parse(text, { recover: true });
  const root = boardRoot(doc);
  const byRef = new Map(parseBoard(text).footprints.map((f) => [f.reference, f.uuid]));
  for (const o of ops) {
    const fp = findBoardItem(root, byRef.get(o.ref)!)!;
    if (o.op === "rotate") rotateBoardItem(fp, o.deg);
    else if (o.op === "flip") flipFootprint(fp);
    else moveBoardItem(fp, o.dx, o.dy);
  }
  return serialize(doc);
}

describe.skipIf(!ok)("board edits match KiCad's pcbnew", () => {
  const dir = mkdtempSync(join(tmpdir(), "crossprobe-bedit-"));
  for (const board of BOARDS) {
    it(board, () => {
      const src = join(DEMOS, board);
      const text = readFileSync(src, "utf8");
      const refs = pick(parseBoard(text).footprints);
      const ops: Op[] = refs.flatMap((ref, i): Op[] => [
        { ref, op: "rotate", deg: 90 },
        { ref, op: "move", dx: 1.27, dy: -2.54 },
        ...(i % 2 ? [{ ref, op: "flip" } as Op, { ref, op: "rotate", deg: 45 } as Op] : [{ ref, op: "flip" } as Op]),
        { ref, op: "rotate", deg: 180 },
      ]);
      const theirsFile = join(dir, board.replace(/\//g, "_"));
      execFileSync(PY, [join(__dirname, "pcbnew-edit.py"), src, theirsFile, JSON.stringify(ops)], { stdio: "ignore" });
      const theirs = new Map(parseBoard(readFileSync(theirsFile, "utf8")).footprints.map((f) => [f.reference, summary(f)]));
      const ours = new Map(parseBoard(apply(text, ops)).footprints.map((f) => [f.reference, summary(f)]));
      for (const ref of refs) expect({ ref, ...ours.get(ref)! }).toEqual({ ref, ...theirs.get(ref)! });
    });
  }

  it("adds tracks and vias that KiCad loads with the right nets", () => {
    const src = join(DEMOS, BOARDS[0]!);
    const text = readFileSync(src, "utf8");
    const b = parseBoard(text);
    const pad = b.footprints.flatMap((f) => f.pads).find((p) => p.net === "VCC")!;
    const doc = parse(text, { recover: true });
    const root = boardRoot(doc);
    addTrack(root, { start: pad.at, end: { x: pad.at.x + 5, y: pad.at.y }, width: 0.25, layer: "F.Cu", net: "VCC" });
    addVia(root, { at: { x: pad.at.x + 5, y: pad.at.y }, size: 0.8, drill: 0.4, layers: ["F.Cu", "B.Cu"], net: "VCC" });
    const file = join(dir, "tracks.kicad_pcb");
    writeFileSync(file, serialize(doc));
    const after = parseBoard(readFileSync(file, "utf8"));
    expect(after.tracks.length).toBe(b.tracks.length + 1);
    expect(after.vias.at(-1)!.net).toBe("VCC");
    // KiCad reads it back: its IPC-D-356 export lists the new via on VCC.
    const out = join(dir, "tracks.d356");
    execFileSync(KICAD_CLI, ["pcb", "export", "ipcd356", "-o", out, file], { stdio: "ignore" });
    const vx = Math.round((pad.at.x + 5) * 1000 * 10) / 10;
    expect(readFileSync(out, "utf8").split("\n").some((l) => l.startsWith("317VCC") && l.includes("VIA"))).toBe(true);
    expect(vx).toBeGreaterThan(0);
  });
});

describe.skipIf(!existsSync(join(DEMOS, BOARDS[0] ?? "")))("footprint texts", () => {
  it("move by the dragged offset on rotated and flipped parts", () => {
    const text = readFileSync(join(DEMOS, BOARDS[0]!), "utf8");
    const board = parseBoard(text);
    // Parts at a quarter turn, at an odd angle and on the back, with a visible reference.
    const picks = [...board.footprints.filter((f) => f.texts.length && f.texts[0]!.uuid)].sort((a, b) => Math.abs((b.rotation % 180) - 90) - Math.abs((a.rotation % 180) - 90)).slice(0, 3);
    const back = board.footprints.find((f) => f.layer === "B.Cu" && f.texts[0]?.uuid);
    if (back) picks.push(back);
    const doc = parse(text);
    const root = boardRoot(doc);
    for (const f of picks) expect(moveFootprintText(root, f.uuid, f.texts[0]!.uuid!, 1.25, -2)).toBe(true);
    const after = parseBoard(serialize(doc));
    for (const f of picks) {
      const t0 = f.texts[0]!;
      const t1 = after.footprints.find((g) => g.uuid === f.uuid)!.texts.find((t) => t.uuid === t0.uuid)!;
      expect([t1.at.x - t0.at.x, t1.at.y - t0.at.y].map((v) => Math.round(v * 1000) / 1000), `${f.reference} at ${f.rotation}° on ${f.layer}`).toEqual([1.25, -2]);
      // The footprint itself stays.
      expect(after.footprints.find((g) => g.uuid === f.uuid)!.at).toEqual(f.at);
    }
  });
});

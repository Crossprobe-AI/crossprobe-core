/**
 * Create Array. The cell offsets follow KiCad's ARRAY_OPTIONS (checked here by
 * hand); the copies are checked against KiCad's pcbnew making the same copies
 * (duplicate, move, turn about the new position): every copied footprint's
 * position, angle, side, pads, graphics and texts must match.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { arrayTransform, boardRoot, createBoardArray, parseBoard, type ArrayOptions, type Footprint } from "../src/index.js";

const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";
const DEMOS = process.env.KICAD_DEMOS!;
const BOARD = "pic_programmer/pic_programmer.kicad_pcb";
const ok = existsSync(PY) && existsSync(join(DEMOS, BOARD));

const r3 = (v: number) => Math.round(v * 1000) / 1000 + 0;
const offsets = (o: ArrayOptions, n: number) => Array.from({ length: n }, (_, i) => arrayTransform(o, i, { x: 0, y: 0 })).map((t) => [r3(t.dx), r3(t.dy)]);

describe("cell offsets", () => {
  it("grid: rows first, offsets, snake, centred", () => {
    expect(offsets({ kind: "grid", nx: 3, ny: 2, dx: 2, dy: 5 }, 6)).toEqual([[0, 0], [2, 0], [4, 0], [0, 5], [2, 5], [4, 5]]);
    expect(offsets({ kind: "grid", nx: 3, ny: 2, dx: 2, dy: 5, horizontalFirst: false }, 6)).toEqual([[0, 0], [0, 5], [2, 0], [2, 5], [4, 0], [4, 5]]);
    expect(offsets({ kind: "grid", nx: 2, ny: 2, dx: 2, dy: 5, offsetX: 1, offsetY: 0.5 }, 4)).toEqual([[0, 0], [2, 0.5], [1, 5], [3, 5.5]]);
    expect(offsets({ kind: "grid", nx: 3, ny: 2, dx: 2, dy: 5, reverseAlternate: true }, 6)).toEqual([[0, 0], [2, 0], [4, 0], [4, 5], [2, 5], [0, 5]]);
    expect(offsets({ kind: "grid", nx: 3, ny: 3, dx: 2, dy: 2, centred: true }, 1)).toEqual([[-2, -2]]);
  });
  it("grid: staggered rows", () => {
    expect(offsets({ kind: "grid", nx: 2, ny: 3, dx: 4, dy: 3, stagger: 2 }, 6)).toEqual([[0, 0], [4, 0], [2, 3], [6, 3], [0, 6], [4, 6]]);
  });
  it("circle: full turn, clockwise, a set angle", () => {
    const c = { kind: "circular", count: 4, center: { x: 10, y: 0 }, angle: 0 } as const;
    // Counter-clockwise on screen (y down): from the left of the centre, down then right.
    expect(offsets(c, 4)).toEqual([[0, 0], [10, 10], [20, 0], [10, -10]]);
    expect(offsets({ ...c, clockwise: true }, 2)).toEqual([[0, 0], [10, -10]]);
    expect(offsets({ ...c, angle: 30 }, 2)).toEqual([[0, 0], [r3(10 - 10 * Math.cos(Math.PI / 6)), 5]]);
  });
});

describe.skipIf(!ok)("copies as KiCad's pcbnew makes them", () => {
  const text = ok ? readFileSync(join(DEMOS, BOARD), "utf8") : "";
  const summary = (f: Footprint) => ({
    at: [r3(f.at.x), r3(f.at.y)],
    rotation: r3(((f.rotation % 360) + 360) % 360) % 360,
    layer: f.layer,
    pads: f.pads.map((p) => `${p.number} ${r3(p.at.x)},${r3(p.at.y)} ${r3(((p.rotation % 360) + 360) % 360) % 360} ${p.net}`).sort(),
    graphics: f.graphics.map((g) => `${g.layer} ${g.kind} ${g.points.map((p) => `${r3(p.x)},${r3(p.y)}`).sort().join(" ")}`).sort(),
    texts: f.texts.map((t) => `${t.layer} ${t.text.replace(/\d+$/, "#")} ${r3(t.at.x)},${r3(t.at.y)} ${r3(((t.rotation % 360) + 360) % 360) % 360}`).sort(),
  });
  const cases: Array<[string, ArrayOptions]> = [
    ["grid", { kind: "grid", nx: 3, ny: 2, dx: 7.5, dy: -4, offsetX: 1.27, stagger: 2 }],
    ["circle", { kind: "circular", count: 5, center: { x: 140, y: 100 }, angle: 0, offset: 10, rotateItems: true }],
  ];
  it.each(cases)("%s", (_name, o) => {
    const board = parseBoard(text);
    // A part on the back, one at an angle, and a plain one.
    const picks = [board.footprints.find((f) => f.layer === "B.Cu"), board.footprints.find((f) => f.rotation % 90 !== 0) ?? board.footprints.find((f) => f.rotation !== 0), board.footprints.find((f) => f.reference === "R1")].filter((f): f is Footprint => !!f);
    const doc = parse(text);
    const fresh = createBoardArray(boardRoot(doc), picks.map((f) => f.uuid), o);
    const after = parseBoard(serialize(doc));
    const made = after.footprints.filter((f) => fresh.includes(f.uuid));
    expect(made.length).toBe(picks.length * ((o.kind === "grid" ? o.nx * o.ny : o.count) - 1));
    // References: unique across the board.
    expect(new Set(after.footprints.map((f) => f.reference)).size).toBe(after.footprints.length);
    // The same copies by pcbnew: each from its source, by the same cell transform.
    const cellOf = new Map<string, number>();
    {
      // Copies are inserted cell by cell, in selection order.
      let i = 0;
      for (let cell = 1; cell < (o.kind === "grid" ? o.nx * o.ny : o.count); cell++) for (const _p of picks) cellOf.set(fresh[i++]!, cell);
    }
    const copies = made.map((f) => {
      const src = picks[fresh.indexOf(f.uuid) % picks.length]!;
      const t = arrayTransform(o, cellOf.get(f.uuid)!, src.at);
      return { ref: src.reference, newref: f.reference, dx: t.dx, dy: t.dy, rot: t.rotation };
    });
    const out = join(mkdtempSync(join(tmpdir(), "array-")), "theirs.kicad_pcb");
    try {
      execFileSync(PY, [join(import.meta.dirname, "pcbnew-array.py"), join(DEMOS, BOARD), out, JSON.stringify(copies)], { stdio: "ignore" });
    } catch {
      // pcbnew may crash on exit after saving.
    }
    const theirs = new Map(parseBoard(readFileSync(out, "utf8")).footprints.map((f) => [f.reference, summary(f)]));
    for (const f of made) expect({ ref: f.reference, ...summary(f) }).toEqual({ ref: f.reference, ...theirs.get(f.reference)! });
  });
});

describe.skipIf(!existsSync(join(DEMOS, BOARD)))("references and arranging", () => {
  const text = existsSync(join(DEMOS, BOARD)) ? readFileSync(join(DEMOS, BOARD), "utf8") : "";
  const run = (refs: string[], o: ArrayOptions, opts: { reannotate?: boolean; arrange?: boolean }) => {
    const board = parseBoard(text);
    const uuids = refs.map((r) => board.footprints.find((f) => f.reference === r)!.uuid);
    const doc = parse(text);
    const fresh = createBoardArray(boardRoot(doc), uuids, o, opts);
    const after = parseBoard(serialize(doc));
    return { after, made: fresh.map((u) => after.footprints.find((f) => f.uuid === u)!), uuids };
  };
  const grid: ArrayOptions = { kind: "grid", nx: 3, ny: 1, dx: 5, dy: 0 };
  it("copies take the next free reference after their own, cell by cell (R1–R21 are taken)", () => {
    expect(run(["R1", "R2"], grid, {}).made.map((f) => f.reference)).toEqual(["R22", "R23", "R24", "R25"]);
  });
  it("or keep their references", () => {
    expect(run(["R1", "R2"], grid, { reannotate: false }).made.map((f) => f.reference)).toEqual(["R1", "R2", "R1", "R2"]);
  });
  it("arrange lays the selection itself out, one item per cell from the first", () => {
    const { after, made, uuids } = run(["R1", "R2", "R3"], grid, { arrange: true });
    expect(made).toEqual([]);
    const at = uuids.map((u) => after.footprints.find((f) => f.uuid === u)!.at);
    expect(at.map((p) => [r3(p.x - at[0]!.x), r3(p.y - at[0]!.y)])).toEqual([[0, 0], [5, 0], [10, 0]]);
  });
});

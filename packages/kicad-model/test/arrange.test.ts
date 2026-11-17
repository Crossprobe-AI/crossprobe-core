/**
 * Align and distribute. Boxes are compared with KiCad's own (pcbnew's
 * GetBoundingBox, through its bundled Python) on the demo boards: footprints,
 * vias, zones and stroke-font texts to the nanometre, tracks and graphics
 * within 0.1 µm (KiCad's arcs have integer centres). The moves follow from
 * the boxes as in KiCad's Align/Distribute tool.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alignMoves, boardItemBox, distributeMoves, parseBoard, type ArrangeItem } from "../src/index.js";

const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";
const DEMOS = process.env.KICAD_DEMOS!;
const BOARDS = ["video/video.kicad_pcb", "stickhub/StickHub.kicad_pcb", "openair-max/One-Air-Max.kicad_pcb", "tiny_tapeout/tinytapeout-demo.kicad_pcb", "vme-wren/vme-wren.kicad_pcb", "jetson-agx-thor-baseboard/jetson-agx-thor-baseboard.kicad_pcb"].filter((b) => existsSync(join(DEMOS, b)));

const box = (uuid: string, x0: number, y0: number, x1: number, y1: number, locked?: boolean): ArrangeItem => ({ uuid, box: { x0, y0, x1, y1 }, locked });
const moves = (m: Array<{ uuid: string; dx: number; dy: number }>) => Object.fromEntries(m.map((x) => [x.uuid, [+x.dx.toFixed(6), +x.dy.toFixed(6)]]));

describe("align", () => {
  const items = [box("a", 0, 0, 2, 1), box("b", 5, 3, 6, 5), box("c", 1, -2, 4, 0)];
  it("to the extreme item", () => {
    expect(moves(alignMoves(items, "left"))).toEqual({ b: [-5, 0], c: [-1, 0] });
    expect(moves(alignMoves(items, "right"))).toEqual({ a: [4, 0], c: [2, 0] });
    expect(moves(alignMoves(items, "top"))).toEqual({ a: [0, -2], b: [0, -5] });
    expect(moves(alignMoves(items, "bottom"))).toEqual({ a: [0, 4], c: [0, 5] });
    // Centres: the leftmost / topmost centre.
    expect(moves(alignMoves(items, "centerX"))).toEqual({ b: [-4.5, 0], c: [-1.5, 0] });
  });
  it("to the item under the cursor", () => {
    expect(moves(alignMoves(items, "left", { x: 5.5, y: 4 }))).toEqual({ a: [5, 0], c: [4, 0] });
  });
  it("to a locked item, which stays", () => {
    const m = moves(alignMoves([...items, box("L", 3, 9, 4, 10, true)], "left"));
    expect(m).toEqual({ a: [3, 0], b: [-2, 0], c: [2, 0] });
  });
});

describe("distribute", () => {
  const items = [box("a", 0, 0, 1, 1), box("b", 2, 0, 5, 1), box("c", 6, 0, 7, 1), box("d", 10, 0, 12, 1)];
  it("by centres", () => {
    // Centres 0.5, 3.5, 6.5, 11 → 0.5, 4, 7.5, 11.
    expect(moves(distributeMoves(items, "centersX"))).toEqual({ b: [0.5, 0], c: [1, 0] });
  });
  it("by gaps", () => {
    // Between a and d: 9 mm, of which b and c take 4: three gaps of 5/3.
    expect(moves(distributeMoves(items, "gapsX"))).toEqual({ b: [0.666667, 0], c: [1.333333, 0] });
  });
  it("needs three unlocked items", () => {
    expect(distributeMoves(items.slice(0, 2), "gapsX")).toEqual([]);
    expect(distributeMoves([...items.slice(0, 2), { ...items[2]!, locked: true }], "gapsX")).toEqual([]);
  });
});

describe.skipIf(!existsSync(PY) || !BOARDS.length)("boxes as KiCad's", () => {
  it.each(BOARDS)("%s", (rel) => {
    const out = join(mkdtempSync(join(tmpdir(), "bbox-")), "box.json");
    try {
      execFileSync(PY, [join(import.meta.dirname, "pcbnew-bbox.py"), join(DEMOS, rel), out], { stdio: "ignore" });
    } catch {
      // pcbnew may crash on exit after writing its output.
    }
    const kicad = JSON.parse(readFileSync(out, "utf8")) as Record<string, Record<string, [number, number, number, number]>>;
    const board = parseBoard(readFileSync(join(DEMOS, rel), "utf8"));
    for (const [kind, items] of Object.entries(kicad)) {
      // KiCad's arcs have integer centres: within 0.1 µm. Everything else to the nanometre.
      const tol = kind === "tracks" || kind === "drawings" ? 100 : 2;
      for (const [uuid, k] of Object.entries(items)) {
        // TrueType text is measured by KiCad with the font's metrics; ours by its glyph outlines.
        if (kind === "texts" && board.texts.find((t) => t.uuid === uuid)?.outline) continue;
        const b = boardItemBox(board, uuid);
        if (!b) continue;
        const d = Math.max(...[b.x0, b.y0, b.x1, b.y1].map((v, i) => Math.abs(v * 1e6 - k[i]!)));
        expect(d, `${kind} ${uuid}`).toBeLessThanOrEqual(tol);
      }
    }
  });
});

/**
 * Turning dimensions, against KiCad's pcbnew (PCB_DIM_ORTHOGONAL::Rotate): every dimension of
 * jetson-agx-thor-baseboard (orthogonal) and tiny_tapeout (aligned) turned by 90°, -90°, 180°, 30° and 120° about a point,
 * by us and by pcbnew, then read by pcbnew: the same ends, height, orientation and text angle.
 * Env: KICAD_DEMOS, KICAD_PYTHON.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChildren, headOf, parse, serialize } from "@crossprobe/kicad-sexpr";
import { boardRoot, rotateBoardItem } from "../src/index.js";

const DEMOS = process.env.KICAD_DEMOS!;
const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";
const BOARDS = ["jetson-agx-thor-baseboard/jetson-agx-thor-baseboard.kicad_pcb", "tiny_tapeout/tinytapeout-demo.kicad_pcb"].map((b) => join(DEMOS ?? "", b)).filter((b) => existsSync(b));
const CENTRE = { x: 150, y: 100 };

type Dim = { start: number[]; end: number[]; textAngle: number; height?: number; vertical?: boolean };
const read = (pcb: string, out: string, args: string[] = []): Record<string, Dim> => {
  try {
    execFileSync(PY, [join(import.meta.dirname, "pcbnew-dims.py"), pcb, out, ...args], { stdio: "ignore" });
  } catch {
    // pcbnew may crash on exit after writing its output.
  }
  return JSON.parse(readFileSync(out, "utf8"));
};

describe.skipIf(!BOARDS.length || !existsSync(PY))("dimensions turn as in KiCad", () => {
  for (const PCB of BOARDS)
  for (const deg of [90, -90, 180, 30, 120])
    it(`${PCB.split("/").pop()} ${deg}°`, () => {
      const text = readFileSync(PCB, "utf8");
      const dir = mkdtempSync(join(tmpdir(), "crossprobe-dims-"));
      const doc = parse(text);
      const root = boardRoot(doc);
      const dims = findChildren(root, "dimension");
      expect(dims.length).toBeGreaterThan(0);
      for (const d of dims) rotateBoardItem(d, deg, CENTRE);
      writeFileSync(join(dir, "ours.kicad_pcb"), serialize(doc));
      writeFileSync(join(dir, "orig.kicad_pcb"), text);
      const ours = read(join(dir, "ours.kicad_pcb"), join(dir, "ours.json"));
      const theirs = read(join(dir, "orig.kicad_pcb"), join(dir, "theirs.json"), [String(deg), String(CENTRE.x), String(CENTRE.y)]);
      expect(Object.keys(ours).sort()).toEqual(Object.keys(theirs).sort());
      expect(dims.every((d) => headOf(d) === "dimension")).toBe(true);
      for (const [uuid, t] of Object.entries(theirs)) {
        const o = ours[uuid]!;
        const at = `${uuid} at ${deg}°`;
        for (const k of [0, 1]) {
          expect(o.start[k], at).toBeCloseTo(t.start[k]!, 5);
          expect(o.end[k], at).toBeCloseTo(t.end[k]!, 5);
        }
        expect(o.vertical, at).toBe(t.vertical);
        if (t.height !== undefined) expect(o.height!, at).toBeCloseTo(t.height, 5);
        expect(((o.textAngle - t.textAngle) % 360 + 360) % 360, at).toBeCloseTo(0, 3);
      }
    });
});

/**
 * Logos against KiCad: trace a bitmap with holes into a logo footprint, place
 * it on a new board, and kicad-cli's own silkscreen plot must cover exactly
 * the inked pixels (the holes stay open in KiCad's reading of our polygons).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { bitmapToPolygons, boardRoot, logoFootprint, newProject, placeFootprint } from "../src/index.js";
import { area, readGerber } from "./gerber-read.js";

const KICAD_CLI = process.env.KICAD_CLI!;
let ok = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  ok = false;
}

describe.skipIf(!ok)("logos", () => {
  it("traces a bitmap KiCad plots pixel for pixel", () => {
    // A ring with a bar across its hole, and a separate dot: outlines, holes and islands.
    const w = 120, h = 80;
    const ink = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x - 40, y - 40);
        const ring = r < 35 && r > 20;
        const bar = Math.abs(y - 40) < 4 && x > 15 && x < 65;
        const dot = Math.hypot(x - 100, y - 20) < 10;
        ink[y * w + x] = ring || bar || dot ? 1 : 0;
      }
    const pixel = 0.1;
    const polys = bitmapToPolygons(ink, w, h, pixel);
    expect(polys.length).toBeGreaterThanOrEqual(2);
    const inked = ink.reduce((n, v) => n + v, 0) * pixel * pixel;

    const dir = mkdtempSync(join(tmpdir(), "crossprobe-logo-"));
    const { files } = newProject("logo");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const pcbName = Object.keys(files).find((f) => f.endsWith(".kicad_pcb"))!;
    const doc = parse(files[pcbName]!);
    placeFootprint(boardRoot(doc), logoFootprint(polys, { name: "Logo", layer: "F.SilkS" }), { at: { x: 100, y: 100 }, reference: "LOGO1", value: "Logo", libId: "Logo:Logo", boardOnly: true });
    writeFileSync(join(dir, pcbName), serialize(doc));
    const out = join(dir, "gbr");
    execFileSync(KICAD_CLI, ["pcb", "export", "gerbers", "--layers", "F.SilkS", "-o", out, join(dir, pcbName)], { stdio: "ignore" });
    const gbr = readdirSync(out).find((f) => /Silk/i.test(f) && !f.endsWith(".gbrjob"))!;
    const plotted = area(readGerber(readFileSync(join(out, gbr), "utf8")));
    expect(Math.abs(plotted - inked) / inked).toBeLessThan(0.005);
  }, 60_000);
});

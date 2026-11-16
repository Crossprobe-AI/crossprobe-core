/**
 * Copper layer count, against KiCad: a new two-layer board made four-layer exports Gerbers for
 * In1/In2, a board with a stackup goes 4 → 6 → 4 and KiCad still reads it (same thickness),
 * and going down is refused while a track sits on a layer that would go.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addTrack, boardRoot, newProject, parseBoard, setCopperLayerCount, setStackup, STACKUPS } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}
const TT = "/Library/Application Support/kicad/demos/tiny_tapeout/tinytapeout-demo.kicad_pcb";

describe("copper layer count", () => {
  it("a new board becomes four-layer, and KiCad plots the inner layers", () => {
    const { files } = newProject("four");
    const name = Object.keys(files).find((f) => f.endsWith(".kicad_pcb"))!;
    const doc = parse(files[name]!);
    expect(setCopperLayerCount(boardRoot(doc), 4)).toBeUndefined();
    addTrack(boardRoot(doc), { start: { x: 10, y: 10 }, end: { x: 20, y: 10 }, width: 0.25, layer: "In1.Cu", net: "" });
    const text = serialize(doc);
    expect(parseBoard(text).copperLayers).toEqual(["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]);
    // Going back to two layers is refused while In1.Cu has a track.
    expect(setCopperLayerCount(boardRoot(parse(text)), 2)).toMatch(/In1\.Cu still has copper/);
    if (!cli) return;
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-layers-"));
    writeFileSync(join(dir, name), text);
    execFileSync(KICAD_CLI, ["pcb", "export", "gerbers", "-l", "F.Cu,In1.Cu,In2.Cu,B.Cu", "-o", dir + "/", join(dir, name)], { stdio: "ignore" });
    const gerbers = readdirSync(dir).filter((f) => /\.g/i.test(f));
    expect(gerbers.some((f) => /In1_Cu/.test(f)) && gerbers.some((f) => /In2_Cu/.test(f))).toBe(true);
  });

  it.skipIf(!existsSync(TT) || !cli)("a board with a stackup goes to six layers and back, KiCad reading the same thickness", () => {
    const doc = parse(readFileSync(TT, "utf8"));
    expect(setCopperLayerCount(boardRoot(doc), 6)).toBeUndefined();
    const six = serialize(doc);
    expect(parseBoard(six).copperLayers).toEqual(["F.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu", "B.Cu"]);
    const stack = (t: string) => (t.match(/\(layer "dielectric \d+"/g) ?? []).length;
    expect(stack(six)).toBe(5);
    expect(setCopperLayerCount(boardRoot(doc), 4)).toBeUndefined();
    const four = serialize(doc);
    expect(stack(four)).toBe(3);
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-layers-"));
    for (const [n, t] of [["six", six], ["four", four]] as const) {
      writeFileSync(join(dir, `${n}.kicad_pcb`), t);
      const out = join(dir, `${n}.json`);
      execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", out, join(dir, `${n}.kicad_pcb`)], { stdio: "ignore" });
      expect(JSON.parse(readFileSync(out, "utf8")).violations.some((v: { type: string }) => v.type === "invalid_outline")).toBe(false);
      // The stackup still adds up to the board thickness.
      const st = t.slice(t.indexOf("(stackup"), t.indexOf("(copper_finish"));
      const thick = [...st.matchAll(/\(layer "(?:[FB]\.Mask|[FB]\.Cu|In\d+\.Cu|dielectric \d+)"[\s\S]*?\(thickness ([\d.]+)\)/g)].reduce((a, m) => a + Number(m[1]), 0);
      const board = parseBoard(t).thickness ?? 1.6;
      expect(Math.abs(thick - board), `${n}: ${thick} of ${board}`).toBeLessThan(0.002);
    }
  });
});

describe.skipIf(!cli)("fab stackups", () => {
  it("JLC04161H-7628 on a new four-layer board, as KiCad's Gerber job file reports it", () => {
    const { files } = newProject("jlc");
    const name = Object.keys(files).find((f) => f.endsWith(".kicad_pcb"))!;
    const doc = parse(files[name]!);
    expect(setCopperLayerCount(boardRoot(doc), 4)).toBeUndefined();
    expect(setStackup(boardRoot(doc), STACKUPS["JLC04161H-7628"]!)).toBeUndefined();
    const text = serialize(doc);
    expect(parseBoard(text).copperThickness).toEqual({ "F.Cu": 0.035, "In1.Cu": 0.0152, "In2.Cu": 0.0152, "B.Cu": 0.035 });
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-stackup-"));
    writeFileSync(join(dir, name), text);
    execFileSync(KICAD_CLI, ["pcb", "export", "gerbers", "-l", "F.Cu", "-o", dir + "/", join(dir, name)], { stdio: "ignore" });
    const job = readdirSync(dir).find((f) => f.endsWith(".gbrjob"));
    expect(job).toBeDefined();
    const j = JSON.parse(readFileSync(join(dir, job!), "utf8"));
    expect(j.GeneralSpecs.BoardThickness).toBeCloseTo(1.6062, 3);
    const stack = j.MaterialStackup.map((m: { Type: string; Thickness?: number }) => `${m.Type} ${m.Thickness ?? ""}`);
    expect(stack).toEqual(expect.arrayContaining(["Copper 0.0152", "Dielectric 1.065", "Dielectric 0.2104"]));
  });
});

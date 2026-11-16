/**
 * Scaled STEP models (scaleStep), read back by OpenCascade (occt-import-js): KiCad's SOT-23 and
 * KCSC02-106 models scaled unevenly keep their solids, with the volume times the three factors and
 * the box scaled axis by axis. On a board (cm5_minima's three SOT-23s at 0.6 × 0.5 × 0.6), the
 * three placed parts have the volume and box of `kicad-cli pcb export step`'s.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import occtimportjs from "occt-import-js";
import { parseBoard, scaleStep, stepAssembly } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const MODELS = process.env.KICAD_3DMODELS!;
let ok = existsSync(MODELS);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  ok = false;
}

async function measure(text: string) {
  const occt = await occtimportjs();
  const r = occt.ReadStepFile(Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff), null);
  let volume = 0;
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const m of r.meshes) {
    const p = m.attributes.position.array, x = m.index.array;
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) (box[k] = Math.min(box[k]!, p[i + k]!)), (box[k + 3] = Math.max(box[k + 3]!, p[i + k]!));
    for (let i = 0; i < x.length; i += 3) {
      const a = x[i]! * 3, b = x[i + 1]! * 3, c = x[i + 2]! * 3;
      volume += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
    }
  }
  return { meshes: r.meshes.length, volume, box };
}

describe.skipIf(!ok)("scaled STEP models", () => {
  it.each([
    ["Package_TO_SOT_SMD.3dshapes/SOT-23.step", [0.6, 0.5, 0.6]],
    ["Display_7Segment.3dshapes/KCSC02-106.step", [1.1, 1, 1]],
    ["Package_TO_SOT_SMD.3dshapes/SOT-23.step", [2, 2, 2]],
  ] as const)("%s × %j", { timeout: 60_000 }, async (file, s) => {
    const text = readFileSync(join(MODELS, file), "latin1");
    const scaled = scaleStep(text, [...s]);
    expect(scaled).toBeDefined();
    const a = await measure(text), b = await measure(scaled!);
    expect(b.meshes).toBe(a.meshes);
    // Tessellation differs a little between the two; the volume within 0.5%.
    expect(Math.abs(b.volume / (a.volume * s[0] * s[1] * s[2]) - 1)).toBeLessThan(5e-3);
    for (let k = 0; k < 6; k++) expect(Math.abs(b.box[k]! - a.box[k]! * s[k % 3]!), `box ${k}`).toBeLessThan(0.01);
  });

  it("cm5_minima's scaled SOT-23s are placed as KiCad places them", { timeout: 300_000 }, async () => {
    // A board with just those three parts (the rest of cm5_minima's models would only slow kicad-cli down).
    const src = `${process.env.KICAD_DEMOS}/cm5_minima/CM5_MINIMA_3.kicad_pcb`;
    const board0 = parseBoard(readFileSync(src, "utf8"), { recover: true });
    const keep = new Set(["D101", "D701", "D502"]);
    const dir = mkdtempSync(join(tmpdir(), "step-scale-"));
    const pcb = join(dir, "b.kicad_pcb");
    // Every other footprint's models hidden, and no board body, so both exports hold just the three SOT-23s.
    let text = readFileSync(src, "utf8").replace(/\$\{KICAD8_3DMODEL_DIR\}/g, "${KICAD10_3DMODEL_DIR}");
    for (const fp of board0.footprints)
      if (!keep.has(fp.reference)) for (const m of fp.models) text = text.split(`(model "${m.path}"`).join(`(model "${m.path}"\n(hide yes)`);
    writeFileSync(pcb, text);
    const board = parseBoard(text, { recover: true });
    spawnSync(KICAD_CLI, ["pcb", "export", "step", "--no-board-body", "-f", "-o", join(dir, "k.step"), pcb], { stdio: "ignore" });
    const models = new Map<string, string>();
    for (const fp of board.footprints) for (const m of fp.models) if (!m.hidden && /\.step$/.test(m.path)) models.set(m.path, readFileSync(m.path.replace("${KICAD10_3DMODEL_DIR}", MODELS), "latin1"));
    const asm = stepAssembly("b", board, models, { body: false });
    expect(asm.placed.sort()).toEqual(["D101", "D502", "D701"]);
    const k = await measure(readFileSync(join(dir, "k.step"), "latin1"));
    const o = await measure(asm.text);
    expect(Math.abs(o.volume - k.volume) / k.volume).toBeLessThan(1e-3);
    o.box.forEach((v, i) => expect(Math.abs(v - k.box[i]!), `box ${i}`).toBeLessThan(0.02));
  });
});

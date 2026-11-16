/**
 * STEP export against KiCad's, both read back by OpenCascade (occt-import-js): on two demo
 * boards the board body alone, and the assembly with every part's STEP model placed, have the
 * volume (within 0.1%: our holes and arcs are polygons) and the bounding box (to 0.02 mm) of
 * `kicad-cli pcb export step`. kicad-cli resolves only ${KICAD10_3DMODEL_DIR} and won't fall back
 * from a missing .wrl, so it gets a copy of the project naming the STEP files we use.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import occtimportjs from "occt-import-js";
import { boardBodySolid, parseBoard, stepAssembly, stepFile } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
const DEMOS = "/Library/Application Support/kicad/demos";
const MODELS = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/3dmodels";
let ok = existsSync(DEMOS) && existsSync(MODELS);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  ok = false;
}

async function measure(text: Uint8Array) {
  const occt = await occtimportjs();
  const r = occt.ReadStepFile(text, null);
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
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

describe.skipIf(!ok)("STEP export matches KiCad's", () => {
  it.each(["pic_programmer/pic_programmer.kicad_pcb", "stickhub/StickHub.kicad_pcb"])("%s", { timeout: 180_000 }, async (file) => {
    const dir = mkdtempSync(join(tmpdir(), "step-"));
    cpSync(dirname(join(DEMOS, file)), dir, { recursive: true });
    const pcb = join(dir, basename(file));
    const text = readFileSync(pcb, "utf8")
      .replace(/\$\{(KICAD\d*_3DMODEL_DIR|KISYS3DMOD)\}/g, "${KICAD10_3DMODEL_DIR}")
      .replace(/(\(model "\$\{KICAD10_3DMODEL_DIR\}[^"]*)\.wrl"/g, '$1.step"');
    writeFileSync(pcb, text);
    const board = parseBoard(text, { recover: true });
    const name = basename(file, ".kicad_pcb");

    // The body alone.
    spawnSync(KICAD_CLI, ["pcb", "export", "step", "--board-only", "-f", "-o", join(dir, "k-body.step"), pcb], { stdio: "ignore" });
    const kBody = await measure(readFileSync(join(dir, "k-body.step")));
    const oBody = await measure(latin1(stepFile(name, [boardBodySolid(board)!])));
    expect(Math.abs(oBody.volume - kBody.volume) / kBody.volume).toBeLessThan(1e-3);
    oBody.box.forEach((v, i) => expect(Math.abs(v - kBody.box[i]!), `body box ${i}`).toBeLessThan(0.02));

    // With the parts.
    spawnSync(KICAD_CLI, ["pcb", "export", "step", "--subst-models", "-f", "-o", join(dir, "k.step"), pcb], { stdio: "ignore" });
    const models = new Map<string, string>();
    for (const fp of board.footprints)
      for (const m of fp.models) {
        const f = m.path.replace("${KICAD10_3DMODEL_DIR}", MODELS).replace("${KIPRJMOD}", dir);
        if (/\.(step|stp)$/i.test(f) && existsSync(f)) models.set(m.path, readFileSync(f, "latin1"));
      }
    const asm = stepAssembly(name, board, models);
    expect(asm.placed.length).toBeGreaterThan(40);
    const k = await measure(readFileSync(join(dir, "k.step")));
    const o = await measure(latin1(asm.text));
    expect(Math.abs(o.volume - k.volume) / k.volume).toBeLessThan(1e-3);
    o.box.forEach((v, i) => expect(Math.abs(v - k.box[i]!), `box ${i}`).toBeLessThan(0.02));
  });
});

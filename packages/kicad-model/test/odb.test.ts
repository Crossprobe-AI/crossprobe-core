/**
 * ODB++ against `kicad-cli pcb export odb`, compared by what CAM tools read (test/odb-compare.py):
 * the signal and drill layers, every copper layer's pads (positions) and line, arc and surface
 * counts, the drill holes (KiCad leaves slots out; we keep them), components, each net's pins
 * and the profile.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { odbFiles, parseBoard } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMOS = process.env.KICAD_DEMOS!;
let ok = existsSync(DEMOS);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
  execFileSync("python3", ["--version"], { stdio: "ignore" });
} catch {
  ok = false;
}
const BOARDS = ["pic_programmer/pic_programmer.kicad_pcb", "stickhub/StickHub.kicad_pcb", "tiny_tapeout/tinytapeout-demo.kicad_pcb", "cm5_minima/CM5_MINIMA_3.kicad_pcb", "video/video.kicad_pcb"];

describe.skipIf(!ok)("ODB++ matches kicad-cli", () => {
  const dir = mkdtempSync(join(tmpdir(), "odb-"));
  it.each(BOARDS)("%s", { timeout: 120_000 }, (file) => {
    const pcb = join(DEMOS, file);
    const name = basename(file, ".kicad_pcb");
    const k = join(dir, `${name}-k`), o = join(dir, `${name}-o`);
    execFileSync(KICAD_CLI, ["pcb", "export", "odb", "--compression", "none", "-o", k, pcb], { stdio: "ignore" });
    for (const [p, text] of Object.entries(odbFiles(parseBoard(readFileSync(pcb, "utf8"), { recover: true })))) {
      mkdirSync(dirname(join(o, p)), { recursive: true });
      writeFileSync(join(o, p), text);
    }
    const r = JSON.parse(execFileSync("python3", [join(import.meta.dirname, "odb-compare.py"), k, o]).toString());
    expect(r.signal[0]).toEqual(r.signal[1]);
    expect(r.drillSpans[0]).toEqual(r.drillSpans[1]);
    for (const [layer, v] of Object.entries(r.copper) as Array<[string, { padsOnly: unknown; L: number[]; A: number[]; S: number[] }]>) {
      expect(v.padsOnly, layer).toEqual([[], []]);
      for (const kind of ["L", "A", "S"] as const) expect(v[kind][0], `${layer} ${kind}`).toBe(v[kind][1]);
    }
    expect(r.holes.nOnly).toEqual([0, 0]);
    expect(r.components.differ).toEqual([]);
    expect(r.components.count[0]).toBe(r.components.count[1]);
    expect(r.nets.differ).toBe(0);
    expect(r.profile[0]).toEqual(r.profile[1]);
  });
});

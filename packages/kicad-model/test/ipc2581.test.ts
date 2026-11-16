/**
 * IPC-2581 against `kicad-cli pcb export ipc2581`, compared by what a fab's CAM reads
 * (test/ipc2581-compare.py): component placements, drill holes and slots, each net's pins and
 * track length per layer, the profile and the BOM's groups must all be KiCad's.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ipc2581, parseBoard } from "../src/index.js";

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

describe.skipIf(!ok)("IPC-2581 matches kicad-cli", () => {
  const dir = mkdtempSync(join(tmpdir(), "ipc2581-"));
  it.each(BOARDS)("%s", { timeout: 120_000 }, (file) => {
    const pcb = join(DEMOS, file);
    const name = basename(file, ".kicad_pcb");
    const k = join(dir, `${name}-k.xml`), o = join(dir, `${name}-o.xml`);
    execFileSync(KICAD_CLI, ["pcb", "export", "ipc2581", "-o", k, pcb], { stdio: "ignore" });
    writeFileSync(o, ipc2581(parseBoard(readFileSync(pcb, "utf8"), { recover: true }), name));
    const r = JSON.parse(execFileSync("python3", [join(import.meta.dirname, "ipc2581-compare.py"), k, o]).toString());
    expect(r.components.differ).toEqual([]);
    expect(r.components.count[0]).toBe(r.components.count[1]);
    expect(r.holes.nOnly).toEqual([0, 0]);
    expect(r.slots.same).toBe(true);
    expect(r.nets.differ).toBe(0);
    expect(r.tracks.differ).toBe(0);
    expect(r.profile[0]).toEqual(r.profile[1]);
    expect(r.bom.same).toBe(true);
  });
});

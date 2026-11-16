/**
 * IPC-D-356 netlists, byte for byte as KiCad writes them: every demo board's export equals
 * `kicad-cli pcb export ipcd356`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ipcD356, parseBoard } from "../src/index.js";

const CORPUS = process.env.KICAD_CORPUS ?? "/Library/Application Support/kicad/demos";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
let cli = existsSync(CORPUS);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}
const boards: string[] = [];
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith(".kicad_pcb")) boards.push(p);
  }
};
if (cli) walk(CORPUS);

describe.skipIf(!cli)("IPC-D-356 matches kicad-cli", () => {
  const dir = mkdtempSync(join(tmpdir(), "d356-"));
  it.each(boards)("%s", (pcb) => {
    const out = join(dir, basename(pcb) + ".d356");
    execFileSync(KICAD_CLI, ["pcb", "export", "ipcd356", "-o", out, pcb], { stdio: "ignore" });
    expect(ipcD356(parseBoard(readFileSync(pcb, "utf8"), { recover: true }))).toBe(readFileSync(out, "utf8"));
  });
});

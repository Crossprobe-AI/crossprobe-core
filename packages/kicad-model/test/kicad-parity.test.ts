/**
 * Key test for the board model: our schematic ↔ board parity check must
 * report the same issues as `kicad-cli pcb drc --schematic-parity`.
 * Findings are compared as a multiset of (type, reference).
 * Env: KICAD_CORPUS, KICAD_CLI, ORACLE_VERBOSE=1 (print differences).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNetlist, checkParity, loadSchematic, parseBoard, projectRuleSeverities } from "../src/index.js";

const CORPUS = process.env.KICAD_CORPUS!;
const KICAD_CLI = process.env.KICAD_CLI!;

function hasKicadCli(): boolean {
  try {
    execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function findBoards(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) findBoards(p, out);
    else if (name.endsWith(".kicad_pcb") && existsSync(p.replace(/\.kicad_pcb$/, ".kicad_sch"))) out.push(p);
  }
  return out;
}

/** "Footprint C101" or "Pad 6 [net] of I2C3 on B.Cu" → reference. */
function refOf(description: string): string {
  const pad = /^Pad .* of (\S+)/.exec(description);
  if (pad) return pad[1]!;
  return description.replace(/^Footprint /, "").trim();
}

function count(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}

const boards = existsSync(CORPUS) && hasKicadCli() ? findBoards(CORPUS) : [];

describe.skipIf(boards.length === 0)("schematic parity matches kicad-cli", () => {
  const outDir = mkdtempSync(join(tmpdir(), "crossprobe-parity-"));

  it.each(boards)("%s", (pcb) => {
    const out = join(outDir, basename(pcb) + ".json");
    execFileSync(KICAD_CLI, ["pcb", "drc", "--schematic-parity", "--format", "json", "-o", out, pcb], { stdio: "ignore" });
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      schematic_parity: Array<{ type: string; description: string; items: Array<{ description: string }> }>;
    };
    const expected = report.schematic_parity.map((v) => `${v.type} ${refOf(v.items[0]?.description ?? "")}`);
    const messages = new Map(report.schematic_parity.map((v) => [`${v.type} ${refOf(v.items[0]?.description ?? "")}`, v.description]));

    const dir = dirname(pcb);
    const sch = basename(pcb).replace(/\.kicad_pcb$/, ".kicad_sch");
    const schematic = loadSchematic(sch, (f) => readFileSync(join(dir, f), "utf8"));
    const board = parseBoard(readFileSync(pcb, "utf8"));
    const pro = pcb.replace(/\.kicad_pcb$/, ".kicad_pro");
    const severities = existsSync(pro) ? projectRuleSeverities(readFileSync(pro, "utf8")) : {};
    const ours = checkParity(schematic, buildNetlist(schematic), board, { severities });
    const actual = ours.map((f) => `${f.type} ${f.reference}`);
    const ourMessages = new Map(ours.map((f) => [`${f.type} ${f.reference}`, f.message]));

    const e = count(expected);
    const a = count(actual);
    const diff: string[] = [];
    for (const k of new Set([...e.keys(), ...a.keys()])) {
      const d = (a.get(k) ?? 0) - (e.get(k) ?? 0);
      if (d !== 0) diff.push(`${d > 0 ? "extra" : "missing"} ×${Math.abs(d)} ${k}: ${d > 0 ? ourMessages.get(k) : messages.get(k)}`);
    }
    if (process.env.ORACLE_VERBOSE) for (const line of diff.slice(0, Number(process.env.ORACLE_MAX ?? 8))) console.log(`  ${basename(pcb)}: ${line}`);
    expect(diff, diff.slice(0, 10).join("\n")).toEqual([]);
  });
});

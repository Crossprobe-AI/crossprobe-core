/**
 * Key test for board connectivity: missing connections (ratsnest lines) per
 * net, against `kicad-cli pcb drc`'s unconnected items. We must never miss
 * one KiCad reports. 16/19 demo boards match exactly; a few zone-to-pad edge
 * cases on One-Air-Max, video and vme-wren still over-report, so the summary
 * allows a small total of extra reports.
 * Env: KICAD_CORPUS, KICAD_CLI, ORACLE_VERBOSE=1.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findUnconnected, parseBoard } from "../src/index.js";

const CORPUS = process.env.KICAD_CORPUS ?? "/Library/Application Support/kicad/demos";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
const CACHE = join(tmpdir(), "crossprobe-drc-cache");
mkdirSync(CACHE, { recursive: true });

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
    else if (name.endsWith(".kicad_pcb")) out.push(p);
  }
  return out;
}

const totals = { exact: 0, boards: 0, missing: 0, extra: 0 };

const boards = existsSync(CORPUS) && hasKicadCli() ? findBoards(CORPUS) : [];

describe.skipIf(boards.length === 0)("unconnected items match kicad-cli", () => {
  it.each(boards)("%s", (pcb) => {
    const out = join(CACHE, `${basename(pcb)}-${createHash("sha1").update(pcb + statSync(pcb).mtimeMs).digest("hex").slice(0, 12)}.json`);
    if (!existsSync(out)) execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", out, pcb], { stdio: "ignore" });
    const report = JSON.parse(readFileSync(out, "utf8")) as { unconnected_items: Array<{ items: Array<{ description: string }> }> };
    const netOf = (d: string) => /\[(.*?)\]/.exec(d)?.[1] ?? "?";
    const count = (nets: string[]) => {
      const m = new Map<string, number>();
      for (const n of nets) m.set(n, (m.get(n) ?? 0) + 1);
      return m;
    };
    const expected = count(report.unconnected_items.map((u) => netOf(u.items[0]!.description)));
    const actual = count(findUnconnected(parseBoard(readFileSync(pcb, "utf8"))).map((u) => u.net));
    const diff: string[] = [];
    for (const net of new Set([...expected.keys(), ...actual.keys()])) {
      const d = (actual.get(net) ?? 0) - (expected.get(net) ?? 0);
      if (d) diff.push(`${net}: ours ${actual.get(net) ?? 0}, kicad ${expected.get(net) ?? 0}`);
    }
    if (process.env.ORACLE_VERBOSE) for (const line of diff.slice(0, 10)) console.log(`  ${basename(pcb)}: ${line}`);
    for (const net of new Set([...expected.keys(), ...actual.keys()])) {
      const d = (actual.get(net) ?? 0) - (expected.get(net) ?? 0);
      if (d < 0) totals.missing -= d;
      else totals.extra += d;
    }
    if (!diff.length) totals.exact++;
    totals.boards++;
  });

  it("never misses a connection, and rarely over-reports", () => {
    console.log(`unconnected: ${totals.exact}/${totals.boards} boards identical, ${totals.missing} missed, ${totals.extra} extra`);
    expect(totals.missing).toBe(0);
    expect(totals.extra).toBeLessThanOrEqual(20);
  });
});

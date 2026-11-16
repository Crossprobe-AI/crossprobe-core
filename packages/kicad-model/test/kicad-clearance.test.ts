/**
 * Copper clearance DRC against `kicad-cli pcb drc --all-track-errors`:
 * the item pairs KiCad reports as clearance violations, shorts and
 * copper-to-edge violations (pads, tracks, vias, zone fills, copper
 * graphics) must match ours, custom .kicad_dru rules included.
 * Env: KICAD_CORPUS, KICAD_CLI, ORACLE_VERBOSE=1.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkClearance, parseBoard, parseDru, projectDesignRules, type DrcItem } from "../src/index.js";

const CORPUS = process.env.KICAD_CORPUS!;
const KICAD_CLI = process.env.KICAD_CLI!;
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

const nn = (n: string) => n || "<no net>";
/** An item identity: a name plus numbers compared with a tolerance (track length, via position). */
type Key = { id: string; nums: number[] };
/** Identify an item the same way from KiCad's description and from ours. */
function kicadKey(it: { description: string; pos: { x: number; y: number } }): Key | undefined {
  const d = it.description;
  let m = /^NPTH pad(?: (\S+))? of (\S+)/.exec(d);
  if (m) return { id: `P:${m[2]}:${m[1] ?? ""}`, nums: [] };
  m = /^(?:\w+ )?pad (\S+) \[(.*?)\] of (\S+)/i.exec(d);
  if (m) return { id: `P:${m[3]}:${m[1]}`, nums: [] };
  m = /^\w*\s*via \[(.*?)\]/i.exec(d);
  if (m) return { id: `V:${m[1]}`, nums: [it.pos.x, it.pos.y] };
  m = /\[(.*?)\].*length ([\d.]+) mm/.exec(d);
  if (m) return { id: `T:${m[1]}`, nums: [Number(m[2])] };
  if (/on Edge\.Cuts/.test(d)) return { id: "EDGE", nums: [] };
  m = /^Zone \[(.*?)\]/.exec(d);
  if (m) return { id: `Z:${m[1]}`, nums: [] };
  m = /^(?:Polygon|Rectangle|Circle|Arc|Segment) \[(.*?)\](?: of (\S+))?/.exec(d);
  if (m) return { id: `G:${m[2] ?? ""}`, nums: [] };
  return undefined;
}
function ourKey(it: DrcItem): Key {
  if (it.kind === "edge") return { id: "EDGE", nums: [] };
  if (it.kind === "zone") return { id: `Z:${nn(it.net)}`, nums: [] };
  if (it.kind === "graphic") return { id: `G:${it.reference ?? ""}`, nums: [] };
  if (it.kind === "pad") return { id: `P:${it.reference}:${it.pad}`, nums: [] };
  if (it.kind === "via") return { id: `V:${nn(it.net)}`, nums: [it.at!.x, it.at!.y] };
  return { id: `T:${nn(it.net)}`, nums: [it.length!] };
}
const same = (a: Key, b: Key) => a.id === b.id && a.nums.every((n, i) => Math.abs(n - b.nums[i]!) < 0.002);
const samePair = (p: [Key, Key], q: [Key, Key]) => (same(p[0], q[0]) && same(p[1], q[1])) || (same(p[0], q[1]) && same(p[1], q[0]));
const show = (p: [Key, Key]) => p.map((k) => `${k.id}${k.nums.length ? "@" + k.nums.map((n) => n.toFixed(3)).join(",") : ""}`).join(" || ");

const totals = { matched: 0, missed: 0, extra: 0 };
const boards = existsSync(CORPUS) && hasKicadCli() ? findBoards(CORPUS) : [];

describe.skipIf(boards.length === 0)("copper clearance matches kicad-cli", () => {
  it.each(boards)("%s", (pcb) => {
    const out = join(CACHE, `clr-${basename(pcb)}-${createHash("sha1").update(pcb + statSync(pcb).mtimeMs).digest("hex").slice(0, 12)}.json`);
    if (!existsSync(out)) execFileSync(KICAD_CLI, ["pcb", "drc", "--all-track-errors", "--format", "json", "-o", out, pcb], { stdio: "ignore" });
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      violations: Array<{ type: string; items: Array<{ description: string; pos: { x: number; y: number } }> }>;
    };
    const theirs: Array<[Key, Key]> = [];
    for (const v of report.violations) {
      if (!["clearance", "shorting_items", "tracks_crossing", "copper_edge_clearance", "hole_clearance"].includes(v.type)) continue;
      const keys = v.items.map(kicadKey);
      // KiCad may report one pair as both a short and a clearance violation.
      if (keys.length === 2 && keys[0] && keys[1] && !theirs.some((p) => samePair(p, [keys[0]!, keys[1]!]))) theirs.push([keys[0], keys[1]]);
    }
    const pro = pcb.replace(/\.kicad_pcb$/, ".kicad_pro");
    const rules = projectDesignRules(existsSync(pro) ? readFileSync(pro, "utf8") : undefined);
    const dru = pcb.replace(/\.kicad_pcb$/, ".kicad_dru");
    if (existsSync(dru)) rules.custom = parseDru(readFileSync(dru, "utf8"));
    const ours: Array<[Key, Key]> = [];
    // One per item pair (zones report once, not per layer).
    for (const v of checkClearance(parseBoard(readFileSync(pcb, "utf8")), rules)) {
      const k: [Key, Key] = [ourKey(v.items[0]), ourKey(v.items[1])];
      if (!ours.some((q) => samePair(q, k))) ours.push(k);
    }
    const missed = theirs.filter((p) => !ours.some((q) => samePair(p, q))).map(show);
    const extra = ours.filter((q) => !theirs.some((p) => samePair(p, q))).map(show);
    totals.matched += theirs.length - missed.length;
    totals.missed += missed.length;
    totals.extra += extra.length;
    if (process.env.ORACLE_VERBOSE && (missed.length || extra.length)) console.log(basename(pcb), { missed, extra });
    expect({ missed, extra }).toEqual({ missed: [], extra: [] });
  });

  afterAll(() => {
    const recall = totals.matched / Math.max(1, totals.matched + totals.missed);
    const precision = totals.matched / Math.max(1, totals.matched + totals.extra);
    console.log(`clearance: recall ${recall.toFixed(3)}, precision ${precision.toFixed(3)} (${totals.matched} matched, ${totals.missed} missed, ${totals.extra} extra)`);
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(precision).toBeGreaterThanOrEqual(0.95);
  });
});

/**
 * Board checks beyond clearance against `kicad-cli pcb drc` on KiCad's demo
 * boards: hole size, annular width, dangling tracks and vias, courtyard
 * overlaps, co-located / too-close holes, text size and mirroring, and
 * silkscreen at the board edge, over solder-mask openings or over other
 * silkscreen, and solder-mask bridges. Severities and exclusions come
 * from each project, custom rules from its .kicad_dru. KiCad stops reporting
 * a type after ~200 findings; there we only require its findings among ours.
 * Shares the clearance test's report cache. Env: KICAD_CORPUS, KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkBoard, parseBoard, parseDru, projectDesignRules, type DrcItem } from "../src/index.js";

const CORPUS = process.env.KICAD_CORPUS ?? "/Library/Application Support/kicad/demos";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
const CACHE = join(tmpdir(), "crossprobe-drc-cache");
mkdirSync(CACHE, { recursive: true });
const TYPES = ["drill_out_of_range", "annular_width", "track_dangling", "via_dangling", "courtyards_overlap", "holes_co_located", "hole_to_hole", "starved_thermal", "text_height", "text_thickness", "track_width", "via_diameter", "mirrored_text_on_front_layer", "nonmirrored_text_on_back_layer", "silk_edge_clearance", "silk_over_copper", "solder_mask_bridge", "silk_overlap"];
const LIMIT = 199;

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

/** An item identity both sides can produce (KiCad's report positions are the item's own). */
function kicadKey(it: { description: string; pos: { x: number; y: number } }): string {
  const d = it.description;
  let m = /pad ?([^\s[]*)(?: \[.*?\])? of (\S+)/i.exec(d);
  if (m) return `P:${m[2]}:${m[1]}`;
  m = /^Zone \[(.*?)\]/.exec(d);
  if (m) return `Z:${m[1]}`;
  m = /^(?:Circle|Rectangle|Polygon|Segment|Arc|Line|Bezier) (?:\[.*?\] )?of (\S+)/.exec(d);
  if (m) return `G:${m[1]}`;
  m = /^Footprint (\S+)/.exec(d);
  if (m) return `F:${m[1]}`;
  m = /via \[(.*?)\]/i.exec(d);
  if (m) return `V:${m[1]}@${it.pos.x.toFixed(2)},${it.pos.y.toFixed(2)}`;
  m = /^Track(?: \(arc\))? \[(.*?)\].*length ([\d.]+) mm/.exec(d);
  if (m) return `T:${m[1]}:${Number(m[2]).toFixed(2)}`;
  return d;
}
function ourKey(it: DrcItem): string {
  if (it.kind === "pad") return it.pad === undefined ? `F:${it.reference}` : `P:${it.reference}:${it.pad}`;
  if (it.kind === "via") return `V:${it.net}@${it.at!.x.toFixed(2)},${it.at!.y.toFixed(2)}`;
  if (it.kind === "track") return `T:${it.net}:${it.length!.toFixed(2)}`;
  if (it.kind === "zone") return `Z:${it.net}`;
  if (it.kind === "graphic" && it.reference) return `G:${it.reference}`;
  return it.description;
}
/** KiCad's report shows net names unescaped ({slash} → /). */
const finding = (keys: string[]) => keys.map((k) => k.replace(/\{slash\}/g, "/")).sort().join(" / ");

const totals = { matched: 0, missed: 0, extra: 0, textExtra: 0, textMissed: 0 };
const boards = existsSync(CORPUS) && hasKicadCli() ? findBoards(CORPUS) : [];

describe.skipIf(boards.length === 0)("board checks match kicad-cli", () => {
  it.each(boards)("%s", (pcb) => {
    const out = join(CACHE, `clr-${basename(pcb)}-${createHash("sha1").update(pcb + statSync(pcb).mtimeMs).digest("hex").slice(0, 12)}.json`);
    if (!existsSync(out)) execFileSync(KICAD_CLI, ["pcb", "drc", "--all-track-errors", "--format", "json", "-o", out, pcb], { stdio: "ignore" });
    const report = JSON.parse(readFileSync(out, "utf8")) as { violations: Array<{ type: string; items: Array<{ description: string; pos: { x: number; y: number } }> }> };
    const pro = pcb.replace(/\.kicad_pcb$/, ".kicad_pro");
    const rules = projectDesignRules(existsSync(pro) ? readFileSync(pro, "utf8") : undefined);
    const dru = pcb.replace(/\.kicad_pcb$/, ".kicad_dru");
    if (existsSync(dru)) rules.custom = parseDru(readFileSync(dru, "utf8"));
    const ours = checkBoard(parseBoard(readFileSync(pcb, "utf8")), rules);

    const result: Record<string, { missed: string[]; extra: string[] }> = {};
    for (const type of TYPES) {
      // Texts are matched by position (descriptions differ: "Reference field of R1"); TrueType
      // stroke-weight findings (KiCad renders those fonts) aren't modelled.
      const isText = type.startsWith("text_") || type.includes("mirrored_text");
      // Silk findings (one per silk item): matched by the item's owner, a footprint or the board.
      // Keyed by owner and by text or graphic; text extras are tallied apart (our stroke font
      // isn't KiCad's, so glyph outlines differ by a few hundredths of a millimetre).
      const silkOwner = (d: string) => `${/(?:of|field of) (\S+)(?: on|$)/.exec(d)?.[1] ?? "board"}|${/^(Reference field|Value field|Text|Field|PCB text)/.test(d) ? "text" : "graphic"}`;
      if (type.startsWith("silk_")) {
        const ourOwner = (it: DrcItem) => `${it.reference || "board"}|${it.description.startsWith("Text") ? "text" : "graphic"}`;
        // silk_overlap pairs two silk items: keyed by both owners.
        const pair = type === "silk_overlap";
        const theirs = report.violations
          .filter((v) => v.type === type)
          .map((v) => (pair ? v.items.map((i) => silkOwner(i.description)).sort().join(" & ") : silkOwner(v.items.find((i) => !/Edge\.Cuts|^Pad /.test(i.description))?.description ?? "")));
        const pool = ours
          .filter((v) => v.type === type)
          .map((v) => (pair ? v.items.map(ourOwner).sort().join(" & ") : ourOwner(v.items.find((i) => i.kind === "graphic")!)));
        const missed = theirs.filter((k) => {
          const i = pool.indexOf(k);
          if (i < 0) return true;
          pool.splice(i, 1);
          return false;
        });
        const extra = theirs.length >= LIMIT ? [] : pool;
        totals.matched += theirs.length - missed.length;
        totals.missed += missed.filter((k) => !k.includes("|text")).length;
        totals.textMissed += missed.filter((k) => k.includes("|text")).length;
        totals.extra += extra.filter((k) => !k.includes("|text")).length;
        totals.textExtra += extra.filter((k) => k.includes("|text")).length;
        if (missed.length || extra.length) result[type] = { missed, extra };
        continue;
      }
      const theirs = report.violations
        .filter((v) => v.type === type && !/TrueType/.test((v as { description?: string }).description ?? ""))
        .map((v) => (isText ? `@${v.items[0]!.pos.x.toFixed(2)},${v.items[0]!.pos.y.toFixed(2)}` : finding(v.items.map(kicadKey))));
      const mine = ours.filter((v) => v.type === type).map((v) => (isText ? `@${v.at.x.toFixed(2)},${v.at.y.toFixed(2)}` : finding(v.items.map(ourKey))));
      const pool = [...mine];
      const missed = theirs.filter((k) => {
        const i = pool.indexOf(k);
        if (i < 0) return true;
        pool.splice(i, 1);
        return false;
      });
      // Past KiCad's report limit the rest of ours are unreported, not wrong.
      const extra = theirs.length >= LIMIT ? [] : pool;
      totals.matched += theirs.length - missed.length;
      totals.missed += missed.length;
      totals.extra += extra.length;
      if (missed.length || extra.length) result[type] = { missed, extra };
    }
    if (process.env.ORACLE_VERBOSE && Object.keys(result).length) appendFileSync(process.env.ORACLE_VERBOSE, `${basename(pcb)} ${JSON.stringify(result)}\n`);
    // Nothing KiCad reports may be missing (silk findings with text are tallied below); a stray
    // extra is tallied below too.
    expect(Object.values(result).flatMap((r) => r.missed).filter((k) => !k.includes("|text"))).toEqual([]);
  });

  afterAll(() => {
    console.log(`board checks: ${totals.matched} matched, ${totals.missed} missed, ${totals.extra} extra (silk text: ${totals.textMissed} missed, ${totals.textExtra} extra)`);
    // Known extras. On CM5: a short track that KiCad's connectivity finds connected, and a
    // silk arc on each of two identical modules whose rounded end overlaps the edge arc by
    // 0.02 mm (KiCad flags the line ending at the same point, not the arc). Not yet
    // explained: one silk graphic over a pad on each of jetson (A3) and One-Air-Max (PM1), and
    // one silk overlap between C11 and PM1's pin-1 circle on One-Air-Max.
    expect(totals.extra).toBeLessThanOrEqual(6);
    // Silk text is drawn in KiCad's own stroke font (and TrueType text from KiCad's cached
    // outlines); a few knockout texts on one board still pair up differently.
    expect(totals.textExtra).toBeLessThanOrEqual(10);
    expect(totals.textMissed).toBeLessThanOrEqual(10);
  });
});

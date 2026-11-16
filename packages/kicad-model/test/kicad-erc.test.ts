/**
 * Key test for ERC: our violations must match `kicad-cli sch erc`.
 * Compared as a multiset of (type, sheet, position of the first item),
 * leaving out the library checks we don't run. Most projects match exactly;
 * the summary asserts at least 98% agreement overall. Known differences: which
 * pin of a conflicting pair is listed first in a few pin_to_pin reports, and a
 * handful of no-connect / multiple-net-name / overlapping-wire edge cases.
 * Env: KICAD_CORPUS, KICAD_CLI, ORACLE_VERBOSE=1, ORACLE_MAX=n.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNetlist, loadSchematic, projectErcSettings, runErc } from "../src/index.js";

const CORPUS = process.env.KICAD_CORPUS!;
const KICAD_CLI = process.env.KICAD_CLI!;
const SKIPPED = new Set(["lib_symbol_issues", "lib_symbol_mismatch", "footprint_link_issues", "footprint_filter"]);

function hasKicadCli(): boolean {
  try {
    execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function findProjects(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) findProjects(p, out);
    else if (name.endsWith(".kicad_pro") && existsSync(p.replace(/\.kicad_pro$/, ".kicad_sch"))) out.push(p.replace(/\.kicad_pro$/, ".kicad_sch"));
  }
  return out;
}

// Round to 0.1 mm with a nudge, so KiCad's 107.94999… and our 107.95 agree.
const r = (v: number) => (Math.round(v * 10 + 1e-3) / 10).toFixed(1);
const key = (type: string, sheet: string, x: number, y: number) => `${type} ${sheet} ${r(x)},${r(y)}`;
function count(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}

const CACHE = join(tmpdir(), "crossprobe-erc-cache");
mkdirSync(CACHE, { recursive: true });

const totals = { expected: 0, actual: 0, matched: 0, exact: 0, projects: 0 };

const projects = existsSync(CORPUS) && hasKicadCli() ? findProjects(CORPUS) : [];

describe.skipIf(projects.length === 0)("ERC matches kicad-cli", () => {

  it.each(projects)("%s", (sch) => {
    // kicad-cli's ERC is slow on big designs; cache its report per file version.
    const stamp = readdirSync(dirname(sch)).filter((f) => f.endsWith(".kicad_sch") || f.endsWith(".kicad_pro")).map((f) => statSync(join(dirname(sch), f)).mtimeMs).join("-");
    const out = join(CACHE, `${basename(sch)}-${createHash("sha1").update(sch + stamp).digest("hex").slice(0, 12)}.json`);
    if (!existsSync(out)) execFileSync(KICAD_CLI, ["sch", "erc", "--format", "json", "--severity-all", "-o", out, sch], { stdio: "ignore" });
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      sheets: Array<{ path: string; violations: Array<{ type: string; description: string; items: Array<{ description: string; pos: { x: number; y: number } }> }> }>;
    };
    const expected: string[] = [];
    const messages = new Map<string, string>();
    for (const sheet of report.sheets) {
      for (const v of sheet.violations) {
        if (SKIPPED.has(v.type)) continue;
        // kicad-cli reports positions in units of 100 mm.
        const k = key(v.type, sheet.path, v.items[0]!.pos.x * 100, v.items[0]!.pos.y * 100);
        expected.push(k);
        messages.set(k, `${v.description} | ${v.items.map((i) => i.description).join(" / ")}`);
      }
    }

    const dir = dirname(sch);
    const schematic = loadSchematic(basename(sch), (f) => readFileSync(join(dir, f), "utf8"));
    const pro = sch.replace(/\.kicad_sch$/, ".kicad_pro");
    const settings = existsSync(pro) ? projectErcSettings(readFileSync(pro, "utf8")) : {};
    const ours = runErc(schematic, buildNetlist(schematic, { detail: true }), { ...settings, severities: { ...settings.severities } });
    const sheetOf = (v: (typeof ours)[number]) => v.kicadSheetName ?? v.sheetName;
    const actual = ours.map((v) => key(v.type, sheetOf(v), v.items[0]!.at.x, v.items[0]!.at.y));
    const ourMessages = new Map(ours.map((v) => [key(v.type, sheetOf(v), v.items[0]!.at.x, v.items[0]!.at.y), `${v.message} | ${v.items.map((i) => i.description).join(" / ")}`]));

    const e = count(expected);
    const a = count(actual);
    const diff: string[] = [];
    for (const k of new Set([...e.keys(), ...a.keys()])) {
      const d = (a.get(k) ?? 0) - (e.get(k) ?? 0);
      if (d !== 0) diff.push(`${d > 0 ? "extra" : "missing"} ×${Math.abs(d)} ${k}: ${d > 0 ? ourMessages.get(k) : messages.get(k)}`);
    }
    if (process.env.ORACLE_VERBOSE) for (const line of diff.slice(0, Number(process.env.ORACLE_MAX ?? 8))) console.log(`  ${basename(sch)}: ${line}`);
    let matched = 0;
    for (const [k, n] of e) matched += Math.min(n, a.get(k) ?? 0);
    totals.expected += expected.length;
    totals.actual += actual.length;
    totals.matched += matched;
    if (diff.length === 0) totals.exact++;
    totals.projects++;
  });

  it("agrees with kicad-cli overall", () => {
    const recall = totals.matched / Math.max(totals.expected, 1);
    const precision = totals.matched / Math.max(totals.actual, 1);
    console.log(`ERC: ${totals.exact}/${totals.projects} projects identical; ${totals.matched}/${totals.expected} KiCad violations found (${(recall * 100).toFixed(1)}%), ${(precision * 100).toFixed(1)}% of ours confirmed`);
    expect(recall).toBeGreaterThanOrEqual(0.98);
    expect(precision).toBeGreaterThanOrEqual(0.98);
  });
});

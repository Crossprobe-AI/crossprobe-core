/**
 * The key test for the design model: our netlist must match KiCad's own.
 *
 * For every project in the corpus, `kicad-cli sch export netlist` is the
 * oracle. Two scores are compared:
 *  - connectivity: each pin belongs to a net with exactly the same pin set
 *  - naming: those nets also carry the same name
 * Skipped when kicad-cli or the corpus is not available.
 * Env: KICAD_CORPUS, KICAD_CLI, ORACLE_VERBOSE=1 (print mismatches), ORACLE_NAMES=n.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, parse, type List } from "@crossprobe/kicad-sexpr";
import { buildNetlist, loadSchematic } from "../src/index.js";

const CORPUS = process.env.KICAD_CORPUS ?? "/Library/Application Support/kicad/demos";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";

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

type NetMap = Map<string, Set<string>>; // net name → "REF:PIN" set

function kicadNetlist(sch: string, outDir: string): NetMap {
  const out = join(outDir, basename(sch) + ".net");
  execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", out, sch], { stdio: "ignore" });
  const root = parse(readFileSync(out, "utf8")).children[0] as List;
  const nets: NetMap = new Map();
  for (const net of findChildren(findChild(root, "nets")!, "net")) {
    const name = String(arg(findChild(net, "name"), 0));
    nets.set(name, new Set(findChildren(net, "node").map((n) => `${arg(findChild(n, "ref"), 0)}:${arg(findChild(n, "pin"), 0)}`)));
  }
  return nets;
}

function ourNetlist(sch: string): NetMap {
  const dir = dirname(sch);
  const schematic = loadSchematic(basename(sch), (f) => readFileSync(join(dir, f), "utf8"));
  const nets: NetMap = new Map();
  for (const n of buildNetlist(schematic).nets) nets.set(n.name, new Set(n.nodes.map((x) => `${x.reference}:${x.pin}`)));
  return nets;
}

interface Score {
  pins: number;
  connectivity: number;
  naming: number;
  examples: string[];
}

function compare(expected: NetMap, actual: NetMap): Score {
  const key = (s: Set<string>) => [...s].sort().join(" ");
  const actualByPin = new Map<string, { name: string; key: string }>();
  for (const [name, pins] of actual) {
    const k = key(pins);
    for (const p of pins) actualByPin.set(p, { name, key: k });
  }
  const score: Score = { pins: 0, connectivity: 0, naming: 0, examples: [] };
  for (const [name, pins] of expected) {
    const k = key(pins);
    for (const p of pins) {
      score.pins++;
      const ours = actualByPin.get(p);
      if (ours?.key === k) {
        score.connectivity++;
        if (ours.name === name) score.naming++;
        else if (score.examples.length < Number(process.env.ORACLE_NAMES ?? 3)) score.examples.push(`name: kicad "${name}" vs ours "${ours.name}"`);
      } else if (score.examples.length < 6 && !score.examples.some((e) => e.includes(`"${name}"`))) {
        const ourPins = ours ? actual.get(ours.name)! : new Set<string>();
        const missing = [...pins].filter((x) => !ourPins.has(x)).slice(0, 4);
        const extra = [...ourPins].filter((x) => !pins.has(x)).slice(0, 4);
        score.examples.push(`net "${name}" @${p}: ours "${ours?.name}" missing [${missing}] extra [${extra}]`);
      }
    }
  }
  return score;
}

const projects = existsSync(CORPUS) && hasKicadCli() ? findProjects(CORPUS) : [];

describe.skipIf(projects.length === 0)("netlist matches kicad-cli", () => {
  const outDir = mkdtempSync(join(tmpdir(), "crossprobe-oracle-"));
  const results: Array<{ project: string } & Score> = [];

  it.each(projects)("%s", (sch) => {
    const score = compare(kicadNetlist(sch, outDir), ourNetlist(sch));
    results.push({ project: basename(sch, ".kicad_sch"), ...score });
    if (process.env.ORACLE_VERBOSE) for (const e of score.examples) console.log(`  ${basename(sch)}: ${e}`);
    expect(score.connectivity, score.examples.join("\n")).toBe(score.pins);
  });

  it("summary", () => {
    const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "100.0").padStart(6);
    console.log("\nproject                          pins   connect%  naming%");
    for (const r of results) console.log(`${r.project.padEnd(30)} ${String(r.pins).padStart(6)} ${pct(r.connectivity, r.pins)}   ${pct(r.naming, r.pins)}`);
  });
});

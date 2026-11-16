/**
 * Netlist edge cases from KiCad's own QA data: for each case our netlist must
 * equal `kicad-cli sch export netlist`, in connectivity and in net names.
 *
 * The cases cover bus member pairing (vectors, groups, aliases, prefixes),
 * global bus labels, jumper pins, stacked pin numbers, no-connect pins, pin
 * alternates and text variables in labels and power symbols.
 * Skipped when kicad-cli or the QA data is not available.
 * Env: KICAD_QA (KiCad's qa/data folder), KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, parse, type List } from "@crossprobe/kicad-sexpr";
import { buildNetlist, loadSchematic } from "../src/index.js";

const QA = process.env.KICAD_QA ?? "";
const KICAD_CLI = process.env.KICAD_CLI!;

/** A project folder (its root sheet is the one named like the .kicad_pro) or a root sheet, below KICAD_QA. */
const CASES = [
  "eeschema/netlists/weak_vector_bus_disambiguation",
  "eeschema/netlists/group_bus_matching",
  "eeschema/netlists/prefix_bus_alias",
  "eeschema/netlists/issue24220",
  "eeschema/issue23840",
  "eeschema/netlists/jumpers",
  "pcbnew/stacked",
  "eeschema/test1243",
  "eeschema/issue22286",
  "eeschema/ERC_dynamic_power_symbol_test.kicad_sch",
];

function hasKicadCli(): boolean {
  try {
    execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function rootSheet(entry: string): string {
  const path = join(QA, entry);
  if (path.endsWith(".kicad_sch")) return path;
  const project = readdirSync(path).find((f) => f.endsWith(".kicad_pro"))!;
  return join(path, project.replace(/\.kicad_pro$/, ".kicad_sch"));
}

/** Net name → sorted "REF:PIN" list, nets without pins left out. */
type Nets = Record<string, string[]>;

function kicadNets(sch: string, outDir: string): Nets {
  const out = join(outDir, basename(sch) + ".net");
  execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", out, sch], { stdio: "ignore" });
  const root = parse(readFileSync(out, "utf8")).children[0] as List;
  const nets: Nets = {};
  for (const net of findChildren(findChild(root, "nets")!, "net")) {
    const pins = findChildren(net, "node").map((n) => `${arg(findChild(n, "ref"), 0)}:${arg(findChild(n, "pin"), 0)}`);
    if (pins.length) nets[String(arg(findChild(net, "name"), 0))] = [...new Set(pins)].sort();
  }
  return nets;
}

function ourNets(sch: string): Nets {
  const dir = dirname(sch);
  const schematic = loadSchematic(basename(sch), (f) => readFileSync(join(dir, f), "utf8"));
  const nets: Nets = {};
  for (const n of buildNetlist(schematic).nets) nets[n.name] = n.nodes.map((x) => `${x.reference}:${x.pin}`).sort();
  return nets;
}

const available = QA !== "" && existsSync(QA) && hasKicadCli();

describe.skipIf(!available)("netlist edge cases match kicad-cli", () => {
  const outDir = available ? mkdtempSync(join(tmpdir(), "crossprobe-cases-")) : "";

  it.each(CASES)("%s", (entry) => {
    const sch = rootSheet(entry);
    expect(ourNets(sch)).toEqual(kicadNets(sch, outDir));
  });
});

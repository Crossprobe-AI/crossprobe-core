/**
 * The netlist file against KiCad's. For every demo project, exportNetlist's file and
 * `kicad-cli sch export netlist` (KiCad's own format) are read back and compared part by part
 * and net by net: each part's value, footprint, library part, sheet, units and symbol UUIDs,
 * each net's name and its pins with their function and electrical type, the sheets, and the
 * library parts' pins.
 *
 * Env: KICAD_CLI, KICAD_CORPUS.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, atomText, findChild, findChildren, isAtom, isList, parse, type List } from "@crossprobe/kicad-sexpr";
import { buildNetlist, exportNetlist, loadSchematic, netClassOf, projectDesignRules } from "../src/index.js";

const CORPUS = process.env.KICAD_CORPUS!;
const KICAD_CLI = process.env.KICAD_CLI!;
let cli = existsSync(CORPUS);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

function findProjects(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) findProjects(p, out);
    else if (name.endsWith(".kicad_pro") && existsSync(p.replace(/\.kicad_pro$/, ".kicad_sch"))) out.push(p.replace(/\.kicad_pro$/, ".kicad_sch"));
  }
  return out;
}

const text = (n: List | undefined, child: string) => String(arg(findChild(n, child), 0) ?? "");
const args = (n: List | undefined) => (n ? n.children.slice(1).filter(isAtom).map(atomText) : []);

/** What a netlist file says, in a form that compares. */
function read(source: string) {
  const root = parse(source).children.find(isList)!;
  const components = new Map<string, unknown>();
  for (const c of findChildren(findChild(root, "components")!, "comp")) {
    components.set(text(c, "ref"), {
      value: text(c, "value"),
      footprint: text(c, "footprint"),
      datasheet: text(c, "datasheet"),
      description: text(c, "description"),
      // (KiCad leaves the library empty for a symbol renamed in the sheet, and puts it all in the part.)
      lib: `${text(findChild(c, "libsource"), "lib")}:${text(findChild(c, "libsource"), "part")}`.replace(/^:/, ""),
      sheet: `${text(findChild(c, "sheetpath"), "names")} ${text(findChild(c, "sheetpath"), "tstamps")}`,
      tstamps: args(findChild(c, "tstamps")).sort(),
      fields: findChildren(findChild(c, "fields")!, "field").map((f) => `${text(f, "name")}=${args(f)[0] ?? ""}`).sort(),
      properties: findChildren(c, "property").map((p) => `${text(p, "name")}=${text(p, "value")}`).sort(),
      units: findChildren(findChild(c, "units") ?? c, "unit").map((u) => `${text(u, "name")}: ${findChildren(findChild(u, "pins")!, "pin").map((p) => text(p, "num")).sort().join(" ")}`),
    });
  }
  const nets = new Map<string, string[]>();
  for (const n of findChildren(findChild(root, "nets")!, "net")) {
    // A net in several classes lists them all in KiCad's file; ours names the first.
    nets.set(`${text(n, "name")} [${text(n, "class").split(",")[0]}]`, findChildren(n, "node").map((x) => `${text(x, "ref")}.${text(x, "pin")} ${text(x, "pinfunction")} ${text(x, "pintype")}`).sort());
  }
  const sheets = findChildren(findChild(root, "design")!, "sheet").map((s) => {
    const t = findChild(s, "title_block");
    return `${text(s, "number")} ${text(s, "name")} ${text(s, "tstamps")} | ${text(t, "title")} | ${text(t, "company")} | ${text(t, "rev")} | ${text(t, "date")} | ${text(t, "source")} | ${findChildren(t!, "comment").map((c) => text(c, "value")).join(",")}`;
  });
  const libparts = new Map<string, string[]>();
  for (const p of findChildren(findChild(root, "libparts")!, "libpart")) {
    libparts.set(`${text(p, "lib")}:${text(p, "part")}`, [
      ...findChildren(findChild(p, "pins") ?? p, "pin").map((x) => `${text(x, "num")} ${text(x, "name")} ${text(x, "type")}`).sort(),
      `fp: ${findChildren(findChild(p, "footprints") ?? p, "fp").map((f) => args(f)[0]).join(" ")}`,
    ]);
  }
  return { components, nets, sheets, libparts };
}

describe.skipIf(!cli)("netlist export", () => {
  const dir = cli ? mkdtempSync(join(tmpdir(), "netexport-")) : "";
  for (const sch of cli ? findProjects(CORPUS) : []) {
    it(basename(dirname(sch)), () => {
      const out = join(dir, basename(sch) + ".net");
      execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", out, sch], { stdio: "ignore" });
      const kicad = read(readFileSync(out, "utf8"));
      const schematic = loadSchematic(basename(sch), (f) => readFileSync(join(dirname(sch), f), "utf8"));
      const pro = sch.replace(/\.kicad_sch$/, ".kicad_pro");
      const rules = projectDesignRules(existsSync(pro) ? readFileSync(pro, "utf8") : undefined);
      const ours = read(exportNetlist(schematic, buildNetlist(schematic), { netClass: (net) => netClassOf(rules, net).name }));
      expect(ours.sheets).toEqual(kicad.sheets);
      expect([...ours.components.keys()].sort()).toEqual([...kicad.components.keys()].sort());
      for (const [ref, c] of kicad.components) expect(ours.components.get(ref), ref).toEqual(c);
      expect([...ours.nets.keys()].sort()).toEqual([...kicad.nets.keys()].sort());
      for (const [name, nodes] of kicad.nets) expect(ours.nets.get(name), name).toEqual(nodes);
      expect([...ours.libparts.keys()].sort()).toEqual([...kicad.libparts.keys()].sort());
      for (const [name, pins] of kicad.libparts) expect(ours.libparts.get(name), name).toEqual(pins);
    });
  }
});

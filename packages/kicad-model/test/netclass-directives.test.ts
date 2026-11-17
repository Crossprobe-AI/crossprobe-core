/**
 * Net classes given in the schematic, against KiCad. KiCad's jetson and royalblue demos assign
 * classes with directives on wires and buses and with rule areas; KiCad keeps the result in the
 * project file (netclass_assignments), and ours is the same for every net. On a copy of
 * pic_programmer, directives are added (one naming a class the project doesn't have) and a rule
 * area is drawn: KiCad reads them back unchanged, its netlist gives every net the class ours
 * does (combined ones too, like "Fast,NOPE"), and its ERC reports the undefined class as ours.
 *
 * Env: KICAD_CLI, KICAD_DEMOS.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, headOf, isList, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import {
  addDirective, addRuleArea, buildNetlist, loadSchematic, netClassOf, netclassAssignments, projectDesignRules, projectErcSettings, runErc, sheetRoot,
} from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMOS = process.env.KICAD_DEMOS!;
let cli = existsSync(join(DEMOS, "pic_programmer"));
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

describe.skipIf(!existsSync(join(DEMOS, "jetson-agx-thor-baseboard")))("net class directives in KiCad's demos", () => {
  it.each([
    ["jetson-agx-thor-baseboard", "jetson-agx-thor-baseboard"],
    ["royalblue54L_feather", "RoyalBlue54L-Feather"],
  ])("%s: the classes KiCad saved for each net", (dir, root) => {
    const read = (f: string) => readFileSync(join(DEMOS, dir, f), "utf8");
    const netlist = buildNetlist(loadSchematic(`${root}.kicad_sch`, read));
    const saved = JSON.parse(read(`${root}.kicad_pro`)).net_settings.netclass_assignments as Record<string, string[]>;
    const nets = new Set(netlist.nets.map((n) => n.name));
    // KiCad's file also keeps entries for buses and for nets that no longer exist.
    const kicad = Object.fromEntries(Object.entries(saved).filter(([n]) => nets.has(n)).map(([n, c]) => [n, [...c].sort()]));
    expect(Object.keys(kicad).length).toBeGreaterThan(1);
    expect(netclassAssignments(netlist)).toEqual(kicad);
  });
});

describe.skipIf(!cli)("net class directives made here", () => {
  it("KiCad reads them, classes its nets as ours, and finds the undefined class", () => {
    const dir = mkdtempSync(join(tmpdir(), "netclass-"));
    cpSync(join(DEMOS, "pic_programmer"), dir, { recursive: true });
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    const ROOT = "pic_programmer.kicad_sch";
    const before = loadSchematic(ROOT, read);
    const doc = parse(read(ROOT));
    const root = sheetRoot(doc);
    const w = before.root.data.wires;
    addDirective(root, w[0]!.a, "NOPE");
    addDirective(root, w[0]!.b, "Fast", 180);
    addDirective(root, w[1]!.a, "Fast", 90);
    // A rule area across the third wire, its class on the first corner.
    const area = [{ x: 54.61, y: 101.6 }, { x: 60.96, y: 101.6 }, { x: 60.96, y: 111.76 }, { x: 54.61, y: 111.76 }];
    addRuleArea(root, area);
    addDirective(root, area[0]!, "Slow");
    writeFileSync(join(dir, ROOT), serialize(doc));
    const pro = JSON.parse(read("pic_programmer.kicad_pro"));
    const base = pro.net_settings.classes[0];
    pro.net_settings.classes.push({ ...base, name: "Fast", priority: 0, clearance: 0.3 }, { name: "Slow", priority: 1, track_width: 0.5 });
    writeFileSync(join(dir, "pic_programmer.kicad_pro"), JSON.stringify(pro, null, 2));

    // KiCad reads the directives and the area back as written.
    const kept = (text: string) =>
      sheetRoot(parse(text))
        .children.filter((c): c is List => isList(c) && (headOf(c) === "netclass_flag" || headOf(c) === "rule_area"))
        .map((n) => (headOf(n) === "rule_area" ? `area ${findChildren(findChild(findChild(n, "polyline")!, "pts")!, "xy").map((p) => `${arg(p, 0)},${arg(p, 1)}`).join(" ")}` : `flag ${arg(findChild(n, "at"), 0)},${arg(findChild(n, "at"), 1)},${arg(findChild(n, "at"), 2)} ${arg(findChildren(n, "property").find((p) => arg(p, 0) === "Netclass"), 1)}`))
        .sort();
    const ours = kept(read(ROOT));
    expect(ours.length).toBeGreaterThanOrEqual(5);
    const copy = join(dir, "copy.kicad_sch");
    writeFileSync(copy, read(ROOT));
    execFileSync(KICAD_CLI, ["sch", "upgrade", "--force", copy], { stdio: "ignore" });
    expect(kept(readFileSync(copy, "utf8"))).toEqual(ours);

    // Every net's class, as KiCad's netlist gives it.
    const out = join(dir, "n.net");
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", out, join(dir, ROOT)], { stdio: "ignore" });
    const net = parse(readFileSync(out, "utf8")).children.find(isList)!;
    const kicad = Object.fromEntries(findChildren(findChild(net, "nets")!, "net").map((n) => [String(arg(findChild(n, "name"), 0)), String(arg(findChild(n, "class"), 0))]));
    const schematic = loadSchematic(ROOT, read);
    const netlist = buildNetlist(schematic, { detail: true });
    const rules = projectDesignRules(read("pic_programmer.kicad_pro"));
    for (const [n, c] of Object.entries(netclassAssignments(netlist))) rules.assignments.set(n, c);
    const mine = Object.fromEntries(netlist.nets.map((n) => [n.name, netClassOf(rules, n.name).name]));
    expect(mine).toEqual(kicad);
    expect(new Set(Object.values(kicad))).toEqual(new Set(["Default", "POWER", "Fast", "Fast,NOPE", "Slow,Default"]));

    // The undefined class, in KiCad's ERC and ours.
    const erc = join(dir, "erc.json");
    try {
      execFileSync(KICAD_CLI, ["sch", "erc", "--format", "json", "--severity-all", "-o", erc, join(dir, ROOT)], { stdio: "ignore" });
    } catch {
      // A non-zero exit only says there are findings.
    }
    const report = JSON.parse(readFileSync(erc, "utf8")) as { sheets: Array<{ violations: Array<{ type: string; description: string; items: Array<{ description: string; pos: { x: number; y: number } }> }> }> };
    const theirs = report.sheets.flatMap((s) => s.violations.filter((v) => v.type === "undefined_netclass").map((v) => `${v.description} | ${v.items.map((i) => `${i.description} @${(i.pos.x * 100).toFixed(2)},${(i.pos.y * 100).toFixed(2)}`).join(" ; ")}`));
    const found = runErc(schematic, netlist, projectErcSettings(read("pic_programmer.kicad_pro")))
      .filter((v) => v.type === "undefined_netclass")
      .map((v) => `${v.message} | ${v.items.map((i) => `${i.description} @${i.at.x.toFixed(2)},${i.at.y.toFixed(2)}`).join(" ; ")}`);
    expect(found).toEqual(theirs);
    expect(found).toHaveLength(1);
  });
});

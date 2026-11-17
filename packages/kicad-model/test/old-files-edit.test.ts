/**
 * Editing files from KiCad 6 and 7, against KiCad. Every schematic in KiCad's own test data older
 * than KiCad 8's format gets the edits the app makes: a wire, a local and a global label, a
 * junction, a no-connect, a text, a rectangle, a part placed from the sheet's own library, and on
 * an existing part a new value, DNP and a hidden field, then a move. Our edits are written in
 * KiCad 10's syntax into the old file. KiCad reads every edited file (`sch upgrade`) and keeps
 * every added item and the changed value; and for annotated designs, KiCad's netlist of the
 * edited file is ours.
 *
 * Not counted as lost, because KiCad itself changes them when it upgrades an old file: header
 * forms it drops or moves (host, page, bus aliases, instance tables), and the values of
 * simulation parts, which it rewrites from their models.
 *
 * Env: KICAD_QA (KiCad's qa/data folder), KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, headOf, isList, parse, serialize } from "@crossprobe/kicad-sexpr";
import {
  addJunction, addLabel, addNoConnect, addSchGraphic, addSchText, addWire, buildNetlist, loadSchematic, moveItem, placeSymbol, setFieldVisible, setSymbolAttributes, setSymbolField, sheetRoot,
} from "../src/index.js";

const QA = process.env.KICAD_QA ?? "";
const KICAD_CLI = process.env.KICAD_CLI!;
let cli = existsSync(join(QA, "eeschema"));
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}
const versionOf = (f: string) => Number(/\(version (\d+)/.exec(readFileSync(f, "utf8"))?.[1] ?? 0);
const files = cli ? execFileSync("find", [join(QA, "eeschema"), "-name", "*.kicad_sch"]).toString().trim().split("\n").filter((f) => versionOf(f) > 0 && versionOf(f) < 20231120) : [];
const MIGRATED = new Set(["lib_symbols", "sheet_instances", "symbol_instances", "version", "generator", "generator_version", "uuid", "paper", "title_block", "embedded_fonts", "host", "page", "bus_alias"]);
const kinds = (t: string) => {
  const out: Record<string, number> = {};
  for (const n of sheetRoot(parse(t, { recover: true })).children) if (isList(n)) out[headOf(n)!] = (out[headOf(n)!] ?? 0) + 1;
  return out;
};
const nets = (pairs: string[][]) => new Set(pairs.map((p) => p.sort().join(" ")));

describe.skipIf(!files.length)("editing KiCad 6 and 7 files", () => {
  it.each(files.map((f) => [f.slice(QA.length), f]))("%s", (_, f) => {
    const dir = mkdtempSync(join(tmpdir(), "oldedit-"));
    cpSync(dirname(f), dir, { recursive: true });
    const file = join(dir, basename(f));
    const doc = parse(readFileSync(file, "utf8"));
    const root = sheetRoot(doc);
    const P = (x: number, y: number) => ({ x: x * 2.54, y: y * 2.54 });
    addWire(root, [P(10, 10), P(20, 10)]);
    addLabel(root, "label", "OLDTEST_L", P(10, 10));
    addLabel(root, "global_label", "OLDTEST_G", P(20, 10), 0, "input");
    addJunction(root, P(15, 10));
    addNoConnect(root, P(30, 30));
    addSchText(root, "old file note", P(10, 20));
    addSchGraphic(root, { kind: "rectangle", points: [P(40, 40), P(50, 45)] });
    const lib = findChildren(findChild(root, "lib_symbols") ?? root, "symbol")[0];
    if (lib) placeSymbol(root, lib, { at: P(60, 60), reference: "ZZ1", sheetPaths: [`/${String(arg(findChild(root, "uuid"), 0) ?? "")}`], projectName: "x" });
    const part = findChildren(root, "symbol").find((s) => !String(arg(findChildren(s, "property").find((p) => arg(p, 0) === "Reference"), 1) ?? "#").startsWith("#"));
    if (part) {
      setSymbolField(part, "Value", "CHANGED");
      setSymbolAttributes(part, { dnp: true });
      setFieldVisible(part, "Value", false);
      moveItem(part, 2.54, 0);
    }
    const edited = serialize(doc);
    writeFileSync(file, edited);

    // Our netlist of the edited file is KiCad's (annotated designs: unannotated ones differ before any edit).
    const schematic = loadSchematic(basename(f), (x) => readFileSync(join(dir, x), "utf8"));
    if (!schematic.placements.some((p) => p.reference.endsWith("?"))) {
      const out = join(dir, "n.net");
      execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", out, file], { stdio: "ignore" });
      const net = parse(readFileSync(out, "utf8")).children.find(isList)!;
      const kicad = nets(findChildren(findChild(net, "nets")!, "net").map((n) => findChildren(n, "node").map((x) => `${arg(findChild(x, "ref"), 0)}.${arg(findChild(x, "pin"), 0)}`)));
      const ours = nets(buildNetlist(schematic).nets.map((n) => n.nodes.map((x) => `${x.reference}.${x.pin}`)));
      expect([...kicad].filter((k) => !ours.has(k))).toEqual([]);
    }

    // KiCad reads it and keeps every edit.
    execFileSync(KICAD_CLI, ["sch", "upgrade", "--force", file], { stdio: "ignore" });
    const back = readFileSync(file, "utf8");
    const ourKinds = kinds(edited);
    const theirs = kinds(back);
    expect(Object.keys(ourKinds).filter((k) => !MIGRATED.has(k) && (theirs[k] ?? 0) < ourKinds[k]!)).toEqual([]);
    expect(back).toContain("OLDTEST_G");
    expect(back).toContain("old file note");
    if (part && !f.includes("/spice_netlists/")) expect(back).toContain('"CHANGED"');
  });
});

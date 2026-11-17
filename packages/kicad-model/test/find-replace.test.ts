/**
 * Find and Replace. The pattern rules (case, whole words, wildcards), and Replace all against
 * KiCad: on a copy of the pic_programmer demo, "RB7" becomes "SDATA" in every label, sheet pin
 * and text of both sheets. KiCad's netlist of the result names the nets as ours does, with the
 * same pins, and the design keeps its connections (the hierarchical label and its sheet pin are
 * renamed together).
 *
 * Env: KICAD_CLI, KICAD_DEMOS.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import {
  buildNetlist, findInSheets, findItem, loadSchematic, planReplace, replaceInText, setItemText, setSheetName, setSheetPinName, setSymbolField, sheetRoot, textMatches,
} from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMO = join(process.env.KICAD_DEMOS!, "pic_programmer");
let cli = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

describe("find patterns", () => {
  it("match case, whole words and wildcards as KiCad's dialog does", () => {
    expect(textMatches("VPP/MCLR", "mclr")).toBe(true);
    expect(textMatches("VPP/MCLR", "mclr", { matchCase: true })).toBe(false);
    expect(textMatches("DATA_RB7", "RB7", { wholeWord: true })).toBe(false);
    expect(textMatches("DATA-RB7", "RB7", { wholeWord: true })).toBe(true);
    expect(textMatches("R12", "R1*", { wildcards: true })).toBe(true);
    expect(textMatches("CR12", "R1*", { wildcards: true })).toBe(false);
    expect(textMatches("R12", "R1?", { wildcards: true })).toBe(true);
    expect(textMatches("a.b", "a?b", { wildcards: true })).toBe(true);
    expect(textMatches("a.b", "a?c")).toBe(false);
    // Characters a regular expression would read are taken as they are.
    expect(textMatches("(x+1)", "(x+1)")).toBe(true);
    expect(replaceInText("rb7 RB7 Rb7", "rb7", "D")).toBe("D D D");
    expect(replaceInText("rb7 RB7", "RB7", "D", { matchCase: true })).toBe("rb7 D");
    expect(replaceInText("R12", "R1*", "Q", { wildcards: true })).toBe("Q");
    expect(replaceInText("abc", "x", "y")).toBeUndefined();
    // "$&" in a replacement is plain text.
    expect(replaceInText("a", "a", "$&$&")).toBe("$&$&");
  });
});

describe.skipIf(!cli)("Replace all", () => {
  it("renames a signal across the hierarchy as KiCad reads it", () => {
    const dir = mkdtempSync(join(tmpdir(), "replace-"));
    cpSync(DEMO, dir, { recursive: true });
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    const ROOT = "pic_programmer.kicad_sch";
    const before = loadSchematic(ROOT, read);
    const files = [...new Set(before.sheets.map((s) => s.file))];
    const docs = new Map(files.map((f) => [f, parse(read(f))]));
    const sheets = files.map((file) => ({ file, root: sheetRoot(docs.get(file)!) }));

    const found = findInSheets(sheets, "RB7");
    // Labels on both sheets and the sheet pin between them.
    expect(new Set(found.map((t) => `${t.kind} ${t.file}`))).toEqual(new Set(["label pic_programmer.kicad_sch", "label pic_sockets.kicad_sch", "sheetpin pic_programmer.kicad_sch"]));
    expect(findInSheets(sheets, "R1", { references: true }).some((t) => t.kind === "field" && t.field === "Reference")).toBe(true);
    expect(findInSheets(sheets, "R1").some((t) => t.kind === "field" && t.field === "Reference")).toBe(false);

    const plan = planReplace(sheets, "RB7", "SDATA");
    expect(plan.length).toBe(found.length);
    for (const t of plan) {
      const root = sheetRoot(docs.get(t.file)!);
      const node = findItem(root, t.uuid)!;
      if (t.kind === "field") setSymbolField(node, t.field, t.to, t.sheetPath);
      else if (t.kind === "sheet") setSheetName(node, t.to);
      else if (t.kind === "sheetpin") setSheetPinName(node, t.pin, t.to);
      else setItemText(node, t.to);
    }
    for (const [f, doc] of docs) writeFileSync(join(dir, f), serialize(doc));
    expect(findInSheets(files.map((file) => ({ file, root: sheetRoot(parse(read(file))) })), "RB7")).toEqual([]);

    const after = loadSchematic(ROOT, read);
    const ours = buildNetlist(after).nets;
    expect(ours.length).toBe(buildNetlist(before).nets.length);
    const out = join(dir, "after.net");
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", out, join(dir, ROOT)], { stdio: "ignore" });
    const root = parse(readFileSync(out, "utf8")).children[0] as List;
    const kicad = new Map(
      findChildren(findChild(root, "nets")!, "net").map((n) => [String(arg(findChild(n, "name"), 0)), findChildren(n, "node").map((x) => `${arg(findChild(x, "ref"), 0)}.${arg(findChild(x, "pin"), 0)}`).sort().join(" ")]),
    );
    expect(kicad.has("/SDATA-SDATA") || [...kicad.keys()].some((k) => k.includes("SDATA"))).toBe(true);
    for (const n of ours) expect(kicad.get(n.name), n.name).toBe(n.nodes.map((x) => `${x.reference}.${x.pin}`).sort().join(" "));
    expect(ours.length).toBe(kicad.size);
  });
});

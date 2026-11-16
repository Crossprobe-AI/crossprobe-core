/**
 * Annotation on a design with a reused sheet: renumbering everything must
 * give unique references per instance and a file KiCad loads unchanged in
 * connectivity.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import { buildNetlist, findItem, loadSchematic, planAnnotation, setSymbolField, sheetRoot } from "../src/index.js";

const DEMO = `${process.env.KICAD_DEMOS}/complex_hierarchy`;
const KICAD_CLI = process.env.KICAD_CLI!;
const hasCli = (() => {
  try {
    execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!existsSync(DEMO) || !hasCli)("annotation", () => {
  it("renumbers a hierarchical design per instance, and KiCad agrees", () => {
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-annotate-"));
    cpSync(DEMO, dir, { recursive: true });
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    const before = loadSchematic("complex_hierarchy.kicad_sch", read);
    const plan = planAnnotation(before, { mode: "all" });
    expect(plan.length).toBeGreaterThan(0);

    const docs = new Map<string, ReturnType<typeof parse>>();
    for (const a of plan) {
      if (!docs.has(a.file)) docs.set(a.file, parse(read(a.file)));
      setSymbolField(findItem(sheetRoot(docs.get(a.file)!), a.symbolUuid)!, "Reference", a.reference, a.sheetPath);
    }
    for (const [f, doc] of docs) writeFileSync(join(dir, f), serialize(doc));

    const after = loadSchematic("complex_hierarchy.kicad_sch", read);
    const refs = after.components.map((c) => c.reference);
    expect(new Set(refs).size).toBe(refs.length);
    // The reused sheet's two instances got different numbers for the same symbol.
    const reusedSymbol = after.placements.find((p) => p.sheet.parent && after.placements.some((q) => q !== p && q.symbol === p.symbol))!;
    const instanceRefs = after.placements.filter((p) => p.symbol === reusedSymbol.symbol).map((p) => p.reference);
    expect(new Set(instanceRefs).size).toBe(instanceRefs.length);
    // Same connectivity as before, just new names: compare net sizes.
    const sizes = (s: typeof after) => buildNetlist(s).nets.map((n) => n.nodes.length).sort((a, b) => a - b).join(",");
    expect(sizes(after)).toBe(sizes(before));

    // KiCad loads it and sees the new references.
    const out = join(dir, "a.net");
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", out, join(dir, "complex_hierarchy.kicad_sch")], { stdio: "ignore" });
    const root = parse(readFileSync(out, "utf8")).children[0] as List;
    const theirs = findChildren(findChild(root, "components")!, "comp").map((c) => String(arg(findChild(c, "ref"), 0))).sort();
    expect(theirs).toEqual([...refs].sort());
  });
});

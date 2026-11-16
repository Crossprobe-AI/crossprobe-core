/**
 * Design blocks (blocks/specs → blocks/library), checked against KiCad.
 *
 * Every spec must cite documents that it lists; the committed library must be
 * what the specs generate; and KiCad itself must load each block, with a
 * netlist equal to the spec and no ERC findings besides the unavoidable
 * "power input not driven" (a block has no supply of its own).
 * Skipped when KiCad's symbol libraries or kicad-cli are not available.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import { blockManifest, buildNetlist, checkSpecCitations, findFreeSpot, findItem, generateBlockSchematic, insertBlock, loadSchematic, planAnnotation, setSymbolField, sheetRoot, verifyBlock, type BlockSpec } from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../blocks/", import.meta.url));
const SYMBOLS = process.env.KICAD_SYMBOLS ?? "/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";

function hasKicadCli(): boolean {
  try {
    execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const specs: BlockSpec[] = readdirSync(join(ROOT, "specs"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(ROOT, "specs", f), "utf8")) as BlockSpec);

const symbols = (lib: string) => readFileSync(join(SYMBOLS, `${lib}.kicad_sym`), "utf8");
const blockDir = (spec: BlockSpec) => join(ROOT, "library/crossprobe.kicad_blocks", `${spec.id}.kicad_block`);

describe.skipIf(!existsSync(SYMBOLS))("design block manifests", () => {
  it("list every connected pin with its KiCad name, and the nets they make", () => {
    for (const spec of specs) {
      const m = blockManifest(spec, symbols);
      // The same nets the schematic is verified against.
      for (const [name, pins] of expectedNets(spec)) expect(m.nets.find((n) => n.name === name)?.pins.slice().sort(), name).toEqual([...pins].sort());
      expect(m.nets.map((n) => n.name).slice(0, Object.keys(spec.power).length)).toEqual(Object.keys(spec.power)); // power nets first
      expect(m.pins.every((p) => p.number && p.net)).toBe(true);
    }
    const esp = blockManifest(specs.find((s) => s.id === "esp32-s3-wroom-1-minimal")!, symbols);
    expect(esp.pins.find((p) => p.ref === "U1" && p.number === "13")).toMatchObject({ name: "USB_D-", net: "USB_DM" });
    expect(esp.nets.find((n) => n.name === "GND")!.pins).toEqual(expect.arrayContaining(["U1.1", "U1.40", "U1.41"]));
    expect(esp.seo?.title.length).toBeLessThanOrEqual(65);
    expect(esp.seo?.description.length).toBeLessThanOrEqual(160);
  });
});

describe("design block specs", () => {
  it("cite only documents they list, and reviewed blocks say who reviewed them", () => {
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(checkSpecCitations(spec), spec.id).toEqual([]);
  });
});

describe.skipIf(!existsSync(SYMBOLS))("design block library", () => {
  it("is what the specs generate, and each schematic matches its spec", () => {
    for (const spec of specs) {
      const generated = generateBlockSchematic(spec, symbols);
      expect(verifyBlock(spec, generated, symbols), spec.id).toEqual([]);
      const committed = readFileSync(join(blockDir(spec), `${spec.id}.kicad_sch`), "utf8");
      expect(committed, `${spec.id}: run node scripts/build-blocks.mjs`).toBe(generated);
      // KiCad's own design-block files: the schematic and a JSON with a description.
      const meta = JSON.parse(readFileSync(join(blockDir(spec), `${spec.id}.json`), "utf8")) as { description: string; keywords: string };
      expect(meta.description).toBe(spec.description);
      expect(meta.keywords).toContain(spec.keywords[0]);
    }
  });
});

describe("design block layouts", () => {
  it("every spec with a layout has its board committed (build-blocks --check proves it is current and DRC-clean)", () => {
    for (const spec of specs.filter((s) => s.layout)) {
      expect(existsSync(join(blockDir(spec), `${spec.id}.kicad_pcb`)), spec.id).toBe(true);
      expect(existsSync(join(ROOT, "images", `${spec.id}-pcb.svg`)), spec.id).toBe(true);
    }
  });
});

describe.skipIf(!existsSync(SYMBOLS) || !hasKicadCli())("design blocks in KiCad", () => {
  it("load in KiCad, with the spec's nets and no ERC findings besides undriven supply pins", () => {
    for (const spec of specs) {
      const dir = mkdtempSync(join(tmpdir(), "crossprobe-block-"));
      const sch = join(dir, "block.kicad_sch");
      cpSync(join(blockDir(spec), `${spec.id}.kicad_sch`), sch);

      // Netlist.
      const net = join(dir, "block.net");
      execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", net, sch], { stdio: "ignore" });
      const kicad = new Map<string, Set<string>>();
      for (const n of findChildren(findChild(parse(readFileSync(net, "utf8")).children[0] as List, "nets")!, "net")) {
        const nodes = findChildren(n, "node").map((x) => `${arg(findChild(x, "ref"), 0)}.${arg(findChild(x, "pin"), 0)}`);
        kicad.set(String(arg(findChild(n, "name"), 0)).replace(/^\//, ""), new Set(nodes));
      }
      for (const [name, pins] of expectedNets(spec)) expect([...(kicad.get(name) ?? [])].sort(), `${spec.id} net ${name}`).toEqual([...pins].sort());

      // ERC.
      const erc = join(dir, "erc.json");
      execFileSync(KICAD_CLI, ["sch", "erc", "--format", "json", "--severity-all", "-o", erc, sch], { stdio: "ignore" });
      const types = new Set<string>();
      for (const sheet of (JSON.parse(readFileSync(erc, "utf8")) as { sheets: Array<{ violations: Array<{ type: string }> }> }).sheets) {
        for (const v of sheet.violations) types.add(v.type);
      }
      expect([...types].filter((t) => t !== "power_pin_not_driven"), `${spec.id} ERC`).toEqual([]);
    }
  });
});

/** The nets the spec lists explicitly (not the no-connect pins), as "REF.pin" sets. */
function expectedNets(spec: BlockSpec): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const part of spec.parts) {
    for (const [key, netName] of Object.entries(part.pins)) {
      const numbers = pinNumbers(part.symbol, key);
      for (const n of numbers) (out.get(netName) ?? out.set(netName, new Set()).get(netName)!).add(`${part.ref}.${n}`);
    }
  }
  return out;
}

/** Pin numbers a spec key refers to: the pin with that number, else every pin with that name. */
function pinNumbers(symbolId: string, key: string): string[] {
  const [lib, name] = symbolId.split(":") as [string, string];
  const root = parse(symbols(lib), { recover: true }).children.find((c) => (c as List).children?.[0]?.type === "atom") as List;
  const byName = new Map(findChildren(root, "symbol").map((s) => [String(arg(s, 0)), s]));
  let sym = byName.get(name)!;
  const parent = findChild(sym, "extends");
  if (parent) sym = byName.get(String(arg(parent, 0)))!;
  const pins = findChildren(sym, "symbol").flatMap((u) => findChildren(u, "pin")).map((p) => ({ number: String(arg(findChild(p, "number"), 0)), name: String(arg(findChild(p, "name"), 0)) }));
  const byNumber = pins.filter((p) => p.number === key);
  return (byNumber.length ? byNumber : pins.filter((p) => p.name === key)).map((p) => p.number);
}

// ---------------------------------------------------------------------------

const DEMO = "/Library/Application Support/kicad/demos/pic_programmer";

describe.skipIf(!existsSync(SYMBOLS) || !hasKicadCli() || !existsSync(DEMO))("inserting a block into a design", () => {
  it("adds each block's parts and nets to a KiCad project, annotated, and KiCad agrees", () => {
    for (const spec of specs) {
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-insert-"));
    cpSync(DEMO, dir, { recursive: true });
    const file = join(dir, "pic_programmer.kicad_sch");
    const read = (f: string) => readFileSync(join(dir, f), "utf8");

    // Insert, then number the new parts the way the app does.
    const doc = parse(read("pic_programmer.kicad_sch"));
    const root = sheetRoot(doc);
    const before = loadSchematic("pic_programmer.kicad_sch", read);
    const inserted = insertBlock(root, readFileSync(join(blockDir(spec), `${spec.id}.kicad_sch`), "utf8"), findFreeSpot(root), [before.root.path], "pic_programmer");
    expect(inserted.symbolUuids.length).toBeGreaterThan(spec.parts.length); // the parts, plus power symbols
    writeFileSync(file, serialize(doc));
    const unnumbered = loadSchematic("pic_programmer.kicad_sch", read);
    const plan = planAnnotation(unnumbered, { mode: "unannotated" });
    expect(plan.length).toBe(inserted.symbolUuids.length);
    const doc2 = parse(read("pic_programmer.kicad_sch"));
    for (const a of plan) setSymbolField(findItem(sheetRoot(doc2), a.symbolUuid)!, "Reference", a.reference, a.sheetPath);
    writeFileSync(file, serialize(doc2));

    const after = loadSchematic("pic_programmer.kicad_sch", read);
    const nets = buildNetlist(after).nets;

    // The block's circuit is there. For the ESP32 block, the EN net joins its four pins.
    if (spec.id === "esp32-s3-wroom-1-minimal") {
      const u = after.components.find((c) => c.value === "ESP32-S3-WROOM-1")!;
      expect(u).toBeDefined();
      const en = nets.find((n) => n.name === "/EN")!;
      expect(en.nodes.length).toBe(4); // module EN, R1, C2, R7
      expect(en.nodes.some((n) => n.reference === u.reference && n.pin === "3")).toBe(true);
    }
    expect(after.components.length - before.components.length).toBe(spec.parts.length);
    // No reference is used twice, and none is left unnumbered.
    const refs = after.components.map((c) => c.reference);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs.filter((r) => r.endsWith("?"))).toEqual([]);

    // KiCad loads the result with the same connectivity as ours.
    const net = join(dir, "out.net");
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", net, file], { stdio: "ignore" });
    const kicad = new Map<string, string>();
    for (const n of findChildren(findChild(parse(readFileSync(net, "utf8")).children[0] as List, "nets")!, "net")) {
      kicad.set(String(arg(findChild(n, "name"), 0)), findChildren(n, "node").map((x) => `${arg(findChild(x, "ref"), 0)}.${arg(findChild(x, "pin"), 0)}`).sort().join(" "));
    }
    const ours = new Map(nets.map((n) => [n.name, n.nodes.map((x) => `${x.reference}.${x.pin}`).sort().join(" ")]));
    expect([...ours].sort()).toEqual([...kicad].sort());
    }
  });
});

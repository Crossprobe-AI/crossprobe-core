/**
 * A placed symbol's properties and global labels, read by KiCad. On KiCad's demo projects: a pin is
 * switched to an alternate function, the part is marked do-not-populate, out of the BOM and out of
 * simulation, a field is hidden, a part is switched to its De Morgan body, and a global label is
 * added. `kicad-cli sch upgrade --force` makes KiCad read the sheet and write it back, and each
 * change comes back as made; KiCad's netlist names the pin by its alternate function, as ours does.
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
  addLabel, buildNetlist, findItem, loadSchematic, setFieldVisible, setLabelShape, setPinAlternate, setSymbolAttributes, setSymbolBodyStyle, sheetRoot,
} from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMOS = process.env.KICAD_DEMOS!;
let cli = existsSync(join(DEMOS, "cm5_minima")) && existsSync(join(DEMOS, "pic_programmer"));
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

/** A copy of a demo project to change, and how to load it. */
function demo(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "symprops-"));
  cpSync(join(DEMOS, name), dir, { recursive: true });
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  return { dir, read, load: (root: string) => loadSchematic(root, read) };
}

describe.skipIf(!cli)("placed symbol properties", () => {
  it("KiCad reads a pin's alternate function, the flags, a hidden field and a global label as made", () => {
    const { dir, read, load } = demo("cm5_minima");
    const before = load("CM5_MINIMA_3.kicad_sch");
    const u1 = before.components.find((c) => c.reference === "U1")!;
    const pin = u1.lib!.pins.find((p) => p.alternates && "SDA" in p.alternates)!;
    const { file } = u1.units[0]!.sheet;
    const text = read(file);
    const doc = parse(text);
    const root = sheetRoot(doc);
    const node = findItem(root, u1.units[0]!.symbol.uuid)!;
    setPinAlternate(node, pin.number, "SDA");
    setSymbolAttributes(node, { dnp: true, inBom: false, excludeFromSim: true });
    expect(u1.units[0]!.symbol.hiddenFields).not.toContain("Value");
    setFieldVisible(node, "Value", false);
    const label = addLabel(root, "global_label", "ACCEL_INT", { x: 25.4, y: 25.4 }, 0, "output");
    setLabelShape(findItem(root, label)!, "tri_state");
    const ours = serialize(doc);
    // Only the lines the edits touch differ.
    const lines = new Set(text.split("\n"));
    expect(ours.split("\n").filter((l) => !lines.has(l)).length).toBeLessThan(40);
    writeFileSync(join(dir, file), ours);

    const check = () => {
      const s = load("CM5_MINIMA_3.kicad_sch");
      const c = s.components.find((x) => x.reference === "U1")!;
      const sym = c.units[0]!.symbol;
      expect(sym.pinAlternates).toEqual({ [pin.number]: "SDA" });
      expect([sym.dnp, sym.inBom, sym.onBoard, sym.excludeFromSim]).toEqual([true, false, true, true]);
      expect(sym.hiddenFields).toContain("Value");
      const g = sheetRoot(parse(read(file))).children.find((n): n is List => isList(n) && headOf(n) === "global_label" && arg(n, 0) === "ACCEL_INT")!;
      expect(arg(findChild(g, "shape"), 0)).toBe("tri_state");
      expect(findChildren(g, "property").map((p) => arg(p, 0))).toEqual(["Intersheetrefs"]);
      return s;
    };
    check();
    execFileSync(KICAD_CLI, ["sch", "upgrade", "--force", join(dir, file)], { stdio: "ignore" });
    const after = check();

    // The netlist names the pin by the function it is switched to.
    const xml = join(dir, "netlist.xml");
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadxml", "-o", xml, join(dir, "CM5_MINIMA_3.kicad_sch")], { stdio: "ignore" });
    const kicad = new RegExp(`<node ref="U1" pin="${pin.number}" pinfunction="([^"]*)"`).exec(readFileSync(xml, "utf8"))?.[1];
    expect(kicad).toBe(`SDA_${pin.number}`);
    const node2 = buildNetlist(after).nets.flatMap((n) => n.nodes).find((n) => n.reference === "U1" && n.pin === pin.number)!;
    expect(node2.pinName).toBe("SDA");
    expect(node2.pinType).toBe(pin.alternates!["SDA"]);

    // Back to the pin's own function: nothing of the alternate is left.
    const doc2 = parse(read(file));
    setPinAlternate(findItem(sheetRoot(doc2), u1.units[0]!.symbol.uuid)!, pin.number, undefined);
    writeFileSync(join(dir, file), serialize(doc2));
    expect(load("CM5_MINIMA_3.kicad_sch").components.find((x) => x.reference === "U1")!.units[0]!.symbol.pinAlternates).toBeUndefined();
  });

  it("KiCad reads a part switched to its De Morgan body", () => {
    const { dir, read, load } = demo("pic_programmer");
    const u5 = load("pic_programmer.kicad_sch").components.find((c) => c.reference === "U5")!;
    expect(u5.lib!.bodyStyles).toBe(2);
    const { file } = u5.units[0]!.sheet;
    const doc = parse(read(file));
    const root = sheetRoot(doc);
    setSymbolBodyStyle(findItem(root, u5.units[0]!.symbol.uuid)!, 2, Number(arg(findChild(root, "version"), 0)));
    writeFileSync(join(dir, file), serialize(doc));
    const style = () => load("pic_programmer.kicad_sch").components.find((c) => c.reference === "U5")!.units[0]!.symbol.bodyStyle;
    expect(style()).toBe(2);
    execFileSync(KICAD_CLI, ["sch", "upgrade", "--force", join(dir, file)], { stdio: "ignore" });
    expect(style()).toBe(2);
    expect(read(file)).toContain("(body_style 2)");
  });
});

describe("placed symbol properties in older files", () => {
  it("a file from before KiCad 10 keeps `convert`", () => {
    const sym = () => parse(`(symbol (lib_id "a:b") (at 0 0 0) (unit 1) (in_bom yes) (on_board yes) (uuid "u"))`).children.find(isList)!;
    const a = sym();
    setSymbolBodyStyle(a, 2, 20250114);
    expect(a.children.filter(isList).map(headOf).slice(2, 4)).toEqual(["unit", "convert"]);
    setSymbolBodyStyle(a, 1, 20250114);
    expect(findChild(a, "convert")).toBeUndefined();
    const b = sym();
    setSymbolBodyStyle(b, 2, 20260101);
    expect(arg(findChild(b, "body_style"), 0)).toBe(2);
    setSymbolAttributes(b, { dnp: true });
    expect(b.children.filter(isList).map(headOf)).toEqual(["lib_id", "at", "unit", "body_style", "in_bom", "on_board", "dnp", "uuid"]);
  });
});

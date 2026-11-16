/**
 * Symbols from KiCad's installed libraries: indexed, resolved (including
 * derived `extends` symbols) and placed, then loaded by KiCad.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import { indexLibrary, loadSchematic, placeSymbol, resolveLibrarySymbol, sheetRoot } from "../src/index.js";

const LIBS = process.env.KICAD_SYMBOLS!;
const DEMO = `${process.env.KICAD_DEMOS}/pic_programmer`;
const KICAD_CLI = process.env.KICAD_CLI!;
const ok = existsSync(LIBS) && existsSync(DEMO);

describe.skipIf(!ok)("KiCad symbol libraries", () => {
  it("indexes, resolves and places library symbols that KiCad accepts", () => {
    const device = readFileSync(join(LIBS, "Device.kicad_sym"), "utf8");
    const index = indexLibrary(device, "Device");
    expect(index.length).toBeGreaterThan(400);
    expect(index.find((e) => e.name === "R")?.prefix).toBe("R");
    const derived = index.find((e) => /\(extends/.test(device.slice(device.indexOf(`(symbol "${e.name}"`), device.indexOf(`(symbol "${e.name}"`) + 2000)))!;
    expect(derived).toBeDefined();

    const power = readFileSync(join(LIBS, "power.kicad_sym"), "utf8");
    expect(indexLibrary(power, "power").find((e) => e.name === "GND")?.power).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "crossprobe-lib-"));
    cpSync(DEMO, dir, { recursive: true });
    const file = join(dir, "pic_programmer.kicad_sch");
    const doc = parse(readFileSync(file, "utf8"));
    const root = sheetRoot(doc);
    const schematic = loadSchematic("pic_programmer.kicad_sch", (f) => readFileSync(join(dir, f), "utf8"));
    const sheetPaths = [schematic.root.path];
    const place = (text: string, lib: string, name: string, reference: string, x: number) => {
      const def = resolveLibrarySymbol(text, lib, name);
      expect(findChild(def, "extends")).toBeUndefined();
      expect(arg(def, 0)).toBe(`${lib}:${name}`);
      placeSymbol(root, def, { at: { x, y: 190.5 }, reference, sheetPaths, projectName: "pic_programmer" });
    };
    place(device, "Device", "R_Small", "R900", 30.48);
    place(device, "Device", derived.name, `${derived.prefix}901`, 45.72);
    place(power, "power", "GND", "#PWR0900", 60.96);
    writeFileSync(file, serialize(doc));

    // The derived symbol was flattened: it has its parent's pins.
    const embedded = findChildren(findChild(root, "lib_symbols")!, "symbol").find((s) => arg(s, 0) === `Device:${derived.name}`) as List;
    const pins = findChildren(embedded, "symbol").reduce((n, u) => n + findChildren(u, "pin").length, 0);
    expect(pins).toBe(derived.pins);

    const out = join(dir, "lib.net");
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", out, file], { stdio: "ignore" });
    const net = readFileSync(out, "utf8");
    expect(net).toContain('(ref "R900")');
    expect(net).toContain(`(ref "${derived.prefix}901")`);
  });
});

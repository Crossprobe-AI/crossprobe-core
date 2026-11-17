/** The app's netlist export: the project's files in, a KiCad netlist with its net classes out. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { netlistFile } from "../src/netlist-file";

const DEMO = join(process.env.KICAD_DEMOS!, "tiny_tapeout");

describe.skipIf(!existsSync(DEMO))("netlist file", () => {
  it("names parts, nets and the classes the project's patterns give them", () => {
    const files: Record<string, string> = {};
    for (const f of readdirSync(DEMO)) if (/\.kicad_(sch|pro)$/.test(f)) files[`demo/${f}`] = readFileSync(join(DEMO, f), "utf8");
    const net = netlistFile(files, "demo/tinytapeout-demo.kicad_pro");
    expect(net.startsWith("(export")).toBe(true);
    expect(net).toContain('(source "tinytapeout-demo.kicad_sch")');
    // "in\d+" is a regular expression in the project's net class patterns.
    expect(net).toMatch(/\(name "in0"\)\s+\(class "ioin"\)/);
    expect(net).toMatch(/\(name "GND"\)\s+\(class "pwr"\)/);
  });
});

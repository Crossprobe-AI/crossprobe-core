/**
 * Length rules of a board's custom rules, against `kicad-cli pcb drc` on
 * KiCad's vme-wren demo (DDR4 nets, lengths between parts with fromTo): most
 * of KiCad's findings are ours, measured within 0.7 mm (15 or more exactly);
 * the rest either side are nets within 0.7 mm of a limit.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLengthRules, parseBoard, parseDru, projectDesignRules } from "../src/index.js";

const DEMOS = process.env.KICAD_DEMOS!;
const KICAD_CLI = process.env.KICAD_CLI!;
const PCB = join(DEMOS ?? "", "vme-wren/vme-wren.kicad_pcb");
const CACHE = join(tmpdir(), "crossprobe-length-cache");
mkdirSync(CACHE, { recursive: true });

describe.skipIf(!existsSync(PCB) || !existsSync(KICAD_CLI))("length rules as KiCad's DRC", () => {
  it("vme-wren", () => {
    const report = join(CACHE, `vme-wren-${statSync(PCB).mtimeMs}.json`);
    if (!existsSync(report))
      try {
        execFileSync(KICAD_CLI, ["pcb", "drc", "--severity-all", "--format", "json", "-o", report, PCB], { stdio: "ignore" });
      } catch {
        // kicad-cli exits non-zero when it finds violations.
      }
    const r = JSON.parse(readFileSync(report, "utf8")) as { violations: Array<{ type: string; description: string; items: Array<{ description: string }> }> };
    const theirs = r.violations
      .filter((v) => v.type === "length_out_of_range")
      .map((v) => ({ rule: /rule '([^']+)'/.exec(v.description)![1]!, net: /\[([^\]]+)\]/.exec(v.items[0]!.description)![1]!, actual: Number(/actual ([\d.]+) mm/.exec(v.description)![1]) }));
    expect(theirs.length).toBeGreaterThan(10);
    const rules = projectDesignRules(readFileSync(PCB.replace(/\.kicad_pcb$/, ".kicad_pro"), "utf8"));
    const custom = parseDru(readFileSync(PCB.replace(/\.kicad_pcb$/, ".kicad_dru"), "utf8"));
    const ours = checkLengthRules(parseBoard(readFileSync(PCB, "utf8")), rules, custom).filter((v) => v.type === "length_out_of_range");
    const key = (v: { rule: string; net: string }) => `${v.rule} ${v.net}`;
    const mine = new Map(ours.map((o) => [key(o), o]));
    // Found: most of KiCad's findings, each measured within 0.7 mm of KiCad (whole nets and acyclic
    // point-to-point paths measure exactly; KiCad's from-to path leaves out a little more on some routes).
    const found = theirs.filter((t) => mine.has(key(t)));
    expect(found.length / theirs.length).toBeGreaterThanOrEqual(0.85);
    for (const t of found) expect(Math.abs(mine.get(key(t))!.actual - t.actual), key(t)).toBeLessThanOrEqual(0.7);
    expect(found.filter((t) => Math.abs(mine.get(key(t))!.actual - t.actual) <= 0.01).length).toBeGreaterThanOrEqual(15);
    // Anything else either side is a net within 0.7 mm of its rule's limit.
    const limits = (rule: string) => custom.find((c) => c.name === rule)!.constraints.find((c) => c.type === "length")!;
    const nearLimit = (rule: string, len: number) => [limits(rule).min, limits(rule).max].some((l) => l !== undefined && Math.abs(len - l) <= 0.7);
    for (const t of theirs.filter((x) => !mine.has(key(x)))) expect(nearLimit(t.rule, t.actual), `missed ${key(t)} ${t.actual}`).toBe(true);
    const theirKeys = new Set(theirs.map(key));
    for (const o of ours.filter((x) => !theirKeys.has(key(x)))) expect(nearLimit(o.rule, o.actual), `extra ${key(o)} ${o.actual}`).toBe(true);
  });
});

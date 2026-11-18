/**
 * Minimum connection width against KiCad's DRC. KiCad reports a neck by its vertex pair, which
 * depends on how its own polygon library orders the outline's points, so the pairs (and the
 * width given) can differ by a few hundredths of a millimetre where several pairs cross one
 * neck. What must match: multichannel's own setting (0.3 mm) gives KiCad's four necks in the GND
 * pour, vme-wren's (0.1 mm) KiCad's 193 findings layer by layer; with the minimum raised to
 * 0.5 mm on five demos the counts per layer are within a quarter of KiCad's, and the places agree
 * (each finding shares an item with one of KiCad's). A project that ignores the check gets none.
 * Env: KICAD_DEMOS, KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBoard, checkConnectionWidth, NeckFinder, parseBoard, projectDesignRules } from "../src/index.js";

const DEMOS = process.env.KICAD_DEMOS ?? "";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
let cli = existsSync(DEMOS);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

describe("necks", () => {
  it("a dumbbell: two squares joined by a 0.2 mm neck", () => {
    // In nm, as KiCad's test runs: 1 mm squares, a 0.2 mm wide, 0.5 mm long bridge.
    const mm = (x: number, y: number) => ({ x: x * 1e6, y: y * 1e6 });
    const shape = [mm(0, 0), mm(1, 0), mm(1, 0.4), mm(1.5, 0.4), mm(1.5, 0), mm(2.5, 0), mm(2.5, 1), mm(1.5, 1), mm(1.5, 0.6), mm(1, 0.6), mm(1, 1), mm(0, 1)];
    const pairs = new NeckFinder(0.3e6).findPairs(shape);
    expect(pairs.length).toBeGreaterThan(0);
    for (const [a, b] of pairs) expect(Math.hypot(shape[a]!.x - shape[b]!.x, shape[a]!.y - shape[b]!.y)).toBeCloseTo(0.2e6, -3);
    // Wider than the neck allows: nothing.
    expect(new NeckFinder(0.15e6).findPairs(shape)).toEqual([]);
  });
});

type KiCadViolation = { type: string; description: string; items: Array<{ uuid: string; description: string }> };
/** KiCad's connection width findings for a demo, with the minimum (and the check) set. */
function kicad(demo: string, minConnection?: number): { dir: string; pcb: string; found: KiCadViolation[] } {
  const dir = mkdtempSync(join(tmpdir(), "crossprobe-connw-"));
  cpSync(join(DEMOS, demo.split("/")[0]!), dir, { recursive: true });
  const pcb = join(dir, demo.split("/")[1]!);
  const proFile = pcb.replace(/\.kicad_pcb$/, ".kicad_pro");
  if (minConnection !== undefined) {
    const pro = JSON.parse(readFileSync(proFile, "utf8"));
    const ds = pro.board.design_settings;
    ds.rules.min_connection = minConnection;
    (ds.rule_severities ??= {}).connection_width = "warning";
    writeFileSync(proFile, JSON.stringify(pro, null, 2));
  }
  execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", join(dir, "drc.json"), pcb], { stdio: "ignore" });
  const found = (JSON.parse(readFileSync(join(dir, "drc.json"), "utf8")).violations as KiCadViolation[]).filter((v) => v.type === "connection_width");
  return { dir, pcb, found };
}
const ours = (pcb: string) => checkBoard(parseBoard(readFileSync(pcb, "utf8")), projectDesignRules(readFileSync(pcb.replace(/\.kicad_pcb$/, ".kicad_pro"), "utf8"))).filter((v) => v.type === "connection_width");
const layerOf = (description: string) => /\(([^()]*)\)$/.exec(description)![1]!;
const actualOf = (description: string) => Number(/actual ([\d.]+) mm/.exec(description)![1]);

describe.skipIf(!cli)("connection width as KiCad's DRC", () => {
  it("multichannel's own 0.3 mm minimum: the four necks in its GND pour", () => {
    const k = kicad("multichannel/multichannel_mixer.kicad_pcb");
    const o = ours(k.pcb);
    expect(k.found).toHaveLength(4);
    expect(o).toHaveLength(4);
    for (const v of o) {
      expect(layerOf(v.message)).toBe("B.Cu");
      expect(v.items.some((i) => i.kind === "zone" && i.net === "GND")).toBe(true);
      expect(Math.abs(v.actual! - actualOf(k.found[0]!.description))).toBeLessThan(0.02);
    }
  });

  it("vme-wren's own 0.1 mm minimum: KiCad's findings on every layer", () => {
    // Its planes' necks, and pairs of touching vias (their circles drawn as KiCad draws them).
    const k = kicad("vme-wren/vme-wren.kicad_pcb");
    const o = ours(k.pcb);
    const perLayer = (descriptions: string[]) => Object.fromEntries([...new Set(descriptions.map(layerOf))].sort().map((l) => [l, descriptions.filter((d) => layerOf(d) === l).length]));
    expect(perLayer(o.map((v) => v.message))).toEqual(perLayer(k.found.map((v) => v.description)));
  });

  it("a project that ignores the check gets none", () => {
    // interf_u has necks at 0.3 mm, but its project sets the check to ignore.
    const k = kicad("interf_u/interf_u.kicad_pcb");
    const pro = JSON.parse(readFileSync(k.pcb.replace(/\.kicad_pcb$/, ".kicad_pro"), "utf8"));
    pro.board.design_settings.rules.min_connection = 0.3;
    writeFileSync(k.pcb.replace(/\.kicad_pcb$/, ".kicad_pro"), JSON.stringify(pro));
    expect(ours(k.pcb)).toEqual([]);
    // Turned on, the rule finds them.
    const board = parseBoard(readFileSync(k.pcb, "utf8"));
    expect(checkConnectionWidth(board, projectDesignRules(JSON.stringify(pro))).length).toBeGreaterThan(0);
  });

  it.each(["pic_programmer/pic_programmer.kicad_pcb", "interf_u/interf_u.kicad_pcb", "multichannel/multichannel_mixer.kicad_pcb", "stickhub/StickHub.kicad_pcb", "video/video.kicad_pcb"])("0.5 mm on %s", (demo) => {
    const k = kicad(demo, 0.5);
    const o = ours(k.pcb);
    const perLayer = (descriptions: string[]) => {
      const m = new Map<string, number>();
      for (const d of descriptions) m.set(layerOf(d), (m.get(layerOf(d)) ?? 0) + 1);
      return m;
    };
    const kl = perLayer(k.found.map((v) => v.description));
    const ol = perLayer(o.map((v) => v.message));
    expect([...ol.keys()].sort()).toEqual([...kl.keys()].sort());
    // Per layer, within a quarter of KiCad's count.
    const slack = 1.25;
    for (const [layer, n] of kl) expect(ol.get(layer)!, layer).toBeGreaterThanOrEqual(n / slack), expect(ol.get(layer)!, layer).toBeLessThanOrEqual(n * slack);
    // The same places: findings share their items.
    const kIds = new Set(k.found.flatMap((v) => v.items.map((i) => i.uuid)));
    const oIds = new Set(o.flatMap((v) => v.items.map((i) => i.uuid)));
    expect(o.filter((v) => v.items.some((i) => kIds.has(i.uuid!))).length / o.length).toBeGreaterThan(0.99);
    expect(k.found.filter((v) => v.items.some((i) => oIds.has(i.uuid))).length / k.found.length).toBeGreaterThan(0.9);
  });
});

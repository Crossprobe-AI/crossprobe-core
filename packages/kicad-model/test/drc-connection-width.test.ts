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
import { checkBoard, checkConnectionWidth, NeckFinder, parseBoard, parseDru, projectDesignRules, unfracture } from "../src/index.js";

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
  it("a fill's cuts taken out again: its outline and each hole", () => {
    // A 10 mm square with a 3 mm and a 2 mm square hole, each joined to the outline's left side by a cut.
    const xy = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 6], [6, 6], [6, 9], [9, 9], [9, 6], [6, 6], [0, 6], [0, 3], [2, 3], [2, 5], [4, 5], [4, 3], [2, 3], [0, 3]];
    const one = xy.map(([x, y]) => ({ x: x!, y: y! }));
    const loops = unfracture(one);
    const area = (l: Array<{ x: number; y: number }>) => Math.abs(l.reduce((s, a, i) => s + a.x * l[(i + 1) % l.length]!.y - l[(i + 1) % l.length]!.x * a.y, 0) / 2);
    expect(loops.map(area).sort((a, b) => a - b).map((a) => Math.round(a))).toEqual([4, 9, 100]);
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

  it("a custom rule's A and B: the first two items at a neck, either way round, copper graphics among them", () => {
    // multichannel's four necks in its GND pour, with only a custom 0.3 mm rule: a track across
    // two of them, a copper line across a third, the fourth left with the zone alone.
    const { dir, pcb } = kicad("multichannel/multichannel_mixer.kicad_pcb", 0);
    const xs = [169.478, 147.478, 125.478];
    const across = (x: number, k: number) =>
      k < 2
        ? `(segment (start ${x} 107) (end ${x} 110) (width 0.05) (layer "B.Cu") (net 0) (uuid "00000000-0000-0000-0000-00000000000${k}"))`
        : `(gr_line (start ${x} 107) (end ${x} 110) (stroke (width 0.05) (type solid)) (layer "B.Cu") (uuid "00000000-0000-0000-0000-00000000000${k}"))`;
    const text = readFileSync(pcb, "utf8").trimEnd();
    writeFileSync(pcb, `${text.slice(0, -1)}${xs.map(across).join("\n")}\n)\n`);
    const dru = pcb.replace(/\.kicad_pcb$/, ".kicad_dru");
    const count = (condition: string) => {
      writeFileSync(dru, `(version 1)\n(rule "r"\n  (constraint connection_width (min 0.3mm))\n  (condition "${condition}"))\n`);
      execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", join(dir, "drc.json"), pcb], { stdio: "ignore" });
      const theirs = (JSON.parse(readFileSync(join(dir, "drc.json"), "utf8")).violations as KiCadViolation[]).filter((v) => v.type === "connection_width").length;
      const rules = { ...projectDesignRules(readFileSync(pcb.replace(/\.kicad_pcb$/, ".kicad_pro"), "utf8")), custom: parseDru(readFileSync(dru, "utf8")) };
      return { theirs, ours: checkBoard(parseBoard(readFileSync(pcb, "utf8")), rules).filter((v) => v.type === "connection_width").length };
    };
    // B is the zone where something else crosses the neck, the line too; A or B a track: two.
    expect(count("B.Type == 'Zone'")).toEqual({ theirs: 3, ours: 3 });
    expect(count("B.Type == 'Track'")).toEqual({ theirs: 2, ours: 2 });
    expect(count("A.Type == 'Zone'")).toEqual({ theirs: 4, ours: 4 });
    expect(count("A.Type == 'Track' && B.Type == 'Track'")).toEqual({ theirs: 0, ours: 0 });
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

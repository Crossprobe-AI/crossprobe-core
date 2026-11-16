/**
 * Zone filling, checked two ways against KiCad:
 *  1. Area: our fill vs the fill KiCad saved in its demo boards (the area
 *     where they differ, relative to KiCad's filled area).
 *  2. Acceptance: refill with our filler, save, and run `kicad-cli pcb drc`.
 *     Our fills must not add any zone clearance, short, edge or hole
 *     violation the original board doesn't have.
 * Env: KICAD_CLI, ORACLE_VERBOSE=1.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { arg, findChild, headOf, isList, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import { boardRoot, fillDifference, fillZones, findBoardItem, fracture, parseBoard, projectDesignRules, setZoneFills } from "../src/index.js";

const DEMOS = "/Library/Application Support/kicad/demos";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
// Boards whose saved fills are current (multichannel_mixer-unrouted's are stale in the demo).
const AREA_BOARDS = [
  "pic_programmer/pic_programmer.kicad_pcb",
  "sonde xilinx/sonde xilinx.kicad_pcb",
  "ecc83/ecc83-pp.kicad_pcb",
  "interf_u/interf_u.kicad_pcb",
  "complex_hierarchy/complex_hierarchy.kicad_pcb",
  "stickhub/StickHub.kicad_pcb",
  "royalblue54L_feather/RoyalBlue54L-Feather.kicad_pcb",
  "multichannel/multichannel_mixer.kicad_pcb",
  "openair-max/One-Air-Max.kicad_pcb",
  "cm5_minima/CM5_MINIMA_3.kicad_pcb",
];
const DRC_BOARDS = ["pic_programmer/pic_programmer.kicad_pcb", "stickhub/StickHub.kicad_pcb", "royalblue54L_feather/RoyalBlue54L-Feather.kicad_pcb", "openair-max/One-Air-Max.kicad_pcb", "cm5_minima/CM5_MINIMA_3.kicad_pcb"];

const ok = existsSync(DEMOS);
const proOf = (pcb: string) => {
  const pro = pcb.replace(/\.kicad_pcb$/, ".kicad_pro");
  return existsSync(pro) ? readFileSync(pro, "utf8") : undefined;
};

const totals = { kicad: 0, diff: 0 };

describe.skipIf(!ok)("zone fill area matches KiCad's saved fills", () => {
  it.each(AREA_BOARDS)("%s", (b) => {
    const pcb = join(DEMOS, b);
    const board = parseBoard(readFileSync(pcb, "utf8"));
    let kicad = 0;
    let diff = 0;
    for (const f of fillZones(board, projectDesignRules(proOf(pcb)))) {
      const d = fillDifference(f.paths, f.zone.fills.filter((p) => p.layer === f.layer).map((p) => p.points));
      kicad += d.kicadArea;
      diff += d.xorArea;
    }
    totals.kicad += kicad;
    totals.diff += diff;
    if (process.env.ORACLE_VERBOSE) console.log(basename(pcb), `${((100 * diff) / kicad).toFixed(2)}% of ${kicad.toFixed(0)} mm²`);
    expect(diff / kicad).toBeLessThan(0.04);
  });
  afterAll(() => {
    console.log(`zone fill: differs from KiCad on ${((100 * totals.diff) / totals.kicad).toFixed(2)}% of ${totals.kicad.toFixed(0)} mm²`);
    expect(totals.diff / totals.kicad).toBeLessThan(0.025);
  });
});

function hasKicadCli(): boolean {
  try {
    execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Zone-related violations KiCad reports, as "type|items" keys. */
function zoneViolations(file: string): string[] {
  const out = `${file}.drc.json`;
  execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", out, file], { stdio: "ignore" });
  const r = JSON.parse(readFileSync(out, "utf8")) as { violations: Array<{ type: string; description: string; items: Array<{ description: string }> }> };
  return r.violations
    .filter((v) => ["clearance", "shorting_items", "copper_edge_clearance", "hole_clearance"].includes(v.type) && v.items.some((i) => /^Zone/.test(i.description)))
    .map((v) => `${v.type} ${v.description} | ${v.items.map((i) => i.description).join(" / ")}`);
}

describe.skipIf(!ok || !hasKicadCli())("refilled boards pass KiCad's DRC", () => {
  it.each(DRC_BOARDS)("%s", (b) => {
    const src = join(DEMOS, b);
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-refill-"));
    const file = join(dir, basename(src));
    copyFileSync(src, file);
    const pro = proOf(src);
    if (pro) writeFileSync(file.replace(/\.kicad_pcb$/, ".kicad_pro"), pro);
    const before = zoneViolations(file);

    const text = readFileSync(file, "utf8");
    const doc = parse(text, { recover: true });
    const root = boardRoot(doc);
    const byZone = new Map<string, Array<{ layer: string; polygons: Array<Array<{ x: number; y: number }>> }>>();
    for (const f of fillZones(parseBoard(text), projectDesignRules(pro))) {
      const list = byZone.get(f.zone.uuid) ?? [];
      list.push({ layer: f.layer, polygons: fracture(f.paths) });
      byZone.set(f.zone.uuid, list);
    }
    for (const [uuid, fills] of byZone) {
      const node = findBoardItem(root, uuid) ?? doc.children.find((c): c is List => isList(c) && headOf(c) === "zone" && String(arg(findChild(c, "uuid"), 0)) === uuid);
      expect(node).toBeDefined();
      setZoneFills(node!, fills);
    }
    writeFileSync(file, serialize(doc));
    const after = zoneViolations(file);
    // Nothing new (KiCad's own fills occasionally have a violation ours don't).
    expect(after.filter((v) => !before.includes(v))).toEqual([]);
  });
});

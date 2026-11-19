/**
 * Footprint courtyard definitions against KiCad's DRC (missing_courtyard, malformed_courtyard,
 * both turned on): courtyard shapes chained as KiCad chains them. The footprints with no
 * courtyard are KiCad's (KiCad stops each check at 199 findings: the first 199 of ours are its
 * 199); the malformed ones are KiCad's, each with its errors within one (where several shape
 * ends meet at one point, which pair KiCad takes follows its k-d tree). Env: KICAD_DEMOS, KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chainOutlines, checkBoard, parseBoard, projectDesignRules, type Graphic } from "../src/index.js";

const line = (x0: number, y0: number, x1: number, y1: number): Graphic => ({ layer: "F.CrtYd", kind: "line", points: [{ x: x0, y: y0 }, { x: x1, y: y1 }], width: 0.05, fill: false });

describe("chaining outlines", () => {
  it("a closed box, a gap, a cross inside, and a polygon", () => {
    const box = [line(0, 0, 2, 0), line(2, 1, 2, 0), line(0, 1, 2, 1), line(0, 0, 0, 1)];
    expect(chainOutlines(box)).toEqual({ ok: true, errors: [] });
    // Ends 0.01 mm apart still meet (KiCad chains within 0.02 mm); 0.1 mm apart they don't.
    expect(chainOutlines([...box.slice(0, 3), line(0, 0.01, 0, 1)]).ok).toBe(true);
    const open = chainOutlines([...box.slice(0, 3), line(0, 0.1, 0, 1)]);
    expect(open.ok).toBe(false);
    expect(open.errors.map((e) => e.message)).toEqual(["(not a closed shape)"]);
    // Two lines crossing the box: closed, but self-intersecting.
    const crossed = chainOutlines([...box, line(1, -0.5, 1, 0.5), line(1, 0.5, 1.5, 1.5), line(1.5, 1.5, 1, -0.5)]);
    expect(crossed.ok).toBe(false);
    expect(crossed.errors.some((e) => e.message === "(self-intersecting)")).toBe(true);
    const poly: Graphic = { layer: "F.CrtYd", kind: "poly", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], width: 0.05, fill: false };
    expect(chainOutlines([poly])).toEqual({ ok: true, errors: [] });
  });
});

const DEMOS = process.env.KICAD_DEMOS ?? "";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
let cli = existsSync(DEMOS);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

type Finding = { type: string; description: string; uuid: string };
function kicad(demo: string): { pcb: string; found: Finding[] } {
  const dir = mkdtempSync(join(tmpdir(), "crossprobe-crtyd-"));
  cpSync(join(DEMOS, demo.split("/")[0]!), dir, { recursive: true });
  const pcb = join(dir, demo.split("/")[1]!);
  const proFile = pcb.replace(/\.kicad_pcb$/, ".kicad_pro");
  const pro = JSON.parse(readFileSync(proFile, "utf8"));
  const sev = (pro.board.design_settings.rule_severities ??= {});
  sev.missing_courtyard = "error";
  sev.malformed_courtyard = "error";
  writeFileSync(proFile, JSON.stringify(pro, null, 2));
  execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", join(dir, "drc.json"), pcb], { stdio: "ignore" });
  const found = (JSON.parse(readFileSync(join(dir, "drc.json"), "utf8")).violations as Array<{ type: string; description: string; items: Array<{ uuid: string }> }>)
    .filter((v) => v.type === "missing_courtyard" || v.type === "malformed_courtyard")
    .map((v) => ({ type: v.type, description: v.description, uuid: v.items[0]!.uuid }));
  return { pcb, found };
}

describe.skipIf(!cli)("courtyard definitions as KiCad's DRC", () => {
  it.each(["vme-wren/vme-wren.kicad_pcb", "openair-max/One-Air-Max.kicad_pcb", "multichannel/multichannel_mixer.kicad_pcb", "stickhub/StickHub.kicad_pcb"])("%s", (demo) => {
    const k = kicad(demo);
    const ours = checkBoard(parseBoard(readFileSync(k.pcb, "utf8")), projectDesignRules(readFileSync(k.pcb.replace(/\.kicad_pcb$/, ".kicad_pro"), "utf8")))
      .filter((v) => v.type === "missing_courtyard" || v.type === "malformed_courtyard")
      .map((v) => ({ type: v.type, description: v.message, uuid: v.items[0]!.uuid! }));
    const missing = (list: Finding[]) => list.filter((v) => v.type === "missing_courtyard").map((v) => v.uuid);
    const theirs = missing(k.found);
    expect(theirs.length).toBeGreaterThan(0);
    // KiCad stops at 199.
    expect(missing(ours).slice(0, 199).sort()).toEqual(theirs.sort());
    if (theirs.length < 199) expect(missing(ours)).toHaveLength(theirs.length);
    // Malformed: the same footprints, each with its errors within one.
    const per = (list: Finding[]) => {
      const m = new Map<string, number>();
      for (const v of list) if (v.type === "malformed_courtyard") m.set(`${v.uuid} ${v.description}`, (m.get(`${v.uuid} ${v.description}`) ?? 0) + 1);
      return m;
    };
    const a = per(k.found), b = per(ours);
    expect([...new Set([...b.keys()].map((x) => x.split(" ")[0]))].sort()).toEqual([...new Set([...a.keys()].map((x) => x.split(" ")[0]))].sort());
    for (const key of new Set([...a.keys(), ...b.keys()])) expect(Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0)), key).toBeLessThanOrEqual(1);
  });

  it("a footprint whose attributes allow no courtyard", () => {
    const k = kicad("stickhub/StickHub.kicad_pcb");
    const uuid = k.found.find((v) => v.type === "missing_courtyard")!.uuid;
    const text = readFileSync(k.pcb, "utf8");
    const at = text.indexOf(`(uuid "${uuid}")`);
    const attr = text.indexOf("(attr", at);
    const allowed = attr >= 0 && attr < text.indexOf("(footprint", at + 1) ? text.slice(0, attr + 5) + " allow_missing_courtyard" + text.slice(attr + 5) : text;
    expect(allowed).not.toBe(text);
    writeFileSync(k.pcb, allowed);
    const rules = projectDesignRules(readFileSync(k.pcb.replace(/\.kicad_pcb$/, ".kicad_pro"), "utf8"));
    const ours = checkBoard(parseBoard(allowed), rules).filter((v) => v.type === "missing_courtyard");
    expect(ours.map((v) => v.items[0]!.uuid)).not.toContain(uuid);
    execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", k.pcb + ".json", k.pcb], { stdio: "ignore" });
    const theirs = (JSON.parse(readFileSync(k.pcb + ".json", "utf8")).violations as Array<{ type: string; items: Array<{ uuid: string }> }>).filter((v) => v.type === "missing_courtyard");
    expect(ours.length).toBe(theirs.length);
  });
});

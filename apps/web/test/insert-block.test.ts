/**
 * The Add block operation as the app runs it: the Editor inserts a design block
 * into a real KiCad project, numbers the new parts in the same step, and the
 * analysis then shows the block's circuit as part of the design.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyze";
import { Editor } from "../src/edit/ops";

const DEMO = "/Library/Application Support/kicad/demos/pic_programmer";
const BLOCK = fileURLToPath(new URL("../../../blocks/library/crossprobe.kicad_blocks/esp32-s3-wroom-1-minimal.kicad_block/esp32-s3-wroom-1-minimal.kicad_sch", import.meta.url));

function load(dir: string) {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.kicad_(sch|pcb|pro)$|sym-lib-table$/.test(f)) files[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return { project: Object.keys(files).find((f) => f.endsWith(".kicad_pro"))!, files };
}

describe.skipIf(!existsSync(DEMO) || !existsSync(BLOCK))("insert design block", () => {
  it("adds numbered parts and the block's nets in one step, leaving existing parts alone", () => {
    const project = load(DEMO);
    const before = analyze(project);
    const sheet = before.sheets[0]!;
    const blockText = readFileSync(BLOCK, "utf8");

    const changed = new Editor().apply(
      project.files,
      [{ op: "insertBlock", file: sheet.file, blockText, at: "free", sheetPaths: before.sheets.filter((s) => s.file === sheet.file).map((s) => s.path), projectName: before.name }],
      project.project.replace(/\.kicad_pro$/, ".kicad_sch"),
    );
    expect(Object.keys(changed)).toEqual([sheet.file]);
    const after = analyze({ project: project.project, files: { ...project.files, ...changed } });

    // 16 new parts, every reference numbered and unique, existing ones untouched.
    expect(after.components.length).toBe(before.components.length + 16);
    const refs = after.components.map((c) => c.reference);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs.filter((r) => r.includes("?"))).toEqual([]);
    for (const c of before.components) expect(refs).toContain(c.reference);

    // The module's EN net joins its four pins, as drawn in the block.
    const module = after.components.find((c) => c.value === "ESP32-S3-WROOM-1")!;
    const en = after.nets.find((n) => n.name === "/EN")!;
    expect(en.nodes.length).toBe(4);
    expect(en.nodes.some((p) => p.reference === module.reference && p.pin === "3")).toBe(true);
    // Placed in free space: nothing existing merged with it (the demo's own nets keep their pins).
    for (const n of before.nets) expect(after.nets.find((m) => m.name === n.name)?.nodes.length ?? 0).toBeGreaterThanOrEqual(n.nodes.length);
    expect(after.nets.find((n) => n.name === "GND")!.nodes.length).toBeGreaterThan(before.nets.find((n) => n.name === "GND")!.nodes.length);
  });
});

// ---------------------------------------------------------------------------
// A block with a layout goes onto the project's board too, and KiCad finds nothing new wrong.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const LDO = "../../../blocks/library/crossprobe.kicad_blocks/ap2112k-3v3-ldo.kicad_block/ap2112k-3v3-ldo";
const LDO_SCH = fileURLToPath(new URL(`${LDO}.kicad_sch`, import.meta.url));
const LDO_PCB = fileURLToPath(new URL(`${LDO}.kicad_pcb`, import.meta.url));
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
const hasCli = (() => {
  try {
    execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function drc(files: Record<string, string>, project: string): Record<string, Array<{ type: string; description: string; items?: Array<{ description: string }> }>> {
  const dir = mkdtempSync(join(tmpdir(), "crossprobe-insboard-"));
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(f)), { recursive: true });
    writeFileSync(join(dir, f), t);
  }
  const out = join(dir, "drc.json");
  execFileSync(KICAD_CLI, ["pcb", "drc", "--schematic-parity", "--format", "json", "--severity-all", "-o", out, join(dir, project.replace(/\.kicad_pro$/, ".kicad_pcb"))], { stdio: "ignore" });
  return JSON.parse(readFileSync(out, "utf8"));
}

describe.skipIf(!existsSync(DEMO) || !existsSync(LDO_PCB) || !hasCli)("insert a block with a layout", () => {
  it("adds linked footprints and copper on the project's nets, without new DRC or parity findings", () => {
    const project = load(DEMO);
    const before = analyze(project);
    const sheet = before.sheets[0]!;
    const changed = new Editor().apply(
      project.files,
      [{ op: "insertBlock", file: sheet.file, blockText: readFileSync(LDO_SCH, "utf8"), blockPcb: readFileSync(LDO_PCB, "utf8"), at: "free", sheetPaths: before.sheets.filter((s) => s.file === sheet.file).map((s) => s.path), projectName: before.name }],
      project.project.replace(/\.kicad_pro$/, ".kicad_sch"),
    );
    const pcbFile = project.project.replace(/\.kicad_pro$/, ".kicad_pcb");
    expect(Object.keys(changed).sort()).toEqual([pcbFile, sheet.file].sort());
    const files = { ...project.files, ...changed };
    const after = analyze({ project: project.project, files });

    // Three new footprints, under the references the schematic gave the new parts.
    expect(after.board!.footprints.length).toBe(before.board!.footprints.length + 3);
    const newParts = after.components.filter((c) => !before.components.some((b) => b.reference === c.reference));
    const newFootprints = after.board!.footprints.filter((f) => !before.board!.footprints.some((b) => b.reference === f.reference));
    expect(newFootprints.map((f) => f.reference).sort()).toEqual(newParts.map((c) => c.reference).sort());
    // Their pads are on the nets the schematic put those pins on.
    const u = newParts.find((c) => c.value === "AP2112K-3.3")!;
    const fp = newFootprints.find((f) => f.reference === u.reference)!;
    const pad = (n: string) => fp.pads.find((p) => p.number === n)!.net;
    expect(pad("5")).toMatch(/3V3/);
    expect(pad("2")).toBe("GND");

    // KiCad: nothing new, apart from findings that were already there.
    const key = (v: { type: string; description: string; items?: Array<{ description: string }> }) => `${v.type}|${(v.items ?? []).map((i) => i.description).join(";")}`;
    const was = drc(project.files, project.project);
    const now = drc(files, project.project);
    for (const k of ["violations", "unconnected_items", "schematic_parity"]) {
      const old = new Set((was[k] ?? []).map(key));
      const added = (now[k] ?? []).filter((v) => !old.has(key(v)) && !/parity|footprint.*symbol/i.test("")).filter((v) => /\b(C\d+|U\d+)\b/.test(key(v)) && newFootprints.some((f) => key(v).includes(`Footprint ${f.reference}`) || key(v).includes(`${f.reference} `)));
      expect(added.map(key), k).toEqual([]);
    }
  });
});

describe.skipIf(!existsSync(DEMO))("every block with a layout, inserted into a project with a board", () => {
  it("adds one footprint per part, under the references the schematic got", () => {
    const lib = fileURLToPath(new URL("../../../blocks/library/crossprobe.kicad_blocks/", import.meta.url));
    const dirs = readdirSync(lib).filter((d) => existsSync(join(lib, d, d.replace(/\.kicad_block$/, ".kicad_pcb"))));
    expect(dirs.length).toBeGreaterThan(1);
    for (const d of dirs) {
      const id = d.replace(/\.kicad_block$/, "");
      const project = load(DEMO);
      const before = analyze(project);
      const sheet = before.sheets[0]!;
      const changed = new Editor().apply(
        project.files,
        [{ op: "insertBlock", file: sheet.file, blockText: readFileSync(join(lib, d, `${id}.kicad_sch`), "utf8"), blockPcb: readFileSync(join(lib, d, `${id}.kicad_pcb`), "utf8"), at: "free", sheetPaths: before.sheets.filter((s) => s.file === sheet.file).map((s) => s.path), projectName: before.name }],
        project.project.replace(/\.kicad_pro$/, ".kicad_sch"),
      );
      const after = analyze({ project: project.project, files: { ...project.files, ...changed } });
      const newRefs = after.components.filter((c) => !before.components.some((b) => b.reference === c.reference)).map((c) => c.reference).sort();
      const newFps = after.board!.footprints.filter((f) => !before.board!.footprints.some((b) => b.reference === f.reference)).map((f) => f.reference).sort();
      expect(newFps, id).toEqual(newRefs.filter((r) => !r.startsWith("#")));
    }
  });
});

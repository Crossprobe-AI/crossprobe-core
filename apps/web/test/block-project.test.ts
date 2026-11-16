/**
 * "Open in Crossprobe": a new project with a design block in its schematic.
 * The parts are numbered, the block's nets are intact, and KiCad opens the result.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyze";
import { projectFromBlock } from "../src/block-project";

const BLOCK = fileURLToPath(new URL("../../../blocks/library/crossprobe.kicad_blocks/esp32-s3-wroom-1-minimal.kicad_block/esp32-s3-wroom-1-minimal.kicad_sch", import.meta.url));
const KICAD_CLI = process.env.KICAD_CLI!;
const hasCli = (() => {
  try {
    execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("new project from a design block", () => {
  it("holds the block with its own reference designators and nothing else", () => {
    const { project, files } = projectFromBlock("ESP32-S3-WROOM-1 minimal system", readFileSync(BLOCK, "utf8"));
    expect(project).toBe("ESP32-S3-WROOM-1_minimal_system.kicad_pro");
    const p = analyze({ project, files });
    expect(p.name).toBe("ESP32-S3-WROOM-1_minimal_system");
    expect(p.components.length).toBe(16);
    const refs = p.components.map((c) => c.reference).sort();
    // The block's designators, as listed on its page and in the datasheet figure.
    expect(refs).toEqual(["C1", "C2", "C3", "C5", "C6", "C8", "JP1", "JP2", "JP3", "JP4", "R1", "R4", "R6", "R7", "SW1", "U1"]);
    expect(p.components.find((c) => c.reference === "C1")!.value).toBe("22uF");
    expect(p.components.find((c) => c.reference === "C3")!.value).toBe("0.1uF");
    const en = p.nets.find((n) => n.name === "/EN")!;
    expect(en.nodes.map((n) => `${n.reference}.${n.pin}`).sort()).toHaveLength(4);
    // The block fits the sheet: every part sits inside A4.
    for (const item of p.sheets[0]!.items) if (item.bbox) expect(item.bbox.x + item.bbox.w).toBeLessThan(297);
  });

  it.skipIf(!hasCli || !existsSync(BLOCK))("is a project KiCad opens, with the same nets", () => {
    const { project, files } = projectFromBlock("block test", readFileSync(BLOCK, "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-blockproject-"));
    for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
    const out = join(dir, "out.net");
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", out, join(dir, project.replace(/\.kicad_pro$/, ".kicad_sch"))], { stdio: "ignore" });
    const net = readFileSync(out, "utf8");
    expect(net).toContain("ESP32-S3-WROOM-1");
    expect(net).toContain('(name "/EN")');
    expect(net).toContain('(name "+3V3")');
  });
});

// ---------------------------------------------------------------------------
// Blocks with a PCB layout: the new project's board holds it, and KiCad agrees.

const LDO = "../../../blocks/library/crossprobe.kicad_blocks/ap2112k-3v3-ldo.kicad_block/ap2112k-3v3-ldo";
const LDO_SCH = fileURLToPath(new URL(`${LDO}.kicad_sch`, import.meta.url));
const LDO_PCB = fileURLToPath(new URL(`${LDO}.kicad_pcb`, import.meta.url));

describe.skipIf(!existsSync(LDO_PCB))("new project from a block with a layout", () => {
  it("puts the block's footprints and copper on the board, linked to the schematic", () => {
    const { project, files } = projectFromBlock("LDO", readFileSync(LDO_SCH, "utf8"), readFileSync(LDO_PCB, "utf8"));
    const p = analyze({ project, files });
    expect(p.board?.footprints.map((f) => f.reference).sort()).toEqual(["C1", "C2", "U1"]);
    expect(p.board!.tracks.length).toBeGreaterThan(5);
    expect(p.board!.vias.length).toBe(3);
    // Every footprint sits in its schematic's net, and nothing is left unrouted or out of sync.
    expect(p.unconnected?.length ?? 0).toBe(0);
    expect(p.parity.filter((f) => f.severity !== "ignore" && f.severity !== undefined && f.severity !== "none")).toEqual([]);
  });

  it.skipIf(!hasCli)("is a board KiCad's DRC and schematic-parity check accept (apart from the missing outline)", () => {
    const { project, files } = projectFromBlock("LDO", readFileSync(LDO_SCH, "utf8"), readFileSync(LDO_PCB, "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-blockboard-"));
    for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
    const out = join(dir, "drc.json");
    execFileSync(KICAD_CLI, ["pcb", "drc", "--schematic-parity", "--format", "json", "--severity-all", "-o", out, join(dir, project.replace(/\.kicad_pro$/, ".kicad_pcb"))], { stdio: "ignore" });
    const r = JSON.parse(readFileSync(out, "utf8")) as Record<string, Array<{ type: string }>>;
    expect((r.violations ?? []).map((v) => v.type).filter((t) => t !== "invalid_outline")).toEqual([]);
    expect(r.unconnected_items ?? []).toEqual([]);
    expect(r.schematic_parity ?? []).toEqual([]);
  });
});

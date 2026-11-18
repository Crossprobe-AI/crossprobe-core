/**
 * ERC exclusions, against KiCad. Findings on a copy of KiCad's pic_programmer demo are excluded the
 * way this app writes them (KiCad's entry format, in the project file's erc.erc_exclusions), and
 * KiCad's ERC must then report those findings as excluded.
 *
 * KiCad matches an entry's whole string. One it can't match isn't dropped: kicad-cli lists it as an
 * extra, excluded marker of its own, beside the live finding it failed to exclude. So each case
 * checks that excluding leaves KiCad's count of those findings unchanged, and that every one is
 * then excluded.
 *
 * Env: KICAD_CLI, KICAD_DEMOS.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addBusEntry, addLabel, addWire, buildNetlist, ercExclusionEntry, isErcExcluded, loadSchematic, projectErcSettings, runErc, sheetRoot, type ErcViolation } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMO = join(process.env.KICAD_DEMOS!, "pic_programmer");
const ROOT = "pic_programmer.kicad_sch";
const PRO = "pic_programmer.kicad_pro";
let cli = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

type KiCadFinding = { type: string; excluded?: boolean; items: Array<{ description: string; pos: { x: number; y: number } }> };

/** A copy of the demo with `edit` applied to one of its sheets. */
function project(sheet: string, edit: (root: ReturnType<typeof sheetRoot>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "erc-excl-"));
  cpSync(DEMO, dir, { recursive: true });
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  const doc = parse(read(sheet));
  edit(sheetRoot(doc));
  writeFileSync(join(dir, sheet), serialize(doc));
  const ours = () => {
    const s = loadSchematic(ROOT, read);
    return runErc(s, buildNetlist(s, { detail: true }), projectErcSettings(read(PRO)));
  };
  const exclude = (findings: ErcViolation[]) => {
    const pro = JSON.parse(read(PRO));
    pro.erc.erc_exclusions = findings.map((v) => [ercExclusionEntry(v), ""]);
    writeFileSync(join(dir, PRO), JSON.stringify(pro, null, 2));
  };
  /** Every finding of KiCad's ERC, on whichever sheet kicad-cli lists it. */
  const kicad = (): KiCadFinding[] => {
    const out = join(dir, "erc.json");
    try {
      execFileSync(KICAD_CLI, ["sch", "erc", "--format", "json", "--severity-all", "-o", out, join(dir, ROOT)], { stdio: "ignore" });
    } catch {
      // A non-zero exit only says there are findings.
    }
    return (JSON.parse(readFileSync(out, "utf8")) as { sheets: Array<{ violations: KiCadFinding[] }> }).sheets.flatMap((s) => s.violations);
  };
  return { read, ours, exclude, kicad };
}

/** Excluding `picked` makes KiCad report each matching finding as excluded, and no more of them. */
function expectKiCadExcludes(p: ReturnType<typeof project>, picked: ErcViolation[], theirs: (v: KiCadFinding) => boolean) {
  const before = p.kicad().filter(theirs);
  expect(before.length).toBeGreaterThan(0);
  expect(before.filter((v) => v.excluded)).toEqual([]);
  p.exclude(picked);
  const after = p.kicad().filter(theirs);
  expect(after.filter((v) => !v.excluded).map((v) => `${v.type}: ${v.items[0]?.description}`)).toEqual([]);
  expect(after.length).toBe(before.length);
}

describe.skipIf(!cli)("ERC exclusions", () => {
  it("KiCad honours the entries written here, and ours KiCad's", () => {
    const p = project(ROOT, (root) => {
      addLabel(root, "global_label", "LONELY", { x: 30.48, y: 30.48 }, 0, "input");
      addLabel(root, "global_label", "ALSO_LONELY", { x: 30.48, y: 40.64 }, 0, "input");
    });
    const lonely = p.ours().find((v) => v.type === "single_global_label" && v.items[0]!.description.includes("'LONELY'"))!;
    expect(lonely).toBeDefined();
    expectKiCadExcludes(p, [lonely], (v) => v.type === "single_global_label" && v.items[0]!.description.includes("'LONELY'"));
    const also = p.kicad().filter((v) => v.type === "single_global_label" && v.items[0]!.description.includes("'ALSO_LONELY'"));
    expect(also.map((v) => v.excluded ?? false)).toEqual([false]);

    // Ours agrees, with our entry and with one KiCad wrote (its UUIDs, its sheet path).
    const entries = projectErcSettings(p.read(PRO)).exclusions!.map((e) => e.entry);
    const findings = p.ours().filter((v) => v.type === "single_global_label");
    expect(findings.map((v) => [v.items[0]!.description, isErcExcluded(v, entries)])).toEqual([
      ["Global Label 'LONELY'", true],
      ["Global Label 'ALSO_LONELY'", false],
    ]);
    const kicadEntry = `single_global_label|304800|304800|0f6b0d1a-1111-4222-8333-444455556666|00000000-0000-0000-0000-000000000000|${lonely.sheet}||`;
    expect(isErcExcluded(lonely, [kicadEntry])).toBe(true);
    expect(isErcExcluded(lonely, [kicadEntry.replace("304800|304800", "304800|406400")])).toBe(false);
  });

  it("KiCad honours entries for labels and wires on a sub-sheet", () => {
    const p = project("pic_sockets.kicad_sch", (root) => {
      addLabel(root, "label", "NOWHERE", { x: 30.48, y: 30.48 });
      addWire(root, [{ x: 20.32, y: 50.8 }, { x: 40.64, y: 50.8 }]);
      addWire(root, [{ x: 30.48, y: 40.64 }, { x: 30.48, y: 60.96 }]);
      addLabel(root, "label", "CROSSING", { x: 30.48, y: 50.8 });
      // A wire to nowhere, and a hierarchical label with no sheet pin.
      addWire(root, [{ x: 60.96, y: 30.48 }, { x: 76.2, y: 30.48 }]);
      addLabel(root, "hierarchical_label", "ORPHAN", { x: 30.48, y: 76.2 }, 0, "input");
    });
    const mine = (v: { type: string; items: Array<{ description: string }> }) =>
      (v.type === "label_dangling" && v.items[0]!.description.includes("NOWHERE")) ||
      v.type === "label_multiple_wires" ||
      (v.type === "hier_label_mismatch" && v.items[0]!.description.includes("ORPHAN")) ||
      v.type === "unconnected_wire_endpoint";
    const picked = p.ours().filter(mine);
    expect([...new Set(picked.map((v) => v.type))].sort()).toEqual(["hier_label_mismatch", "label_dangling", "label_multiple_wires", "unconnected_wire_endpoint"]);
    for (const v of picked) for (const i of v.items) expect(i.uuid, `${v.type}: ${i.description}`).toBeTruthy();
    expectKiCadExcludes(p, picked, mine);
  });

  it("KiCad honours entries for off-grid ends, at the end KiCad marks", () => {
    // A wire whose only off-grid point is its end, and a bus entry whose second end is off grid:
    // KiCad's marker (and so its exclusion's place) is on that end, not the item's start, and this
    // check records no sheet.
    const p = project(ROOT, (root) => {
      addWire(root, [{ x: 25.4, y: 25.4 }, { x: 33.02, y: 25.9 }]);
      addBusEntry(root, { x: 25.4, y: 38.1 }, { x: 2.54, y: 2 });
    });
    const picked = p.ours().filter((v) => v.type === "endpoint_off_grid" && [25.9, 40.1].some((y) => Math.abs((v.at?.y ?? 0) - y) < 1e-6));
    expect(picked.map((v) => v.items[0]!.description.split(/[ ,]/)[0])).toEqual(["Wire", "Bus"]);
    const near = (a: number, mm: number) => Math.abs(a * 100 - mm) < 0.01;
    expectKiCadExcludes(p, picked, (v) => v.type === "endpoint_off_grid" && near(v.items[0]!.pos.x, 25.4) && [25.4, 38.1].some((y) => near(v.items[0]!.pos.y, y)));
  });
});

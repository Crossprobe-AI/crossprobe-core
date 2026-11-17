/**
 * ERC on buses, against KiCad. A new project gets a bus D[0..3] with mistakes on it: a plain label
 * "FOO" on the bus, a wire through a bus entry labelled X (not a member) and one labelled D1 (a
 * member), a bus label E[0..1] on a wire, and a second bus named twice (A[0..1], B[0..1]). KiCad's
 * ERC and ours report the same bus_to_net_conflict, net_not_bus_member and multiple_net_names
 * findings: message, sheet and place of each item (for a conflict, of the net item). (KiCad's item descriptions give a bus or wire
 * a hundredth of its length, so lengths are left out of the comparison.) A label on a bus is not
 * dangling.
 *
 * Env: KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addBus, addBusEntry, addLabel, addWire, buildNetlist, loadSchematic, newProject, runErc, sheetRoot } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

const TYPES = new Set(["bus_to_net_conflict", "net_not_bus_member", "multiple_net_names"]);

describe.skipIf(!cli)("ERC on buses", () => {
  it("finds what KiCad finds", () => {
    const dir = mkdtempSync(join(tmpdir(), "erc-bus-"));
    const { files } = newProject("bus");
    const sch = Object.keys(files).find((f) => f.endsWith(".kicad_sch"))!;
    const doc = parse(files[sch]!);
    const root = sheetRoot(doc);
    const g = (x: number, y: number) => ({ x: x * 2.54, y: y * 2.54 });
    addBus(root, [g(20, 20), g(60, 20)]);
    addLabel(root, "label", "D[0..3]", g(22, 20));
    addLabel(root, "label", "FOO", g(30, 20));
    addBusEntry(root, g(40, 20), { x: 2.54, y: 2.54 });
    addWire(root, [g(41, 21), g(45, 21)]);
    addLabel(root, "label", "X", g(45, 21));
    addBusEntry(root, g(50, 20), { x: 2.54, y: 2.54 });
    addWire(root, [g(51, 21), g(55, 21)]);
    addLabel(root, "label", "D1", g(55, 21));
    addWire(root, [g(20, 40), g(40, 40)]);
    addLabel(root, "label", "E[0..1]", g(25, 40));
    addBus(root, [g(20, 60), g(60, 60)]);
    addLabel(root, "label", "A[0..1]", g(22, 60));
    addLabel(root, "label", "B[0..1]", g(50, 60));
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), k === sch ? serialize(doc) : v);

    const out = join(dir, "erc.json");
    try {
      execFileSync(KICAD_CLI, ["sch", "erc", "--format", "json", "--severity-all", "-o", out, join(dir, sch)], { stdio: "ignore" });
    } catch {
      // A non-zero exit only says there are findings.
    }
    const at = (x: number, y: number) => `${x.toFixed(2)},${y.toFixed(2)}`;
    const item = (d: string, x: number, y: number) => `${d.replace(/, length [\d.]+ mm/, "")} @${at(x, y)}`;
    // For a conflict, KiCad names the first net item and the first bus item it finds; which bus item
    // comes first (the bus or a bus label on it) changes between its runs, so only the net item counts.
    const items = (type: string, list: string[]) => (type === "bus_to_net_conflict" ? list.slice(0, 1) : list).join(" ; ");
    type V = { type: string; description: string; items: Array<{ description: string; pos: { x: number; y: number } }> };
    const report = JSON.parse(readFileSync(out, "utf8")) as { sheets: Array<{ path: string; violations: V[] }> };
    const kicad = report.sheets.flatMap((s) => s.violations.filter((v) => TYPES.has(v.type)).map((v) => `${v.type} ${s.path} | ${v.description} | ${items(v.type, v.items.map((i) => item(i.description, i.pos.x * 100, i.pos.y * 100)))}`)).sort();
    const schematic = loadSchematic(sch, (f) => readFileSync(join(dir, f), "utf8"));
    const all = runErc(schematic, buildNetlist(schematic, { detail: true }));
    const ours = all.filter((v) => TYPES.has(v.type)).map((v) => `${v.type} ${v.sheetName} | ${v.message} | ${items(v.type, v.items.map((i) => item(i.description, i.at.x, i.at.y)))}`).sort();
    expect(ours).toEqual(kicad);
    expect(kicad).toHaveLength(5);
    expect(all.some((v) => v.type === "label_dangling" && v.items[0]!.description === "Label 'FOO'")).toBe(false);
  });
});

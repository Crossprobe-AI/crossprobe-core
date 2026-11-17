/**
 * A power part with an ordinary reference (PS1, not #PWR…) and a stacked pin ("[1-2]"): KiCad's
 * netlist lists it with both pads on the power net, and so does ours.
 *
 * Env: KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { buildNetlist, loadSchematic, newProject, placeSymbol, resolveLibrarySymbol, sheetRoot, withLibTableEntry } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

const LIB = `(kicad_symbol_lib (version 20241209) (generator "test")
  (symbol "VSTACK" (power) (pin_names (offset 0) hide) (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "PS" (at 0 -3.81 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "VSTACK" (at 0 3.556 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Description" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "VSTACK_0_1" (polyline (pts (xy -0.762 1.27) (xy 0 2.54) (xy 0.762 1.27)) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "VSTACK_1_1" (pin power_in line (at 0 0 90) (length 0) hide (name "VSTACK" (effects (font (size 1.27 1.27)))) (number "[1-2]" (effects (font (size 1.27 1.27))))))
  )
)
`;

describe.skipIf(!cli)("a power part with a stacked pin", () => {
  it("lists every pad, as KiCad does", () => {
    const dir = mkdtempSync(join(tmpdir(), "pwrstack-"));
    const { files } = newProject("ps");
    const name = Object.keys(files).find((f) => f.endsWith(".kicad_sch"))!;
    const doc = parse(files[name]!);
    placeSymbol(sheetRoot(doc), resolveLibrarySymbol(LIB, "ps", "VSTACK"), { reference: "PS1", sheetPaths: ["/"], projectName: "ps", at: { x: 101.6, y: 101.6 } });
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), k === name ? serialize(doc) : v);
    writeFileSync(join(dir, "ps.kicad_sym"), LIB);
    writeFileSync(join(dir, "sym-lib-table"), withLibTableEntry(undefined, "sym", "ps", "${KIPRJMOD}/ps.kicad_sym"));
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "-o", join(dir, "net.net"), join(dir, name)], { stdio: "ignore" });
    const text = readFileSync(join(dir, "net.net"), "utf8");
    const theirs = [...text.matchAll(/\(node\s*\(ref "PS1"\)\s*\(pin "(\d+)"\)/g)].map((m) => m[1]).sort();
    expect(theirs).toEqual(["1", "2"]);
    const s = loadSchematic(name, (f) => readFileSync(join(dir, f), "utf8"));
    const ours = buildNetlist(s).nets.flatMap((n) => n.nodes.filter((x) => x.reference === "PS1").map((x) => `${n.name} ${x.pin}`)).sort();
    const net = /\(net\s+\(code "\d+"\)\s+\(name "([^"]+)"\)[^]*?\(ref "PS1"\)/.exec(text)![1];
    expect(ours).toEqual([`${net} 1`, `${net} 2`]);
  });
});

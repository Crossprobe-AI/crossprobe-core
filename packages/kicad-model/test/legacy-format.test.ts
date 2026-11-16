/**
 * Schematics in older file formats, against KiCad. A KiCad 6 file keeps each part's reference,
 * value and footprint in the root sheet's `symbol_instances` (read up to version 20221001), and a
 * power symbol with a hidden pin names its net after the pin. From KiCad 7 (20230221) the net takes
 * the symbol's value. Our netlist of the same text must be the one `kicad-cli` gives for each version.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, parse, type List } from "@crossprobe/kicad-sexpr";
import { buildNetlist, loadSchematic } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

const font = "(effects (font (size 1.27 1.27)))";
const hidden = "(effects (font (size 1.27 1.27)) hide)";
/** From 20221002 the reference is kept with the symbol, per sheet path. */
const instance = (version: number, reference: string) =>
  version < 20221002 ? "" : `\n    (instances (project "old" (path "/00000000-0000-4000-8000-000000000001" (reference "${reference}") (unit 1))))`;
const R = (version: number, n: number, x: number) => `
  (symbol (lib_id "Device:R") (at ${x} 100 0) (unit 1) (in_bom yes) (on_board yes)
    (uuid 00000000-0000-4000-8000-00000000001${n})
    (property "Reference" "R" (id 0) (at ${x + 2} 99 0) ${font})
    (property "Value" "R" (id 1) (at ${x + 2} 101 0) ${font})
    (property "Footprint" "" (id 2) (at ${x} 100 0) ${hidden})
    (property "Datasheet" "~" (id 3) (at ${x} 100 0) ${hidden})
    (pin "1" (uuid 00000000-0000-4000-8000-0000000001${n}1))
    (pin "2" (uuid 00000000-0000-4000-8000-0000000001${n}2))${instance(version, `R${n}`)})`;

/** Two resistors joined at pin 1; R1's pin 2 on a power symbol with the value VDD and a hidden pin named VCC. */
const schematic = (version: number) => `(kicad_sch (version ${version}) (generator eeschema)
  (uuid 00000000-0000-4000-8000-000000000001)
  (paper "A4")
  (lib_symbols
    (symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (in_bom yes) (on_board yes)
      (property "Reference" "R" (id 0) (at 2.032 0 90) ${font})
      (property "Value" "R" (id 1) (at 0 0 90) ${font})
      (property "Footprint" "" (id 2) (at -1.778 0 90) ${hidden})
      (property "Datasheet" "~" (id 3) (at 0 0 0) ${hidden})
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default) (color 0 0 0 0)) (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~" ${font}) (number "1" ${font}))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" ${font}) (number "2" ${font}))))
    (symbol "power:VDD" (power) (pin_names (offset 0)) (in_bom yes) (on_board yes)
      (property "Reference" "#PWR" (id 0) (at 0 -3.81 0) ${hidden})
      (property "Value" "VDD" (id 1) (at 0 3.81 0) ${font})
      (property "Footprint" "" (id 2) (at 0 0 0) ${hidden})
      (property "Datasheet" "" (id 3) (at 0 0 0) ${hidden})
      (symbol "VDD_0_1"
        (polyline (pts (xy 0 0) (xy 0 2.54)) (stroke (width 0) (type default) (color 0 0 0 0)) (fill (type none))))
      (symbol "VDD_1_1"
        (pin power_in line (at 0 0 90) (length 0) hide (name "VCC" ${font}) (number "1" ${font})))))
  (wire (pts (xy 100 96.19) (xy 110 96.19)) (stroke (width 0) (type default) (color 0 0 0 0))
    (uuid 00000000-0000-4000-8000-000000000002))${R(version, 1, 100)}${R(version, 2, 110)}
  (symbol (lib_id "power:VDD") (at 100 103.81 180) (unit 1) (in_bom yes) (on_board yes)
    (uuid 00000000-0000-4000-8000-000000000013)
    (property "Reference" "#PWR" (id 0) (at 100 107 0) ${hidden})
    (property "Value" "VDD" (id 1) (at 100 108 0) ${font})
    (property "Footprint" "" (id 2) (at 100 103.81 0) ${hidden})
    (property "Datasheet" "" (id 3) (at 100 103.81 0) ${hidden})
    (pin "1" (uuid 00000000-0000-4000-8000-000000000131))${instance(version, "#PWR01")})
  (sheet_instances (path "/" (page "1")))
  (symbol_instances
    (path "/00000000-0000-4000-8000-000000000011" (reference "R1") (unit 1) (value "10k") (footprint "Resistor_SMD:R_0603_1608Metric"))
    (path "/00000000-0000-4000-8000-000000000012" (reference "R2") (unit 1) (value "22k") (footprint ""))
    (path "/00000000-0000-4000-8000-000000000013" (reference "#PWR01") (unit 1) (value "VDD") (footprint "")))
)
`;

const ours = (text: string) => {
  const s = loadSchematic("old.kicad_sch", () => text);
  return { schematic: s, nets: buildNetlist(s).nets.map((n) => `${n.name}: ${n.nodes.map((x) => `${x.reference}.${x.pin}`).sort().join(" ")}`).sort() };
};

describe("older schematic formats", () => {
  it("a KiCad 6 file's references, values and footprints come from the root sheet's table", () => {
    const { schematic: s, nets } = ours(schematic(20211123));
    expect(s.components.map((c) => `${c.reference} ${c.value} ${c.footprint}`)).toEqual(["R1 10k Resistor_SMD:R_0603_1608Metric", "R2 22k "]);
    expect(nets).toEqual(["Net-(R1-Pad1): R1.1 R2.1", "VCC: R1.2", "unconnected-(R2-Pad2): R2.2"]);
  });

  it("from KiCad 7 a power symbol's value names the net", () => {
    expect(ours(schematic(20230220)).nets).toContain("VCC: R1.2");
    expect(ours(schematic(20230221)).nets).toContain("VDD: R1.2");
  });

  it.skipIf(!cli).each([20211123, 20221001, 20221002, 20230220, 20230221])("the netlist of version %i is KiCad's", (version) => {
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-old-"));
    const file = join(dir, "old.kicad_sch");
    writeFileSync(file, schematic(version));
    execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", join(dir, "old.net"), file], { stdio: "ignore" });
    const root = parse(readFileSync(join(dir, "old.net"), "utf8")).children[0] as List;
    const kicad = findChildren(findChild(root, "nets")!, "net")
      .map((net) => `${arg(findChild(net, "name"), 0)}: ${findChildren(net, "node").map((n) => `${arg(findChild(n, "ref"), 0)}.${arg(findChild(n, "pin"), 0)}`).sort().join(" ")}`)
      .sort();
    expect(ours(schematic(version)).nets).toEqual(kicad);
  });
});

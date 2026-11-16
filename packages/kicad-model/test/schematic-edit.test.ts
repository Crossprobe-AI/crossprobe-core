/**
 * Key test for schematic editing: apply every kind of edit to a copy of a
 * demo project, then check that
 *  - KiCad loads the edited file (kicad-cli exports a netlist from it),
 *  - KiCad's netlist of the edited file equals ours (edits mean what we think),
 *  - the file changed only where we edited it (small line diff).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import {
  addJunction,
  addLabel,
  addNoConnect,
  addSheet,
  addSheetPin,
  addWire,
  newSheetFile,
  buildNetlist,
  deleteItem,
  duplicateItems,
  findItem,
  placeSymbol,
  loadSchematic,
  mirrorSymbol,
  moveItem,
  rotateItem,
  setSymbolField,
  sheetRoot,
  transformLibPoint,
  unitPins,
} from "../src/index.js";

const DEMO = process.env.EDIT_DEMO ?? "/Library/Application Support/kicad/demos/pic_programmer";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
const hasCli = (() => {
  try {
    execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function kicadNets(sch: string, out: string): Map<string, string> {
  execFileSync(KICAD_CLI, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", out, sch], { stdio: "ignore" });
  const root = parse(readFileSync(out, "utf8")).children[0] as List;
  const byPin = new Map<string, string>();
  for (const net of findChildren(findChild(root, "nets")!, "net")) {
    const pins = findChildren(net, "node").map((n) => `${arg(findChild(n, "ref"), 0)}:${arg(findChild(n, "pin"), 0)}`).sort();
    for (const p of pins) byPin.set(p, pins.join(" "));
  }
  return byPin;
}

describe.skipIf(!existsSync(DEMO) || !hasCli)("schematic edits round-trip through KiCad", () => {
  it("applies edits that KiCad reads back with the same connectivity", () => {
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-edit-"));
    cpSync(DEMO, dir, { recursive: true });
    const file = join(dir, "pic_programmer.kicad_sch");
    const original = readFileSync(file, "utf8");
    const schematic = loadSchematic("pic_programmer.kicad_sch", (f) => readFileSync(join(dir, f), "utf8"));
    const doc = parse(original);
    const root = sheetRoot(doc);
    const rootSheet = schematic.root;
    const placement = (ref: string) => schematic.placements.find((p) => p.sheet === rootSheet && p.reference === ref)!;
    const pinAt = (ref: string, number: string) => {
      const pl = placement(ref);
      const pin = unitPins(pl.lib!, pl.unit, pl.symbol.bodyStyle).find((p) => p.number === number)!;
      return transformLibPoint(pin.at, pl.symbol, pl.symbol.at);
    };

    // 1. Field edits, including a reference change.
    setSymbolField(findItem(root, placement("R1").symbol.uuid)!, "Value", "4k7");
    setSymbolField(findItem(root, placement("C5").symbol.uuid)!, "MPN", "GRM188R71H103KA01D");
    setSymbolField(findItem(root, placement("R2").symbol.uuid)!, "Reference", "R200", rootSheet.path);

    // 2. A wire joining two pins on different nets, with a label and junction on it.
    const a = pinAt("R4", "1");
    const b = pinAt("R5", "1");
    const corner = { x: b.x, y: a.y };
    addWire(root, [a, corner, b]);
    addLabel(root, "label", "EDITED_NET", corner);
    addJunction(root, corner);

    // 3. A no-connect on an unused pin, and a deleted wire.
    addNoConnect(root, pinAt("U3", "2"));
    const someWire = schematic.root.data.wires[0]!;
    const wireNode = root.children.find(
      (c) => (c as List).children && findChild(c as List, "pts") && JSON.stringify(findChildren(findChild(c as List, "pts")!, "xy").map((x) => [arg(x, 0), arg(x, 1)])) === JSON.stringify([[someWire.a.x, someWire.a.y], [someWire.b.x, someWire.b.y]]),
    ) as List;
    deleteItem(root, String(arg(findChild(wireNode, "uuid"), 0)));

    // 4. Move, rotate and mirror symbols.
    moveItem(findItem(root, placement("C9").symbol.uuid)!, 0, 2.54);
    rotateItem(findItem(root, placement("C3").symbol.uuid)!);
    mirrorSymbol(findItem(root, placement("D11").symbol.uuid)!, "y");

    // 5. Duplicate a resistor (new reference) and place a new one from the embedded library.
    duplicateItems(root, root, [placement("R5").symbol.uuid], 25.4, 0, { [placement("R5").symbol.uuid]: "R100" }, [rootSheet.path]);
    const libDef = findChildren(findChild(root, "lib_symbols")!, "symbol").find((s) => arg(s, 0) === placement("R5").symbol.libId)!;
    placeSymbol(root, libDef, { at: { x: 200.66, y: 180.34 }, reference: "R101", sheetPaths: [rootSheet.path], projectName: "pic_programmer" });

    // 6. A new hierarchical sheet: a resistor inside, wired to a hierarchical
    //    label, and the parent's sheet pin wired to R4 pin 2.
    const sheetUuid = addSheet(root, { at: { x: 30.48, y: 30.48 }, size: { x: 25.4, y: 15.24 }, name: "Sub", file: "sub.kicad_sch", projectName: "pic_programmer", parentPaths: [rootSheet.path], page: 3 });
    const sheetNode = findItem(root, sheetUuid)!;
    const pinPos = addSheetPin(sheetNode, "SIG", "input", { x: 55.88, y: 38.1 });
    const r4p2 = pinAt("R4", "2");
    addWire(root, [pinPos, { x: r4p2.x, y: pinPos.y }, r4p2]);
    const child = parse(newSheetFile());
    const childRoot = sheetRoot(child);
    const childPath = `${rootSheet.path}/${sheetUuid}`;
    placeSymbol(childRoot, libDef, { at: { x: 101.6, y: 76.2 }, reference: "R300", sheetPaths: [childPath], projectName: "pic_programmer" });
    // The R symbol is vertical: pin 1 is 3.81 mm above its anchor.
    addLabel(childRoot, "hierarchical_label", "SIG", { x: 101.6, y: 66.04 });
    addWire(childRoot, [{ x: 101.6, y: 66.04 }, { x: 101.6, y: 72.39 }]);
    writeFileSync(join(dir, "sub.kicad_sch"), serialize(child));

    const edited = serialize(doc);
    writeFileSync(file, edited);

    // KiCad loads it, and agrees with us about the connectivity.
    const theirs = kicadNets(file, join(dir, "edited.net"));
    const ours = new Map<string, string>();
    const reloaded = loadSchematic("pic_programmer.kicad_sch", (f) => readFileSync(join(dir, f), "utf8"));
    for (const n of buildNetlist(reloaded).nets) {
      const pins = n.nodes.map((x) => `${x.reference}:${x.pin}`).sort();
      for (const p of pins) ours.set(p, pins.join(" "));
    }
    const mismatched = [...theirs.keys()].filter((p) => theirs.get(p) !== ours.get(p));
    expect(mismatched.slice(0, 5)).toEqual([]);
    expect(theirs.get("R200:1")).toBeDefined();
    expect(theirs.get("R100:1")).toBeDefined();
    expect(theirs.get("R101:2")).toBeDefined();
    // The child sheet's resistor is on R4 pin 2's net, through the sheet pin.
    expect(theirs.get("R300:1")).toContain("R4:2");
    expect(theirs.get(`R4:1`)).toContain("R5:1");

    // The diff is limited to what we changed.
    const before = original.split("\n");
    const after = edited.split("\n");
    const common = new Set(before);
    const changed = after.filter((l) => !common.has(l)).length;
    expect(changed).toBeLessThan(260);
  });
});

/**
 * Footprints made with the footprint editor's edits, read back by KiCad itself (pcbnew's
 * FootprintLoad in KiCad's bundled Python): every pad (number, type, shape, position, size,
 * drill, angle, layers), every graphic (kind, layer, points, width) and the attributes must be
 * what we wrote.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addFpGraphic, addFpPad, addFpPadArray, addFpPasteWindows, footprintNode, moveFpItems, newFootprintText, parseBoard, rotateFpItems, setFpCourtyard, setFpPad, setFpProps } from "../src/index.js";

const q4 = (v: number) => Math.round(v * 1e4) / 1e4;
const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";

const DUMP = `
import sys, json, pcbnew
fp = pcbnew.FootprintLoad(sys.argv[1], sys.argv[2])
mm = pcbnew.ToMM
shapes = {pcbnew.PAD_SHAPE_RECT: "rect", pcbnew.PAD_SHAPE_ROUNDRECT: "roundrect", pcbnew.PAD_SHAPE_CIRCLE: "circle", pcbnew.PAD_SHAPE_OVAL: "oval"}
types = {pcbnew.PAD_ATTRIB_SMD: "smd", pcbnew.PAD_ATTRIB_PTH: "thru_hole", pcbnew.PAD_ATTRIB_NPTH: "np_thru_hole"}
pads = []
for p in fp.Pads():
    pads.append({"number": p.GetNumber(), "type": types.get(p.GetAttribute(), "?"), "shape": shapes.get(p.GetShape(), "?"),
        "at": [round(mm(p.GetPosition().x), 4), round(mm(p.GetPosition().y), 4)], "size": [round(mm(p.GetSize().x), 4), round(mm(p.GetSize().y), 4)],
        "drill": round(mm(p.GetDrillSize().x), 4), "angle": round(p.GetOrientationDegrees(), 3),
        "layers": sorted(fp.GetBoard().GetLayerName(l) if fp.GetBoard() else pcbnew.LayerName(l) for l in p.GetLayerSet().Seq()),
        "mask": (lambda v: None if v is None else round(mm(v), 4))(p.GetLocalSolderMaskMargin()),
        "paste": (lambda v: None if v is None else round(mm(v), 4))(p.GetLocalSolderPasteMargin()),
        "ratio": (lambda v: None if v is None else round(v, 4))(p.GetLocalSolderPasteMarginRatio()),
        "heatsink": p.GetProperty() == pcbnew.PAD_PROP_HEATSINK})
kinds = {pcbnew.SHAPE_T_SEGMENT: "line", pcbnew.SHAPE_T_RECTANGLE: "rect", pcbnew.SHAPE_T_CIRCLE: "circle", pcbnew.SHAPE_T_POLY: "poly", pcbnew.SHAPE_T_ARC: "arc"}
graphics = []
for g in fp.GraphicalItems():
    if g.GetClass() != "PCB_SHAPE": continue
    graphics.append({"kind": kinds.get(g.GetShape(), "?"), "layer": pcbnew.LayerName(g.GetLayer()), "width": round(mm(g.GetWidth()), 4),
        "start": [round(mm(g.GetStart().x), 4), round(mm(g.GetStart().y), 4)], "end": [round(mm(g.GetEnd().x), 4), round(mm(g.GetEnd().y), 4)]})
print(json.dumps({"name": fp.GetFPID().GetLibItemName().wx_str(), "descr": fp.GetLibDescription(), "tags": fp.GetKeywords(),
    "smd": bool(fp.GetAttributes() & pcbnew.FP_SMD), "tht": bool(fp.GetAttributes() & pcbnew.FP_THROUGH_HOLE),
    "nobom": bool(fp.GetAttributes() & pcbnew.FP_EXCLUDE_FROM_BOM), "pads": pads, "graphics": graphics}))
`;

describe.skipIf(!existsSync(PY))("footprint editor", () => {
  it("writes footprints KiCad reads exactly as made", () => {
    const doc = parse(newFootprintText("Test_Module", { smd: false }));
    const fp = footprintNode(doc);
    const header = addFpPadArray(fp, { type: "thru_hole", shape: "circle", size: { x: 1.7, y: 1.7 }, drill: 1 }, { first: 1, columns: 4, rows: 1, pitch: { x: 2.54, y: 0 }, origin: { x: 0, y: 0 } });
    setFpPad(fp, header[0]!, { shape: "rect" });
    const smd = addFpPad(fp, { number: "5", type: "smd", shape: "roundrect", at: { x: 2, y: 4 }, size: { x: 1.2, y: 0.6 } });
    addFpPad(fp, { number: "6", type: "smd", shape: "oval", at: { x: 6, y: 4 }, size: { x: 1.5, y: 0.8 }, rotation: 90 });
    addFpPad(fp, { number: "", type: "np_thru_hole", shape: "circle", at: { x: 9, y: 2 }, size: { x: 1.2, y: 1.2 }, drill: 1.2 });
    moveFpItems(fp, [smd], { x: 0.5, y: 0 });
    setFpPad(fp, smd, { size: { x: 1.4, y: 0.7 } });
    addFpGraphic(fp, { kind: "rect", layer: "F.Fab", points: [{ x: -1.5, y: -1.5 }, { x: 9.5, y: 5.5 }] });
    addFpGraphic(fp, { kind: "line", layer: "F.SilkS", points: [{ x: -1.6, y: -1.6 }, { x: 9.6, y: -1.6 }] });
    addFpGraphic(fp, { kind: "circle", layer: "F.SilkS", points: [{ x: -2, y: 0 }, { x: -1.8, y: 0 }] });
    addFpGraphic(fp, { kind: "poly", layer: "F.Fab", points: [{ x: 0, y: 6 }, { x: 1, y: 6 }, { x: 0.5, y: 6.8 }], fill: true });
    // An exposed pad as KiCad's generator makes them: heatsink, smaller mask, paste in windows.
    const ep = addFpPad(fp, { number: "7", type: "smd", shape: "rect", at: { x: 4, y: 8 }, size: { x: 1.7, y: 1.7 } });
    setFpPad(fp, ep, { maskMargin: -0.05, pasteRatio: -0.2, heatsink: true });
    const windows = addFpPasteWindows(fp, ep, { columns: 2, rows: 2, coverage: 0.66 });
    addFpGraphic(fp, { kind: "arc", layer: "F.Fab", points: [{ x: -1, y: 7 }, { x: 0, y: 6.5 }, { x: 1, y: 7 }] });
    // The header row turned a quarter about its middle pad.
    rotateFpItems(fp, header, { x: 2.54, y: 0 }, 90);
    setFpCourtyard(fp);
    setFpProps(fp, { description: "A test module", tags: "test module", attr: "through_hole", excludeFromBom: true });
    const text = serialize(doc);

    const dir = mkdtempSync(join(tmpdir(), "crossprobe-fp-"));
    const lib = join(dir, "Test.pretty");
    mkdirSync(lib);
    writeFileSync(join(lib, "Test_Module.kicad_mod"), text);
    writeFileSync(join(dir, "dump.py"), DUMP);
    const k = JSON.parse(execFileSync(PY, [join(dir, "dump.py"), lib, "Test_Module"], { encoding: "utf8" }));

    // Ours, the same file read by our parser (footprint at the origin).
    const ours = parseBoard(`(kicad_pcb (version 20260206)\n${text}\n)`).footprints[0]!;
    expect(k.name).toBe("Test_Module");
    expect([k.descr, k.tags, k.tht, k.smd, k.nobom]).toEqual(["A test module", "test module", true, false, true]);
    const norm = (l: string) => l.replace("*.Cu", "F.Cu,B.Cu").replace("*.Mask", "F.Mask,B.Mask").split(",");
    expect(k.pads.map((p: any) => [p.number, p.type, p.shape, p.at, p.size, p.type === "smd" ? 0 : p.drill, ((p.angle % 360) + 360) % 360])).toEqual(
      ours.pads.map((p) => [p.number, p.type, p.shape, [p.at.x, p.at.y].map(q4), [p.size.x, p.size.y].map(q4), p.type === "smd" ? 0 : p.drill, ((p.rotation % 360) + 360) % 360]),
    );
    for (const [i, p] of ours.pads.entries()) expect(k.pads[i].layers.filter((l: string) => /Cu|Mask|Paste/.test(l) && !/^In\d/.test(l)).sort()).toEqual(p.layers.flatMap(norm).sort());
    const canon = (l: string) => ({ "F.Silkscreen": "F.SilkS", "B.Silkscreen": "B.SilkS", "F.Courtyard": "F.CrtYd", "B.Courtyard": "B.CrtYd" })[l] ?? l;
    expect(k.graphics.map((g: any) => [g.kind, canon(g.layer), g.width])).toEqual(ours.graphics.map((g) => [g.kind, g.layer, g.width]));
    // The exposed pad and its paste windows, as KiCad reads them.
    const kep = k.pads.find((p: any) => p.number === "7");
    expect([kep.mask, kep.ratio, kep.heatsink, kep.layers.some((l: string) => /Paste/.test(l))]).toEqual([-0.05, -0.2, true, false]);
    const kw = k.pads.filter((p: any) => p.number === "" && p.type === "smd");
    expect(kw.length).toBe(windows.length);
    expect(kw.map((p: any) => [p.size, p.layers])).toEqual(Array(4).fill([[0.6905, 0.6905], ["F.Paste"]]));
    expect(kw.map((p: any) => p.at).sort()).toEqual([[3.575, 7.575], [3.575, 8.425], [4.425, 7.575], [4.425, 8.425]]);
    // The turned row: pads 1-4 now down the x = 2.54 line, at 90°.
    expect(k.pads.filter((p: any) => ["1", "2", "3", "4"].includes(p.number)).map((p: any) => [p.at, ((p.angle % 360) + 360) % 360])).toEqual([[[2.54, 2.54], 90], [[2.54, 0], 90], [[2.54, -2.54], 90], [[2.54, -5.08], 90]]);
    expect(k.graphics.some((g: any) => g.kind === "arc")).toBe(true);
  });
});

describe.skipIf(!existsSync(`${process.env.KICAD_DEMOS}/pic_programmer/pic_programmer.kicad_pcb`))("update footprint from library", () => {
  it("leaves pads, nets and fields where they were when the library is unchanged (front and back, any angle)", async () => {
    const { readFileSync } = await import("node:fs");
    const { boardRoot, flipFootprint, updateFootprintFromLibrary } = await import("../src/index.js");
    const text = readFileSync(`${process.env.KICAD_DEMOS}/pic_programmer/pic_programmer.kicad_pcb`, "utf8");
    const before = parseBoard(text);
    const doc = parse(text);
    const root = boardRoot(doc);
    // Each footprint's own geometry as a library file: undo its placement (only the pads matter here).
    const multi = before.footprints.filter((f) => f.pads.length > 1);
    const picks = [...multi.filter((f) => f.layer === "B.Cu").slice(0, 4), ...multi.filter((f) => f.layer === "F.Cu" && f.rotation % 180 !== 0).slice(0, 4), ...multi.filter((f) => f.layer === "F.Cu" && f.rotation % 180 === 0).slice(0, 4)];
    expect(picks.some((f) => f.layer === "B.Cu") && picks.some((f) => f.rotation % 180 !== 0)).toBe(true);
    for (const f of picks) {
      const node = root.children.find((c) => isFp(c, f.uuid))!;
      // A back-side footprint is stored flipped: its library form is the front one.
      const copy = parse(serialize(node));
      if (f.layer === "B.Cu") flipFootprint(footprintNode(copy));
      const lib = libraryForm(serialize(copy));
      expect(updateFootprintFromLibrary(root, f.uuid, lib)).toBe(f.uuid);
    }
    const after = parseBoard(serialize(doc));
    for (const f of picks) {
      const g = after.footprints.find((x) => x.uuid === f.uuid)!;
      expect([g.reference, g.value, g.layer, Math.round(g.rotation)], f.reference).toEqual([f.reference, f.value, f.layer, Math.round(f.rotation)]);
      const key = (p: { number: string; at: { x: number; y: number }; net: string }) => `${p.number} ${p.at.x.toFixed(3)},${p.at.y.toFixed(3)} ${p.net}`;
      expect(g.pads.map(key).sort(), f.reference).toEqual(f.pads.map(key).sort());
    }
  });
});

const isFp = (c: unknown, uuid: string) => {
  const t = serialize(c as never);
  return t.startsWith("(footprint") && t.includes(uuid);
};

/** A placed footprint turned back into library form: KiCad's files keep pads in the footprint frame already. */
function libraryForm(placed: string): string {
  const d = parse(placed);
  const fp = footprintNode(d);
  // Drop placement-only parts: position, uuid, symbol link and nets (pad positions are already local).
  fp.children = fp.children.filter((c, i) => !(i > 0 && typeof c === "object" && "children" in c && ["at", "uuid", "path", "sheetname", "sheetfile"].includes(serialize(c).slice(1).split(/[\s)]/)[0]!)));
  return serialize(d).replace(/\(net \d+ "[^"]*"\)/g, "").replace(/\(net "[^"]*"\)/g, "");
}

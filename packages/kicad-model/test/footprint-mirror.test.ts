/**
 * Footprint editor mirror, renumber, custom pads and 3D models, against KiCad. A footprint
 * with rotated, custom-shaped and offset pads, graphics and justified text is mirrored by us and,
 * from the same file, by pcbnew (PCB_SHAPE.Mirror and PCB_TEXT.Mirror; pads as the footprint
 * editor's mirror tool does it: FlipPrimitives, position, −angle). KiCad must read the two the
 * same: pads (position, angle, custom outline), graphics and text (position, justification).
 * Renumbering and the 3D model are read back by pcbnew too.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addFpCustomPad, addFpGraphic, addFpPad, footprintNode, mirrorFpItems, newFootprintText, renumberFpPads, setFpModel, withUuids } from "../src/index.js";

const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";

const SCRIPT = `
import sys, json, pcbnew
lib, name, mirror, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
fp = pcbnew.FootprintLoad(lib, name)
# On a board, as in the editor (flipping custom pad primitives needs one).
board = pcbnew.BOARD()
board.Add(fp)
mm = pcbnew.ToMM
if mirror != "none":
    d = pcbnew.FLIP_DIRECTION_LEFT_RIGHT if mirror == "x" else pcbnew.FLIP_DIRECTION_TOP_BOTTOM
    c = pcbnew.VECTOR2I(pcbnew.FromMM(1), pcbnew.FromMM(0.5))
    for p in fp.Pads():
        if p.GetShape(pcbnew.PADSTACK.ALL_LAYERS) == pcbnew.PAD_SHAPE_CUSTOM: p.FlipPrimitives(d)
        q = p.GetPosition()
        if mirror == "x": q.x = 2 * c.x - q.x
        else: q.y = 2 * c.y - q.y
        p.SetPosition(q)
        o = p.GetOffset(pcbnew.PADSTACK.ALL_LAYERS)
        if mirror == "x": o.x = -o.x
        else: o.y = -o.y
        p.SetOffset(pcbnew.PADSTACK.ALL_LAYERS, o)
        p.SetOrientationDegrees(-p.GetOrientationDegrees())
    for g in fp.GraphicalItems(): g.Mirror(c, d)
    for f in fp.GetFields(): f.Mirror(c, d)
pads = []
for p in fp.Pads():
    poly = p.GetEffectivePolygon(pcbnew.F_Cu, pcbnew.ERROR_INSIDE)
    box = poly.BBox()
    pads.append({"number": p.GetNumber(), "at": [round(mm(p.GetPosition().x), 3), round(mm(p.GetPosition().y), 3)],
        "angle": round(p.GetOrientationDegrees() % 360, 2) % 180 if p.GetShape(pcbnew.PADSTACK.ALL_LAYERS) != pcbnew.PAD_SHAPE_CUSTOM else round(p.GetOrientationDegrees() % 360, 2),
        "offset": [round(mm(p.GetOffset(pcbnew.PADSTACK.ALL_LAYERS).x), 3), round(mm(p.GetOffset(pcbnew.PADSTACK.ALL_LAYERS).y), 3)],
        "copper": [round(mm(box.GetX()), 2), round(mm(box.GetY()), 2), round(mm(box.GetRight()), 2), round(mm(box.GetBottom()), 2)], "area": round(poly.Area() / 1e12, 3)})
graphics = sorted([[pcbnew.LayerName(g.GetLayer()), round(mm(g.GetStart().x), 3), round(mm(g.GetStart().y), 3), round(mm(g.GetEnd().x), 3), round(mm(g.GetEnd().y), 3)] for g in fp.GraphicalItems() if g.GetClass() == "PCB_SHAPE"])
fields = sorted([[f.GetName(), round(mm(f.GetPosition().x), 3), round(mm(f.GetPosition().y), 3), int(f.GetHorizJustify())] for f in fp.GetFields()])
models = [[m.m_Filename, m.m_Offset.x, m.m_Offset.y, m.m_Offset.z, m.m_Rotation.z] for m in fp.Models()]
open(out, "w").write(json.dumps({"pads": sorted(pads, key=lambda p: p["number"]), "graphics": graphics, "fields": fields, "models": models}))
`;

function footprint() {
  const doc = parse(withUuids(newFootprintText("Mirror_Test", { smd: true })));
  const fp = footprintNode(doc);
  const ids = [
    addFpPad(fp, { number: "1", type: "smd", shape: "roundrect", at: { x: -1.5, y: 0.3 }, size: { x: 1.2, y: 0.6 }, rotation: 30 }),
    addFpPad(fp, { number: "2", type: "smd", shape: "oval", at: { x: 2.5, y: -1 }, size: { x: 1.5, y: 0.8 }, rotation: 90 }),
    addFpPad(fp, { number: "3", type: "thru_hole", shape: "rect", at: { x: 0, y: 2.5 }, size: { x: 1.7, y: 1.7 }, drill: 1 }),
    addFpCustomPad(fp, { number: "4", type: "smd", at: { x: 4, y: 2 }, polygon: [{ x: 3.6, y: 1.6 }, { x: 5.2, y: 1.6 }, { x: 5.2, y: 2.2 }, { x: 4.4, y: 2.4 }, { x: 3.6, y: 2.4 }] }),
    addFpGraphic(fp, { kind: "line", layer: "F.SilkS", points: [{ x: -3, y: -2 }, { x: 4, y: -2.5 }] }),
    addFpGraphic(fp, { kind: "rect", layer: "F.Fab", points: [{ x: -2.5, y: -1.5 }, { x: 3.5, y: 3 }] }),
    addFpGraphic(fp, { kind: "circle", layer: "F.SilkS", points: [{ x: -3, y: 1 }, { x: -2.7, y: 1 }] }),
  ];
  return { doc, fp, ids };
}

describe.skipIf(!existsSync(PY))("footprint mirror, renumber, custom pads, 3D model", () => {
  const dir = mkdtempSync(join(tmpdir(), "fpmirror-"));
  const dump = (lib: string, mirror: string) => {
    const out = join(dir, `dump-${Math.random()}.json`);
    // pcbnew may crash on exit after the footprint is written out: the output file is what counts.
    spawnSync(PY, ["-c", SCRIPT, lib, "Mirror_Test", mirror, out], { stdio: "ignore" });
    return JSON.parse(readFileSync(out, "utf8"));
  };
  const save = (name: string, text: string) => {
    const lib = join(dir, `${name}.pretty`);
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "Mirror_Test.kicad_mod"), text);
    return lib;
  };

  for (const axis of ["x", "y"] as const)
    it(`mirrors ${axis === "x" ? "left-right" : "top-bottom"} as KiCad does`, () => {
      const { doc, fp, ids } = footprint();
      // The fields too (left-justified, so the justification swaps across a vertical line).
      const fieldIds = fp.children.filter((c) => (c as { children?: unknown[] }).children && String((c as never as { children: Array<{ raw?: string }> }).children[0]?.raw) === "property").map((c) => {
        const u = (c as never as { children: Array<{ children?: Array<{ raw?: string }> }> }).children.find((x) => x.children?.[0]?.raw === "uuid");
        return String(u?.children?.[1]?.raw ?? "").replace(/"/g, "");
      });
      const original = save(`orig-${axis}`, serialize(doc));
      mirrorFpItems(fp, [...ids, ...fieldIds.filter(Boolean)], axis === "x" ? 1 : 0.5, axis);
      const ours = save(`ours-${axis}`, serialize(doc));
      expect(dump(ours, "none")).toEqual(dump(original, axis));
    });

  it("renumbers pads in the order picked, and keeps the 3D model", () => {
    const { doc, fp, ids } = footprint();
    renumberFpPads(fp, [ids[3]!, ids[0]!, ids[2]!, ids[1]!], { first: 1, prefix: "A" });
    setFpModel(fp, { path: "${KICAD9_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.wrl", offset: { x: 0.5, y: -0.25, z: 0 }, rotate: { x: 0, y: 0, z: 90 } });
    const d = dump(save("renumber", serialize(doc)), "none");
    expect(d.pads.map((p: { number: string; at: number[] }) => `${p.number}@${p.at.join(",")}`)).toEqual(["A1@4,2", "A2@-1.5,0.3", "A3@0,2.5", "A4@2.5,-1"]);
    expect(d.models).toEqual([["${KICAD9_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.wrl", 0.5, -0.25, 0, 90]]);
  });
});

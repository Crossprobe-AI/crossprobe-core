/**
 * The land-pattern generator against KiCad's own library: from the dimensions KiCad's footprint
 * generator used, the pads come out the same (number, type, shape, position, size, drill), and an
 * exposed pad's paste windows land where KiCad's are.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { boardRoot, checkBoard, landPatternText, newProject, parseBoard, placeFootprint, projectDesignRules, type LandPattern } from "../src/index.js";

const LIB = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints";
const fpOf = (text: string) => parseBoard(`(kicad_pcb (version 20260206)\n${text}\n)`).footprints[0]!;
const q = (v: number) => Math.round(v * 1000) / 1000;
const pads = (text: string) =>
  fpOf(text)
    .pads.filter((p) => p.number)
    .map((p) => `${p.number} ${p.type} ${p.shape} ${q(p.at.x)},${q(p.at.y)} ${q(p.size.x)}x${q(p.size.y)}${p.drill ? ` d${q(p.drill)}` : ""}`);
const paste = (text: string) =>
  fpOf(text)
    .pads.filter((p) => !p.number && p.layers.join() === "F.Paste")
    .map((p) => [q(p.at.x), q(p.at.y), q(p.size.x)]);

const CASES: Array<[string, LandPattern]> = [
  ["Package_DFN_QFN.pretty/QFN-16-1EP_3x3mm_P0.5mm_EP1.7x1.7mm", { family: "quad", name: "QFN16", pins: 16, pitch: 0.5, padWidth: 0.25, padLength: 0.825, rowSpan: 2.925, exposedPad: { w: 1.7, h: 1.7, pasteColumns: 2, pasteRows: 2, pasteCoverage: 0.66 }, body: { w: 3, h: 3 } }],
  ["Package_SO.pretty/SOIC-8_3.9x4.9mm_P1.27mm", { family: "dual", name: "SOIC8", pins: 8, pitch: 1.27, padWidth: 0.6, padLength: 1.95, rowSpan: 4.95, body: { w: 3.9, h: 4.9 } }],
  ["Package_QFP.pretty/TQFP-44_10x10mm_P0.8mm", { family: "quad", name: "TQFP44", pins: 44, pitch: 0.8, padWidth: 0.55, padLength: 1.475, rowSpan: 11.325, body: { w: 10, h: 10 } }],
  ["Resistor_SMD.pretty/R_0603_1608Metric", { family: "chip", name: "R0603", pins: 2, padWidth: 0.95, padLength: 0.8, rowSpan: 1.65, body: { w: 1.6, h: 0.8 } }],
  ["Connector_PinHeader_2.54mm.pretty/PinHeader_2x05_P2.54mm_Vertical", { family: "grid", name: "H2x5", pins: 10, columns: 2, rows: 5, pitch: 2.54, padWidth: 1.7, drill: 1, shape: "circle" }],
];

describe.skipIf(!existsSync(LIB))("land patterns", () => {
  it.each(CASES)("%s", (lib, lp) => {
    const kicad = readFileSync(`${LIB}/${lib}.kicad_mod`, "utf8");
    const ours = landPatternText(lp);
    expect(pads(ours).sort()).toEqual(pads(kicad).sort());
    const kp = paste(kicad);
    if (kp.length) {
      const op = paste(ours);
      expect(op.length).toBe(kp.length);
      for (const [x, y, w] of kp) expect(op.some(([a, b, c]) => Math.abs(a! - x!) < 0.01 && Math.abs(b! - y!) < 0.01 && Math.abs(c! - w!) < 0.01), `paste at ${x},${y}`).toBe(true);
    }
    // And it's a footprint our own checks are happy with: a courtyard, pad 1, no duplicate numbers.
    const fp = fpOf(ours);
    expect(fp.graphics.some((g) => g.layer === "F.CrtYd")).toBe(true);
    expect(new Set(fp.pads.filter((p) => p.number).map((p) => p.number)).size).toBe(fp.pads.filter((p) => p.number).length);
  });
});

describe("land pattern silkscreen", () => {
  it("stays off the pads and the mask openings (our DRC, KiCad's silk checks)", () => {
    const { files } = newProject("lp");
    const name = Object.keys(files).find((f) => f.endsWith(".kicad_pcb"))!;
    const doc = parse(files[name]!);
    const root = boardRoot(doc);
    CASES.forEach(([, lp], i) => placeFootprint(root, landPatternText(lp), { at: { x: 20 + i * 20, y: 20 }, reference: `U${i + 1}`, value: lp.name, libId: `lp:${lp.name}` }));
    const board = parseBoard(serialize(doc));
    const bad = checkBoard(board, projectDesignRules(files[Object.keys(files).find((f) => f.endsWith(".kicad_pro"))!])).filter((v) => /silk/.test(v.type));
    expect(bad.map((v) => `${v.type}: ${v.items.map((it) => it.description).join(" / ")}`)).toEqual([]);
  });
});

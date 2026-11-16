/**
 * Blind, buried and micro vias against KiCad: a 4-layer board with one via of each kind (made
 * with addVia) reads back with its type, its drill files are KiCad's (one per via span, the same
 * names, FileFunction and holes as `kicad-cli pcb export drill`), and each copper layer's Gerber
 * flashes only the vias that reach it (within 1% of KiCad's plot).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addVia, boardRoot, fabricationFiles, newProject, parseBoard, setCopperLayerCount } from "../src/index.js";
import { area, readGerber, xor } from "./gerber-read.js";

const KICAD_CLI = process.env.KICAD_CLI!;
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

/** Hole positions as numbers ("X10.0Y-10.0" and "X10Y-10" alike), with their tool's size. */
const holes = (text: string) => {
  const tools = new Map<string, string>();
  let size = "";
  const out: string[] = [];
  for (const l of text.split("\n")) {
    let m = /^T(\d+)C([\d.]+)/.exec(l);
    if (m) tools.set(m[1]!, Number(m[2]).toFixed(3));
    else if ((m = /^T(\d+)$/.exec(l))) size = tools.get(m[1]!) ?? "";
    else if ((m = /^X(-?[\d.]+)Y(-?[\d.]+)$/.exec(l))) out.push(`${size} ${Number(m[1]).toFixed(3)},${Number(m[2]).toFixed(3)}`);
  }
  return out.sort();
};
const fileFunction = (text: string) => /TF\.FileFunction,([^\n]*)/.exec(text)?.[1]?.trim();

function board() {
  const { files } = newProject("vias");
  const name = Object.keys(files).find((f) => f.endsWith(".kicad_pcb"))!;
  const doc = parse(files[name]!);
  const root = boardRoot(doc);
  setCopperLayerCount(root, 4);
  addVia(root, { at: { x: 10, y: 10 }, size: 0.6, drill: 0.3, layers: ["F.Cu", "B.Cu"], net: "" });
  addVia(root, { type: "blind", at: { x: 12, y: 10 }, size: 0.5, drill: 0.25, layers: ["F.Cu", "In1.Cu"], net: "" });
  addVia(root, { type: "buried", at: { x: 14, y: 10 }, size: 0.5, drill: 0.25, layers: ["In1.Cu", "In2.Cu"], net: "" });
  addVia(root, { type: "micro", at: { x: 16, y: 10 }, size: 0.3, drill: 0.1, layers: ["B.Cu", "In2.Cu"], net: "" });
  addVia(root, { type: "micro", at: { x: 18, y: 10 }, size: 0.3, drill: 0.1, layers: ["In2.Cu", "B.Cu"], net: "" });
  return { files: { ...files, [name]: serialize(doc) }, name };
}

describe("blind, buried and micro vias", () => {
  it("read back with their type and span", () => {
    const { files, name } = board();
    const b = parseBoard(files[name]!);
    expect(b.vias.map((v) => `${v.type ?? "through"} ${v.layers.join("-")}`)).toEqual(["through F.Cu-B.Cu", "blind F.Cu-In1.Cu", "buried In1.Cu-In2.Cu", "micro B.Cu-In2.Cu", "micro In2.Cu-B.Cu"]);
  });

  it.skipIf(!cli)("drill files and copper as KiCad makes them", { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "vias-"));
    const { files, name } = board();
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k.split("/").pop()!), v);
    const pcb = join(dir, name.split("/").pop()!);
    execFileSync(KICAD_CLI, ["pcb", "export", "drill", "--format", "excellon", "--excellon-separate-th", "-o", dir + "/", pcb], { stdio: "ignore" });
    execFileSync(KICAD_CLI, ["pcb", "export", "gerbers", "--layers", "F.Cu,In1.Cu,In2.Cu,B.Cu", "--no-protel-ext", "-o", dir + "/", pcb], { stdio: "ignore" });
    const ours = fabricationFiles(parseBoard(files[name]!), { name: "vias" });
    const kicadDrills = readdirSync(dir).filter((f) => f.endsWith(".drl") && !f.endsWith("-NPTH.drl")).sort();
    expect(Object.keys(ours).filter((f) => f.endsWith(".drl")).sort()).toEqual(kicadDrills);
    for (const f of kicadDrills) {
      const k = readFileSync(join(dir, f), "utf8");
      expect(fileFunction(ours[f]!), f).toBe(fileFunction(k)!.replace(/,Drill$/, ""));
      expect(holes(ours[f]!), f).toEqual(holes(k));
    }
    for (const layer of ["F_Cu", "In1_Cu", "In2_Cu", "B_Cu"]) {
      const f = readdirSync(dir).find((x) => x.endsWith(`-${layer}.gbr`))!;
      const kicad = readGerber(readFileSync(join(dir, f), "utf8"));
      const mine = readGerber(ours[Object.keys(ours).find((x) => x.endsWith(`-${layer}.gbr`))!]!);
      expect(area(xor(kicad, mine)) / area(kicad), layer).toBeLessThan(0.01);
    }
  });
});

/**
 * Drawing sheets (.kicad_wks), against KiCad's plots. vme-wren's own sheet, interf_u's (old
 * format, %-codes), and KiCad's ISO, GOST (rotated texts, first-page-only items) and default
 * templates are put on demo schematics; every text drawingSheetPrims places is in KiCad's SVG of
 * that page, with the same text at the same place. (KiCad's ${KICAD_VERSION} is its own version;
 * ours is given as KiCad's here.)
 *
 * Env: KICAD_CLI, KICAD_DEMOS. The templates come from KiCad's installation.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, isList, parse } from "@crossprobe/kicad-sexpr";
import { drawingSheetPrims, loadSchematic, parseDrawingSheet, sheetsByPage } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMOS = process.env.KICAD_DEMOS!;
const TEMPLATES = join(dirname(process.env.KICAD_SYMBOLS!), "template");
let cli = existsSync(join(DEMOS, "vme-wren")) && existsSync(TEMPLATES);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

// [demo, root sheet, the sheet: "own" (the project's), a file of the demo, or a KiCad template]
const CASES: Array<[string, string, string]> = [
  ["vme-wren", "vme-wren", "own"],
  ["interf_u", "interf_u", "demo:pagelayout_logo.kicad_wks"],
  ["pic_programmer", "pic_programmer", "A3_ISO5457-1999_ISO7200-2004_EN.kicad_wks"],
  ["pic_programmer", "pic_programmer", "gost_landscape.kicad_wks"],
  ["pic_programmer", "pic_programmer", "pagelayout_default.kicad_wks"],
  ["complex_hierarchy", "complex_hierarchy", "A4_ISO5457-1999_ISO7200-2004_EN.kicad_wks"],
];

describe.skipIf(!cli)("drawing sheets", () => {
  it.each(CASES)("%s with %s", (demo, root, which) => {
    const dir = mkdtempSync(join(tmpdir(), "wks-"));
    cpSync(join(DEMOS, demo), dir, { recursive: true });
    const proFile = join(dir, `${root}.kicad_pro`);
    const pro = JSON.parse(readFileSync(proFile, "utf8"));
    if (which !== "own") {
      const name = which.replace(/^demo:/, "");
      if (!which.startsWith("demo:")) cpSync(join(TEMPLATES, name), join(dir, name));
      pro.schematic.page_layout_descr_file = name;
      writeFileSync(proFile, JSON.stringify(pro, null, 2));
    }
    const sheet = parseDrawingSheet(readFileSync(join(dir, pro.schematic.page_layout_descr_file), "utf8"));
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    const s = loadSchematic(`${root}.kicad_sch`, read);
    execFileSync(KICAD_CLI, ["sch", "export", "svg", "-o", join(dir, "svg"), join(dir, `${root}.kicad_sch`)], { stdio: "ignore" });
    const pages = sheetsByPage(s);
    let placed = 0;
    const missing: string[] = [];
    for (const [i, page] of pages.entries()) {
      const svgName = page.namePath === "/" ? `${root}.svg` : `${root}-${page.namePath.split("/").filter(Boolean).join("-")}.svg`;
      const svg = readFileSync(join(dir, "svg", svgName), "utf8");
      const [, w, h] = /width="([\d.]+)mm" height="([\d.]+)mm"/.exec(svg)!;
      const unescape = (t: string) => t.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      const kicad = [...svg.matchAll(/<text x="([-\d.]+)" y="([-\d.]+)"[^>]*>([^<]*)</g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), text: unescape(m[3]!) }));
      const paper = findChild(parse(read(page.file)).children.find(isList)!, "paper");
      const info = { titleBlock: page.data.titleBlock, paper: String(arg(paper, 0) ?? "A4"), page: page.pageNumber ?? String(i + 1), pages: pages.length, sheetName: page.ref?.name ?? "", sheetPath: page.namePath, fileName: page.file, variables: s.textVariables, generator: "KiCad E.D.A. 10.0.4" };
      for (const p of drawingSheetPrims(sheet, Number(w), Number(h), info, i === 0)) {
        if (p.kind !== "text" || !p.text.trim() || p.text.includes("\n") || p.text.includes("KiCad E.D.A.")) continue;
        // KiCad's SVG gives a text's baseline: half its height below a centred one's middle.
        const dy = p.v === "center" ? p.size.y / 2 : p.v === "top" ? p.size.y : 0;
        if (kicad.some((k) => k.text === p.text && Math.abs(k.x - p.at.x) < 0.05 && Math.abs(k.y - (p.at.y + dy)) < 0.05)) placed++;
        else missing.push(`${p.text} @${p.at.x.toFixed(2)},${(p.at.y + dy).toFixed(2)}`);
      }
    }
    expect(missing).toEqual([]);
    expect(placed).toBeGreaterThan(20);
  });
});

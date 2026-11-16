/**
 * Page settings against KiCad: a new project's schematic set to A3 portrait and its board to
 * user size 200 × 150 mm, both with a title block. kicad-cli's SVG exports come out at those
 * paper sizes with the title block's text in the frame, and the settings read back.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { boardRoot, newProject, pageSettings, setPageSettings, sheetRoot } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

const settings = { paper: "A3", portrait: true, title: "Sensor board", date: "2026-11-07", rev: "B", company: "Crossprobe", comments: ["Checked by KiCad", "", "", "", "", "", "", "", "Ninth"] };

describe("page settings", () => {
  it("set and read back", () => {
    const { files } = newProject("pages");
    const sch = Object.keys(files).find((f) => f.endsWith(".kicad_sch"))!;
    const doc = parse(files[sch]!);
    setPageSettings(sheetRoot(doc), settings);
    expect(pageSettings(sheetRoot(parse(serialize(doc))))).toEqual({ ...settings, width: undefined, height: undefined });
  });

  it.skipIf(!cli)("KiCad plots the paper and title block as set", { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "pages-"));
    const { files } = newProject("pages");
    for (const [k, v] of Object.entries(files)) {
      const doc = parse(v);
      if (k.endsWith(".kicad_sch")) setPageSettings(sheetRoot(doc), settings);
      if (k.endsWith(".kicad_pcb")) setPageSettings(boardRoot(doc), { ...settings, paper: "User", width: 200, height: 150, portrait: false, rev: "C" });
      writeFileSync(join(dir, k.split("/").pop()!), /\.kicad_(sch|pcb)$/.test(k) ? serialize(doc) : v);
    }
    execFileSync(KICAD_CLI, ["sch", "export", "svg", "-o", dir, join(dir, "pages.kicad_sch")], { stdio: "ignore" });
    const schSvg = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".svg"))!), "utf8");
    const size = (svg: string) => (/width="([\d.]+)mm" height="([\d.]+)mm"/.exec(svg) ?? []).slice(1).map((v) => Math.round(Number(v)));
    expect(size(schSvg)).toEqual([297, 420]);
    // (KiCad's default drawing sheet shows comments 1–4; 9 is kept in the file.)
    for (const t of ["Sensor board", "Rev: B", "Crossprobe", "Checked by KiCad", "2026-11-07"]) expect(schSvg, t).toContain(t);
    execFileSync(KICAD_CLI, ["pcb", "export", "svg", "--mode-single", "--layers", "F.Cu", "-o", join(dir, "board.svg"), join(dir, "pages.kicad_pcb")], { stdio: "ignore" });
    const pcbSvg = readFileSync(join(dir, "board.svg"), "utf8");
    expect(size(pcbSvg)).toEqual([200, 150]);
    for (const t of ["Sensor board", "Rev: C"]) expect(pcbSvg, t).toContain(t);
  });
});

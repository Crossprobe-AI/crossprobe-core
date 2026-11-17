/**
 * The board's page frame with the project's text variables: a drawing sheet text naming a
 * project variable shows its value, as in KiCad's own SVG plot of the board (kicad-cli pcb export
 * svg draws the board's drawing sheet). interf_u's board sheet gets a text "Rev ${BOARD_REV} by
 * ${AUTHOR}" and its project those two variables.
 * Env: KICAD_CLI, KICAD_DEMOS.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boardFrame, parseBoard, parseDrawingSheet } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMOS = process.env.KICAD_DEMOS!;
const DEMO = join(DEMOS ?? "", "interf_u");
const VARS = { BOARD_REV: "C.7", AUTHOR: "A. Tester" };
const SHOWN = "Rev C.7 by A. Tester";
const TEXT = '  (tbtext "Rev ${BOARD_REV} by ${AUTHOR}" (name "") (pos 60 30 ltcorner))\n';

const withText = (wks: string) => wks.replace(/\)\s*$/, `${TEXT})\n`);

describe("board frame text variables", () => {
  it("a sheet text shows the project's variables", () => {
    const sheet = parseDrawingSheet(withText('(kicad_wks (version 20231118) (generator "pl_editor")\n  (setup (textsize 1.5 1.5) (linewidth 0.15) (textlinewidth 0.15) (left_margin 10) (right_margin 10) (top_margin 10) (bottom_margin 10))\n)'));
    const page = { paper: "A4", title: "", date: "", rev: "", company: "", comments: [] };
    const texts = boardFrame(page, "x.kicad_pcb", sheet, { variables: VARS }).filter((p) => p.kind === "text").map((p) => (p as { text: string }).text);
    expect(texts).toContain(SHOWN);
  });
});

describe.skipIf(!existsSync(DEMO) || !existsSync(KICAD_CLI))("board frame text variables as KiCad plots them", () => {
  it("interf_u", () => {
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-frame-"));
    cpSync(DEMO, dir, { recursive: true });
    const pro = JSON.parse(readFileSync(join(dir, "interf_u.kicad_pro"), "utf8"));
    pro.text_variables = { ...(pro.text_variables ?? {}), ...VARS };
    writeFileSync(join(dir, "interf_u.kicad_pro"), JSON.stringify(pro, null, 2));
    const wksFile = join(dir, pro.pcbnew.page_layout_descr_file);
    writeFileSync(wksFile, withText(readFileSync(wksFile, "utf8")));
    execFileSync(KICAD_CLI, ["pcb", "export", "svg", "--mode-single", "--layers", "Edge.Cuts", "-o", join(dir, "board.svg"), join(dir, "interf_u.kicad_pcb")], { stdio: "ignore" });
    const svg = readFileSync(join(dir, "board.svg"), "utf8");
    const kicad = [...svg.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]!.replace(/&amp;/g, "&").trim());
    expect(kicad).toContain(SHOWN);
    // Ours, from the same files.
    const board = parseBoard(readFileSync(join(dir, "interf_u.kicad_pcb"), "utf8"));
    const ours = boardFrame(board.page!, "interf_u.kicad_pcb", parseDrawingSheet(readFileSync(wksFile, "utf8")), { variables: pro.text_variables })
      .filter((p) => p.kind === "text")
      .map((p) => (p as { text: string }).text);
    expect(ours).toContain(SHOWN);
  });
});

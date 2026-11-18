/**
 * Drawing-sheet paths from the project file, resolved as KiCad does, against the files the
 * browser holds (keyed from where the project was opened); and the app reading interf_u's sheet
 * through such paths for the board and the schematic. Env: KICAD_DEMOS.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyze";
import { resolveProjectPath } from "../src/project-path";

const dir = "work/board/";
const files = {
  "work/board/board.kicad_pro": "",
  "work/board/sheets/a.kicad_wks": "",
  "work/board/b.kicad_wks": "",
  "work/shared/c.kicad_wks": "",
};

describe("project paths", () => {
  it("relative, ${KIPRJMOD} and ./ paths, with backslashes", () => {
    expect(resolveProjectPath("sheets/a.kicad_wks", dir, files)).toEqual({
      file: "work/board/sheets/a.kicad_wks",
    });
    expect(
      resolveProjectPath("${KIPRJMOD}/sheets/a.kicad_wks", dir, files),
    ).toEqual({ file: "work/board/sheets/a.kicad_wks" });
    expect(resolveProjectPath("./b.kicad_wks", dir, files)).toEqual({
      file: "work/board/b.kicad_wks",
    });
    expect(resolveProjectPath("sheets\\a.kicad_wks", dir, files)).toEqual({
      file: "work/board/sheets/a.kicad_wks",
    });
  });
  it("project variables, whose values may use ${KIPRJMOD} or other variables", () => {
    const vars = {
      SHEETS: "${KIPRJMOD}/sheets",
      SHEET: "${SHEETS}/a.kicad_wks",
    };
    expect(resolveProjectPath("${SHEET}", dir, files, vars)).toEqual({
      file: "work/board/sheets/a.kicad_wks",
    });
  });
  it("an absolute path into the project folder", () => {
    expect(
      resolveProjectPath(
        "/Users/someone/work/board/sheets/a.kicad_wks",
        dir,
        files,
      ),
    ).toEqual({ file: "work/board/sheets/a.kicad_wks" });
    expect(
      resolveProjectPath("C:\\Projects\\board\\b.kicad_wks", dir, files),
    ).toEqual({ file: "work/board/b.kicad_wks" });
  });
  it("outside the project, or missing in it", () => {
    // Above the project folder: read when the browser holds it (opened from a folder above), else outside.
    expect(resolveProjectPath("../shared/c.kicad_wks", dir, files)).toEqual({
      file: "work/shared/c.kicad_wks",
    });
    expect(resolveProjectPath("../elsewhere/c.kicad_wks", dir, files)).toEqual({
      outside: "../elsewhere/c.kicad_wks",
    });
    expect(resolveProjectPath("/opt/kicad/c.kicad_wks", dir, files)).toEqual({
      outside: "/opt/kicad/c.kicad_wks",
    });
    expect(
      resolveProjectPath("${KICAD10_TEMPLATE_DIR}/x.kicad_wks", dir, files),
    ).toEqual({ outside: "${KICAD10_TEMPLATE_DIR}/x.kicad_wks" });
    expect(resolveProjectPath("sheets/none.kicad_wks", dir, files)).toEqual({
      missing: "sheets/none.kicad_wks",
    });
    // Out of the project folder and back in: missing, not outside.
    expect(resolveProjectPath("../board/none.kicad_wks", dir, files)).toEqual({ missing: "../board/none.kicad_wks" });
  });
});

const DEMO = `${process.env.KICAD_DEMOS}/interf_u`;

describe.skipIf(!existsSync(DEMO))(
  "the project's drawing sheets in the app",
  () => {
    const load = (
      pcbnew: string,
      schematic: string,
      vars?: Record<string, string>,
    ) => {
      const files: Record<string, string> = {};
      for (const f of [
        "interf_u.kicad_pro",
        "interf_u.kicad_pcb",
        "interf_u.kicad_sch",
        "pagelayout_logo.kicad_wks",
      ])
        files[`interf_u/${f}`] = readFileSync(`${DEMO}/${f}`, "utf8");
      const pro = JSON.parse(files["interf_u/interf_u.kicad_pro"]!);
      pro.pcbnew.page_layout_descr_file = pcbnew;
      pro.schematic.page_layout_descr_file = schematic;
      if (vars) pro.text_variables = vars;
      files["interf_u/interf_u.kicad_pro"] = JSON.stringify(pro);
      return analyze({ project: "interf_u/interf_u.kicad_pro", files });
    };
    const sheetWarnings = (v: ReturnType<typeof analyze>) =>
      v.warnings.filter((w) => w.includes("drawing sheet"));

    it("an absolute path into the project, for the board and the schematic", () => {
      const v = load(
        "/home/someone/interf_u/pagelayout_logo.kicad_wks",
        "C:\\kicad\\interf_u\\pagelayout_logo.kicad_wks",
      );
      expect(sheetWarnings(v)).toEqual([]);
      expect(v.boardDrawingSheet).toBeDefined();
      // The sheet's logo is on every schematic page (the default frame has none).
      expect(JSON.stringify(v.sheets[0]!.items).includes("data:image/")).toBe(
        true,
      );
    });
    it("the schematic's path with project variables, as the board's", () => {
      const v = load(
        "${SHEETS}/pagelayout_logo.kicad_wks",
        "${SHEETS}/pagelayout_logo.kicad_wks",
        { SHEETS: "${KIPRJMOD}" },
      );
      expect(sheetWarnings(v)).toEqual([]);
      expect(v.boardDrawingSheet).toBeDefined();
      expect(JSON.stringify(v.sheets[0]!.items).includes("data:image/")).toBe(
        true,
      );
    });
    it("warns: outside the project, or not found", () => {
      const v = load("../shared/x.kicad_wks", "missing.kicad_wks");
      expect(sheetWarnings(v)).toEqual([
        "drawing sheet missing.kicad_wks not found: the default frame is drawn",
        "board drawing sheet ../shared/x.kicad_wks is outside the project (only the project's own files are read): the default frame is drawn",
      ]);
    });
  },
);

/**
 * Page numbers of sheets in a KiCad 6 project, which keeps them in the root file's sheet_instances
 * rather than on the sheet symbols. The sheet hint's Page button sets one on the root sheet and one
 * on a sheet two levels down: our hierarchy has the new numbers, and so do KiCad's plots of those pages.
 *
 * Env: KICAD_QA (KiCad's qa/data folder), KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSchematic } from "@crossprobe/kicad-model";
import { Editor } from "../src/edit/ops";

const KICAD_CLI = process.env.KICAD_CLI!;
const DATA = join(process.env.KICAD_QA ?? "", "eeschema/netlists/complex_hierarchy_shared");
let cli = existsSync(DATA);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

const ROOT = "complex_hierarchy.kicad_sch";
const SUB = "ampli_ht/ampli_ht.kicad_sch";

describe.skipIf(!cli)("KiCad 6 sheet page numbers", () => {
  it("are written where KiCad 6 keeps them", () => {
    const dir = mkdtempSync(join(tmpdir(), "v6-pages-"));
    cpSync(DATA, dir, { recursive: true });
    const files = { [ROOT]: readFileSync(join(dir, ROOT), "utf8"), [SUB]: readFileSync(join(dir, SUB), "utf8") };
    const read = (f: string) => files[f] ?? readFileSync(join(dir, f), "utf8");
    const before = loadSchematic(ROOT, read);
    const top = before.sheets.find((s) => s.ref?.name === "ampli_ht_vertical1")!;
    const nested = before.sheets.find((s) => s.parent === top)!;
    expect([top.pageNumber, nested.pageNumber]).toEqual(["2", "3"]);

    const changed = new Editor().apply(
      files,
      [
        { op: "setSheetProps", file: ROOT, uuid: top.ref!.uuid, page: { path: before.root.path, number: "12" } },
        { op: "setSheetProps", file: SUB, uuid: nested.ref!.uuid, page: { path: top.path, number: "13" } },
      ],
      ROOT,
    );
    // The sheet symbols have no instances in a KiCad 6 file: the sub-sheet's text stays as it was.
    expect(changed[SUB] ?? files[SUB]).toBe(files[SUB]);
    Object.assign(files, changed);
    const after = loadSchematic(ROOT, read);
    const pages = (s: typeof after) => s.sheets.map((x) => `${x.namePath} ${x.pageNumber}`);
    expect(pages(after)).toEqual(pages(before).map((p) => p.replace(/^(\/ampli_ht_vertical1\/) 2$/, "$1 12").replace(/^(\/ampli_ht_vertical1\/Filter FC=1000Hz1\/) 3$/, "$1 13")));

    writeFileSync(join(dir, ROOT), files[ROOT]!);
    // KiCad's plot of each page: its title block says "Id: <page>/<pages>".
    execFileSync(KICAD_CLI, ["sch", "export", "svg", "-o", join(dir, "svg"), join(dir, ROOT)], { stdio: "ignore" });
    const id = (page: string) => /Id: (\d+)\/\d+</.exec(readFileSync(join(dir, "svg", `complex_hierarchy-${page}.svg`), "utf8"))?.[1];
    expect([id("ampli_ht_vertical1"), id("ampli_ht_vertical1-Filter FC=1000Hz1"), id("ampli_ht_horizontal1")]).toEqual(["12", "13", "4"]);
  });
});

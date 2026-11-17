/**
 * Text variables as KiCad shows them. On a copy of KiCad's pic_programmer demo, texts that use the
 * title block's, the sheet's and the project's variables and other parts' fields (${R1:VALUE})
 * are added to the root sheet and a sub-sheet, and a field of R1 uses its own (${REFERENCE}).
 * KiCad plots the sheets, and each text in its plot reads as shownText resolves it, including
 * what it prints for a part or a field that does not exist.
 *
 * Env: KICAD_CLI, KICAD_DEMOS.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { addSchText, findItem, loadSchematic, setFieldVisible, setSymbolAttributes, setSymbolField, sheetRoot, shownText } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
const DEMO = join(process.env.KICAD_DEMOS!, "pic_programmer");
let cli = existsSync(DEMO);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

/** Each starts with a tag of its own, to find it in KiCad's plot. */
const TEXTS = [
  "A> ${TITLE} | ${REVISION} | ${ISSUE_DATE} | ${COMPANY} | ${COMMENT1} | ${COMMENT2}",
  "B> ${#} of ${##} | ${SHEETNAME} | ${SHEETPATH} | ${FILENAME} | ${PROJECTNAME} | ${SHEETFILE}",
  "C> ${R1:VALUE} | ${R1:FOOTPRINT} | ${R1:FOOTPRINT_LIBRARY} | ${R1:FOOTPRINT_NAME} | ${R1:SYMBOL_NAME} | ${R1:SYMBOL_LIBRARY}",
  "D> ${NOPE} | ${R999:VALUE} | ${R1:NOPE} | ${U5:UNIT} | ${R1:UNIT} | ${R1:DNP} | ${R1:EXCLUDE_FROM_BOM} | ${C1:DNP}",
  "E> ${R1:REFERENCE} | ${R1:DESCRIPTION} | ${R1:DATASHEET} | ${R1:Note}",
];
const FIELD = "F> ${REFERENCE} = ${VALUE} in ${FOOTPRINT_NAME} / ${Value}";

describe.skipIf(!cli)("text variables", () => {
  it("read as in KiCad's plot", () => {
    const dir = mkdtempSync(join(tmpdir(), "textvars-"));
    cpSync(DEMO, dir, { recursive: true });
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    const before = loadSchematic("pic_programmer.kicad_sch", read);
    const r1 = before.components.find((c) => c.reference === "R1")!;
    // The same texts on every sheet (tagged with the sheet's number), and the field on R1.
    before.sheets.forEach((sheet, n) => {
      const doc = parse(read(sheet.file));
      const root = sheetRoot(doc);
      TEXTS.forEach((t, i) => addSchText(root, `${n}${t}`, { x: 30.48, y: 20.32 + i * 5.08 }));
      const node = findItem(root, r1.units[0]!.symbol.uuid);
      if (node) {
        setSymbolField(node, "Note", FIELD);
        setFieldVisible(node, "Note", true);
        setSymbolAttributes(node, { dnp: true, inBom: false });
      }
      writeFileSync(join(dir, sheet.file), serialize(doc));
    });
    const s = loadSchematic("pic_programmer.kicad_sch", read);
    expect(s.sheets.length).toBeGreaterThan(1);
    const ours = s.sheets.flatMap((sheet, n) => TEXTS.map((t) => shownText(`${n}${t}`, sheet, s)));
    const pl = s.placements.find((p) => p.reference === "R1")!;
    ours.push(shownText(FIELD, pl.sheet, s, pl));
    expect(ours.join("\n")).not.toContain("${R1");
    expect(ours.join("\n")).toContain("| DNP | Excluded from BOM |");

    execFileSync(KICAD_CLI, ["sch", "export", "svg", "-o", join(dir, "svg"), join(dir, "pic_programmer.kicad_sch")], { stdio: "ignore" });
    const svg = readdirSync(join(dir, "svg")).map((f) => readFileSync(join(dir, "svg", f), "utf8")).join("");
    const unescape = (t: string) => t.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const kicad = [...svg.matchAll(/<(?:text|desc)[^>]*>([^<]*)</g)].map((m) => unescape(m[1]!));
    for (const text of ours) {
      const tag = text.slice(0, text.indexOf(">") + 1);
      expect(kicad.find((k) => k.startsWith(tag)), tag).toBe(text);
    }
  });
});

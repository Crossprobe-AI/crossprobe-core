/**
 * Links on texts and labels (KiCad's href), against KiCad. A web link and a page link are put on a
 * text and a label of a new project, and the text's link is then taken off again and set anew:
 * KiCad reads the sheet and writes it back (`sch upgrade`) with the same links. A link KiCad wrote
 * (tiny_tapeout's) is read here.
 *
 * Env: KICAD_CLI, KICAD_DEMOS.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isList, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import { addLabel, addSchText, findItem, hyperlinkOf, newProject, setHyperlink, sheetRoot } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}
const links = (root: List) => root.children.filter(isList).map((n) => hyperlinkOf(n)).filter((h): h is string => h !== undefined).sort();

describe.skipIf(!cli)("hyperlinks", () => {
  it("KiCad keeps the links set here", () => {
    const dir = mkdtempSync(join(tmpdir(), "href-"));
    const { files } = newProject("links");
    const name = Object.keys(files).find((f) => f.endsWith(".kicad_sch"))!;
    const doc = parse(files[name]!);
    const root = sheetRoot(doc);
    const text = findItem(root, addSchText(root, "Datasheet", { x: 50.8, y: 50.8 }))!;
    const label = findItem(root, addLabel(root, "label", "GO_TO_2", { x: 50.8, y: 63.5 }))!;
    setHyperlink(text, "https://example.com/old");
    setHyperlink(text, undefined);
    expect(hyperlinkOf(text)).toBeUndefined();
    setHyperlink(text, "https://example.com/datasheet.pdf");
    setHyperlink(label, "#2");
    const file = join(dir, name);
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), k === name ? serialize(doc) : v);
    const ours = links(sheetRoot(parse(readFileSync(file, "utf8"))));
    expect(ours).toEqual(["#2", "https://example.com/datasheet.pdf"]);
    execFileSync(KICAD_CLI, ["sch", "upgrade", "--force", file], { stdio: "ignore" });
    expect(links(sheetRoot(parse(readFileSync(file, "utf8"))))).toEqual(ours);
  });

  it.skipIf(!existsSync(join(process.env.KICAD_DEMOS!, "tiny_tapeout")))("reads a link KiCad wrote", () => {
    const root = sheetRoot(parse(readFileSync(join(process.env.KICAD_DEMOS!, "tiny_tapeout", "tinytapeout-demo.kicad_sch"), "utf8")));
    expect(links(root)).toContain("https://github.com/TinyTapeout/tt-demo-pcb");
  });
});

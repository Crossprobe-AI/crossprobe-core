/**
 * Schematic text, text boxes and drawings, read by KiCad: a new sheet gets a text, a text box,
 * a polyline, a rectangle, a circle and a renamed label; `kicad-cli sch upgrade --force` makes
 * KiCad read the file and write it back in its own format, and every item comes back as made
 * (text, position, size, shape). kicad-cli's SVG shows the texts.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arg, findChild, findChildren, headOf, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import { addLabel, addSchGraphic, addSchText, addSchTextBox, findItem, newProject, setItemText, sheetRoot } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

/** What each item is, for comparing ours with KiCad's re-saved copy. */
function items(root: List) {
  const num = (n: List | undefined, i: number) => Math.round(Number(arg(n, i)) * 1000) / 1000;
  return root.children
    .filter((c): c is List => typeof c === "object" && "children" in c && ["text", "text_box", "polyline", "rectangle", "circle", "label"].includes(headOf(c as List) ?? ""))
    .map((n) => {
      const h = headOf(n)!;
      if (h === "text" || h === "text_box" || h === "label") {
        const at = findChild(n, "at"), size = findChild(n, "size");
        return `${h} "${arg(n, 0)}" @${num(at, 0)},${num(at, 1)}${size ? ` ${num(size, 0)}x${num(size, 1)}` : ""}`;
      }
      if (h === "polyline") return `polyline ${findChildren(findChild(n, "pts")!, "xy").map((p) => `${num(p, 0)},${num(p, 1)}`).join(" ")}`;
      if (h === "rectangle") return `rectangle ${num(findChild(n, "start"), 0)},${num(findChild(n, "start"), 1)} ${num(findChild(n, "end"), 0)},${num(findChild(n, "end"), 1)}`;
      return `circle ${num(findChild(n, "center"), 0)},${num(findChild(n, "center"), 1)} r${num(findChild(n, "radius"), 0)}`;
    })
    .sort();
}

describe.skipIf(!cli)("schematic text and drawings", () => {
  it("KiCad reads them back as made", () => {
    const dir = mkdtempSync(join(tmpdir(), "schgfx-"));
    const { files } = newProject("gfx");
    const name = Object.keys(files).find((f) => f.endsWith(".kicad_sch"))!;
    const doc = parse(files[name]!);
    const root = sheetRoot(doc);
    addSchText(root, "Power supply", { x: 50.8, y: 30.48 }, { size: 2.54 });
    addSchTextBox(root, "Keep C1 close to U1", { x: 60.96, y: 40.64 }, { x: 91.44, y: 50.8 });
    addSchGraphic(root, { kind: "polyline", points: [{ x: 20.32, y: 20.32 }, { x: 40.64, y: 20.32 }, { x: 40.64, y: 30.48 }] });
    addSchGraphic(root, { kind: "rectangle", points: [{ x: 25.4, y: 60.96 }, { x: 76.2, y: 101.6 }] }, { dash: true });
    addSchGraphic(root, { kind: "circle", points: [{ x: 120.65, y: 80.01 }, { x: 125.73, y: 80.01 }] });
    const label = addLabel(root, "label", "OLD", { x: 101.6, y: 50.8 });
    setItemText(findItem(root, label)!, "NEW_NAME");
    const file = join(dir, name.split("/").pop()!);
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k.split("/").pop()!), k === name ? serialize(doc) : v);
    const ours = items(sheetRoot(parse(readFileSync(file, "utf8"))));
    execFileSync(KICAD_CLI, ["sch", "upgrade", "--force", file], { stdio: "ignore" });
    const kicad = items(sheetRoot(parse(readFileSync(file, "utf8"))));
    expect(kicad).toEqual(ours);
    expect(ours).toHaveLength(6);
    execFileSync(KICAD_CLI, ["sch", "export", "svg", "-o", dir, file], { stdio: "ignore" });
    const svg = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".svg"))!), "utf8");
    for (const t of ["Power supply", "Keep C1 close to U1", "NEW_NAME"]) expect(svg, t).toContain(t);
  });
});

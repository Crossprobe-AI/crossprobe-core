/**
 * Text boxes as KiCad plots them. A board of text boxes is made by KiCad's
 * pcbnew (wrapping, every justification, bold, quarter-turned and rotated,
 * mirrored on the back, with and without a border); our silkscreen Gerbers of
 * it must cover KiCad's (kicad-cli's) to within 1% of their area.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { boardRoot, fabricationFiles, findBoardItem, linebreak, parseBoard, rotateBoardItem, textBoxText, type Board } from "../src/index.js";
import { area, readGerber, xor } from "./gerber-read.js";

const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";
const KICAD_CLI = process.env.KICAD_CLI!;
const ok = existsSync(PY) && existsSync(KICAD_CLI);

describe("line breaking (KiCad's LinebreakText)", () => {
  it("breaks only between words: everything on a line when it fits, a word to a line when nothing does", () => {
    expect(linebreak("ab ab ab", 1e12, 1e6, 0)).toBe("ab ab ab");
    expect(linebreak("ab ab ab", 1, 1e6, 0)).toBe("ab\nab\nab");
    // A word too long for any line keeps its own line, whole.
    expect(linebreak("abcdefghij x", 1, 1e6, 0)).toBe("abcdefghij\nx");
    expect(linebreak("one\ntwo", 1e12, 1e6, 0)).toBe("one\ntwo");
  });
});

describe.skipIf(!ok)("text boxes as KiCad plots them", () => {
  const dir = ok ? mkdtempSync(join(tmpdir(), "textbox-")) : "";
  const file = join(dir, "tb.kicad_pcb");
  if (ok) {
    try {
      execFileSync(PY, [join(import.meta.dirname, "pcbnew-textbox.py"), file], { stdio: "ignore" });
    } catch {
      // pcbnew may crash on exit after saving.
    }
  }
  /** Our silkscreen Gerbers of `board` against kicad-cli's of `kicadFile`. */
  const compare = (board: Board, kicadFile: string, out: string) => {
    execFileSync(KICAD_CLI, ["pcb", "export", "gerbers", "--no-protel-ext", "-l", "F.SilkS,B.SilkS", "-o", out + "/", kicadFile], { stdio: "ignore" });
    const ours = fabricationFiles(board, { name: kicadFile.split("/").pop()!.replace(".kicad_pcb", "") });
    for (const layer of ["F_Silkscreen", "B_Silkscreen"]) {
      const f = Object.keys(ours).find((k) => k.endsWith(`-${layer}.gbr`))!;
      const kicad = readGerber(readFileSync(join(out, f), "utf8"));
      const mine = readGerber(ours[f]!);
      const ka = area(kicad);
      expect(ka, layer).toBeGreaterThan(1);
      expect(area(xor(kicad, mine)) / ka, `${layer}: ${board.textBoxes.filter((t) => t.layer.startsWith(layer[0]!)).map((t) => JSON.stringify(textBoxText(t).text)).join(" | ")}`).toBeLessThan(0.01);
    }
  };

  it("silkscreen Gerbers match kicad-cli's", () => {
    const board = parseBoard(readFileSync(file, "utf8"));
    expect(board.textBoxes.length).toBe(8);
    compare(board, file, dir);
  });

  it.each([30, 90])("turned %d° as KiCad turns them", (deg) => {
    const text = readFileSync(file, "utf8");
    const doc = parse(text);
    const root = boardRoot(doc);
    for (const tb of parseBoard(text).textBoxes) rotateBoardItem(findBoardItem(root, tb.uuid)!, deg, { x: 60, y: 50 });
    const out = mkdtempSync(join(tmpdir(), "textbox-rot-"));
    const theirs = join(out, "rot.kicad_pcb");
    try {
      execFileSync(PY, [join(import.meta.dirname, "pcbnew-rotate-textboxes.py"), file, theirs, String(deg), "60", "50"], { stdio: "ignore" });
    } catch {
      // pcbnew may crash on exit after saving.
    }
    const ours = parseBoard(serialize(doc));
    // The same corners and angles as KiCad's, and the same plot.
    const k = parseBoard(readFileSync(theirs, "utf8"));
    for (const tb of ours.textBoxes) {
      const kt = k.textBoxes.find((x) => x.uuid === tb.uuid)!;
      expect(((tb.angle % 360) + 360) % 360, tb.text).toBeCloseTo(((kt.angle % 360) + 360) % 360, 6);
      const key = (pts: typeof tb.corners) => pts.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).sort();
      expect(key(tb.corners), tb.text).toEqual(key(kt.corners));
    }
    compare(ours, theirs, out);
  });
});

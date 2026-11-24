/**
 * The board outline (invalid_outline) against KiCad's DRC: pic_programmer's outline broken in
 * the ways KiCad reports (a gap, a stray line, a line of almost no length, an open shape inside,
 * a line drawn twice, no outline at all) gives KiCad's findings, with the shapes it names (where
 * shape ends meet at one point, as with the line drawn twice, the pair named follows KiCad's k-d
 * tree, built as KiCad builds it). The demos' outlines have no findings, as in KiCad. Env: KICAD_DEMOS, KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBoard, checkBoardOutline, parseBoard, projectDesignRules } from "../src/index.js";

const DEMOS = process.env.KICAD_DEMOS ?? "";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
let cli = existsSync(DEMOS);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

const line = (x0: number, y0: number, x1: number, y1: number, n: number) =>
  `\t(gr_line (start ${x0} ${y0}) (end ${x1} ${y1}) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "aaaaaaaa-0000-0000-0000-00000000000${n}"))\n`;
const add = (text: string, more: string) => `${text.trimEnd().slice(0, -1)}${more})\n`;

describe.skipIf(!cli)("board outline as KiCad's DRC", () => {
  const dir = join(DEMOS, "pic_programmer");
  const pcb = () => readFileSync(join(dir, "pic_programmer.kicad_pcb"), "utf8");
  const kicad = (text: string) => {
    const tmp = mkdtempSync(join(tmpdir(), "crossprobe-outline-"));
    cpSync(dir, tmp, { recursive: true });
    const file = join(tmp, "pic_programmer.kicad_pcb");
    writeFileSync(file, text);
    execFileSync(KICAD_CLI, ["pcb", "drc", "--format", "json", "-o", join(tmp, "drc.json"), file], { stdio: "ignore" });
    return (JSON.parse(readFileSync(join(tmp, "drc.json"), "utf8")).violations as Array<{ type: string; description: string; items: Array<{ uuid: string }> }>)
      .filter((v) => v.type === "invalid_outline")
      .map((v) => `${v.description} | ${v.items.map((i) => i.uuid).join(",")}`);
  };
  const ours = (text: string) => checkBoardOutline(parseBoard(text)).map((v) => `${v.message} | ${v.items.map((i) => i.uuid ?? "").join(",")}`);

  it.each([
    ["a 0.1 mm gap", (t: string) => t.replace("(start 73.66 139.7)\n\t\t(end 73.66 40.64)", "(start 73.66 139.7)\n\t\t(end 73.66 40.74)")],
    ["a stray line across the edge", (t: string) => add(t, line(100, 30, 100, 50, 1))],
    ["a line 500 nm long", (t: string) => add(t, line(120, 90, 120.0005, 90, 2))],
    ["an open shape inside", (t: string) => add(t, line(100, 60, 110, 60, 4) + line(110, 60, 110, 70, 5))],
    ["a line drawn twice", (t: string) => add(t, line(73.66, 40.64, 173.99, 40.64, 3))],
  ])("%s", (name, edit) => {
    const text = edit(pcb());
    expect(text).not.toBe(pcb());
    let theirs = kicad(text);
    expect(theirs.length).toBeGreaterThan(0);
    let mine = ours(text);
    if (name === "a line drawn twice") {
      // The two copies end at the same points, and which of them KiCad names there varies from run
      // to run: either will do.
      const copies = [...text.matchAll(/\(gr_line\s*\(start 73\.66 40\.64\)\s*\(end 173\.99 40\.64\)[\s\S]*?\(uuid "([^"]+)"\)/g)].map((m) => m[1]!);
      expect(new Set(copies).size).toBe(2);
      const either = (l: string[]) => l.map((v) => copies.reduce((t, u) => t.replaceAll(u, "<either copy>"), v)).sort();
      [theirs, mine] = [either(theirs), either(mine)];
    }
    expect(mine).toEqual(theirs);
  });

  it("no outline at all", () => {
    const text = pcb().replace(/\t\(gr_line\s*\n(?:\t\t[^\n]*\n|\t\t\t[^\n]*\n)*?\t\t\(layer "Edge.Cuts"\)\n(?:\t\t[^\n]*\n)*?\t\)\n/g, "");
    const strip = (l: string[]) => l.map((s) => s.split(" | ")[0]);
    expect(strip(kicad(text))).toEqual(["Board has malformed outline (no edges found on Edge.Cuts layer)"]);
    expect(strip(ours(text))).toEqual(strip(kicad(text)));
  });

  it("the demos' outlines: nothing to report, and checkBoard reports it", () => {
    for (const d of readdirSync(DEMOS)) {
      const dirD = join(DEMOS, d);
      if (!existsSync(dirD) || !readdirSync(dirD).length) continue;
      for (const f of readdirSync(dirD).filter((x) => x.endsWith(".kicad_pcb"))) expect(checkBoardOutline(parseBoard(readFileSync(join(dirD, f), "utf8"))), `${d}/${f}`).toEqual([]);
    }
    const text = add(pcb(), line(100, 60, 110, 60, 4));
    const rules = projectDesignRules(readFileSync(join(dir, "pic_programmer.kicad_pro"), "utf8"));
    expect(checkBoard(parseBoard(text), rules).filter((v) => v.type === "invalid_outline").length).toBeGreaterThan(0);
  });
});

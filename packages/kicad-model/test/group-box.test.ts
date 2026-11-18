/**
 * Group boxes against KiCad's: pic_programmer with three groups that hold items this model doesn't
 * (a layer alignment target, a reference image, a table) beside footprints, one of them inside a
 * fourth group. KiCad's pcbnew gives
 * each group's box (its position is the centre) and each footprint's box with its texts.
 * Env: KICAD_DEMOS, KICAD_PYTHON.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { footprintBoxWithText, groupBox, parseBoard } from "../src/index.js";

const DEMOS = process.env.KICAD_DEMOS!;
const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";
const PCB = join(DEMOS ?? "", "pic_programmer/pic_programmer.kicad_pcb");

/** A plain w×h PNG, base64 (no pHYs chunk: KiCad takes 300 pixels per inch). */
function png(w: number, h: number): string {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 200)])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const uuidOf = (text: string, ref: string) => {
  const at = text.indexOf(`(property "Reference" "${ref}"`);
  const fp = text.lastIndexOf("(footprint ", at);
  return /\(uuid "([^"]+)"\)/.exec(text.slice(fp, at))![1]!;
};
const cell = (x: number, y: number, w: number, h: number) =>
  `(table_cell "" (start ${x} ${y}) (end ${x + w} ${y + h}) (margins 1 1 1 1) (span 1 1) (layer "Cmts.User") (uuid "${crypto.randomUUID()}") (effects (font (size 1 1) (thickness 0.15)) (justify left top)))`;

describe.skipIf(!existsSync(PCB) || !existsSync(PY))("group boxes as KiCad's", () => {
  it("groups with a target, an image and a table; footprints with their texts", () => {
    let text = readFileSync(PCB, "utf8");
    const [r1, r2, r3, c2, u1, r4] = ["R1", "R2", "R3", "C2", "U1", "R4"].map((r) => uuidOf(text, r));
    const ids = { target: "7a26e5f1-0000-4000-8000-0000000000b1", image: "7a26e5f1-0000-4000-8000-0000000000b2", table: "7a26e5f1-0000-4000-8000-0000000000b3" };
    const groups = ["7a26e5f1-0000-4000-8000-0000000000c1", "7a26e5f1-0000-4000-8000-0000000000c2", "7a26e5f1-0000-4000-8000-0000000000c3", "7a26e5f1-0000-4000-8000-0000000000c4"];
    const end = text.lastIndexOf(")");
    text =
      text.slice(0, end) +
      `\t(target plus (at 70 150) (size 5) (width 0.1) (layer "Edge.Cuts") (uuid "${ids.target}"))\n` +
      `\t(image (at 200 60) (layer "F.SilkS") (scale 1.5) (uuid "${ids.image}") (data "${png(240, 90)}"))\n` +
      `\t(table (column_count 2) (uuid "${ids.table}") (layer "Cmts.User") (border (external yes) (header yes) (stroke (width 0.1) (type solid))) (separators (rows yes) (cols yes) (stroke (width 0.1) (type solid))) (column_widths 20 15) (row_heights 6 6)\n` +
      `\t\t(cells ${cell(30, 40, 20, 6)} ${cell(50, 40, 15, 6)} ${cell(30, 46, 20, 6)} ${cell(50, 46, 15, 6)}))\n` +
      `\t(group "a" (uuid "${groups[0]}") (members "${r1}" "${r2}" "${ids.target}"))\n` +
      `\t(group "b" (uuid "${groups[1]}") (members "${c2}" "${ids.image}"))\n` +
      `\t(group "c" (uuid "${groups[2]}") (members "${r3}" "${u1}" "${ids.table}"))\n` +
      // Nested: group a inside d, its box (0.25 mm larger) merged as it is.
      `\t(group "d" (uuid "${groups[3]}") (members "${groups[0]}" "${r4}"))\n` +
      text.slice(end);
    const dir = mkdtempSync(join(tmpdir(), "crossprobe-groupbox-"));
    writeFileSync(join(dir, "in.kicad_pcb"), text);
    const theirs = new Map(
      execFileSync(PY, [join(import.meta.dirname, "pcbnew-group-box.py"), join(dir, "in.kicad_pcb")], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((l) => l.split(" "))
        .map(([u, ...b]) => [u!, b.map(Number)] as const),
    );
    const board = parseBoard(text);
    const near = (ours: { x0: number; y0: number; x1: number; y1: number } | undefined, k: readonly number[] | undefined, what: string) => {
      expect(ours, what).toBeDefined();
      const d = Math.max(...[ours!.x0, ours!.y0, ours!.x1, ours!.y1].map((v, i) => Math.abs(v - k![i]!)));
      expect(d, `${what}: ours ${JSON.stringify(ours)}, KiCad ${k!.join(" ")}`).toBeLessThan(0.01);
    };
    for (const g of groups) near(groupBox(board, g), theirs.get(g), `group ${g}`);
    let fps = 0;
    for (const f of board.footprints) {
      if (!theirs.has(f.uuid)) continue;
      near(footprintBoxWithText(f), theirs.get(f.uuid), `footprint ${f.reference}`);
      fps++;
    }
    expect(fps).toBe(board.footprints.length);
  });
});

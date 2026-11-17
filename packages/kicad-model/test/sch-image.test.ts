/**
 * Images in a schematic, against KiCad. A PNG is placed (at scale 1 and at 0.5) in a new project:
 * KiCad reads the sheet and writes it back (`sch upgrade`) with the same place, scale and picture
 * data, and its SVG plot draws both images.
 *
 * Env: KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { arg, atomText, findChild, findChildren, isAtom, parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import { addImage, findItem, newProject, setImageScale, sheetRoot } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

/** A small PNG (red and blue stripes), as base64. */
function png(w: number, h: number): string {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "latin1");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), ...Array.from({ length: w }, (_, x) => Buffer.from(((x >> 3) + y) % 2 ? [220, 30, 30] : [30, 60, 220]))])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const images = (root: List) =>
  findChildren(root, "image").map((n) => ({
    at: `${arg(findChild(n, "at"), 0)},${arg(findChild(n, "at"), 1)}`,
    scale: Number(arg(findChild(n, "scale"), 0) ?? 1),
    data: findChild(n, "data")!.children.slice(1).filter(isAtom).map(atomText).join(""),
  })).sort((a, b) => (a.at < b.at ? -1 : 1));

describe.skipIf(!cli)("schematic images", () => {
  it("KiCad reads them back as placed and plots them", () => {
    const dir = mkdtempSync(join(tmpdir(), "schimg-"));
    const { files } = newProject("img");
    const name = Object.keys(files).find((f) => f.endsWith(".kicad_sch"))!;
    const doc = parse(files[name]!);
    const root = sheetRoot(doc);
    const data = png(240, 120);
    addImage(root, { x: 101.6, y: 76.2 }, data);
    setImageScale(findItem(root, addImage(root, { x: 177.8, y: 76.2 }, data))!, 0.5);
    const file = join(dir, name);
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), k === name ? serialize(doc) : v);
    const ours = images(sheetRoot(parse(readFileSync(file, "utf8"))));
    expect(ours).toEqual([
      { at: "101.6,76.2", scale: 1, data },
      { at: "177.8,76.2", scale: 0.5, data },
    ]);
    execFileSync(KICAD_CLI, ["sch", "upgrade", "--force", file], { stdio: "ignore" });
    expect(images(sheetRoot(parse(readFileSync(file, "utf8"))))).toEqual(ours);
    execFileSync(KICAD_CLI, ["sch", "export", "svg", "-o", join(dir, "svg"), file], { stdio: "ignore" });
    const svg = readdirSync(join(dir, "svg")).map((f) => readFileSync(join(dir, "svg", f), "utf8")).join("");
    expect((svg.match(/<image\b/g) ?? []).length).toBe(2);
  });
});

/**
 * Pictures and squeezed texts, against KiCad's plot. A PNG saved at 72 dpi is a drawing-sheet logo
 * and a schematic image: KiCad sizes both by the PNG's own resolution (71 ppi as it rounds it),
 * centred on their position, and so does bitmapInfo / drawingSheetPrims. A title too long for its
 * maxlen is squeezed to that width, as KiCad does, and a % at the end of a text is dropped by both.
 *
 * Env: KICAD_CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { base64Bytes, bitmapInfo, bitmapSizeMm, drawingSheetPrims, parseDrawingSheet, strokeAdvance } from "../src/index.js";

const KICAD_CLI = process.env.KICAD_CLI!;
let cli = true;
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}

/** A grey PNG of w × h pixels, with a pHYs of `ppm` pixels per metre when given. */
function png(w: number, h: number, ppm?: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const td = Buffer.concat([Buffer.from(t), d]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w);
  ih.writeUInt32BE(h, 4);
  ih[8] = 8;
  ih[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const ph = Buffer.alloc(9);
  ph.writeUInt32BE(ppm ?? 0);
  ph.writeUInt32BE(ppm ?? 0, 4);
  ph[8] = 1;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk("IHDR", ih), ...(ppm ? [chunk("pHYs", ph)] : []), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("bitmap sizes", () => {
  it("follow the PNG's resolution, else 300 ppi", () => {
    expect(bitmapInfo(png(60, 30, 2835))).toMatchObject({ width: 60, height: 30, ppi: 71 });
    expect(bitmapInfo(png(60, 30, 11811))!.ppi).toBe(300);
    expect(bitmapInfo(png(60, 30))!.ppi).toBe(300);
    expect(bitmapSizeMm(bitmapInfo(png(300, 150))!, 2)).toEqual({ w: 50.8, h: 25.4 });
  });
});

describe.skipIf(!cli)("pictures and squeezed texts against KiCad", () => {
  it("are placed and sized as KiCad plots them", () => {
    const dir = mkdtempSync(join(tmpdir(), "bitmaps-"));
    const b64 = png(60, 30, 2835).toString("base64");
    const wks = `(kicad_wks (version 20231118) (generator "x")
 (setup (textsize 1.5 1.5) (linewidth 0.15) (textlinewidth 0.15) (left_margin 10) (right_margin 10) (top_margin 10) (bottom_margin 10))
 (tbtext "\${TITLE}" (name "") (pos 100 20 ltcorner) (font (size 2 2)) (maxlen 30))
 (tbtext "Scale 100%" (name "") (pos 100 40 ltcorner))
 (bitmap (name "") (pos 60 60 ltcorner) (scale 1) (data "${b64}")))
`;
    const title = "A rather long title that will not fit in thirty millimetres";
    writeFileSync(join(dir, "t.kicad_wks"), wks);
    writeFileSync(join(dir, "p.kicad_sch"), `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "11111111-1111-1111-1111-111111111111") (paper "A4")
 (title_block (title "${title}"))
 (image (at 150 120) (uuid "22222222-2222-2222-2222-222222222222") (data "${b64}"))
 (sheet_instances (path "/" (page "1"))))
`);
    writeFileSync(join(dir, "p.kicad_pro"), JSON.stringify({ schematic: { page_layout_descr_file: "t.kicad_wks" }, meta: { filename: "p.kicad_pro", version: 1 } }));
    mkdirSync(join(dir, "svg"));
    execFileSync(KICAD_CLI, ["sch", "export", "svg", "-o", join(dir, "svg"), join(dir, "p.kicad_sch")], { stdio: "ignore" });
    const svg = readFileSync(join(dir, "svg", readdirSync(join(dir, "svg"))[0]!), "utf8");
    const images = [...svg.matchAll(/<image x="([\d.]+)" y="([\d.]+)"/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));

    const prims = drawingSheetPrims(parseDrawingSheet(wks), 297, 210, { titleBlock: { title }, paper: "A4", page: "1", pages: 1, sheetName: "", sheetPath: "/", fileName: "p.kicad_sch" }, true);
    // The logo: its top-left corner.
    const logo = prims.find((p) => p.kind === "bitmap")!;
    expect(logo.kind === "bitmap" && [logo.at.x, logo.at.y]).toEqual([expect.closeTo(images[0]!.x, 2), expect.closeTo(images[0]!.y, 2)]);
    // The schematic image, centred on (150, 120).
    const { w, h } = bitmapSizeMm(bitmapInfo(base64Bytes(b64))!);
    expect([150 - w / 2, 120 - h / 2]).toEqual([expect.closeTo(images[1]!.x, 2), expect.closeTo(images[1]!.y, 2)]);

    // The title, squeezed: as wide as KiCad draws it (its strokes, within half a millimetre).
    const t = prims.find((p) => p.kind === "text" && p.text === title)!;
    const ours = t.kind === "text" ? strokeAdvance(title) * t.size.x : 0;
    const i = svg.indexOf(`<desc>${title}</desc>`);
    const strokes = svg.slice(i, svg.indexOf("</g>", i));
    const xs = [...strokes.matchAll(/[ML]\s*([\d.]+)/g)].map((m) => Number(m[1]));
    expect(ours).toBeLessThanOrEqual(30.5);
    expect(Math.abs(ours - (Math.max(...xs) - Math.min(...xs)))).toBeLessThan(0.5);

    // The % at the end: dropped by both.
    expect(svg).toContain("<desc>Scale 100</desc>");
    expect(prims.some((p) => p.kind === "text" && p.text === "Scale 100")).toBe(true);
  });
});

/**
 * The page frame drawn around a schematic sheet or a board: the project's
 * drawing sheet (.kicad_wks) when it has one, else a default frame laid out
 * like KiCad's default drawing sheet (borders, zone references every 50 mm,
 * a title block at the bottom right). Both come as drawing-sheet primitives in
 * page millimetres.
 */
import { drawingSheetPrims, type DrawingSheet, type DrawingSheetInfo, type DrawingSheetPrim } from "./drawing-sheet.js";
import type { Point } from "./geometry.js";
import { PAPER_SIZES, type PageSettings } from "./page-settings.js";

/** A page's size in mm (landscape unless portrait; a user size as given). */
export function paperSize(p: Pick<PageSettings, "paper" | "width" | "height" | "portrait">): { w: number; h: number } {
  let [w, h] = p.paper === "User" && p.width && p.height ? [p.width, p.height] : (PAPER_SIZES[p.paper] ?? PAPER_SIZES["A4"]!);
  if (p.portrait) [w, h] = [h, w];
  return { w, h };
}

/** The default frame: two borders with zone references every 50 mm, and a title block. */
export function defaultFrame(paper: { w: number; h: number }, title: Record<string, string>, sheetLabel: string, file: string): DrawingSheetPrim[] {
  const rect = (x: number, y: number, w: number, h: number): DrawingSheetPrim => ({ kind: "rect", a: { x, y }, b: { x: x + w, y: y + h }, width: 0.15 });
  const line = (x0: number, y0: number, x1: number, y1: number): DrawingSheetPrim => ({ kind: "line", a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, width: 0.15 });
  const text = (at: Point, s: string, size: number, h: "left" | "center" = "left", bold = false): DrawingSheetPrim => ({ kind: "text", at, text: s, size: { x: size, y: size }, width: size / 8, bold, italic: false, h, v: "center", angle: 0 });
  const m = 10;
  const g = 2; // between the outer and inner border, where the zone references go
  const out: DrawingSheetPrim[] = [rect(m, m, paper.w - 2 * m, paper.h - 2 * m), rect(m + g, m + g, paper.w - 2 * (m + g), paper.h - 2 * (m + g))];
  const step = 50;
  const cols = Math.max(1, Math.round((paper.w - 2 * m) / step));
  const rows = Math.max(1, Math.round((paper.h - 2 * m) / step));
  const cw = (paper.w - 2 * m) / cols;
  const rh = (paper.h - 2 * m) / rows;
  for (let c = 0; c < cols; c++) {
    const x = m + c * cw;
    if (c > 0) out.push(line(x, m, x, m + g), line(x, paper.h - m - g, x, paper.h - m));
    out.push(text({ x: x + cw / 2, y: m + g / 2 }, String(c + 1), 1.3, "center"), text({ x: x + cw / 2, y: paper.h - m - g / 2 }, String(c + 1), 1.3, "center"));
  }
  for (let r = 0; r < rows; r++) {
    const y = m + r * rh;
    const letter = String.fromCharCode(65 + (r % 26));
    if (r > 0) out.push(line(m, y, m + g, y), line(paper.w - m - g, y, paper.w - m, y));
    out.push(text({ x: m + g / 2, y: y + rh / 2 }, letter, 1.3, "center"), text({ x: paper.w - m - g / 2, y: y + rh / 2 }, letter, 1.3, "center"));
  }
  // The title block, at the bottom right of the inner border.
  const bw = 110;
  const bh = 34;
  const x0 = paper.w - m - g - bw;
  const y0 = paper.h - m - g - bh;
  out.push(rect(x0, y0, bw, bh), line(x0, y0 + 14, x0 + bw, y0 + 14), line(x0, y0 + 22, x0 + bw, y0 + 22), line(x0, y0 + 28, x0 + bw, y0 + 28));
  out.push(line(x0 + 40, y0 + 28, x0 + 40, y0 + bh), line(x0 + 80, y0 + 28, x0 + 80, y0 + bh));
  if (title["company"]) out.push(text({ x: x0 + 2, y: y0 + 3 }, title["company"], 1.6, "left", true));
  [1, 2, 3, 4].forEach((n, i) => {
    const c = title[`comment${n}`];
    if (c) out.push(text({ x: x0 + 2, y: y0 + 6.5 + i * 2.2 }, c, 1.1));
  });
  out.push(text({ x: x0 + 2, y: y0 + 16.5 }, `Sheet: ${sheetLabel}`, 1.27));
  out.push(text({ x: x0 + 2, y: y0 + 19.5 }, `File: ${file}`, 1.27));
  out.push(text({ x: x0 + 2, y: y0 + 25 }, `Title: ${title["title"] ?? ""}`, 2, "left", true));
  out.push(text({ x: x0 + 2, y: y0 + 31 }, `Size: ${Math.round(paper.w)}×${Math.round(paper.h)} mm`, 1.27));
  out.push(text({ x: x0 + 42, y: y0 + 31 }, `Date: ${title["date"] ?? ""}`, 1.27));
  out.push(text({ x: x0 + 82, y: y0 + 31 }, `Rev: ${title["rev"] ?? ""}`, 1.27));
  return out;
}

/**
 * A board's page frame: its drawing sheet (pcbnew's page_layout_descr_file)
 * when there is one, else the default frame, filled from its page settings.
 */
export function boardFrame(page: PageSettings, file: string, sheet?: DrawingSheet, o: { layer?: string; variables?: Record<string, string> } = {}): DrawingSheetPrim[] {
  const paper = paperSize(page);
  const title: Record<string, string> = { title: page.title, date: page.date, rev: page.rev, company: page.company };
  page.comments.forEach((c, i) => c && (title[`comment${i + 1}`] = c));
  if (!sheet) return defaultFrame(paper, title, "", file);
  const info: DrawingSheetInfo = { titleBlock: title, paper: page.paper, page: "1", pages: 1, sheetName: "", sheetPath: "/", fileName: file, layer: o.layer, variables: o.variables, generator: "Crossprobe" };
  return drawingSheetPrims(sheet, paper.w, paper.h, info, true);
}

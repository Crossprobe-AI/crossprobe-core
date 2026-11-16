/**
 * Turn a PDF into an index: lines with positions per page, printed page
 * numbers, and passages (headings, tables, text blocks) under their headings.
 * Everything is deterministic text work on what pdf.js reads from the file.
 */
import { figuresOf, marksOf, type OpListLike, type OpsLike } from "./figures";
import type { Box, DatasheetIndex, Line, PageIndex, Passage } from "./types";

/** The parts of a pdf.js document we use (so tests can pass the Node build). */
export interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<{
    view: number[];
    getViewport(o: { scale: number }): { width: number; height: number; transform: number[] };
    getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number; height?: number }> }>;
    getOperatorList?(): Promise<OpListLike>;
  }>;
}

export interface Run {
  str: string;
  x: number;
  /** Baseline, y down. */
  base: number;
  w: number;
  size: number;
}

const median = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** Group a page's text runs into visual lines, top to bottom, left to right. */
export function buildLines(runs: Run[]): Line[] {
  const real = runs.filter((r) => r.str.trim() !== "");
  real.sort((a, b) => a.base - b.base || a.x - b.x);
  const groups: Run[][] = [];
  for (const r of real) {
    const g = groups[groups.length - 1];
    // Same line when baselines are within a third of the font size.
    if (g && Math.abs(g[0]!.base - r.base) < Math.max(r.size, g[0]!.size) * 0.35) g.push(r);
    else groups.push([r]);
  }
  const lines: Line[] = [];
  for (const g of groups) {
    g.sort((a, b) => a.x - b.x);
    const size = Math.max(...g.map((r) => r.size));
    let text = "";
    const cells: string[] = [];
    const cellSizes: number[] = [];
    const cellSpans: Array<[number, number]> = [];
    let cell = "";
    let cellSize = 0;
    let cellStart = g[0]!.x;
    let prevEnd = g[0]!.x;
    for (const r of g) {
      const gap = r.x - prevEnd;
      if (cell && gap > size * 1.2) {
        cells.push(cell.trim());
        cellSizes.push(cellSize);
        cellSpans.push([cellStart, prevEnd]);
        cell = "";
        cellSize = 0;
        cellStart = r.x;
        text += "  ";
      } else if (cell && gap > size * 0.12 && !cell.endsWith(" ") && !r.str.startsWith(" ")) {
        cell += " ";
        text += " ";
      }
      cell += r.str;
      cellSize = Math.max(cellSize, r.size);
      text += r.str;
      prevEnd = r.x + r.w;
    }
    if (cell.trim()) (cells.push(cell.trim()), cellSizes.push(cellSize), cellSpans.push([cellStart, prevEnd]));
    const x0 = g[0]!.x;
    const x1 = Math.max(...g.map((r) => r.x + r.w));
    const base = median(g.map((r) => r.base));
    lines.push({ text: text.replace(/[ \t]+$/g, ""), cells, cellSizes, cellSpans, size, bold: false, box: { x: x0, y: base - size * 0.8, w: x1 - x0, h: size } });
  }
  return lines;
}

/** The page number printed in the header or footer: "3", "Page 3", "3 of 20". */
function printedNumber(lines: Line[], height: number): string | undefined {
  const edge = lines.filter((l) => l.box.y < height * 0.09 || l.box.y > height * 0.9).reverse();
  for (const l of edge) {
    const t = l.text.trim();
    const m = /\bpage\s*[-–]?\s*(\d{1,4})\b/i.exec(t) ?? /\b(\d{1,4})\s+of\s+\d{1,4}\b/i.exec(t) ?? /^(\d{1,4})$/.exec(t) ?? /\s{2,}(\d{1,4})$/.exec(t);
    if (m) return m[1];
  }
  return undefined;
}

/** Printed page numbers, kept only where they agree with one offset from the PDF's numbering. */
function assignLabels(pages: PageIndex[]): void {
  const seen = pages.map((p) => ({ p, n: printedNumber(p.lines, p.height) }));
  const offsets = new Map<number, number>();
  for (const { p, n } of seen) if (n !== undefined) offsets.set(Number(n) - p.number, (offsets.get(Number(n) - p.number) ?? 0) + 1);
  const best = [...offsets].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < Math.max(1, Math.ceil(seen.filter((s) => s.n !== undefined).length * 0.6))) return;
  for (const p of pages) {
    const label = p.number + best[0];
    if (label >= 1) p.label = String(label);
  }
  // A label is only worth showing when it differs or is confirmed: keep all, the UI shows both when they differ.
}

const NUMBERED = /^(\d+(?:\.\d+){0,3})\.?\s+\S/;
const CAPTION = /^(table|figure)\s+\d+[-.]\d+/i;

/** The heading a line starts, if it does (its first cell when the line has several columns). */
export function headingText(line: Line, body: number): string | undefined {
  if (line.furniture) return undefined;
  const t = (line.cells[0] ?? line.text).trim();
  const size = line.cellSizes[0] ?? line.size;
  if (t.length < 3 || t.length > 90) return undefined;
  const numbered = NUMBERED.test(t);
  if (CAPTION.test(t)) return line.text.replace(/\s+/g, " ").trim().slice(0, 90);
  if (/[.,;:]$/.test(t) && !numbered) return undefined;
  const words = t.split(/\s+/);
  // Figure labels and values ("VOUT 1.2V/1.8V/", "GND", "1mF") are not headings.
  if (!numbered && (words.some((w) => /^[\d.]+[a-zA-Zµ]{0,3}(?:\/[\d.]*[a-zA-Zµ]{0,3})*\/?$/.test(w)) || (words.length === 1 && t.length < 5) || /[=<>]/.test(t))) return undefined;
  if (size >= body * 1.18 && line.cells.length <= 3) return t;
  // Numbered section titles at body size ("6.2 Recommended Operating Conditions").
  return numbered && /^[\d.\s]+[A-Z]/.test(t) && words.length <= 9 && !/\d\s*$/.test(t.replace(NUMBERED, "")) ? t : undefined;
}

/** Mark repeated header and footer lines (same text apart from digits, on many pages) as furniture. */
function markFurniture(pages: PageIndex[]): void {
  const key = (l: Line) => l.text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const count = new Map<string, number>();
  const band = (p: PageIndex, l: Line) => l.box.y < p.height * 0.09 || l.box.y > p.height * 0.9;
  for (const p of pages) for (const k of new Set(p.lines.filter((l) => band(p, l)).map(key))) count.set(k, (count.get(k) ?? 0) + 1);
  const min = Math.max(3, Math.ceil(pages.length * 0.3));
  for (const p of pages) for (const l of p.lines) if (band(p, l) && ((count.get(key(l)) ?? 0) >= min || /^(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$/i.test(l.text.trim()))) l.furniture = true;
}

const WIDE = /\S\s{2,}\S/;

/** Split a page's lines into passages under their headings. */
function buildPassages(pages: PageIndex[]): Passage[] {
  const out: Passage[] = [];
  let heading: string | undefined;
  const body = median(pages.flatMap((p) => p.lines.map((l) => l.size)));
  for (const page of pages) {
    const { lines } = page;
    let i = 0;
    let n = 0;
    const push = (from: number, count: number, kind: Passage["kind"]) => {
      const ls = lines.slice(from, from + count);
      if (!ls.length) return;
      const x0 = Math.min(...ls.map((l) => l.box.x));
      const y0 = Math.min(...ls.map((l) => l.box.y));
      const x1 = Math.max(...ls.map((l) => l.box.x + l.box.w));
      const y1 = Math.max(...ls.map((l) => l.box.y + l.box.h));
      const box: Box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      out.push({ id: `p${page.number}-${n++}`, page: page.number, heading: kind === "heading" ? undefined : heading, kind, from, count, text: ls.map((l) => l.text).join("\n"), box });
    };
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.furniture) {
        i++;
        continue;
      }
      const head = headingText(line, body);
      if (head) {
        heading = head;
        push(i, 1, "heading");
        out[out.length - 1]!.text = head;
        i++;
        continue;
      }
      // A run of lines with a small vertical gap; table-like when most have several cells.
      let j = i + 1;
      while (j < lines.length && !lines[j]!.furniture && !headingText(lines[j]!, body)) {
        const gap = lines[j]!.box.y - (lines[j - 1]!.box.y + lines[j - 1]!.box.h);
        if (gap > lines[j - 1]!.size * 1.1 || j - i >= 24) break;
        j++;
      }
      const wide = lines.slice(i, j).filter((l) => WIDE.test(l.text) || l.cells.length >= 3).length;
      push(i, j - i, wide >= 3 && wide >= (j - i) * 0.5 ? "table" : "text");
      i = j;
    }
  }
  return out;
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", view.slice().buffer));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function indexPdf(pdf: PdfDocLike, bytes: ArrayBuffer | Uint8Array, title: string, ops?: OpsLike, ocr?: (page: number) => Promise<Run[]>): Promise<DatasheetIndex> {
  const pages: PageIndex[] = [];
  const scanned: number[] = [];
  const lists: Array<{ list: OpListLike; vt: number[] } | undefined> = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    // The page as displayed: rotated pages (landscape tables, sideways scans) have their text mapped into the view the engineer sees.
    const vp = page.getViewport({ scale: 1 });
    const vt = vp.transform as [number, number, number, number, number, number];
    const height = vp.height;
    const tc = await page.getTextContent();
    const runs: Run[] = [];
    for (const it of tc.items) {
      if (typeof it.str !== "string" || !it.transform) continue;
      const t = it.transform as [number, number, number, number, number, number];
      const a = vt[0] * t[0] + vt[2] * t[1];
      const b = vt[1] * t[0] + vt[3] * t[1];
      if (Math.abs(b) > Math.abs(a)) continue; // text running up or down the displayed page (side labels): not a line of text
      const c = vt[0] * t[2] + vt[2] * t[3];
      const d = vt[1] * t[2] + vt[3] * t[3];
      runs.push({ str: it.str, x: vt[0] * t[4] + vt[2] * t[5] + vt[4], base: vt[1] * t[4] + vt[3] * t[5] + vt[5], w: it.width ?? 0, size: Math.hypot(c, d) || it.height || 0 });
    }
    // A page with no text at all (a scan): read it with OCR when that was asked for.
    const blank = runs.every((r) => !r.str.trim());
    if (blank) scanned.push(n);
    if (blank && ocr) runs.push(...(await ocr(n)));
    pages.push({ number: n, width: vp.width, height, lines: buildLines(runs) });
    lists.push(ops && page.getOperatorList ? { list: await page.getOperatorList().catch(() => undefined as never), vt } : undefined);
  }
  assignLabels(pages);
  markFurniture(pages);
  const passages = buildPassages(pages);
  // Figures: drawings and images with their captions and labels, searchable like any passage.
  if (ops) {
    for (const page of pages) {
      const entry = lists[page.number - 1];
      if (!entry?.list) continue;
      const headLines = new Set(passages.filter((p) => p.page === page.number && p.kind === "heading").map((p) => p.from));
      figuresOf(page, marksOf(ops, entry.list, page.width, page.height, entry.vt), headLines).forEach((f, n) => {
        const text = f.lines.map((i) => page.lines[i]!.text).join("\n");
        passages.push({ id: `f${page.number}-${n}`, page: page.number, heading: f.caption, kind: "figure", from: f.lines[0] ?? 0, count: f.lines.length, lines: f.lines, caption: f.caption, text: text || f.caption || `Figure on page ${page.number}`, box: f.box });
      });
    }
  }
  return { id: await sha256Hex(bytes), title, pages, passages, scanned, ocr: !!ocr };
}

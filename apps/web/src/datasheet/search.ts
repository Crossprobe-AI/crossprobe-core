/**
 * Finding things in an indexed datasheet. No model is involved here: scoring is
 * BM25 over passages plus the section and pin-table rules below, so a result
 * is always a place in the document that really contains the words.
 */
import type { Box, DatasheetIndex, Hit, Passage } from "./types";

const STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "for", "is", "on", "at", "what", "which", "how", "does", "do", "with"]);

export const tokens = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9µΩ][a-z0-9µΩ.+\-_/]*/g) ?? []).map((t) => t.replace(/[.\-_/+]+$/g, "")).filter((t) => t && !STOP.has(t));

interface Bm25 {
  df: Map<string, number>;
  avg: number;
  docs: Array<{ tf: Map<string, number>; len: number; head: Set<string> }>;
}

const cache = new WeakMap<DatasheetIndex, Bm25>();

function stats(index: DatasheetIndex): Bm25 {
  let s = cache.get(index);
  if (s) return s;
  const df = new Map<string, number>();
  const docs = index.passages.map((p) => {
    const tf = new Map<string, number>();
    const ts = tokens(p.text);
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { tf, len: ts.length || 1, head: new Set(tokens(p.heading ?? "")) };
  });
  s = { df, docs, avg: docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length) };
  cache.set(index, s);
  return s;
}

/** The page's line indexes a passage covers. */
export const passageLines = (p: Passage): number[] => p.lines ?? Array.from({ length: p.count }, (_, k) => p.from + k);

/** Lines of a passage that contain at least one of the terms (for the highlight). */
function matchingLines(index: DatasheetIndex, p: Passage, terms: string[]): number[] {
  const lines = index.pages[p.page - 1]!.lines;
  const out: number[] = [];
  for (const i of passageLines(p)) {
    const t = new Set(tokens(lines[i]!.text));
    if (terms.some((q) => t.has(q))) out.push(i);
  }
  return out;
}

export function search(index: DatasheetIndex, query: string, limit = 8): Hit[] {
  const terms = [...new Set(tokens(query))];
  if (!terms.length) return [];
  const s = stats(index);
  const N = index.passages.length;
  const hits: Hit[] = [];
  index.passages.forEach((p, i) => {
    const d = s.docs[i]!;
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const f = d.tf.get(t) ?? 0;
      const h = d.head.has(t);
      if (!f && !h) continue;
      matched++;
      const idf = Math.log(1 + (N - (s.df.get(t) ?? 0) + 0.5) / ((s.df.get(t) ?? 0) + 0.5));
      score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.len) / s.avg)) + (h ? 0.8 : 0));
    }
    if (!matched) return;
    score *= 0.5 + matched / terms.length; // reward covering more of the query
    if (p.kind === "heading") score *= 0.6; // a heading alone says little; its passages carry the content
    hits.push({ passage: p, score, lines: matchingLines(index, p, terms), why: p.kind === "figure" ? (p.caption ? `Figure: ${p.caption}` : "Figure") : p.heading ? `under “${p.heading}”` : "text" });
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---- Sections: the places an engineer looks first ----

export type SectionId = "abs-max" | "operating" | "electrical" | "pins" | "application" | "layout" | "package";

export const SECTIONS: Record<SectionId, { label: string; heading: RegExp; words: string }> = {
  "abs-max": { label: "Absolute maximum ratings", heading: /absolute\s+max|maximum\s+ratings?/i, words: "absolute maximum ratings stress" },
  operating: { label: "Recommended operating conditions", heading: /recommended\s+operating|operating\s+conditions/i, words: "recommended operating conditions supply voltage" },
  electrical: { label: "Electrical characteristics", heading: /electrical\s+char|dc\s+char|specifications/i, words: "electrical characteristics" },
  pins: { label: "Pin configuration and functions", heading: /pin\s+(config|function|descr|assign|out)|terminal\s+(config|function)|pinout/i, words: "pin configuration functions description" },
  application: { label: "Typical application", heading: /typical\s+appl|application\s+(circuit|info)|reference\s+design|schematic/i, words: "typical application circuit" },
  layout: { label: "Layout guidelines", heading: /layout|placement|pcb\s+design/i, words: "layout guidelines placement" },
  package: { label: "Package and land pattern", heading: /package|mechanical|dimensions|land\s+pattern|footprint|outline/i, words: "package dimensions land pattern" },
};

/**
 * The regions under headings that match a section: from the heading down to the
 * next heading on the page (a table, a figure and its notes together), so the
 * engineer sees the section as printed. Full-text search when no heading matches.
 */
export function findSection(index: DatasheetIndex, id: SectionId, limit = 6): Hit[] {
  const sec = SECTIONS[id];
  const hits: Array<Hit & { content: number }> = [];
  for (const h of index.passages) {
    if (h.kind !== "heading" || !sec.heading.test(h.text)) continue;
    const page = index.pages[h.page - 1]!;
    const next = index.passages.find((p) => p.page === h.page && p.kind === "heading" && p.from > h.from);
    const end = next ? next.from : page.lines.length;
    const lines = page.lines.slice(h.from, end).filter((l) => !l.furniture && l.box.y <= page.lines[h.from]!.box.y + page.height * 0.62);
    if (!lines.length) continue;
    const x0 = Math.min(...lines.map((l) => l.box.x));
    const y0 = Math.min(...lines.map((l) => l.box.y));
    // Full text width: a table's notes run wider than the lines we measured.
    let box = { x: Math.min(x0, 36), y: y0, w: page.width - 2 * Math.min(x0, 36), h: Math.max(...lines.map((l) => l.box.y + l.box.h)) - y0 };
    // A section that is mostly a drawing has little text: show the space below the heading too.
    const textLen = lines.map((l) => l.text).join("\n").length - h.text.length;
    if (textLen < 60) {
      const limit = Math.min(page.height - 40, y0 + page.height * 0.4, next ? next.box.y : Infinity);
      box = { x: Math.min(x0, 40), y: y0, w: page.width - 80, h: Math.max(box.h, limit - y0) };
    }
    const text = lines.map((l) => l.text).join("\n");
    const passage: Passage = { id: `s${h.page}-${h.from}`, page: h.page, heading: h.text, kind: lines.length > 3 && lines.filter((l) => l.cells.length >= 3).length >= 3 ? "table" : "text", from: h.from, count: lines.length, text, box };
    hits.push({ passage, box, score: 1, lines: [], why: `under “${h.text}”`, content: text.length - h.text.length });
  }
  // A table of contents lists the headings with nothing under them: real content first, then later pages first.
  // Pictures first: a typical-application circuit or a pinout is what the engineer wants to see.
  const figures: Hit[] = index.passages
    .filter((p) => p.kind === "figure" && p.caption && sec.heading.test(p.caption))
    .slice(0, 3)
    .map((p) => ({ passage: p, score: 5, lines: [], why: `Figure: ${p.caption}` }));
  // A figure already shows its section's picture: drop section regions it mostly covers.
  const overlapsFigure = (b: Box) => figures.some((f) => f.passage.page === (hits.find((h) => h.box === b)?.passage.page ?? -1) && Math.min(f.passage.box.y + f.passage.box.h, b.y + b.h) - Math.max(f.passage.box.y, b.y) > 0.6 * b.h);
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i]!.box && overlapsFigure(hits[i]!.box!)) hits.splice(i, 1);
  const real = hits.filter((h) => h.content > 60);
  const picked = (real.length ? real : hits).sort((a, b) => Math.min(b.content, 800) - Math.min(a.content, 800) || a.passage.page - b.passage.page).slice(0, limit);
  if (picked.length || figures.length) return [...figures, ...picked.map(({ content: _c, ...h }) => h)].slice(0, limit + figures.length);
  return search(index, sec.words, limit).map((h) => ({ ...h, why: "text search (no matching heading)" }));
}

// ---- Pins ----

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The rows of pin tables that describe one pin: a line whose first cell is the
 * pin number (or a cell is the pin's name), and that mentions its name.
 */
export function findPin(index: DatasheetIndex, pin: { number: string; name?: string }, limit = 6): Hit[] {
  const name = pin.name && pin.name !== "~" ? norm(pin.name) : "";
  const hits: Hit[] = [];
  for (const p of index.passages) {
    if (p.kind === "heading") continue;
    const lines = index.pages[p.page - 1]!.lines;
    const rows: number[] = [];
    for (const i of passageLines(p)) {
      const cells = lines[i]!.cells;
      const first = cells[0] ?? "";
      const numberCell = first === pin.number || cells.some((c) => c === pin.number) || first.split(/[\s,]+/).includes(pin.number);
      const nameCell = name && cells.some((c) => norm(c) === name || norm(c).startsWith(name));
      if ((numberCell && (!name || nameCell || norm(lines[i]!.text).includes(name))) || (name && nameCell && /pin|terminal|signal|name/i.test(p.heading ?? ""))) rows.push(i);
    }
    if (!rows.length) continue;
    // Prefer real pin-table rows: under a pin heading, several cells, a description after the name.
    const best = Math.max(...rows.map((i) => lines[i]!.text.length));
    const cells = Math.max(...rows.map((i) => lines[i]!.cells.length));
    hits.push({ passage: p, score: (/pin|terminal/i.test(p.heading ?? "") ? 3 : 0) + (p.kind === "table" ? 1 : 0) + (cells >= 3 ? 1.5 : 0) + (best > 25 ? 2 : 0), lines: rows, why: "pin table row" });
  }
  hits.sort((a, b) => b.score - a.score || a.passage.page - b.passage.page);
  // Weak matches (the pin number in a figure, a page number) are noise next to a real pin-table row.
  const top = hits[0]?.score ?? 0;
  return hits.filter((h) => h.score >= Math.max(2, top * 0.5)).slice(0, limit);
}

// ---- Quotes ----

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** True when `quote` occurs in the page's text (ignoring spacing and case). The only way text from a model reaches the screen. */
export function verifyQuote(index: DatasheetIndex, page: number, quote: string): boolean {
  const p = index.pages[page - 1];
  if (!p || !quote.trim()) return false;
  const hay = squash(p.lines.map((l) => l.text).join(" "));
  return hay.includes(squash(quote));
}

/** The verbatim text of some lines of a passage. */
export function quoteOf(index: DatasheetIndex, passage: Passage, lines?: number[]): string {
  const page = index.pages[passage.page - 1]!;
  const pick = lines?.length ? lines : passageLines(passage);
  return pick.map((i) => page.lines[i]!.text).join("\n");
}

// ---- Figures ----

/** The pictures in the document, in page order; with a query, those whose caption or labels match, best first. */
export function findFigures(index: DatasheetIndex, query = "", limit = 60): Hit[] {
  const figs = index.passages.filter((p) => p.kind === "figure");
  const why = (p: Passage) => (p.caption ? `Figure: ${p.caption}` : "Figure");
  if (!query.trim()) return figs.slice(0, limit).map((p) => ({ passage: p, score: 1, lines: [], why: why(p) }));
  return search(index, query, 200)
    .filter((h) => h.passage.kind === "figure")
    .slice(0, limit)
    .map((h) => ({ ...h, why: why(h.passage) }));
}

/**
 * Datasheet evidence: what we keep from a PDF, and what we show the engineer.
 *
 * Coordinates are PDF points with the origin at the page's top-left (y down),
 * so a box can be drawn over a rendered page by scaling alone.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One visual line of text on a page. */
export interface Line {
  text: string;
  /** Cells of a table-like line: runs separated by a wide gap. */
  cells: string[];
  box: Box;
  /** Font size in points (the largest in the line), and per cell. */
  size: number;
  cellSizes: number[];
  /** x start and end of each cell. */
  cellSpans: Array<[number, number]>;
  bold: boolean;
  /** A running header, footer or page number: repeated on many pages, not content. */
  furniture?: boolean;
}

export interface PageIndex {
  /** 1-based PDF page number. */
  number: number;
  /** The number printed on the page, when it differs from the PDF's (cover pages, roman numerals). */
  label?: string;
  width: number;
  height: number;
  lines: Line[];
}

export type PassageKind = "heading" | "table" | "text" | "figure";

/** A block of lines the search can return whole, under the heading it sits below. */
export interface Passage {
  id: string;
  page: number;
  /** The nearest heading above, if any. */
  heading?: string;
  kind: PassageKind;
  /** Index of its first line on the page, and how many lines it has. */
  from: number;
  count: number;
  /** Explicit line indexes, for passages that are not one run of lines (figures: labels around a drawing). */
  lines?: number[];
  /** For figures: the caption. */
  caption?: string;
  text: string;
  box: Box;
}

export interface DatasheetIndex {
  /** Content hash of the PDF (first 16 hex digits of SHA-256). */
  id: string;
  title: string;
  pages: PageIndex[];
  passages: Passage[];
  /** Pages with no text layer at all (scans). */
  scanned: number[];
  /** These pages were read with OCR. */
  ocr: boolean;
}

/** A hit: a passage and the lines in it that matched. */
export interface Hit {
  passage: Passage;
  /** Region to show instead of the passage's own (a whole section). */
  box?: Box;
  score: number;
  /** Line indexes (on the passage's page) that contain what was searched for. */
  lines: number[];
  /** Why it was returned: "heading", "pin table", "text"… */
  why: string;
}

/** What the engineer can pin to a part: a place in a document, not a claim. */
export interface Evidence {
  doc: { id: string; title: string; source: string };
  page: number;
  label?: string;
  box: Box;
  /** Verbatim text of the region. */
  quote: string;
  heading?: string;
}

/**
 * Text in KiCad's stroke font (Newstroke, CC0), laid out as KiCad lays it
 * out, so plotted, displayed and checked text matches KiCad's.
 *
 * Glyphs: two characters of left/right bounds, then x/y pairs offset from
 * 'R', in units of 1/21 of the text size, y shifted by 8 so the baseline is
 * near 0; " R" lifts the pen. A glyph advances by its width; a space by the
 * space glyph's.
 *
 * Lines: 1.68 × 0.9583 heights apart (the stroke font's legacy pitch). The first line's baseline sits one text height
 * (less a twentieth of the pen) below the anchor for top alignment; centred
 * and bottom-aligned blocks move up by half or all of their height, which
 * counts the first line as 1.17 heights. Left-aligned lines start a pen/1.52
 * in; right-aligned ones end that far short; centred ones are centred on
 * their advance.
 */
import { NEWSTROKE, NEWSTROKE_FIRST } from "./newstroke-data.js";

interface Point {
  x: number;
  y: number;
}
interface Glyph {
  /** Strokes in font units (a text size is 1). */
  strokes: Point[][];
  /** Advance in font units. */
  width: number;
}

const R = 82;
const UNIT = 1 / 21;
const OFFSET = -8;
const cache = new Map<number, Glyph>();

function decode(s: string): Glyph {
  const left = (s.charCodeAt(0) - R) * UNIT;
  const right = (s.charCodeAt(1) - R) * UNIT;
  const strokes: Point[][] = [];
  let cur: Point[] = [];
  for (let i = 2; i + 1 < s.length; i += 2) {
    if (s[i] === " " && s[i + 1] === "R") {
      if (cur.length) strokes.push(cur);
      cur = [];
      continue;
    }
    cur.push({ x: (s.charCodeAt(i) - R) * UNIT - left, y: (s.charCodeAt(i + 1) - R + OFFSET) * UNIT });
  }
  if (cur.length) strokes.push(cur);
  return { strokes, width: right - left };
}

/** The glyph for a code point ("?" for ones the font doesn't have). */
export function strokeGlyph(code: number): Glyph {
  let g = cache.get(code);
  if (g) return g;
  const s = NEWSTROKE[code - NEWSTROKE_FIRST];
  g = s && s.length >= 2 ? decode(s) : strokeGlyph(63);
  cache.set(code, g);
  return g;
}

/** Advance of a string in font units. */
export function strokeAdvance(text: string): number {
  let w = 0;
  for (const ch of text) w += strokeGlyph(ch.codePointAt(0)!).width;
  return w;
}

export interface StrokeLine {
  /** Where the line's first glyph starts (its baseline origin), in the text's frame. */
  x: number;
  y: number;
}

/**
 * Line origins for `lines` of text `size` (x: width, y: height) and `pen`,
 * relative to the anchor, before rotation and mirroring.
 */
export function strokeLinePositions(lines: string[], size: Point, pen: number, justify: string[], advance: (line: string) => number): StrokeLine[] {
  // The stroke font's line pitch: 1.68 heights, scaled to match KiCad's legacy spacing.
  const interline = size.y * 1.68 * 0.9583;
  const height = size.y * 1.17 + (lines.length - 1) * interline;
  let oy = size.y - pen * 0.052;
  const ox = pen / 1.52;
  if (justify.includes("bottom")) oy -= height;
  else if (!justify.includes("top")) oy -= height / 2;
  return lines.map((line, i) => {
    const w = advance(line) * size.x;
    const x = justify.includes("left") ? ox : justify.includes("right") ? -(w + ox) : -w / 2;
    return { x, y: oy + i * interline };
  });
}

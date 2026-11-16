/**
 * Builds the stroke-font glyph table from the Newstroke sources (CC0, in
 * third_party/newstroke): each glyph a KiCad library symbol whose polylines are
 * the strokes and whose pins mark its left/right bounds and accent anchors;
 * charlist.txt maps Unicode code points to glyphs, possibly transformed
 * (mirrored, turned, raised) and with accents placed at anchors.
 *
 * Output: an array of strings, one per code point from 32, in the stroke
 * encoding KiCad's font uses: two characters of bounds, then x/y pairs as
 * characters offset from 'R', with " R" lifting the pen.
 *
 * Usage: node scripts/build-newstroke.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";

const SRC = new URL("../third_party/newstroke/", import.meta.url);
const OUT = new URL("../packages/kicad-model/src/newstroke-data.ts", import.meta.url);
const SCALE = 50; // library units per font unit
const BASE = 9; // baseline offset in font units
const R = 82; // 'R'
const MISSING = "DEL"; // shown for glyphs the map names but the libraries lack
const CAP = -21, X = -14, SYM = -16, SUP = -13, SUB = 6;
// Glyph prefixes: [scale x, scale y, offset y].
const TRANSFORMS = {
  "!": [-1, 1, 0], // mirrored
  "-": [1, -1, X], // flipped, small letter
  "=": [1, -1, CAP], // flipped, capital
  "~": [1, -1, SYM], // flipped, symbol
  "+": [-1, -1, X], // turned, small
  "%": [-1, -1, CAP], // turned, capital
  "*": [-1, -1, SYM], // turned, symbol
  "^": [1, 1, SUP], // superscript
  "`": [-1, 1, SUP], // superscript, mirrored
  ".": [1, 1, SUB], // subscript
  ",": [-1, 1, SUB], // subscript, mirrored
};

// ---- glyph libraries ----
const glyphs = new Map(); // name -> { strokes: [[x, y]...][], left, right, anchors: Map }
for (const file of ["symbol.lib", "font.lib"]) {
  let g;
  for (const line of readFileSync(new URL(file, SRC), "utf8").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[0] === "DEF") glyphs.set(f[1], (g = { strokes: [], left: undefined, right: undefined, anchors: new Map() }));
    else if (f[0] === "P" && g) {
      const n = Number(f[1]);
      const pts = [];
      for (let i = 0; i < n; i++) {
        const p = [Number(f[5 + 2 * i]) / SCALE, -Number(f[6 + 2 * i]) / SCALE];
        const last = pts[pts.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
      }
      g.strokes.push(pts);
    } else if (f[0] === "X" && g) {
      const [name, x, y] = [f[1], Number(f[3]) / SCALE, -Number(f[4]) / SCALE];
      g.anchors.set(name, [x, y]);
      // Bounds: pins named "~" either side of the origin, or P (left) and S (right).
      if ((x > 0 && name === "~") || name === "S") g.right = x;
      else if ((x <= 0 && name === "~") || name === "P") g.left = x;
    }
  }
}

// ---- helpers ----
const parse = (ref) => (ref && TRANSFORMS[ref[0]] ? { name: ref.slice(1), t: TRANSFORMS[ref[0]] } : { name: ref, t: [1, 1, 0] });
const known = (ref) => glyphs.has(parse(ref).name);
const chr = (v) => String.fromCharCode(Math.trunc(v) + R);

/** The strokes of glyph `ref` moved by (dx, dy), encoded. */
function strokes(ref, dx = 0, dy = 0) {
  if (!known(ref)) ref = MISSING;
  const { name, t } = parse(ref);
  const g = glyphs.get(name);
  const oy = dy + t[2] + BASE;
  let out = "";
  let prev;
  g.strokes.forEach((pts, i) => {
    pts.forEach(([x, y], k) => {
      const c = chr(x * t[0] + dx) + chr(y * t[1] + oy);
      // A stroke that starts where the last one ended continues it (no pen lift).
      if (k === 0 && i > 0 && c !== prev) out += " R";
      if (c !== prev) {
        out += c;
        prev = c;
      }
    });
  });
  return out;
}
/** Left and right bounds of `ref` (swapped when mirrored). */
function bounds(ref) {
  if (!known(ref)) ref = MISSING;
  const { name, t } = parse(ref);
  const g = glyphs.get(name);
  const [l, r] = [g.left ?? 0, g.right ?? 0];
  return t[0] < 0 ? [t[0] * r, t[0] * l] : [l, r];
}
/** Where accent `acc` goes on `base` (dx, dy), matched by an anchor ("name" or "base=accent"). */
function anchorOffset(base, acc, anchor) {
  if (!anchor || anchor === "#") return [0, 0];
  const [an, ac] = anchor.includes("=") ? anchor.split("=") : [anchor, anchor];
  const b = parse(base), a = parse(acc);
  const pb = glyphs.get(b.name)?.anchors.get(an), pa = glyphs.get(a.name)?.anchors.get(ac);
  if (!pb || !pa) return [0, 0];
  return [b.t[0] * pb[0] - a.t[0] * pa[0], b.t[1] * pb[1] + b.t[2] - a.t[1] * pa[1] - a.t[2]];
}
/** A base glyph with up to three accents, at x offset `cx`; also the last accent's x offset. */
function compose(f, cx = 0) {
  let s = strokes(f[1], cx, 0);
  let lastDx = 0;
  for (let k = 2; k + 1 <= 7 && f[k] && f[k] !== "#"; k += 2) {
    const [dx, dy] = anchorOffset(f[1], f[k], f[k + 1]);
    s += " R" + strokes(f[k], cx + dx, dy);
    lastDx = dx;
    if (f[k + 1] === "#") break;
  }
  return { s, lastDx };
}

// ---- the character map ----
const table = [];
let first, seq;
for (const line of readFileSync(new URL("charlist.txt", SRC), "utf8").split("\n")) {
  const f = line.trim().split(/\s+/);
  switch (f[0]) {
    case "startchar":
      first ??= Number(f[1]);
      break;
    case "skipcodes":
      for (let i = 0; i < Number(f[1]); i++) table.push(bounds(MISSING).map(chr).join("") + strokes(MISSING));
      break;
    case "+":
    case "+w":
    case "+p": {
      const { s, lastDx } = compose(f);
      let b = bounds(f[1]);
      // +w: wide to the right to fit the accent; +p: from the accent's left.
      if (f[0] === "+w") b = [bounds(f[1])[0], bounds(f[2])[1] + lastDx];
      if (f[0] === "+p") b = [bounds(f[2])[0] + lastDx, bounds(f[1])[1]];
      table.push(b.map(chr).join("") + s);
      break;
    }
    case "+(": // a ligature of several glyphs side by side
      seq = { first: f[1], prev: f[1], x: 0, s: compose(f).s };
      break;
    case "+|":
    case "+)": {
      const [pr, ref] = [bounds(seq.prev), bounds(f[1])];
      seq.x += pr[1] - ref[0];
      seq.s += " R" + compose(f, seq.x).s;
      seq.prev = f[1];
      if (f[0] === "+)") {
        table.push(chr(bounds(seq.first)[0]) + chr(bounds(f[1])[1] + seq.x) + seq.s);
        seq = undefined;
      }
      break;
    }
  }
}

/** Pen lifts between a point and the same point again are no lifts: join those strokes. */
function joinStrokes(glyph) {
  let out = glyph.slice(0, 2);
  for (let i = 2; i < glyph.length; i += 2) {
    const pair = glyph.slice(i, i + 2);
    if (pair === " R" && glyph.slice(i + 2, i + 4) === out.slice(-2) && out.length > 2) {
      i += 2; // skip the lift and the repeated point
      continue;
    }
    out += pair;
  }
  return out;
}
for (let i = 0; i < table.length; i++) table[i] = joinStrokes(table[i]);

writeFileSync(
  OUT,
  `/**
 * The Newstroke stroke font (KiCad's), by Vladimir Uryvaev, CC0 1.0: built by
 * scripts/build-newstroke.mjs from third_party/newstroke. One glyph per code
 * point from NEWSTROKE_FIRST: two characters of left/right bounds, then x/y
 * pairs as characters offset from 'R'; " R" lifts the pen.
 */
export const NEWSTROKE_FIRST = ${first ?? 32};
export const NEWSTROKE: readonly string[] = ${JSON.stringify(table, null, 0).replace(/","/g, '",\n"')};
`,
);
console.log(`${table.length} glyphs from U+${(first ?? 32).toString(16)}`);

/**
 * Text boxes (KiCad's PCB_TEXTBOX), laid out as KiCad lays them out: the
 * text is wrapped to the box's width less its margins (FONT::LinebreakText),
 * then drawn as ordinary text from an anchor at the box's corner, edge middle
 * or centre (by its justification), inset by the margins
 * (PCB_TEXTBOX::GetDrawPos). The box itself is drawn when it has a border.
 *
 * Lengths are worked in KiCad's integer nanometres where KiCad rounds.
 */
import type { BoardText, TextBox } from "./board.js";
import type { Point } from "./geometry.js";
import { strokeGlyph } from "./stroke-font.js";

const NM = 1e6;
const nm = (v: number) => Math.round(v * NM);
const KiROUND = (v: number) => Math.sign(v) * Math.round(Math.abs(v));

/** The text pen KiCad draws with: the thickness, else a fifth (bold) or an eighth of the width, at most a quarter of the size. */
export function textBoxPen(tb: TextBox): number {
  const w = nm(tb.size.x), h = nm(tb.size.y);
  const t = nm(tb.thickness);
  const pen = t > 1 ? t : tb.bold ? KiROUND(w / 5) : KiROUND(w / 8);
  return Math.min(pen, KiROUND(Math.min(w, h) * 0.25)) / NM;
}

/** The width of a run of text in the stroke font (STROKE_FONT::GetTextAsGlyphs' advance), nm. */
function advance(text: string, w: number): number {
  let x = 0;
  for (const ch of text) x += KiROUND(strokeGlyph(ch.codePointAt(0)!).width * w);
  return x;
}

/**
 * KiCad's FONT::LinebreakText: each line of the text broken between words so
 * none is wider than `column` less the text thickness (nm). Words are the
 * text up to and including each space; a word too long for a line keeps its
 * own line.
 */
export function linebreak(text: string, column: number, w: number, thickness: number): string {
  const space = advance(" ", w);
  return text
    .split("\n")
    .map((line) => {
      const words = line.match(/[^ ]* ?/g)!.filter((x) => x !== "");
      let out = "";
      let lineWidth = 0;
      let pending = "";
      let bury = false;
      for (const word of words) {
        let pw = pending.length * space;
        const ww = advance(word.trim() || word, w);
        if (lineWidth + pw + ww > column - thickness && pending.length > 0) {
          out += "\n";
          lineWidth = 0;
          pending = "";
          pw = 0;
          bury = true;
        }
        if (word === " ") pending += word;
        else {
          if (bury) bury = false;
          else {
            out += pending;
            lineWidth += pw;
          }
          if (word.endsWith(" ")) {
            out += word.slice(0, -1);
            pending = " ";
          } else {
            out += word;
            pending = "";
          }
          lineWidth += ww;
        }
      }
      return out;
    })
    .join("\n");
}

const norm360 = (a: number) => ((a % 360) + 360) % 360;

/** EDA_SHAPE::GetCornersInSequence: the box's corners from its top-left as the text reads, nm. */
function cornersInSequence(tb: TextBox, angle: number): Point[] {
  const c = tb.corners.map((p) => ({ x: nm(p.x), y: nm(p.y) }));
  if (tb.rect) {
    // The rectangle's bounding box, with half the border's width (as getBoundingBox inflates it).
    const half = Math.trunc(Math.max(0, nm(tb.borderWidth)) / 2);
    const l = Math.min(...c.map((p) => p.x)) - half, r = Math.max(...c.map((p) => p.x)) + half;
    const t = Math.min(...c.map((p) => p.y)) - half, b = Math.max(...c.map((p) => p.y)) + half;
    const [tl, tr, br, bl] = [{ x: l, y: t }, { x: r, y: t }, { x: r, y: b }, { x: l, y: b }];
    if (angle === 90) return [bl, tl, tr, br];
    if (angle === 180) return [br, bl, tl, tr];
    if (angle === 270) return [tr, br, bl, tl];
    return [tl, tr, br, bl];
  }
  let minX = c[0]!, maxX = c[0]!, minY = c[0]!, maxY = c[0]!;
  for (const p of c) {
    if (p.x < minX.x) minX = p;
    if (p.x > maxX.x) maxX = p;
    if (p.y < minY.y) minY = p;
    if (p.y > maxY.y) maxY = p;
  }
  if (angle < 90) return [minX, minY, maxX, maxY];
  if (angle < 180) return [maxY, minX, minY, maxX];
  if (angle < 270) return [maxX, maxY, minX, minY];
  return [minY, maxX, maxY, minX];
}

/** KiCad's RotatePoint (counter-clockwise on screen, y down). */
function rotate(p: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: Math.round(p.x * c + p.y * s), y: Math.round(-p.x * s + p.y * c) };
}

/**
 * The text a text box draws, as an ordinary board text: wrapped, anchored and
 * justified as KiCad draws it.
 */
export function textBoxText(tb: TextBox): BoardText {
  const angle = norm360(tb.angle);
  const corners = cornersInSequence(tb, angle);
  const mirror = tb.justify.includes("mirror");
  const just: "left" | "center" | "right" = tb.justify.includes("left") ? "left" : tb.justify.includes("right") ? "right" : "center";
  const v: "top" | "center" | "bottom" = tb.justify.includes("top") ? "top" : tb.justify.includes("bottom") ? "bottom" : "center";
  // Mirrored (back-side) text anchors at the other side; it is drawn with its own justification, mirrored.
  const h = mirror ? (just === "left" ? "right" : just === "right" ? "left" : just) : just;
  const mid = (a: Point, b: Point) => ({ x: Math.trunc((a.x + b.x) / 2), y: Math.trunc((a.y + b.y) / 2) });
  const [c0, c1, c2, c3] = corners as [Point, Point, Point, Point];
  const centre = { x: Math.trunc((c0.x + c1.x + c2.x + c3.x) / 4), y: Math.trunc((c0.y + c1.y + c2.y + c3.y) / 4) };
  const anchor = {
    "left top": c0, "center top": mid(c0, c1), "right top": c1,
    "left center": mid(c0, c3), "center center": centre, "right center": mid(c1, c2),
    "left bottom": c3, "center bottom": mid(c3, c2), "right bottom": c2,
  }[`${h} ${v}`]!;
  const m = { l: nm(tb.margins.left), t: nm(tb.margins.top), r: nm(tb.margins.right), b: nm(tb.margins.bottom) };
  const off = rotate({ x: h === "left" ? m.l : h === "right" ? -m.r : 0, y: v === "top" ? m.t : v === "bottom" ? -m.b : 0 }, angle);
  let column = Math.hypot(c1.x - c0.x, c1.y - c0.y);
  column -= angle === 0 || angle === 180 ? m.l + m.r : m.t + m.b;
  return {
    layer: tb.layer,
    text: linebreak(tb.text, Math.trunc(column), nm(tb.size.x), nm(tb.thickness)),
    at: { x: (anchor.x + off.x) / NM, y: (anchor.y + off.y) / NM },
    rotation: tb.angle,
    size: tb.size,
    thickness: textBoxPen(tb),
    justify: [just, v, ...(mirror ? ["mirror"] : [])].filter((j) => j !== "center"),
    // The pen above is already the bold one.
  };
}

/** The border's corners in order (a closed loop), when the box has one to draw. */
export function textBoxBorder(tb: TextBox): Point[] | undefined {
  return tb.border && tb.borderWidth > 0 ? tb.corners : undefined;
}

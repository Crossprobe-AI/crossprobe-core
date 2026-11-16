/**
 * Figures: the pictures in a datasheet (typical application circuits, block
 * diagrams, pinouts, layout examples, graphs). pdf.js's drawing operations give
 * the boxes of images and vector drawing; nearby ones are merged into a figure,
 * tied to its caption, and kept with the text labels inside it. Table rules
 * (axis-aligned lines only) are not figures.
 */
import type { Box, Line, PageIndex } from "./types";

/** pdf.js operator codes this file needs (passed in, so tests can use the Node build). */
export interface OpsLike {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
}

export interface OpListLike {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];

/** One piece of drawing on a page, in points with y down. */
export interface Mark {
  box: Box;
  kind: "image" | "path";
  /** A path with a diagonal, a curve, or a filled shape: drawings, not table rules. */
  shaped: boolean;
}

/** Boxes of everything drawn on a page (images and filled or stroked paths). */
export function marksOf(ops: OpsLike, list: OpListLike, width: number, height: number, vt: number[]): Mark[] {
  const painting = new Set([ops.stroke, ops.closeStroke, ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const marks: Mark[] = [];
  const toBox = (pts: Array<[number, number]>): Box => {
    // pdf.js's view transform maps user space to the displayed page (rotation and y flip included).
    const mapped = pts.map(([x, y]): [number, number] => [vt[0]! * x + vt[2]! * y + vt[4]!, vt[1]! * x + vt[3]! * y + vt[5]!]);
    const xs = mapped.map((p) => p[0]);
    const ys = mapped.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  };
  const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i]!;
    const args = list.argsArray[i] as unknown;
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore) ctm = stack.pop() ?? ctm;
    else if (fn === ops.transform) ctm = mul(ctm, args as M);
    else if (fn === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = (args as unknown[])[0] as M | null;
      if (m) ctm = mul(ctm, m);
    } else if (fn === ops.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject || fn === ops.paintImageMaskXObject) {
      const corners: Array<[number, number]> = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
      marks.push({ box: toBox(corners), kind: "image", shaped: true });
    } else if (fn === ops.constructPath) {
      const [paint, data, minMax] = args as [number, ArrayLike<number>, ArrayLike<number> | undefined];
      if (!painting.has(paint) || !minMax) continue;
      let shaped = paint === ops.fill || paint === ops.eoFill || paint === ops.fillStroke || paint === ops.closeFillStroke || paint === ops.eoFillStroke || paint === ops.closeEOFillStroke;
      // Path data is a flat list: 0 moveTo x y, 1 lineTo x y, 2 curveTo x1 y1 x2 y2 x y, 3 quadratic, 4 close.
      let px = 0;
      let py = 0;
      for (let k = 0; k < data.length && !shaped; ) {
        const code = data[k]!;
        if (code === 0 || code === 1) {
          const x = data[k + 1]!;
          const y = data[k + 2]!;
          if (code === 1 && Math.abs(x - px) > 0.6 && Math.abs(y - py) > 0.6) shaped = true;
          px = x;
          py = y;
          k += 3;
        } else if (code === 2) {
          shaped = true;
          k += 7;
        } else if (code === 3) {
          shaped = true;
          k += 5;
        } else k += 1;
      }
      const [x0, y0, x1, y1] = [minMax[0]!, minMax[1]!, minMax[2]!, minMax[3]!];
      marks.push({ box: toBox([apply(ctm, x0, y0), apply(ctm, x1, y0), apply(ctm, x0, y1), apply(ctm, x1, y1)]), kind: "path", shaped });
    }
  }
  return marks.filter((m) => m.box.w < width * 0.995 || m.box.h < height * 0.995); // not the page border or background
}

const gapBetween = (a: Box, b: Box): number => Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w), Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

export interface Figure {
  page: number;
  /** The picture, with its caption. */
  box: Box;
  caption?: string;
  /** Indexes of the page's lines inside the picture or its caption (labels, notes). */
  lines: number[];
  /** Contains an embedded image (a photo, a graph exported as a bitmap). */
  image: boolean;
}

const CAPTION = /^(figure|fig\.?)\s*[\d.-]+/i;
const KEYWORD = /typical\s+appl|application\s+circuit|block\s+diagram|reference\s+(design|circuit)|schematic|layout|pinout|pin\s+(assign|config)|diagram|waveform|timing|curve|characteristic/i;

/** Merge a page's marks into figures and attach captions and labels. */
export function figuresOf(page: PageIndex, marks: Mark[], headingLines: Set<number>): Figure[] {
  // Cluster boxes that touch or nearly touch.
  const clusters: Array<{ box: Box; n: number; shaped: number; image: boolean; rules: number }> = [];
  const sorted = marks.slice().sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  for (const m of sorted) {
    const thin = Math.min(m.box.w, m.box.h) < 2.5 && Math.max(m.box.w, m.box.h) > 20;
    const near = clusters.filter((c) => gapBetween(c.box, m.box) <= 7);
    if (!near.length) {
      clusters.push({ box: m.box, n: 1, shaped: m.shaped ? 1 : 0, image: m.kind === "image", rules: thin ? 1 : 0 });
      continue;
    }
    // A mark can bridge several clusters.
    const [first, ...rest] = near;
    first!.box = union(first!.box, m.box);
    first!.n++;
    if (m.shaped) first!.shaped++;
    if (m.kind === "image") first!.image = true;
    if (thin) first!.rules++;
    for (const r of rest) {
      first!.box = union(first!.box, r.box);
      first!.n += r.n;
      first!.shaped += r.shaped;
      first!.image ||= r.image;
      first!.rules += r.rules;
      clusters.splice(clusters.indexOf(r), 1);
    }
  }
  const figures: Figure[] = [];
  for (const c of clusters) {
    const big = c.box.w >= 70 && c.box.h >= 45;
    // Tables are grids of rules and rectangles: no diagonals, curves or images, mostly thin lines.
    const tableLike = !c.image && c.shaped < 6 && c.rules >= c.n * 0.5;
    if (!big || tableLike || (!c.image && c.n < 8)) continue;
    // Labels inside the drawing, then a caption just above or below.
    const inside = (l: Line) => l.box.x >= c.box.x - 4 && l.box.x + l.box.w <= c.box.x + c.box.w + 4 && l.box.y >= c.box.y - 4 && l.box.y + l.box.h <= c.box.y + c.box.h + 4;
    const lines: number[] = [];
    page.lines.forEach((l, i) => inside(l) && !l.furniture && lines.push(i));
    let caption: string | undefined;
    let box = c.box;
    // Short labels just beside the drawing (a value on a pin, a note on a rail) belong to it.
    page.lines.forEach((l, i) => {
      if (l.furniture || lines.includes(i) || l.cells.length > 2 || l.text.length > 24) return;
      const beside = l.box.y >= c.box.y - 2 && l.box.y + l.box.h <= c.box.y + c.box.h + 2 && l.box.x >= c.box.x + c.box.w - 4 && l.box.x <= c.box.x + c.box.w + 90;
      if (beside) (lines.push(i), (box = union(box, l.box)));
    });
    // A caption line can hold two captions side by side (two-column pages): take the cell over this drawing.
    const overlap = (x0: number, x1: number) => x1 > c.box.x - 20 && x0 < c.box.x + c.box.w + 20;
    const candidates = page.lines
      .map((l, i) => {
        const k = l.cells.findIndex((t, n) => (CAPTION.test(t) || (headingLines.has(i) && KEYWORD.test(t))) && overlap(l.cellSpans[n]![0], l.cellSpans[n]![1]));
        return { l, i, k };
      })
      .filter(({ l, i, k }) => k >= 0 && !l.furniture && !inside(l))
      .map(({ l, i, k }) => ({ l, i, k, gap: l.box.y >= c.box.y + c.box.h ? l.box.y - (c.box.y + c.box.h) : c.box.y - (l.box.y + l.box.h) }))
      .filter((x) => x.gap >= -2 && x.gap < 44)
      .sort((a, b) => a.gap - b.gap);
    const cap = candidates[0];
    if (cap) {
      const [cx0, cx1] = cap.l.cellSpans[cap.k]!;
      const capBox: Box = { x: cx0, y: cap.l.box.y, w: cx1 - cx0, h: cap.l.box.h };
      caption = cap.l.cells[cap.k]!.replace(/\s+/g, " ").trim();
      box = union(box, capBox);
      lines.push(cap.i);
      // The caption wraps: following lines directly beneath it, in the same column.
      for (let j = cap.i + 1; j < page.lines.length && cap.l.box.y > c.box.y; j++) {
        const next = page.lines[j]!;
        const inColumn = next.cellSpans.some(([x0, x1]) => x0 >= cx0 - 6 && x0 < cx1);
        if (next.box.y - (page.lines[j - 1]!.box.y + page.lines[j - 1]!.box.h) > next.size * 0.8 || headingLines.has(j) || CAPTION.test(next.text) || !inColumn) break;
        if (next.box.y > box.y + box.h + 40) break;
        box = union(box, next.box);
        lines.push(j);
      }
    }
    // Diagrams without a caption: kept when they carry labels (components, pin names) or an image.
    if (!caption && !c.image && lines.length < 3) continue;
    // A grid of cells (a ratings table with shaded rows) or a block of prose in a box is not a picture.
    const rows = lines.map((i) => page.lines[i]!);
    const gridLike = rows.length >= 5 && rows.filter((l) => l.cells.length >= 3).length >= rows.length * 0.45;
    const wideRows = rows.filter((l) => l.cells.length >= 4).length;
    if (rows.length >= 25 || (!c.image && (gridLike || (!caption && wideRows >= 2)))) continue;
    figures.push({ page: page.number, box, caption, lines: [...new Set(lines)].sort((a, b) => a - b), image: c.image });
  }
  // Clusters that split one drawing: keep the larger of heavily overlapping figures.
  const area = (b: Box) => b.w * b.h;
  const inter = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const kept = figures.filter((f, i) => !figures.some((g, j) => j !== i && inter(f.box, g.box) > 0.6 * area(f.box) && (area(g.box) > area(f.box) || (area(g.box) === area(f.box) && j < i))));
  return kept.sort((a, b) => a.box.y - b.box.y);
}

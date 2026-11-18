/**
 * Board rendering: turns the board model into cached Path2D objects per
 * layer, drawn on a canvas. Building paths once and only re-stroking them
 * on pan/zoom keeps large boards (thousands of footprints, big zone fills)
 * interactive.
 */
import { displayName, knockoutText, padCorners, textBoxBorder, textBoxText, textOutline, textPen, textStrokes, type Board, type DrawingSheetPrim, type BoardText, type Graphic, type Pad, type Point } from "@crossprobe/kicad-model";

export const LAYER_COLORS: Record<string, string> = {
  "F.Cu": "#c83434",
  "B.Cu": "#4d7fc4",
  "F.SilkS": "#f2eda1",
  "B.SilkS": "#e8b2a7",
  "F.Fab": "#afafaf",
  "B.Fab": "#585d84",
  "F.CrtYd": "#ff26e2",
  "B.CrtYd": "#26e9ff",
  "F.Mask": "#d864ff",
  "B.Mask": "#02ffee",
  "F.Paste": "#b5b5b5",
  "B.Paste": "#00c2c2",
  "Edge.Cuts": "#d0d2cd",
  "Dwgs.User": "#c2c2c2",
  "Cmts.User": "#5994dc",
  "Eco1.User": "#b4dbd2",
  "Eco2.User": "#d8c852",
  Margin: "#ff26e2",
};
const INNER = ["#7fc87f", "#ce7d2c", "#4f7038", "#85497e", "#aca34c", "#3b6969", "#91678f", "#5c8fd0", "#b77b4d", "#8ca870"];

export function layerColor(name: string, copper: string[]): string {
  if (LAYER_COLORS[name]) return LAYER_COLORS[name]!;
  const i = copper.indexOf(name);
  return INNER[(Math.max(i, 1) - 1) % INNER.length]!;
}

export interface LayerPaths {
  name: string;
  color: string;
  fills: Path2D; // zones and filled graphics
  strokes: Map<number, Path2D>; // tracks and outlines by width
  pads: Path2D;
  /** Knockout texts: a filled box with the letters (stroked at `width`) cut out. */
  knockouts: Array<{ box: Path2D; letters: Path2D; width: number }>;
}

export interface BoardScene {
  layers: Map<string, LayerPaths>;
  /** Drawing order, back to front. */
  order: string[];
  vias: Path2D;
  holes: Path2D;
  bbox: { x: number; y: number; w: number; h: number };
}

const rot = (p: Point, deg: number): Point => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c };
};

/** Rounded rectangle centred at `c`, rotated, as a closed polygon. */
function roundRect(path: Path2D, c: Point, w: number, h: number, radius: number, deg: number) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const pts: Point[] = [];
  const corner = (cx: number, cy: number, start: number) => {
    const n = r > 0 ? 6 : 1;
    for (let i = 0; i < n; i++) {
      const a = ((start + (90 * i) / Math.max(n - 1, 1)) * Math.PI) / 180;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  };
  corner(w / 2 - r, h / 2 - r, 0);
  corner(-w / 2 + r, h / 2 - r, 90);
  corner(-w / 2 + r, -h / 2 + r, 180);
  corner(w / 2 - r, -h / 2 + r, 270);
  pts.forEach((p, i) => {
    const q = rot(p, deg);
    if (i === 0) path.moveTo(c.x + q.x, c.y + q.y);
    else path.lineTo(c.x + q.x, c.y + q.y);
  });
  path.closePath();
}

export function padPath(path: Path2D, padIn: Pad) {
  const { x: w, y: h } = padIn.size;
  // The copper is centred on the hole plus the pad's (rotated) offset.
  const o = padIn.offset ? rot(padIn.offset, padIn.rotation) : undefined;
  const pad = o ? { ...padIn, at: { x: padIn.at.x + o.x, y: padIn.at.y + o.y } } : padIn;
  if (pad.shape === "custom" && pad.primitives?.length) {
    customPadPath(path, pad);
    return;
  }
  if (pad.chamfer && (pad.shape === "rect" || pad.shape === "roundrect")) {
    const pts = padCorners(pad).map((p) => {
      const q = rot(p, pad.rotation);
      return { x: pad.at.x + q.x, y: pad.at.y + q.y };
    });
    path.moveTo(pts[0]!.x, pts[0]!.y);
    for (const p of pts.slice(1)) path.lineTo(p.x, p.y);
    path.closePath();
    return;
  }
  switch (pad.shape) {
    case "circle":
      path.moveTo(pad.at.x + w / 2, pad.at.y);
      path.arc(pad.at.x, pad.at.y, w / 2, 0, Math.PI * 2);
      break;
    case "oval":
      roundRect(path, pad.at, w, h, Math.min(w, h) / 2, pad.rotation);
      break;
    case "roundrect":
      roundRect(path, pad.at, w, h, Math.min(w, h) * (pad.roundrectRatio ?? 0.25), pad.rotation);
      break;
    default:
      roundRect(path, pad.at, w, h, 0, pad.rotation);
  }
}

/**
 * A custom pad: its anchor plus primitives (in the pad frame). Every subpath
 * is wound the same way so overlapping parts fill (non-zero rule).
 */
function customPadPath(path: Path2D, pad: Pad) {
  const place = (p: Point) => {
    const q = rot(p, pad.rotation);
    return { x: pad.at.x + q.x, y: pad.at.y + q.y };
  };
  const polygon = (pts: Point[]) => {
    if (pts.length < 3) return;
    const area = pts.reduce((a, p, i) => {
      const q = pts[(i + 1) % pts.length]!;
      return a + p.x * q.y - q.x * p.y;
    }, 0);
    const ordered = area < 0 ? [...pts].reverse() : pts;
    path.moveTo(ordered[0]!.x, ordered[0]!.y);
    for (const p of ordered.slice(1)) path.lineTo(p.x, p.y);
    path.closePath();
  };
  const { x: w, y: h } = pad.size;
  if (w > 0 && h > 0) polygon([{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }].map(place));
  for (const pr of pad.primitives ?? []) {
    if (pr.kind === "poly") polygon(pr.points.map(place));
    else if (pr.kind === "rect") {
      const [a, b] = [pr.points[0]!, pr.points[1]!];
      polygon([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }].map(place));
    } else if (pr.kind === "circle") {
      const c = place(pr.points[0]!);
      const r = Math.hypot(pr.points[1]!.x - pr.points[0]!.x, pr.points[1]!.y - pr.points[0]!.y) + pr.width / 2;
      polygon(Array.from({ length: 32 }, (_, i) => ({ x: c.x + r * Math.cos((i * Math.PI) / 16), y: c.y + r * Math.sin((i * Math.PI) / 16) })));
    } else if (pr.kind === "line") {
      // A thick line as a rectangle.
      const [a, b] = [place(pr.points[0]!), place(pr.points[1]!)];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const n = { x: (-(b.y - a.y) / len) * (pr.width / 2), y: ((b.x - a.x) / len) * (pr.width / 2) };
      polygon([
        { x: a.x + n.x, y: a.y + n.y },
        { x: b.x + n.x, y: b.y + n.y },
        { x: b.x - n.x, y: b.y - n.y },
        { x: a.x - n.x, y: a.y - n.y },
      ]);
    }
  }
}

function arcThrough(path: Path2D, a: Point, m: Point, b: Point) {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-9) {
    path.moveTo(a.x, a.y);
    path.lineTo(b.x, b.y);
    return;
  }
  const sq = (p: Point) => p.x * p.x + p.y * p.y;
  const cx = (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d;
  const cy = (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  const ang = (p: Point) => Math.atan2(p.y - cy, p.x - cx);
  const tau = Math.PI * 2;
  const norm = (x: number) => ((x % tau) + tau) % tau;
  const ccw = norm(ang(m) - ang(a)) > norm(ang(b) - ang(a));
  path.moveTo(a.x, a.y);
  path.arc(cx, cy, r, ang(a), ang(b), ccw);
}

function graphicPath(g: Graphic, fills: Path2D, stroke: Path2D) {
  const p = g.points;
  switch (g.kind) {
    case "line":
      stroke.moveTo(p[0]!.x, p[0]!.y);
      stroke.lineTo(p[1]!.x, p[1]!.y);
      break;
    case "rect": {
      const [a, b] = [p[0]!, p[1]!];
      const target = g.fill ? fills : stroke;
      target.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      if (g.fill) stroke.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      break;
    }
    case "circle": {
      const r = Math.hypot(p[1]!.x - p[0]!.x, p[1]!.y - p[0]!.y);
      for (const t of g.fill ? [fills, stroke] : [stroke]) {
        t.moveTo(p[0]!.x + r, p[0]!.y);
        t.arc(p[0]!.x, p[0]!.y, r, 0, Math.PI * 2);
      }
      break;
    }
    case "arc":
      arcThrough(stroke, p[0]!, p[1]!, p[2]!);
      break;
    case "poly":
    case "curve":
      for (const t of g.fill ? [fills, stroke] : [stroke]) {
        p.forEach((q, i) => (i ? t.lineTo(q.x, q.y) : t.moveTo(q.x, q.y)));
        if (g.kind === "poly") t.closePath();
      }
      break;
  }
}

/** Layers a pad appears on, expanding "*.Cu" and "F&B.Cu". */
export function padLayers(pad: Pad, copper: string[]): string[] {
  const out: string[] = [];
  for (const l of pad.layers) {
    if (l === "*.Cu") out.push(...copper);
    else if (l === "F&B.Cu") out.push("F.Cu", "B.Cu");
    else if (l.startsWith("*.")) out.push(`F.${l.slice(2)}`, `B.${l.slice(2)}`);
    else out.push(l);
  }
  return out;
}

export interface NetFilter {
  net?: string;
  reference?: string;
}

/**
 * Build the scene. With a filter, only items on that net (or footprint) are
 * included — used for the highlight overlay.
 */
export function buildScene(board: Board, filter?: NetFilter): BoardScene {
  const copper = board.copperLayers.length ? board.copperLayers : ["F.Cu", "B.Cu"];
  const layers = new Map<string, LayerPaths>();
  const L = (name: string) => {
    let l = layers.get(name);
    if (!l) layers.set(name, (l = { name, color: layerColor(name, copper), fills: new Path2D(), strokes: new Map(), pads: new Path2D(), knockouts: [] }));
    return l;
  };
  const S = (l: LayerPaths, w: number) => {
    const k = Math.round(w * 1000) / 1000;
    let p = l.strokes.get(k);
    if (!p) l.strokes.set(k, (p = new Path2D()));
    return p;
  };
  const vias = new Path2D();
  const holes = new Path2D();
  // Texts in KiCad's stroke font, as the fab's plotter draws them.
  const addText = (t: BoardText) => {
    const l = L(t.layer);
    const w = textPen(t);
    if (t.knockout) {
      const k = knockoutText(t);
      if (!k) return;
      const box = new Path2D();
      k.box.forEach((p, i) => (i ? box.lineTo(p.x, p.y) : box.moveTo(p.x, p.y)));
      box.closePath();
      const letters = new Path2D();
      for (const st of k.strokes) st.forEach((p, i) => (i ? letters.lineTo(p.x, p.y) : letters.moveTo(p.x, p.y)));
      l.knockouts.push({ box, letters, width: w });
      return;
    }
    const glyphs = textOutline(t);
    if (glyphs) {
      // TrueType text: KiCad's glyph outlines, filled.
      for (const poly of glyphs) {
        poly.forEach((p, k) => (k ? l.fills.lineTo(p.x, p.y) : l.fills.moveTo(p.x, p.y)));
        l.fills.closePath();
      }
      return;
    }
    const path = S(l, w);
    for (const st of textStrokes(t)) {
      if (st.length === 1) {
        path.moveTo(st[0]!.x, st[0]!.y);
        path.lineTo(st[0]!.x + 1e-4, st[0]!.y);
      } else st.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
    }
  };
  const keep = (net: string) => !filter || (filter.net !== undefined && net === filter.net);

  for (const z of board.zones) {
    if (!keep(z.net) || z.keepout) continue;
    for (const fill of z.fills) {
      const path = L(fill.layer).fills;
      fill.points.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
      path.closePath();
    }
  }
  for (const t of board.tracks) {
    if (!keep(t.net)) continue;
    const path = S(L(t.layer), t.width);
    if (t.kind === "arc" && t.mid) arcThrough(path, t.start, t.mid, t.end);
    else {
      path.moveTo(t.start.x, t.start.y);
      path.lineTo(t.end.x, t.end.y);
    }
  }
  for (const v of board.vias) {
    if (!keep(v.net)) continue;
    vias.moveTo(v.at.x + v.size / 2, v.at.y);
    vias.arc(v.at.x, v.at.y, v.size / 2, 0, Math.PI * 2);
    holes.moveTo(v.at.x + v.drill / 2, v.at.y);
    holes.arc(v.at.x, v.at.y, v.drill / 2, 0, Math.PI * 2);
  }
  for (const fp of board.footprints) {
    const wholeFootprint = !filter || (filter.reference !== undefined && fp.reference === filter.reference);
    for (const pad of fp.pads) {
      if (!wholeFootprint && !keep(pad.net)) continue;
      for (const layer of padLayers(pad, copper)) {
        if (!layer.endsWith(".Cu")) continue;
        padPath(L(layer).pads, pad);
      }
      if (pad.drill && (pad.type === "thru_hole" || pad.type === "np_thru_hole")) {
        if (pad.drillSize) roundRect(holes, pad.at, pad.drillSize.x, pad.drillSize.y, Math.min(pad.drillSize.x, pad.drillSize.y) / 2, pad.rotation);
        else {
          holes.moveTo(pad.at.x + pad.drill / 2, pad.at.y);
          holes.arc(pad.at.x, pad.at.y, pad.drill / 2, 0, Math.PI * 2);
        }
      }
    }
    if (!wholeFootprint) continue;
    for (const g of fp.graphics) {
      const l = L(g.layer);
      graphicPath(g, l.fills, S(l, g.width || 0.1));
    }
    for (const t of fp.texts) addText(t);
  }
  if (!filter) {
    for (const g of board.drawings) {
      const l = L(g.layer);
      graphicPath(g, l.fills, S(l, g.width || 0.1));
    }
    for (const t of board.texts) addText(t);
    // Text boxes: the border, and the text wrapped in the box, as KiCad draws them.
    for (const tb of board.textBoxes) {
      const border = textBoxBorder(tb);
      if (border) {
        const path = S(L(tb.layer), tb.borderWidth);
        border.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
        path.closePath();
      }
      addText(textBoxText(tb));
    }
  }

  // Back to front: user layers, back side, inner copper (deepest first), front side.
  const back = ["B.CrtYd", "B.Fab", "B.Paste", "B.Mask", "B.SilkS"];
  const front = ["F.Mask", "F.Paste", "F.Cu", "F.SilkS", "F.Fab", "F.CrtYd"];
  const inner = copper.filter((c) => c !== "F.Cu" && c !== "B.Cu").reverse();
  const known = new Set(["B.Cu", ...back, ...inner, ...front, "Edge.Cuts"]);
  const others = [...layers.keys()].filter((k) => !known.has(k));
  const order = [...others, ...back.slice(0, 4), "B.Cu", "B.SilkS", ...inner, ...front, "Edge.Cuts"].filter((k, i, a) => a.indexOf(k) === i);

  // Bounding box from the outline, else from everything.
  const pts: Point[] = board.outline.flatMap((o) => o.points);
  if (pts.length === 0) for (const fp of board.footprints) pts.push(fp.at, ...fp.pads.map((p) => p.at));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  // Without an outline, footprint anchors get a margin so their bodies fit too.
  const m = board.outline.length ? 0 : 10;
  const bbox = pts.length
    ? { x: Math.min(...xs) - m, y: Math.min(...ys) - m, w: Math.max(...xs) - Math.min(...xs) + 2 * m, h: Math.max(...ys) - Math.min(...ys) + 2 * m }
    : { x: 0, y: 0, w: 100, h: 100 };

  return { layers, order, vias, holes, bbox };
}

/** Find what is under a board point: pad, via, then track. */
export function hitTest(board: Board, p: Point, tolerance: number): { net?: string; reference?: string } | undefined {
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      const q = rot({ x: p.x - pad.at.x, y: p.y - pad.at.y }, -pad.rotation);
      if (Math.abs(q.x) <= pad.size.x / 2 + tolerance && Math.abs(q.y) <= pad.size.y / 2 + tolerance) {
        return { net: pad.net || undefined, reference: fp.reference };
      }
    }
  }
  for (const v of board.vias) if (Math.hypot(p.x - v.at.x, p.y - v.at.y) <= v.size / 2 + tolerance) return { net: v.net };
  for (const t of board.tracks) {
    const dx = t.end.x - t.start.x;
    const dy = t.end.y - t.start.y;
    const len2 = dx * dx + dy * dy;
    const u = len2 ? Math.max(0, Math.min(1, ((p.x - t.start.x) * dx + (p.y - t.start.y) * dy) / len2)) : 0;
    const d = Math.hypot(p.x - (t.start.x + u * dx), p.y - (t.start.y + u * dy));
    if (d <= t.width / 2 + tolerance) return { net: t.net };
  }
  return undefined;
}

/** Knockout texts of a layer: the box in the layer's colour, the letters in `background`. */
export function drawKnockouts(ctx: CanvasRenderingContext2D, l: LayerPaths, color: string | CanvasGradient | CanvasPattern, background: string) {
  for (const k of l.knockouts) {
    ctx.fillStyle = color;
    ctx.fill(k.box);
    ctx.strokeStyle = background;
    ctx.lineWidth = k.width;
    ctx.stroke(k.letters);
  }
}

/** KiCad's short net name: the last part of a hierarchical name, escapes undone ({slash} → /). */
export function shortNetName(net: string): string {
  // Split the hierarchical path first ("/sheet/NET" → "NET"), then undo escapes, so
  // "/VPP{slash}MCLR" reads "VPP/MCLR".
  const parts = net.split("/").filter(Boolean);
  const last = parts.length ? parts[parts.length - 1]! : net;
  // Text markup (~{overbar}, ^{super}, _{sub}) reads as its plain text here.
  return displayName(last).replace(/[~^_]\{([^}]*)\}/g, "$1");
}

/**
 * Pad numbers and net names drawn inside the pads, as KiCad does: along the
 * pad's longer side, sized to fit, once the pad is big enough on screen to
 * read. `view` is the visible board area (mm), so off-screen pads cost nothing.
 */
export function drawPadLabels(
  ctx: CanvasRenderingContext2D,
  board: Board,
  scale: number,
  flipped: boolean,
  visible: Set<string>,
  view: { x0: number; y0: number; x1: number; y1: number },
) {
  const minPx = 9; // smaller pads stay unlabelled
  const front = flipped ? "B.Cu" : "F.Cu";
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const fp of board.footprints)
    for (const pad of fp.pads) {
      const short = Math.min(pad.size.x, pad.size.y);
      if (short * scale < minPx) continue;
      const r = Math.max(pad.size.x, pad.size.y) / 2;
      if (pad.at.x + r < view.x0 || pad.at.x - r > view.x1 || pad.at.y + r < view.y0 || pad.at.y - r > view.y1) continue;
      // Labelled on the side being looked at (through-hole pads are on both).
      const layers = pad.layers;
      const onFront = layers.some((l) => l === front || l === "*.Cu" || l === "F&B.Cu");
      const onShown = layers.some((l) => (l.endsWith(".Cu") || l === "*.Cu") && (visible.has(l) || l === "*.Cu"));
      if (!onFront || !onShown) continue;
      const net = pad.net && !pad.net.startsWith("unconnected-") ? shortNetName(pad.net) : "";
      const lines = [pad.number, net].filter(Boolean);
      if (!lines.length) continue;
      // Along the longer side: KiCad reads vertical labels bottom to top.
      // Round and square pads have no long side: their labels stay horizontal.
      let angle = Math.abs(pad.size.x - pad.size.y) < 1e-6 ? 0 : -pad.rotation;
      let [long, across] = [pad.size.x, pad.size.y];
      if (pad.size.y > pad.size.x) {
        angle -= 90;
        [long, across] = [pad.size.y, pad.size.x];
      }
      angle = ((angle % 360) + 360) % 360;
      if (angle >= 90 && angle < 270) angle -= 180;
      // Fit: each line's height a share of the narrow side, its width within the long side.
      const longest = Math.max(...lines.map((l) => l.length));
      const size = Math.min((across * 0.62) / lines.length, (long * 0.8) / (longest * 0.62));
      if (size * scale < 4) continue;
      ctx.save();
      ctx.translate(pad.at.x, pad.at.y);
      if (flipped) ctx.scale(-1, 1);
      ctx.rotate(((flipped ? -angle : angle) * Math.PI) / 180);
      ctx.font = `${size}px "Helvetica Neue", Arial, sans-serif`;
      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      lines.forEach((line, i) => ctx.fillText(line, 0, (i - (lines.length - 1) / 2) * size * 1.05));
      ctx.restore();
    }
  ctx.restore();
}

/**
 * Net names along tracks, as KiCad shows them when zoomed in: inside the
 * track, along it and kept upright, repeated along long segments. Only
 * tracks wide enough on screen to read, on visible layers (or just `layer`), in `view`.
 */
export function drawTrackLabels(
  ctx: CanvasRenderingContext2D,
  board: Board,
  scale: number,
  flipped: boolean,
  visible: Set<string>,
  view: { x0: number; y0: number; x1: number; y1: number },
  layer?: string,
) {
  const minPx = 9;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  let font = 0;
  for (const t of board.tracks) {
    if (!t.net || t.width * scale < minPx || !visible.has(t.layer) || (layer && t.layer !== layer)) continue;
    const { start: a, end: b } = t;
    const m = t.kind === "arc" && t.mid ? t.mid : undefined;
    const xs = [a.x, b.x, ...(m ? [m.x] : [])], ys = [a.y, b.y, ...(m ? [m.y] : [])];
    if (Math.max(...xs) < view.x0 || Math.min(...xs) > view.x1 || Math.max(...ys) < view.y0 || Math.min(...ys) > view.y1) continue;
    const name = shortNetName(t.net);
    const size = t.width * 0.7;
    if (font !== size) ctx.font = `${(font = size)}px "Helvetica Neue", Arial, sans-serif`;
    const w = ctx.measureText(name).width;
    if (m) {
      // An arc: one label at its middle, along the tangent there (parallel to the chord).
      if (arcLength(a, m, b) < w + 4 * t.width) continue;
      let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      if (flipped) angle = 180 - angle;
      angle = ((angle % 360) + 360) % 360;
      if (angle > 90 && angle <= 270) angle -= 180;
      ctx.save();
      ctx.translate(m.x, m.y);
      if (flipped) ctx.scale(-1, 1);
      ctx.rotate((angle * Math.PI) / 180);
      ctx.fillText(name, 0, 0);
      ctx.restore();
      continue;
    }
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // Labels with gaps between them; none where the segment is too short for one.
    const slot = w + 6 * t.width;
    const n = Math.floor(len / slot);
    if (n < 1) continue;
    let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    if (flipped) angle = 180 - angle;
    angle = ((angle % 360) + 360) % 360;
    if (angle > 90 && angle <= 270) angle -= 180;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      ctx.save();
      ctx.translate(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
      if (flipped) ctx.scale(-1, 1);
      ctx.rotate((angle * Math.PI) / 180);
      ctx.fillText(name, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

/** Length of the circular arc through a, m, b (the chord when they're in line). */
function arcLength(a: Point, m: Point, b: Point): number {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-12) return Math.hypot(b.x - a.x, b.y - a.y);
  const ux = ((a.x ** 2 + a.y ** 2) * (m.y - b.y) + (m.x ** 2 + m.y ** 2) * (b.y - a.y) + (b.x ** 2 + b.y ** 2) * (a.y - m.y)) / d;
  const uy = ((a.x ** 2 + a.y ** 2) * (b.x - m.x) + (m.x ** 2 + m.y ** 2) * (a.x - b.x) + (b.x ** 2 + b.y ** 2) * (m.x - a.x)) / d;
  const r = Math.hypot(a.x - ux, a.y - uy);
  const ang = (p: Point) => Math.atan2(p.y - uy, p.x - ux);
  // The sweep from a to b that passes through m.
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ab = norm(ang(b) - ang(a));
  const am = norm(ang(m) - ang(a));
  return r * (am <= ab ? ab : 2 * Math.PI - ab);
}

/** Net names inside vias, once they're big enough on screen to read (horizontal, sized to fit). */
export function drawViaLabels(ctx: CanvasRenderingContext2D, board: Board, scale: number, flipped: boolean, view: { x0: number; y0: number; x1: number; y1: number }) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const v of board.vias) {
    if (!v.net || v.size * scale < 14) continue;
    if (v.at.x + v.size < view.x0 || v.at.x - v.size > view.x1 || v.at.y + v.size < view.y0 || v.at.y - v.size > view.y1) continue;
    const name = shortNetName(v.net);
    const size = Math.min(v.size * 0.3, (v.size * 0.85) / (name.length * 0.62));
    if (size * scale < 4) continue;
    ctx.save();
    ctx.translate(v.at.x, v.at.y);
    if (flipped) ctx.scale(-1, 1);
    ctx.font = `${size}px "Helvetica Neue", Arial, sans-serif`;
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fillText(name, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/** KiCad's drawing sheet colour in the board editor. */
export const SHEET_COLOR = "#c872ab";

/** Drawing sheet bitmaps, decoded once (by their data). */
const sheetImages = new Map<string, HTMLImageElement>();
/** Redraws waiting for a logo to load. */
const imageWaiters = new WeakMap<HTMLImageElement, Set<() => void>>();

/**
 * The page frame (drawing sheet primitives, page mm = board mm), texts in KiCad's stroke font,
 * bitmaps (logos) as images. `onImage` is called when a bitmap has loaded, to draw again.
 */
export function drawFrame(ctx: CanvasRenderingContext2D, prims: DrawingSheetPrim[], scale: number, onImage?: () => void): void {
  ctx.save();
  ctx.strokeStyle = SHEET_COLOR;
  ctx.fillStyle = SHEET_COLOR;
  const pen = (w: number) => (ctx.lineWidth = Math.max(w, 1 / scale));
  for (const p of prims) {
    ctx.beginPath();
    if (p.kind === "line") {
      pen(p.width);
      ctx.moveTo(p.a.x, p.a.y);
      ctx.lineTo(p.b.x, p.b.y);
      ctx.stroke();
    } else if (p.kind === "rect") {
      pen(p.width);
      ctx.rect(Math.min(p.a.x, p.b.x), Math.min(p.a.y, p.b.y), Math.abs(p.b.x - p.a.x), Math.abs(p.b.y - p.a.y));
      ctx.stroke();
    } else if (p.kind === "polygon") {
      p.points.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.fill();
    } else if (p.kind === "bitmap") {
      let img = sheetImages.get(p.png);
      if (!img) {
        const waiting = new Set<() => void>();
        img = new Image();
        // Every view that drew it while it loaded redraws (a remounted one too, not only the first).
        img.onload = () => (waiting.forEach((f) => f()), waiting.clear());
        img.onerror = () => waiting.clear();
        imageWaiters.set(img, waiting);
        img.src = `data:${p.mime};base64,${p.png}`;
        sheetImages.set(p.png, img);
      }
      if (img.complete && img.naturalWidth) ctx.drawImage(img, p.at.x, p.at.y, p.w, p.h);
      else if (onImage) imageWaiters.get(img)?.add(onImage);
    } else if (p.kind !== "text") {
      continue;
    } else {
      // Too small to read: skip the strokes.
      if (p.size.y * scale < 2 || !p.text) continue;
      const t: BoardText = {
        layer: "",
        text: p.text,
        at: p.at,
        rotation: p.angle,
        size: p.size,
        thickness: p.width,
        bold: p.bold,
        justify: [p.h === "center" ? "" : p.h, p.v === "center" ? "" : p.v].filter(Boolean),
      };
      pen(p.width || p.size.y / 8);
      for (const st of textStrokes(t)) st.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.stroke();
    }
  }
  ctx.restore();
}

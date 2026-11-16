/**
 * KiCad's Net Inspector numbers per net: pads, vias, via length, track length per copper layer
 * and in total, as KiCad's length calculation gives them.
 * - **Tracks:** joined into lines through joints, as KiCad 10 does (see netLayerLengths). A line's end
 *   inside a via is redrawn from the via's centre to where the line leaves it, and an end at a
 *   pad's centre from the centre to where it leaves the pad.
 * - **Vias:** a via's length is the stackup height between the outermost copper layers its
 *   tracks actually use (or, with one track, the pad it sits in), so a via joining F.Cu to
 *   In1.Cu counts only that span, and a stub counts nothing.
 *
 * KiCad 10.0 (the release, checked against pcbnew) is followed where it differs from KiCad's
 * development branch.
 */
import type { Point } from "./geometry.js";
import { flashChecker, type Board, type Pad, type Track, type Via } from "./board.js";
import { arcPoints } from "./drc.js";
import { onLayer } from "./fab.js";
import { padPolygons } from "./zone-fill.js";

const COPPER_MM = 0.035;
const MASK_MM = 0.01;

/**
 * Height between two copper layers through the stackup, as KiCad measures it: the dielectrics
 * between them, plus each outer copper's full thickness and half of an inner one's. Without a
 * stackup in the file, KiCad's default one: the board thickness less copper and mask, spread
 * evenly over the dielectrics.
 */
export function layerDistance(board: Board, a: string, b: string): number {
  if (a === b) return 0;
  const copper = board.copperLayers;
  let [i, j] = [copper.indexOf(a), copper.indexOf(b)];
  if (i < 0 || j < 0) return 0;
  if (i > j) [i, j] = [j, i];
  const outer = (k: number) => k === 0 || k === copper.length - 1;
  const st = board.stackup;
  if (st?.length) {
    // Front to back: copper layers by name, dielectrics in between.
    let total = 0;
    let on = false;
    for (const item of st) {
      const k = item.type === "copper" ? copper.indexOf(item.name) : -1;
      if (!on && k === i) on = true;
      if (!on) continue;
      // Half of an inner start or end layer; layers passed through count in full.
      total += (k === i || k === j) && !outer(k) ? item.thickness / 2 : item.thickness;
      if (k === j) break;
    }
    return total;
  }
  const n = copper.length;
  const dielectric = ((board.thickness ?? 1.6) - COPPER_MM * n - MASK_MM * 2) / Math.max(1, n - 1);
  let total = (j - i) * dielectric;
  for (const k of [i, j]) total += outer(k) ? COPPER_MM : COPPER_MM / 2;
  for (let k = i + 1; k < j; k++) total += COPPER_MM;
  return total;
}

export interface NetStats {
  net: string;
  pads: number;
  vias: number;
  /** Through the stackup, mm. */
  viaLength: number;
  /** Routed copper per layer, mm. */
  layers: Record<string, number>;
  trackLength: number;
  /** trackLength + viaLength. */
  total: number;
}

const near = (p: Point, q: Point, r: number) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 <= r * r + 1e-12;

/**
 * The copper layers a via joins electrically, as KiCad 10 decides it from the tracks ending in
 * it: none → nothing; one → a via-in-pad (one pad exactly on the via, on another layer) joins
 * that track's layer to the pad's, else it's a stub; two or more → the span of their layers.
 */
function viaSpan(board: Board, v: Via, tracks: Track[], pads: Array<{ pad: Pad; layer: string }>): string[] {
  const copper = board.copperLayers;
  const [a, b] = [copper.indexOf(v.layers[0]!), copper.indexOf(v.layers[v.layers.length - 1]!)];
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const lines = tracks.filter((t) => {
    const k = copper.indexOf(t.layer);
    return k >= lo && k <= hi && (near(t.start, v.at, v.size / 2) || near(t.end, v.at, v.size / 2));
  });
  if (lines.length === 1) {
    const layer = lines[0]!.layer;
    const onIt = pads.filter(({ pad }) => near(pad.at, v.at, 1e-6));
    const pad = onIt.length === 1 ? onIt[0]!.pad : undefined;
    const padLayer = pad && copper.find((l) => onLayer(pad.layers, l));
    return pad && padLayer && !onLayer(pad.layers, layer) ? copper.filter((l) => l === layer || l === padLayer) : [layer];
  }
  const used = new Set(lines.map((t) => t.layer));
  return copper.filter((l) => used.has(l));
}

/** The Net Inspector's numbers for every net that has pads (or for the nets given). */
export function netStats(board: Board, only?: Iterable<string>): NetStats[] {
  const want = only ? new Set(only) : undefined;
  const byNet = new Map<string, { pads: Array<{ pad: Pad; layer: string }>; tracks: Track[]; vias: Via[] }>();
  const of = (net: string) => {
    let e = byNet.get(net);
    if (!e) byNet.set(net, (e = { pads: [], tracks: [], vias: [] }));
    return e;
  };
  for (const fp of board.footprints)
    for (const pad of fp.pads) {
      if (!pad.net || (want && !want.has(pad.net))) continue;
      const smd = pad.type === "smd" || pad.type === "connect";
      const cu = pad.layers.find((l) => l.endsWith(".Cu") && !l.startsWith("*")) ?? (fp.layer === "B.Cu" ? "B.Cu" : "F.Cu");
      of(pad.net).pads.push({ pad, layer: smd ? cu : fp.layer });
    }
  for (const t of board.tracks) if (t.net && (!want || want.has(t.net))) of(t.net).tracks.push(t);
  for (const v of board.vias) if (v.net && (!want || want.has(v.net))) of(v.net).vias.push(v);

  const out: NetStats[] = [];
  for (const [net, e] of byNet) {
    if (!e.pads.length && !want) continue;
    const layers = netLayerLengths(board, net, e);
    let viaLength = 0;
    for (const v of e.vias) {
      const span = viaSpan(board, v, e.tracks, e.pads);
      if (span.length >= 2) viaLength += layerDistance(board, span[0]!, span[span.length - 1]!);
    }
    const trackLength = Object.values(layers).reduce((a, b) => a + b, 0);
    out.push({ net, pads: e.pads.length, vias: e.vias.length, viaLength, layers, trackLength, total: trackLength + viaLength });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Track lengths, as KiCad's length calculation gives them
// ---------------------------------------------------------------------------

interface Line {
  layer: string;
  chain: Chain;
  state: "unmerged" | "inUse" | "retired";
}

const pkey = (p: Point) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`;
const same = (p: Point, q: Point) => pkey(p) === pkey(q);

function inPolys(p: Point, polys: Point[][]): boolean {
  let inside = false;
  for (const poly of polys)
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  return inside;
}

/** Crossings of segment a→b with a circle or polygon outlines, as parameters along it. */
function circleHits(c: Point, r: number, a: Point, b: Point): number[] {
  const dx = b.x - a.x, dy = b.y - a.y, fx = a.x - c.x, fy = a.y - c.y;
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (A === 0 || disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)].filter((t) => t >= 0 && t <= 1);
}
function polyHits(polys: Point[][], a: Point, b: Point): number[] {
  const out: number[] = [];
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const c = poly[i]!, d = poly[(i + 1) % poly.length]!;
      const ex = d.x - c.x, ey = d.y - c.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
      const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push(t);
    }
  return out;
}

// ---------------------------------------------------------------------------
// KiCad's line chains: points, some of them on arcs, with the arcs themselves kept (so a length
// counts an arc at its true length, and cutting a chain inside an arc keeps the rest an arc).
// Coordinates in mm, rounded to KiCad's nanometres where KiCad rounds.
// ---------------------------------------------------------------------------

const nm = (v: number) => Math.round(v * 1e6) / 1e6;
const ang = (p: Point, c: Point) => Math.atan2(p.y - c.y, p.x - c.x);
const norm2pi = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

interface KArc {
  start: Point;
  mid: Point;
  end: Point;
  /** KiCad keeps the centre in whole nanometres. */
  c: Point;
  r: number;
}

function circumcentre(a: Point, b: Point, m: Point): Point {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  const sq = (p: Point) => p.x * p.x + p.y * p.y;
  return { x: (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d, y: (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d };
}

function makeArc(start: Point, mid: Point, end: Point): KArc {
  const cc = circumcentre(start, end, mid);
  const c = { x: nm(cc.x), y: nm(cc.y) };
  return { start, mid, end, c, r: Math.hypot(start.x - c.x, start.y - c.y) };
}

/** The signed sweep from start to end through mid (radians; positive = increasing angle). */
function sweep(a: KArc): number {
  if (same(a.start, a.end)) return 2 * Math.PI;
  const a0 = ang(a.start, a.c);
  const d = norm2pi(ang(a.end, a.c) - a0);
  return norm2pi(ang(a.mid, a.c) - a0) < d ? d : d - 2 * Math.PI;
}
const arcLength = (a: KArc) => Math.abs(a.r * sweep(a));

/** KiCad's ConstructFromStartEndCenter: the mid point rotated half way (rounded), the centre found again. */
function arcFromStartEndCentre(start: Point, end: Point, c: Point, clockwise: boolean): KArc {
  let d = norm2pi(norm2pi(ang(end, c)) - norm2pi(ang(start, c)));
  if (clockwise) d -= 2 * Math.PI;
  const h = d / 2;
  const v = { x: start.x - c.x, y: start.y - c.y };
  const mid = { x: nm(c.x + v.x * Math.cos(h) - v.y * Math.sin(h)), y: nm(c.y + v.x * Math.sin(h) + v.y * Math.cos(h)) };
  return makeArc(start, mid, end);
}

/** KiCad's SHAPE_ARC::ConvertToPolyline, with its segment count rules (nanometre integers). */
function arcPolyline(a: KArc, width: number, maxError = 1000): Point[] {
  const R = (a.r + width / 2) * 1e6;
  const ca = sweep(a);
  const caDeg = Math.abs((ca * 180) / Math.PI);
  const half = Math.max(1, maxError / 2);
  // The mid point's distance from the chord.
  const dx = a.end.x - a.start.x, dy = a.end.y - a.start.y, L = Math.hypot(dx, dy);
  const t = L ? Math.max(0, Math.min(1, ((a.mid.x - a.start.x) * dx + (a.mid.y - a.start.y) * dy) / (L * L))) : 0;
  const chordDist = Math.hypot(a.mid.x - a.start.x - t * dx, a.mid.y - a.start.y - t * dy) * 1e6;
  let n: number, eff: number;
  if (R < half || chordDist < half) {
    n = 0;
    eff = R;
  } else {
    const Ri = Math.max(1, Math.trunc(R));
    const inc = Math.min(360 / 8, ((180 / Math.PI) * Math.acos(1 - Math.max(1, maxError) / Ri)) * 2);
    n = Math.max(Math.round(caDeg / inc), 2);
    let seg360 = Math.trunc((n * 360) / caDeg);
    if (seg360 <= 2) seg360 = 3;
    eff = Math.round(Math.abs(Math.trunc(R) * (1 - 1 / Math.cos(Math.PI / seg360))));
  }
  const rr = a.r + eff / 2 / 1e6;
  n *= 2;
  const sa = norm2pi(ang(a.start, a.c));
  const pts = [a.start];
  for (let i = 1; i < n; i += 2) {
    const q = sa + (ca * i) / n;
    pts.push({ x: nm(a.c.x + rr * Math.cos(q)), y: nm(a.c.y + rr * Math.sin(q)) });
  }
  pts.push(a.end);
  return pts;
}

interface Chain {
  pts: Point[];
  /** Per point: the arc it lies on, or -1. */
  arcOf: number[];
  arcs: KArc[];
}

const chainOf = (pts: Point[]): Chain => ({ pts: [...pts], arcOf: pts.map(() => -1), arcs: [] });
function chainOfArc(a: KArc, width: number): Chain {
  const pts = arcPolyline(a, width);
  return pts.length > 2 ? { pts, arcOf: pts.map(() => 0), arcs: [a] } : chainOf(pts);
}
const onArc = (c: Chain, i: number) => i >= 0 && i < c.pts.length && c.arcOf[i]! >= 0;
const isArcSeg = (c: Chain, i: number) => onArc(c, i) && onArc(c, i + 1) && c.arcOf[i] === c.arcOf[i + 1];
const isArcStart = (c: Chain, i: number) => onArc(c, i) && (i === 0 || c.arcOf[i - 1] !== c.arcOf[i]);
/** The index where the shape after the one at i starts, or -1. */
function nextShape(c: Chain, i: number): number {
  if (isArcSeg(c, i)) {
    let k = i;
    while (k + 1 < c.pts.length && c.arcOf[k + 1] === c.arcOf[i]) k++;
    return k >= c.pts.length - 1 ? -1 : k;
  }
  return i + 1 >= c.pts.length ? -1 : i + 1;
}
function appendPoint(c: Chain, p: Point): void {
  if (c.pts.length && same(c.pts[c.pts.length - 1]!, p)) return;
  c.pts.push(p);
  c.arcOf.push(-1);
}
function appendChain(c: Chain, o: Chain): void {
  if (!o.pts.length) return;
  const base = c.arcs.length;
  c.arcs.push(...o.arcs);
  const fix = (k: number) => (k < 0 ? k : k + base);
  if (!c.pts.length || !same(o.pts[0]!, c.pts[c.pts.length - 1]!)) {
    c.pts.push(o.pts[0]!);
    c.arcOf.push(fix(o.arcOf[0]!));
  } else if (isArcSeg(o, 0) && c.arcOf[c.arcOf.length - 1] === -1) c.arcOf[c.arcOf.length - 1] = fix(o.arcOf[0]!);
  for (let i = 1; i < o.pts.length; i++) {
    c.pts.push(o.pts[i]!);
    c.arcOf.push(fix(o.arcOf[i]!));
  }
}
const clockwise = (a: KArc) => sweep(a) < 0;

/** KiCad's SHAPE_LINE_CHAIN::Slice: points s…e, an arc cut part way kept as an arc on the same centre. */
function slice(c: Chain, s: number, e: number): Chain {
  const n = c.pts.length;
  if (e < 0) e += n;
  const rv: Chain = { pts: [], arcOf: [], arcs: [] };
  if (isArcSeg(c, s) && !isArcStart(c, s)) {
    const ai = c.arcOf[s]!;
    const arc = c.arcs[ai]!;
    for (let i = s; i < n && c.arcOf[i] === ai; i++) {
      rv.pts.push(c.pts[i]!);
      rv.arcOf.push(rv.arcs.length);
    }
    rv.arcs.push(arcFromStartEndCentre(c.pts[s]!, arc.end, arc.c, clockwise(arc)));
    s += rv.pts.length;
  }
  for (let i = s; i <= e && i < n; i = nextShape(c, i)) {
    if (i === -1) return rv;
    const next = nextShape(c, i);
    const last = next < 0;
    if (isArcStart(c, i)) {
      if ((last && e !== n - 1) || next > e) {
        if (i === e) {
          appendPoint(rv, c.pts[i]!);
          return rv;
        }
        const ai = c.arcOf[i]!;
        const arc = c.arcs[ai]!;
        const k0 = rv.arcs.length;
        for (; i <= e && i < n && c.arcOf[i] === ai; i++) {
          rv.pts.push(c.pts[i]!);
          rv.arcOf.push(k0);
        }
        rv.arcs.push(arcFromStartEndCentre(arc.start, c.pts[e]!, arc.c, clockwise(arc)));
        return rv;
      }
      // The whole arc, approximated again (the chain's arcs have no width).
      appendChain(rv, chainOfArc(c.arcs[c.arcOf[i]!]!, 0));
      if (last) return rv;
    } else {
      if (i === s) appendPoint(rv, c.pts[i]!);
      const nextIsArc = last ? false : isArcSeg(c, next);
      if (!nextIsArc && i < n - 1 && i < e) appendPoint(rv, c.pts[i + 1]!);
    }
    if (last) return rv;
  }
  return rv;
}

/** KiCad's chain length: straight segments plus each arc's true length. */
function chainLength(c: Chain): number {
  let l = 0;
  for (let i = 0; i + 1 < c.pts.length; i++) if (!isArcSeg(c, i)) l += Math.hypot(c.pts[i + 1]!.x - c.pts[i]!.x, c.pts[i + 1]!.y - c.pts[i]!.y);
  for (const a of c.arcs) l += arcLength(a);
  return l;
}

/** Where an arc crosses a pad's outline, nearest `near` (KiCad's findArcPadIntersection). */
function arcPadCrossing(a: KArc, polys: Point[][], near: Point): Point | undefined {
  const sw = sweep(a);
  const onSweep = (p: Point) => {
    const d = ang(p, a.c) - ang(a.start, a.c);
    const t = sw >= 0 ? norm2pi(d) : norm2pi(-d);
    return t <= Math.abs(sw) + 1e-9;
  };
  let best: Point | undefined, bestD = Infinity;
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
      for (const t of circleHits(a.c, a.r, p, q)) {
        const x = { x: nm(p.x + t * (q.x - p.x)), y: nm(p.y + t * (q.y - p.y)) };
        if (!onSweep(x)) continue;
        const d = (x.x - near.x) ** 2 + (x.y - near.y) ** 2;
        if (d < bestD) (bestD = d), (best = x);
      }
    }
  return best;
}

/**
 * Redraw a chain's end inside a via or pad: from its centre to where the chain leaves it, then on
 * from the first point outside (KiCad's clipLineToVia / clipLineToPad). `forward` clips the start.
 */
function clipChain(c: Chain, centre: Point, inside: (p: Point) => boolean, crossing: (outside: Point, insidePt: Point, arc?: KArc) => Point | undefined, forward: boolean): Chain {
  const n = c.pts.length;
  let out = -1;
  let x: Point | undefined;
  for (let v = forward ? 1 : n - 2; forward ? v < n : v >= 0; v += forward ? 1 : -1) {
    if (inside(c.pts[v]!)) continue;
    out = v;
    const prev = forward ? v - 1 : v + 1;
    const ai = c.arcOf[prev]!;
    x = crossing(c.pts[v]!, c.pts[prev]!, ai >= 0 && c.arcOf[v] === ai ? c.arcs[ai] : undefined);
    break;
  }
  if (out < 0) return c;
  const rv: Chain = { pts: [], arcOf: [], arcs: [] };
  if (forward) {
    appendPoint(rv, centre);
    if (x) appendPoint(rv, x);
    appendChain(rv, slice(c, out, -1));
  } else {
    appendChain(rv, slice(c, 0, out));
    if (x) appendPoint(rv, x);
    appendPoint(rv, centre);
  }
  return rv;
}

/**
 * The tracks in the order KiCad's connectivity hands them to the length calculation: a
 * breadth-first walk of the connected copper (tracks, vias, pads) from the net's first track in
 * the file, and on from the next unvisited one for each further piece. The order decides which
 * line takes the others over when they merge (an arc takes the lines after it, but is never taken).
 */
function connectivityOrder(board: Board, tracks: Track[], vias: Via[], pads: Pad[]): Track[] {
  const T = tracks.length;
  // Nodes: tracks 0…T-1, then vias, then pads. Edges built once: shared track ends, and track
  // ends inside a via (on its layers) or a pad (flashed on the track's layer), found on a grid.
  const adj: number[][] = Array.from({ length: T + vias.length + pads.length }, () => []);
  const link = (i: number, j: number) => (adj[i]!.push(j), adj[j]!.push(i));
  const byEnd = new Map<string, number[]>();
  tracks.forEach((t, i) => {
    for (const q of [t.start, t.end]) {
      const k = pkey(q);
      const here = byEnd.get(k) ?? byEnd.set(k, []).get(k)!;
      for (const j of here) if (j !== i) link(i, j);
      if (!here.includes(i)) here.push(i);
    }
  });
  const CELL = 2;
  const cell = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  const grid = new Map<string, number[]>();
  tracks.forEach((t, i) => {
    for (const q of [t.start, t.end]) {
      const k = cell(q.x, q.y);
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    }
  });
  const near = (x0: number, y0: number, x1: number, y1: number) => {
    const out = new Set<number>();
    for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++) for (let y = Math.floor(y0 / CELL); y <= Math.floor(y1 / CELL); y++) for (const i of grid.get(`${x},${y}`) ?? []) out.add(i);
    return out;
  };
  const copper = board.copperLayers;
  vias.forEach((v, k) => {
    const [a, b] = [copper.indexOf(v.layers[0]!), copper.indexOf(v.layers[v.layers.length - 1]!)];
    const r = v.size / 2 + 1e-9;
    for (const i of near(v.at.x - r, v.at.y - r, v.at.x + r, v.at.y + r)) {
      const t = tracks[i]!;
      const l = copper.indexOf(t.layer);
      if (l < Math.min(a, b) || l > Math.max(a, b)) continue;
      if ([t.start, t.end].some((q) => Math.hypot(q.x - v.at.x, q.y - v.at.y) <= r)) link(i, T + k);
    }
  });
  const flashed = flashChecker(board);
  pads.forEach((p, k) => {
    const polys = padPolygons(p, 0);
    const xs = polys.flat().map((q) => q.x), ys = polys.flat().map((q) => q.y);
    if (!xs.length) return;
    for (const i of near(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))) {
      const t = tracks[i]!;
      if (flashed(p, t.layer) && [t.start, t.end].some((q) => inPolys(q, polys))) link(i, T + vias.length + k);
    }
  });
  const seen = new Uint8Array(adj.length);
  const order: Track[] = [];
  const queue: number[] = [];
  for (let s = 0; s < T; s++) {
    if (seen[s]) continue;
    seen[s] = 1;
    queue.length = 0;
    queue.push(s);
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h]!;
      if (i < T) order.push(tracks[i]!);
      for (const j of [...new Set(adj[i])].sort((a, b) => a - b))
        if (!seen[j]) {
          seen[j] = 1;
          queue.push(j);
        }
    }
  }
  return order;
}

/**
 * A net's routed track length per copper layer, as KiCad's Net Inspector and length tuner give
 * it (KiCad 10.0): tracks merged into lines through joints, line ends inside a via
 * redrawn from its centre, then line ends at a pad's centre redrawn from the centre to where
 * they leave the pad.
 */
export function netLayerLengths(board: Board, net: string, items?: { tracks: Track[]; vias: Via[]; pads: Array<{ pad: Pad }> }): Record<string, number> {
  const tracks = items?.tracks ?? board.tracks.filter((t) => t.net === net);
  const vias = items?.vias ?? board.vias.filter((v) => v.net === net);
  const pads = items ? items.pads.map((p) => p.pad) : board.footprints.flatMap((f) => f.pads.filter((p) => p.net === net));
  const lines: Line[] = connectivityOrder(board, tracks, vias, pads).map((t) => ({ layer: t.layer, chain: t.kind === "arc" && t.mid ? chainOfArc(makeArc(t.start, t.mid, t.end), t.width) : chainOf([t.start, t.end]), state: "unmerged" }));
  // Line ends by position, all layers together (as KiCad 10 keys them).
  const at = new Map<string, Set<Line>>();
  const ends = (l: Line) => [l.chain.pts[0]!, l.chain.pts[l.chain.pts.length - 1]!];
  for (const l of lines) for (const p of ends(l)) (at.get(pkey(p)) ?? at.set(pkey(p), new Set()).get(pkey(p))!).add(l);
  const unlist = (l: Line) => {
    for (const p of ends(l)) at.get(pkey(p))?.delete(l);
  };

  // Merge, in file order: a line takes over the one other line end left where it ends, if that
  // line is on its layer and holds no arc. (At a three-way joint the first line through stays
  // apart, and the next one takes the third.)
  for (const line of lines) {
    if (line.state !== "unmerged") continue;
    unlist(line);
    line.state = "inUse";
    for (let merged = true; merged; ) {
      merged = false;
      for (const end of ["start", "end"] as const) {
        const pos = end === "start" ? line.chain.pts[0]! : line.chain.pts[line.chain.pts.length - 1]!;
        const here = at.get(pkey(pos));
        if (!here || here.size !== 1) continue;
        const other = [...here][0]!;
        if (other.chain.arcs.length || other.layer !== line.layer) continue;
        other.state = "retired";
        const o = same(other.chain.pts[0]!, pos) ? other.chain.pts : [...other.chain.pts].reverse();
        unlist(other);
        // KiCad appends the other line's points one by one, or inserts them at the front.
        for (const p of o.slice(1)) {
          if (end === "end") appendPoint(line.chain, p);
          else {
            line.chain.pts.unshift(p);
            line.chain.arcOf.unshift(-1);
          }
        }
        merged = true;
      }
    }
  }
  const live = lines.filter((l) => l.state === "inUse");
  const copper = board.copperLayers;

  // Ends inside a via: from its centre (one end per via and line, the start first).
  for (const v of vias) {
    const [a, b] = [copper.indexOf(v.layers[0]!), copper.indexOf(v.layers[v.layers.length - 1]!)];
    const r = v.size / 2;
    const inside = (p: Point) => (p.x - v.at.x) ** 2 + (p.y - v.at.y) ** 2 <= r * r + 1e-12;
    for (const l of live) {
      const k = copper.indexOf(l.layer);
      const pts = l.chain.pts;
      if (k < Math.min(a, b) || k > Math.max(a, b) || pts.length < 2) continue;
      // The crossing on the segment back in from the first point outside, nearest that point.
      const crossing = (o: Point, i: Point) => {
        const t = circleHits(v.at, r, o, i);
        return t.length ? { x: nm(o.x + Math.min(...t) * (i.x - o.x)), y: nm(o.y + Math.min(...t) * (i.y - o.y)) } : undefined;
      };
      if (inside(pts[0]!)) l.chain = clipChain(l.chain, v.at, inside, crossing, true);
      else if (inside(pts[pts.length - 1]!)) l.chain = clipChain(l.chain, v.at, inside, crossing, false);
    }
  }

  // Ends at a pad's centre: from the centre to where the line leaves the pad.
  const flashed = flashChecker(board);
  for (const pad of pads) {
    const polys = padPolygons(pad, 0);
    const inside = (p: Point) => inPolys(p, polys);
    // On an arc, where the arc itself crosses the outline; else on the segment, nearest the point outside.
    const crossing = (o: Point, i: Point, arc?: KArc) => {
      const onArc = arc && arcPadCrossing(arc, polys, i);
      if (onArc) return onArc;
      const t = polyHits(polys, o, i);
      return t.length ? { x: o.x + Math.min(...t) * (i.x - o.x), y: o.y + Math.min(...t) * (i.y - o.y) } : undefined;
    };
    for (const l of live) {
      const pts = l.chain.pts;
      if (pts.length < 2) continue;
      const s = pts[0]!, e = pts[pts.length - 1]!;
      if (!same(s, pad.at) && !same(e, pad.at)) continue;
      if (!flashed(pad, l.layer)) continue;
      if (inside(s)) l.chain = clipChain(l.chain, pad.at, inside, crossing, true);
      else if (inside(e)) l.chain = clipChain(l.chain, pad.at, inside, crossing, false);
    }
  }
  const out: Record<string, number> = {};
  for (const l of live) out[l.layer] = (out[l.layer] ?? 0) + chainLength(l.chain);
  return out;
}

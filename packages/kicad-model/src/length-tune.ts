/**
 * Length tuning: lengthening a net with meanders (KiCad's "tune length").
 * A straight track is replaced by square bumps standing to one side of it,
 * each adding twice its height; bumps are kept back from the track's ends and
 * checked for clearance, larger first, either side.
 */
import { netLayerLengths } from "./net-stats.js";
import { flashChecker, type Board, type Pad, type Track } from "./board.js";
import { arcPoints, edgeChains, netClassOf, trackConflicts, type CopperItem, type DesignRules } from "./drc.js";
import type { Point } from "./geometry.js";
import { padPolygons } from "./zone-fill.js";

/** A track's length (arcs along the arc). */
export function trackLength(t: Track): number {
  if (t.kind === "arc" && t.mid) return arcPoints(t.start, t.mid, t.end).length;
  return Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
}

const key = (p: Point) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`;
const inPoly = (p: Point, poly: Point[]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

/**
 * Routed length of a net as KiCad measures it (its tracks, merged and clipped at vias and pads,
 * see netLayerLengths). Vias and pad-to-die lengths aren't counted.
 */
export function netLength(board: Board, net: string): number {
  return Object.values(netLayerLengths(board, net)).reduce((a, b) => a + b, 0);
}

/** Where segment a→b (a inside) first crosses a polygon edge. */
function edgeCrossing(a: Point, b: Point, polys: Point[][]): Point | undefined {
  let best: { t: number; p: Point } | undefined;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const c = poly[i]!, d = poly[(i + 1) % poly.length]!;
      const ex = d.x - c.x, ey = d.y - c.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
      const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && (!best || t < best.t)) best = { t, p: { x: a.x + t * dx, y: a.y + t * dy } };
    }
  return best?.p;
}

export interface MeanderOptions {
  /** Largest bump height (mm); default 1. */
  maxAmplitude?: number;
  /** Distance between a bump's two legs, and between bumps (mm); default 2 × track width (at least width + clearance). */
  spacing?: number;
  /** Straight length to keep at the start / end (e.g. to leave a pad first), on top of the spacing. */
  keepStart?: number;
  keepEnd?: number;
  /** Board edge segments, kept `edgeClearance` (plus half the width) away from. */
  edges?: Array<[Point, Point]>;
  edgeClearance?: number;
  /**
   * Drilled holes (vias, through-hole pads), kept `holeClearance` away from where they are of another
   * net. With a thin via ring (a fine net class's 0.3/0.15 mm vias), keeping the copper clearance from
   * the via isn't enough.
   */
  holes?: Array<{ at: Point; r: number; net: string }>;
  holeClearance?: number;
}

/**
 * The polyline replacing straight track `t` with meanders adding up to `extra`
 * mm, clear of `items` (other nets' copper), or undefined when none fits.
 * Returns the points and the length actually added.
 */
export function meanderTrack(t: Track, extra: number, rules: DesignRules, items: CopperItem[], opts: MeanderOptions = {}): { points: Point[]; added: number } | undefined {
  if (t.kind === "arc" || extra <= 1e-6) return undefined;
  const L = Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
  const u = { x: (t.end.x - t.start.x) / L, y: (t.end.y - t.start.y) / L };
  // A small difference (a pair's skew) takes one low bump, which fits a short leg: its sides need
  // only a little room between them (it's all one net).
  const low = extra < 2 * t.width;
  const s = opts.spacing ?? (low ? t.width + 0.1 : Math.max(2 * t.width, t.width + netClassOf(rules, t.net).clearance));
  const margin = s + (opts.keepStart ?? 0); // straight lead-in
  const tailRoom = s + (opts.keepEnd ?? 0); // and lead-out
  const nMax = Math.floor((L - margin - tailRoom + s) / (2 * s));
  if (nMax < 1) return undefined;
  // Bumps are at least a track width high, except to make up a small difference (a pair's skew):
  // then one low bump adds just what's missing.
  const aMin = Math.min(t.width, Math.max(0.02, extra / 2));
  const solid = items.filter((it) => it.item.kind !== "zone" && it.item.uuid !== t.uuid);
  const at = (x: number, y: number, side: number) => ({ x: t.start.x + u.x * x - u.y * y * side, y: t.start.y + u.y * x + u.x * y * side });
  for (let aMax = opts.maxAmplitude ?? 1; aMax >= aMin - 1e-9; aMax /= 2) {
    // As few bumps as reach the extra length, each no taller than aMax (or all that fit).
    const n = Math.min(nMax, Math.max(1, Math.ceil(extra / (2 * aMax))));
    const a = Math.min(aMax, extra / (2 * n));
    if (a < aMin - 1e-9) continue;
    for (const side of [1, -1]) {
      const pts: Point[] = [t.start];
      for (let i = 0; i < n; i++) {
        const x0 = margin + i * 2 * s;
        pts.push(at(x0, 0, side), at(x0, a, side), at(x0 + s, a, side), at(x0 + s, 0, side));
      }
      pts.push(t.end);
      const nearEdge = (a: Point, b: Point) => (opts.edges ?? []).some(([c, d]) => segDist(a, b, c, d) < (opts.edgeClearance ?? 0) + t.width / 2);
      const nearHole = (a: Point, b: Point) => (opts.holes ?? []).some((h) => h.net !== t.net && segDist(a, b, h.at, h.at) < h.r + (opts.holeClearance ?? 0) + t.width / 2 - 1e-9);
      const clear = pts.every((q, k) => k === 0 || (trackConflicts(solid, rules, { a: pts[k - 1]!, b: q, width: t.width, layer: t.layer, net: t.net }).length === 0 && !nearEdge(pts[k - 1]!, q) && !nearHole(pts[k - 1]!, q)));
      if (clear) return { points: pts, added: 2 * a * n };
    }
  }
  return undefined;
}

/**
 * Meanders that bring `net` up to `target` mm: on `prefer` first (a track
 * uuid), then the net's longest straight tracks, until the length is reached
 * or nothing more fits. Returns the tracks to replace and the new length.
 */
export function tuneNetLength(
  board: Board,
  rules: DesignRules,
  items: CopperItem[],
  net: string,
  target: number,
  prefer?: string,
  opts?: MeanderOptions,
): { replace: Array<{ uuid: string; points: Point[]; width: number; layer: string }>; length: number } {
  let length = netLength(board, net);
  const replace: Array<{ uuid: string; points: Point[]; width: number; layer: string }> = [];
  const edges = edgeChains(board).flatMap((c) => c.slice(1).map((b, i): [Point, Point] => [c[i]!, b]));
  const holes = [
    ...board.vias.map((v) => ({ at: v.at, r: v.drill / 2, net: v.net })),
    ...board.footprints.flatMap((f) => f.pads.map((p) => ({ at: p.at, r: (p.drillSize ? Math.max(p.drillSize.x, p.drillSize.y) : (p.drill ?? 0)) / 2, net: p.net })).filter((h) => h.r > 0)),
  ];
  const candidates = board.tracks
    .filter((t) => t.net === net && t.kind !== "arc")
    .sort((a, b) => (a.uuid === prefer ? -1 : b.uuid === prefer ? 1 : trackLength(b) - trackLength(a)));
  for (const t of candidates) {
    const extra = target - length;
    if (extra <= 1e-4) break;
    // Earlier meanders are obstacles too (same net, so only for neatness they're kept apart).
    // Bumps start only once the track has left any pad of its net.
    const m = meanderTrack(t, extra, rules, items, { edges, edgeClearance: rules.copperEdgeClearance ?? 0, holes, holeClearance: rules.holeClearance ?? 0, ...opts, keepStart: inPadRun(board, t, t.start, t.end), keepEnd: inPadRun(board, t, t.end, t.start) });
    if (!m) continue;
    replace.push({ uuid: t.uuid, points: m.points, width: t.width, layer: t.layer });
    length += m.added;
  }
  return { replace, length };
}

/** How far track `t`, from end `a` toward `b`, runs inside a pad of its net. */
function inPadRun(board: Board, t: Track, a: Point, b: Point): number {
  let run = 0;
  for (const f of board.footprints)
    for (const pad of f.pads) {
      if (pad.net !== t.net) continue;
      const polys = padPolygons(pad, 0);
      if (polys.filter((poly) => inPoly(a, poly)).length % 2 === 0) continue;
      const exit = edgeCrossing(a, b, polys);
      run = Math.max(run, exit ? Math.hypot(exit.x - a.x, exit.y - a.y) : Math.hypot(b.x - a.x, b.y - a.y));
    }
  return run;
}

/** Distance between segments a–b and c–d. */
function segDist(a: Point, b: Point, c: Point, d: Point): number {
  const pt = (p: Point, q: Point, r: Point) => {
    const dx = r.x - q.x, dy = r.y - q.y, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p.x - q.x) * dx + (p.y - q.y) * dy) / l)) : 0;
    return Math.hypot(p.x - q.x - t * dx, p.y - q.y - t * dy);
  };
  const o = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0;
  return Math.min(pt(a, c, d), pt(b, c, d), pt(c, a, b), pt(d, a, b));
}

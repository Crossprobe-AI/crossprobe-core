/**
 * Differential pair gap and uncoupled length from custom rules, as KiCad's
 * DRC checks them (DRC_TEST_PROVIDER_DIFF_PAIR_COUPLING, reimplemented from
 * its behaviour):
 *
 * - The tracks and vias of each pair (nets ending P/N or +/-, both present)
 *   take the diff_pair_gap and diff_pair_uncoupled constraints of the rules
 *   that win for them, on their own layer; items are grouped per pair and rule.
 * - Coupled: a P and an N segment on a shared layer that run exactly parallel,
 *   over the stretch where each projects onto the other; their gap is the
 *   distance between them less half of each width. A coupling with other copper
 *   in between (a line from one to the other crossing it) doesn't count.
 * - Uncoupled length: the longer side's track length less the coupled length
 *   whose gap is within the rule (diff_pair_uncoupled_length_too_long).
 * - Each coupled stretch whose gap is out of range is reported
 *   (diff_pair_gap_out_of_range); as in KiCad, gap findings come from the
 *   rule's gap-only grouping, and again with an uncoupled-length finding.
 *
 * Lengths are worked in KiCad's integer nanometres. Near-concentric arcs
 * couple over the angles both span. Tuning patterns are left out, as KiCad.
 */
import type { Board, Pad, Track, Via } from "./board.js";
import { flashChecker } from "./board.js";
import { netClassOf, type DesignRules, type DrcItem } from "./drc.js";
import { customConstraint, matchDpSuffix, type DruRule, type RuleItem } from "./drc-rules.js";
import { onLayer } from "./fab.js";
import type { Point } from "./geometry.js";
import { padPolygons } from "./zone-fill.js";

const NM = 1e6;
const nm = (v: number) => Math.round(v * NM);
type IP = { x: number; y: number };
type Seg = { a: IP; b: IP };

/** A diff pair's nets (P and N) from either one's name, as KiCad's IsNetADiffPair. */
export function diffPairPartner(net: string): { p: string; n: string } | undefined {
  const m = matchDpSuffix(net);
  if (!m) return undefined;
  return m.positive ? { p: net, n: m.partner } : { p: m.partner, n: net };
}

const sub = (a: IP, b: IP): IP => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: IP, b: IP) => a.x * b.x + a.y * b.y;
const cross = (a: IP, b: IP) => a.x * b.y - a.y * b.x;
const len2 = (s: Seg) => dot(sub(s.b, s.a), sub(s.b, s.a));
/** SEG::LineProject: the point of the line through s nearest p (integers). */
function lineProject(s: Seg, p: IP): IP {
  const d = sub(s.b, s.a);
  const l = dot(d, d);
  if (!l) return s.a;
  const t = dot(sub(p, s.a), d);
  return { x: s.a.x + Math.round((d.x * t) / l), y: s.a.y + Math.round((d.y * t) / l) };
}
/** KiCad's rescale(a, b, c): a·b/c rounded. */
const rescale = (a: number, b: number, c: number) => Math.round((a * b) / c);

/**
 * SEG::Intersect(seg, false, true) in KiCad 10.0: whether two lines cross.
 * Parallel lines don't (collinear ones do); nearly parallel lines whose
 * crossing lies beyond 32-bit coordinates don't either.
 */
function linesCross(p: Seg, n: Seg): boolean {
  const dir1 = sub(p.b, p.a), dir2 = sub(n.b, n.a), offset = sub(n.a, p.a);
  const det = cross(dir2, dir1);
  if (det === 0) return cross(dir1, offset) === 0;
  const q = cross(dir1, offset);
  const x = n.a.x + Math.round((q * dir2.x) / det), y = n.a.y + Math.round((q * dir2.y) / det);
  const MAX = 2147483647;
  return !(x > MAX || x < -MAX - 1 || y > MAX || y < -MAX - 1);
}

/** commonParallelProjection: the stretches of p and n over which each lies alongside the other. */
function parallelStretch(p: Seg, n: Seg): { p: Seg; n: Seg } | undefined {
  const tc = (q: IP) => dot(sub(q, p.a), sub(p.b, p.a));
  const pa = lineProject(p, n.a), pb = lineProject(p, n.b);
  let ta = 0, tb = tc(p.b), qa = tc(pa), qb = tc(pb);
  if (tb < ta) [ta, tb] = [tb, ta];
  if (qb < qa) [qa, qb] = [qb, qa];
  if (tb <= qa || ta >= qb) return undefined;
  const tv = [0, tc(p.b), tc(pa), tc(pb)].sort((x, y) => x - y);
  const L = len2(p);
  const d = sub(p.b, p.a);
  const A = { x: p.a.x + rescale(d.x, tv[1]!, L), y: p.a.y + rescale(d.y, tv[1]!, L) };
  const B = { x: p.a.x + rescale(d.x, tv[2]!, L), y: p.a.y + rescale(d.y, tv[2]!, L) };
  return { p: { a: A, b: B }, n: { a: lineProject(n, A), b: lineProject(n, B) } };
}

/** Nearest points of two segments, and their distance. */
function nearest(s: Seg, t: Seg): { p: IP; q: IP; d: number } {
  const close = (p: IP, u: Seg): IP => {
    const d = sub(u.b, u.a), l = dot(d, d);
    const k = l ? Math.max(0, Math.min(1, dot(sub(p, u.a), d) / l)) : 0;
    return { x: u.a.x + k * d.x, y: u.a.y + k * d.y };
  };
  let best = { p: s.a, q: close(s.a, t), d: Infinity };
  for (const [p, u, flip] of [[s.a, t, false], [s.b, t, false], [t.a, s, true], [t.b, s, true]] as const) {
    const c = close(p, u);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d < best.d) best = flip ? { p: c, q: p, d } : { p, q: c, d };
  }
  return best;
}

const segDist = (p: IP, a: IP, b: IP) => {
  const d = sub(b, a), l = dot(d, d);
  const k = l ? Math.max(0, Math.min(1, dot(sub(p, a), d) / l)) : 0;
  return Math.hypot(p.x - (a.x + k * d.x), p.y - (a.y + k * d.y));
};
/** Distance between two segments (0 when they cross). */
function segSegDist(a: Seg, b: Seg): number {
  const d1 = sub(a.b, a.a), d2 = sub(b.b, b.a);
  const den = cross(d1, d2);
  if (den !== 0) {
    const t = cross(sub(b.a, a.a), d2) / den, u = cross(sub(b.a, a.a), d1) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(segDist(a.a, b.a, b.b), segDist(a.b, b.a, b.b), segDist(b.a, a.a, a.b), segDist(b.b, a.a, a.b));
}

type Arc = { c: IP; r: number; start: number; sweep: number };
/** An arc track as KiCad's SHAPE_ARC made counter-clockwise (angles from the centre, y down as stored; nm). */
function arcOf(t: Track): Arc | undefined {
  if (!t.mid) return undefined;
  const a = { x: nm(t.start.x), y: nm(t.start.y) }, m = { x: nm(t.mid.x), y: nm(t.mid.y) }, b = { x: nm(t.end.x), y: nm(t.end.y) };
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (!d) return undefined;
  const s2 = (q: IP) => q.x * q.x + q.y * q.y;
  const c = { x: (s2(a) * (m.y - b.y) + s2(m) * (b.y - a.y) + s2(b) * (a.y - m.y)) / d, y: (s2(a) * (b.x - m.x) + s2(m) * (a.x - b.x) + s2(b) * (m.x - a.x)) / d };
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ang = (q: IP) => Math.atan2(q.y - c.y, q.x - c.x);
  const ccw = norm(ang(m) - ang(a)) <= norm(ang(b) - ang(a));
  const [from, to] = ccw ? [a, b] : [b, a];
  return { c, r: Math.hypot(a.x - c.x, a.y - c.y), start: ang(from), sweep: norm(ang(to) - ang(from)) };
}
const pointOn = (a: Arc, t: number): IP => ({ x: a.c.x + a.r * Math.cos(t), y: a.c.y + a.r * Math.sin(t) });

/**
 * KiCad's commonParallelProjection for arcs: two near-concentric arcs (radii
 * within half of each other, centres within half the larger radius) coupled
 * over the angles both span. Gives the clipped arcs' span.
 */
function arcStretch(p: Arc, n: Arc): { from: number; sweep: number } | undefined {
  if (Math.abs(p.r - n.r) / Math.max(p.r, n.r) > 0.5 || Math.hypot(p.c.x - n.c.x, p.c.y - n.c.y) > Math.max(p.r, n.r) * 0.5) return undefined;
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // Angles relative to p's start.
  let ns = norm(n.start - p.start);
  if (ns > Math.PI * 1.5) ns -= 2 * Math.PI;
  const ne = ns + n.sweep;
  if (ns >= p.sweep || ne <= 0) return undefined;
  const from = Math.max(0, ns), to = Math.min(p.sweep, ne);
  if (to - from <= (0.001 * Math.PI) / 180) return undefined;
  if (p.r * (to - from) < 1 || n.r * (to - from) < 1) return undefined;
  return { from: p.start + from, sweep: to - from };
}

export interface DiffPairViolation {
  type: "diff_pair_gap_out_of_range" | "diff_pair_uncoupled_length_too_long";
  rule: string;
  netP: string;
  netN: string;
  /** mm: the gap, or the uncoupled length. */
  actual: number;
  min?: number;
  max?: number;
  layer?: string;
  at: Point;
  message: string;
  items: DrcItem[];
}

type Obstacle = { kind: "track"; t: Track; s: Seg; r: number } | { kind: "via"; v: Via; c: IP; r: number } | { kind: "pad"; pad: Pad; polys: IP[][] };

/** The diff pair checks of the custom rules. */
export function checkDiffPairRules(board: Board, rules: DesignRules, custom: DruRule[]): DiffPairViolation[] {
  const relevant = custom.some((r) => r.constraints.some((c) => c.type === "diff_pair_gap" || c.type === "diff_pair_uncoupled"));
  if (!relevant) return [];
  const nets = new Set(board.nets);
  const tuning = new Set(board.tuningPatternMembers ?? []);
  type Group = { netP: string; netN: string; gapRule?: string; gap?: { min?: number; max?: number }; uncRule?: string; unc?: { min?: number; max?: number }; P: Array<Track | Via>; N: Array<Track | Via> };
  const groups = new Map<string, Group>();
  const ruleItem = (type: RuleItem["type"], net: string, layer: string, layers: string[]): RuleItem => ({
    type,
    netName: net,
    netClass: netClassOf(rules, net).name,
    layer,
    layers: new Set(layers),
    hasNet: (n) => nets.has(n),
    intersectsArea: () => false,
  });
  const take = (item: Track | Via, layer: string, isVia: boolean) => {
    const pair = diffPairPartner(item.net);
    if (!pair || !nets.has(pair.p) || !nets.has(pair.n)) return;
    const ri = ruleItem(isVia ? "Via" : "Track", item.net, layer, isVia ? (item as Via).layers : [layer]);
    // As KiCad builds its keys: first with the gap rule alone, then with the uncoupled rule added.
    const key: Omit<Group, "P" | "N"> = { netP: pair.p, netN: pair.n };
    for (const type of ["diff_pair_gap", "diff_pair_uncoupled"] as const) {
      const c = customConstraint(custom, type, ri, layer);
      if (!c) continue;
      if (type === "diff_pair_gap") (key.gapRule = c.rule), (key.gap = c);
      else (key.uncRule = c.rule), (key.unc = c);
      // KiCad's DIFF_PAIR_KEY compares the gap rule's name only when there is none; otherwise the
      // uncoupled rule's: so a pair's gap-only groups on different layers are one group, keyed by
      // whichever item came first.
      const k = `${key.netP}\0${key.netN}\0${key.gapRule ? `u:${key.uncRule ?? ""}` : `g:${key.gapRule ?? ""}`}`;
      const g = groups.get(k) ?? groups.set(k, { ...key, P: [], N: [] }).get(k)!;
      (item.net === pair.n ? g.N : g.P).push(item);
    }
  };
  for (const t of board.tracks) if (t.net && !tuning.has(t.uuid)) take(t, t.layer, false);
  for (const v of board.vias) if (v.net) take(v, v.layers[0]!, true);

  // Copper that can stand between a pair, per layer.
  const flashed = flashChecker(board);
  // Obstacles per layer, in a 2 mm grid by their bounding boxes.
  const CELL = 2 * NM;
  const grids = new Map<string, Map<string, Obstacle[]>>();
  const boxOf = (o: Obstacle) => {
    const pts = o.kind === "track" ? [o.s.a, o.s.b] : o.kind === "via" ? [o.c] : o.polys.flat();
    const r = o.kind === "pad" ? 0 : o.r;
    return { x0: Math.min(...pts.map((q) => q.x)) - r, y0: Math.min(...pts.map((q) => q.y)) - r, x1: Math.max(...pts.map((q) => q.x)) + r, y1: Math.max(...pts.map((q) => q.y)) + r };
  };
  const cells = (b: { x0: number; y0: number; x1: number; y1: number }) => {
    const out: string[] = [];
    for (let x = Math.floor(b.x0 / CELL); x <= Math.floor(b.x1 / CELL); x++) for (let y = Math.floor(b.y0 / CELL); y <= Math.floor(b.y1 / CELL); y++) out.push(`${x},${y}`);
    return out;
  };
  /** The obstacles on a layer whose boxes meet the segment's box. */
  const obstaclesOn = (layer: string, near: Seg): Obstacle[] => {
    let grid = grids.get(layer);
    if (!grid) {
      grid = new Map();
      for (const o of allOn(layer)) for (const k of cells(boxOf(o))) (grid.get(k) ?? grid.set(k, []).get(k)!).push(o);
      grids.set(layer, grid);
    }
    const found = new Set<Obstacle>();
    for (const k of cells({ x0: Math.min(near.a.x, near.b.x), y0: Math.min(near.a.y, near.b.y), x1: Math.max(near.a.x, near.b.x), y1: Math.max(near.a.y, near.b.y) })) for (const o of grid.get(k) ?? []) found.add(o);
    return [...found];
  };
  const allOn = (layer: string): Obstacle[] => {
    const o: Obstacle[] = [];
    const copper = board.copperLayers;
    for (const t of board.tracks) {
      if (t.layer !== layer) continue;
      const pts = t.kind === "arc" && t.mid ? [t.start, t.mid, t.end] : [t.start, t.end];
      for (let k = 1; k < pts.length; k++) o.push({ kind: "track", t, s: { a: { x: nm(pts[k - 1]!.x), y: nm(pts[k - 1]!.y) }, b: { x: nm(pts[k]!.x), y: nm(pts[k]!.y) } }, r: nm(t.width) / 2 });
    }
    for (const v of board.vias) {
      const [a, b] = [copper.indexOf(v.layers[0]!), copper.indexOf(v.layers[v.layers.length - 1]!)];
      const k = copper.indexOf(layer);
      // Where its unused copper is removed, a via is only its hole.
      if (k >= Math.min(a, b) && k <= Math.max(a, b)) o.push({ kind: "via", v, c: { x: nm(v.at.x), y: nm(v.at.y) }, r: nm(flashed(v, layer) ? v.size : v.drill) / 2 });
    }
    for (const fp of board.footprints)
      for (const pad of fp.pads) {
        if (onLayer(pad.layers, layer) && flashed(pad, layer)) o.push({ kind: "pad", pad, polys: padPolygons(pad, 0).map((poly) => poly.map((q) => ({ x: nm(q.x), y: nm(q.y) }))) });
        // A pad's hole goes through every copper layer.
        else if (pad.drill && pad.type !== "smd") {
          const r = nm(pad.drill) / 2;
          o.push({ kind: "pad", pad, polys: [Array.from({ length: 16 }, (_, i) => ({ x: nm(pad.at.x) + r * Math.cos((i * Math.PI) / 8), y: nm(pad.at.y) + r * Math.sin((i * Math.PI) / 8) }))] });
        }
      }
    return o;
  };
  const inPolys = (p: IP, polys: IP[][]) => {
    let inside = false;
    for (const poly of polys)
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]!, b = poly[j]!;
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
    return inside;
  };
  const covers = (o: Obstacle, p: IP) => (o.kind === "track" ? segDist(p, o.s.a, o.s.b) <= o.r : o.kind === "via" ? Math.hypot(p.x - o.c.x, p.y - o.c.y) <= o.r : inPolys(p, o.polys));
  const hits = (o: Obstacle, s: Seg): boolean => {
    if (o.kind === "track") return segSegDist(s, o.s) < o.r;
    if (o.kind === "via") return segDist(o.c, s.a, s.b) < o.r;
    if (inPolys(s.a, o.polys) || inPolys(s.b, o.polys)) return true;
    return o.polys.some((poly) => poly.some((q, i) => segSegDist(s, { a: q, b: poly[(i + 1) % poly.length]! }) === 0));
  };

  const epsilon = nm(0.0005);
  const out: DiffPairViolation[] = [];
  for (const g of groups.values()) {
    type Coupled = { p: Track; n: Track; gap: number; length: number; layer: string; at: Point; failMin: boolean; failMax: boolean };
    const coupled: Coupled[] = [];
    const segOf = (t: Track): Seg => ({ a: { x: nm(t.start.x), y: nm(t.start.y) }, b: { x: nm(t.end.x), y: nm(t.end.y) } });
    for (const p of g.P) {
      if (!("kind" in p) || p.kind !== "segment") continue;
      const sp = segOf(p);
      for (const n of g.N) {
        if (!("kind" in n) || n.kind !== "segment" || n.layer !== p.layer) continue;
        const sn = segOf(n);
        // Only segments whose lines don't cross couple (SEG::Intersect as lines).
        if (len2(sp) <= 2 || len2(sn) <= 2 || linesCross(sp, sn)) continue;
        const st = parallelStretch(sp, sn);
        if (!st) continue;
        const near = nearest(st.p, st.n);
        const gap = Math.sqrt(Math.round(near.d * near.d)) - (nm(p.width) + nm(n.width)) / 2;
        // Copper between them (a line from one to the other) breaks the coupling.
        const check: Seg = { a: near.q, b: near.p };
        const ends = [st.n.a, st.n.b, st.p.a, st.p.b];
        const blocked = obstaclesOn(p.layer, check).some((o) => {
          if (o.kind === "track" && (o.t === p || o.t === n)) return false;
          if (o.kind !== "pad" && ends.some((e) => covers(o, e))) return false;
          if (o.kind === "pad") {
            const exits = (t: Track) => inPolys(segOf(t).a, o.polys) !== inPolys(segOf(t).b, o.polys);
            if (exits(p) || exits(n)) return false;
          }
          return hits(o, check);
        });
        if (blocked) continue;
        const failMin = !!g.gap && g.gap.min !== undefined && g.gap.min >= 0 && gap < nm(g.gap.min) - epsilon;
        const failMax = !!g.gap && g.gap.max !== undefined && g.gap.max >= 0 && gap > nm(g.gap.max) + epsilon;
        coupled.push({ p, n, gap, length: Math.round(Math.sqrt(len2(st.n))), layer: p.layer, at: p.start, failMin, failMax });
      }
    }
    // Arcs: near-concentric arcs on a shared layer, their centres within a track width of each other.
    for (const p of g.P) {
      if (!("kind" in p) || p.kind !== "arc") continue;
      const ap = arcOf(p);
      if (!ap) continue;
      for (const n of g.N) {
        if (!("kind" in n) || n.kind !== "arc" || n.layer !== p.layer) continue;
        const an = arcOf(n);
        if (!an || trackLen(p) <= 2 || trackLen(n) <= 2) continue;
        if ((ap.c.x - an.c.x) ** 2 + (ap.c.y - an.c.y) ** 2 >= nm(p.width) ** 2) continue;
        const st = arcStretch(ap, an);
        if (!st) continue;
        // The gap: nearest points of the two clipped arcs, less half of each width.
        let best = Infinity;
        const steps = 64;
        for (let i = 0; i <= steps; i++) {
          const q = pointOn(ap, st.from + (st.sweep * i) / steps);
          for (let j = 0; j <= steps; j++) best = Math.min(best, Math.hypot(q.x - pointOn(an, st.from + (st.sweep * j) / steps).x, q.y - pointOn(an, st.from + (st.sweep * j) / steps).y));
        }
        const gap = Math.round(best) - (nm(p.width) + nm(n.width)) / 2;
        // Other copper between the arcs' middles breaks the coupling (the pair's own nets don't).
        const mid = st.from + st.sweep / 2;
        const check: Seg = { a: pointOn(an, mid), b: pointOn(ap, mid) };
        const blocked = obstaclesOn(p.layer, check).some((o) => {
          if ((o.kind === "track" && (o.t.net === p.net || o.t.net === n.net)) || (o.kind === "via" && (o.v.net === p.net || o.v.net === n.net))) return false;
          if (o.kind === "pad") {
            const exits = (t: Track) => inPolys(segOf(t).a, o.polys) !== inPolys(segOf(t).b, o.polys);
            if (exits(p) || exits(n)) return false;
          }
          return hits(o, check);
        });
        if (blocked) continue;
        const failMin = !!g.gap && g.gap.min !== undefined && g.gap.min >= 0 && gap < nm(g.gap.min) - epsilon;
        const failMax = !!g.gap && g.gap.max !== undefined && g.gap.max >= 0 && gap > nm(g.gap.max) + epsilon;
        coupled.push({ p, n, gap, length: Math.round(an.r * st.sweep), layer: p.layer, at: p.start, failMin, failMax });
      }
    }
    const trackLength = (list: Array<Track | Via>) => list.reduce((s, t) => s + ("kind" in t ? trackLen(t) : 0), 0);
    const totalCoupled = coupled.filter((c) => !c.failMin && !c.failMax).reduce((s, c) => s + c.length, 0);
    const total = Math.max(trackLength(g.N), trackLength(g.P));
    const uncoupled = total - totalCoupled;
    let uncoupledViolation = false;
    if (g.unc && g.unc.max !== undefined && g.unc.max >= 0 && (g.P.length || g.N.length) && uncoupled > nm(g.unc.max)) {
      uncoupledViolation = true;
      const first = g.N[0] ?? g.P[0]!;
      out.push({
        type: "diff_pair_uncoupled_length_too_long",
        rule: g.uncRule!,
        netP: g.netP,
        netN: g.netN,
        actual: uncoupled / NM,
        max: g.unc.max,
        at: "kind" in first ? first.start : first.at,
        message: `Differential uncoupled length too long (${g.uncRule} maximum uncoupled length ${g.unc.max.toFixed(4)} mm; actual ${(uncoupled / NM).toFixed(4)} mm)`,
        items: [...g.P, ...g.N].map(itemOf),
      });
    }
    if (g.gap && (uncoupledViolation || !g.unc))
      for (const c of coupled) {
        if (!c.failMin && !c.failMax) continue;
        // Re-checked against the P track's own rule on its layer (KiCad's EvalRules), named after the group's.
        const own = customConstraint(custom, "diff_pair_gap", ruleItem("Track", c.p.net, c.layer, [c.layer]), c.layer);
        const failMin = !!own && own.min !== undefined && own.min >= 0 && c.gap < nm(own.min);
        const failMax = !!own && own.max !== undefined && own.max >= 0 && c.gap > nm(own.max);
        if (!failMin && !failMax) continue;
        c.failMin = failMin;
        c.failMax = failMax;
        g.gap = { min: own!.min, max: own!.max };
        out.push({
          type: "diff_pair_gap_out_of_range",
          rule: g.gapRule!,
          netP: g.netP,
          netN: g.netN,
          actual: c.gap / NM,
          min: g.gap.min,
          max: g.gap.max,
          layer: c.layer,
          at: c.at,
          message: `Differential pair gap out of range (${g.gapRule} ${c.failMin ? `minimum gap ${g.gap.min!.toFixed(4)}` : `maximum gap ${g.gap.max!.toFixed(4)}`} mm; actual ${(c.gap / NM).toFixed(4)} mm)`,
          items: [itemOf(c.p), itemOf(c.n)],
        });
      }
  }
  return out;
}

/** A track's length as KiCad's PCB_TRACK::GetLength gives it (nm; arcs along the arc). */
function trackLen(t: Track): number {
  if (t.kind === "arc" && t.mid) {
    const a = t.start, m = t.mid, b = t.end;
    const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
    if (Math.abs(d) > 1e-12) {
      const s2 = (q: Point) => q.x * q.x + q.y * q.y;
      const c = { x: (s2(a) * (m.y - b.y) + s2(m) * (b.y - a.y) + s2(b) * (a.y - m.y)) / d, y: (s2(a) * (b.x - m.x) + s2(m) * (a.x - b.x) + s2(b) * (m.x - a.x)) / d };
      const r = Math.hypot(a.x - c.x, a.y - c.y);
      const ang = (q: Point) => Math.atan2(q.y - c.y, q.x - c.x);
      const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const ccw = norm(ang(m) - ang(a)) <= norm(ang(b) - ang(a));
      const sweep = ccw ? norm(ang(b) - ang(a)) : norm(ang(a) - ang(b));
      return Math.round(r * sweep * NM);
    }
  }
  return Math.round(Math.hypot(nm(t.end.x) - nm(t.start.x), nm(t.end.y) - nm(t.start.y)));
}

const itemOf = (t: Track | Via): DrcItem => ("kind" in t ? { kind: "track", net: t.net, uuid: t.uuid, description: `Track [${t.net}] on ${t.layer}` } : { kind: "via", net: t.net, uuid: t.uuid, at: t.at, description: `Via [${t.net}]` });

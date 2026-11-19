/**
 * Graphic shapes chained into closed outlines, as KiCad's ConvertOutlineToPolygon chains them
 * (courtyards, and a board's Edge.Cuts), with the errors it reports on the way: a chain whose
 * ends don't meet ("not a closed shape"), a chain that runs into a shape already taken, and
 * outlines that cross or overlap themselves or each other ("self-intersecting").
 *
 * Followed step by step: shapes taken in order, each open one extended both ways to the shape
 * whose end is nearest (of the two nearest ends, within 0.02 mm); polygons, circles and
 * rectangles closed by themselves. When every outline closes, the segments of all of them are
 * tested against each other, in integer nanometres as KiCad's are.
 */
import type { Point } from "./geometry.js";
import type { Graphic } from "./board.js";
import { arcPoints } from "./drc.js";

export interface ChainError {
  message: "(not a closed shape)" | "(self-intersecting)";
  /** Where KiCad marks it (mm). */
  at: Point;
  /** The shapes involved (indices into the list given). */
  shapes: number[];
}

interface P {
  x: number;
  y: number;
}

const nm = (p: Point): P => ({ x: Math.round(p.x * 1e6), y: Math.round(p.y * 1e6) });
const mm = (p: P): Point => ({ x: p.x / 1e6, y: p.y / 1e6 });
const d2 = (a: P, b: P) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const same = (a: P, b: P) => a.x === b.x && a.y === b.y;

/** A shape's two ends, as KiCad gives them (GetStart, GetEnd). */
function ends(g: Graphic): [P, P] {
  const pts = g.points;
  if (g.kind === "arc") return [nm(pts[0]!), nm(pts[2] ?? pts[1]!)];
  if (g.kind === "curve") return [nm(pts[0]!), nm(pts[pts.length - 1]!)];
  if (g.kind === "poly") return [nm(pts[0]!), nm(pts[0]!)];
  return [nm(pts[0]!), nm(pts[1] ?? pts[0]!)];
}

const closedKind = (g: Graphic) => g.kind === "poly" || g.kind === "circle" || g.kind === "rect";

/** A closed shape's outline. */
function closedOutline(g: Graphic): P[] {
  if (g.kind === "rect") {
    const [a, b] = [nm(g.points[0]!), nm(g.points[1]!)];
    return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
  }
  if (g.kind === "circle") {
    const c = g.points[0]!, r = Math.hypot(g.points[1]!.x - c.x, g.points[1]!.y - c.y);
    const n = Math.max(8, Math.ceil((2 * Math.PI) / (2 * Math.acos(Math.max(-1, 1 - 0.005 / Math.max(r, 1e-6))))));
    return Array.from({ length: n }, (_, k) => nm({ x: c.x + r * Math.cos((2 * Math.PI * k) / n), y: c.y + r * Math.sin((2 * Math.PI * k) / n) }));
  }
  return g.points.map(nm);
}

/** The points along an open shape from the end at `from` (excluded) to its other end. */
function along(g: Graphic, from: P, eps: number): { pts: P[]; end: P } | undefined {
  const [s, e] = ends(g);
  if (g.kind === "arc") {
    // An arc starts exactly where the chain is (KiCad snaps it), else it is skipped.
    let [a, b] = [s, e];
    if (d2(from, a) > eps * eps) {
      if (d2(from, b) > eps * eps) return undefined;
      [a, b] = [b, a];
    }
    const mid = g.points[1]!;
    const pts = arcPoints(mm(from), mid, mm(b), 0.1).pts.slice(1).map(nm);
    pts[pts.length - 1] = b;
    return { pts, end: b };
  }
  if (g.kind === "curve") {
    const forward = d2(from, s) < d2(from, e);
    const ctrl = g.points;
    const pts: P[] = [];
    for (let k = 1; k <= 16; k++) {
      const t = k / 16, u = 1 - t;
      const q = ctrl.length >= 4
        ? { x: u ** 3 * ctrl[0]!.x + 3 * u * u * t * ctrl[1]!.x + 3 * u * t * t * ctrl[2]!.x + t ** 3 * ctrl[3]!.x, y: u ** 3 * ctrl[0]!.y + 3 * u * u * t * ctrl[1]!.y + 3 * u * t * t * ctrl[2]!.y + t ** 3 * ctrl[3]!.y }
        : { x: ctrl[0]!.x + (ctrl[ctrl.length - 1]!.x - ctrl[0]!.x) * t, y: ctrl[0]!.y + (ctrl[ctrl.length - 1]!.y - ctrl[0]!.y) * t };
      pts.push(nm(q));
    }
    const list = forward ? pts : [nm(ctrl[0]!), ...pts.slice(0, -1)].reverse();
    return { pts: list, end: forward ? e : s };
  }
  const end = d2(from, s) < d2(from, e) ? e : s;
  return { pts: [end], end };
}

/** Closest points of two segments (for where a gap is marked). */
function nearest(a0: P, a1: P, b0: P, b1: P): [P, P] {
  const onSeg = (p: P, s0: P, s1: P): P => {
    const dx = s1.x - s0.x, dy = s1.y - s0.y, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p.x - s0.x) * dx + (p.y - s0.y) * dy) / l)) : 0;
    return { x: s0.x + t * dx, y: s0.y + t * dy };
  };
  let best: [P, P] = [a0, onSeg(a0, b0, b1)];
  for (const [p, q] of [[a1, onSeg(a1, b0, b1)], [onSeg(b0, a0, a1), b0], [onSeg(b1, a0, a1), b1]] as Array<[P, P]>) if (d2(p, q) < d2(best[0], best[1])) best = [p, q];
  return best;
}

/**
 * KiCad's SEG::Intersect with endpoint touches ignored (integer maths): the crossing point, or
 * undefined.
 */
function intersect(a: P, b: P, c: P, d: P): P | undefined {
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) return undefined;
  const e = { x: b.x - a.x, y: b.y - a.y }, f = { x: d.x - c.x, y: d.y - c.y }, o = { x: c.x - a.x, y: c.y - a.y };
  const cross = (u: P, v: P) => u.x * v.y - u.y * v.x;
  const det = cross(f, e);
  if (det === 0) {
    if (cross(e, o) !== 0) return undefined;
    const useX = Math.abs(e.x) >= Math.abs(e.y);
    const [s1, e1, s2, e2] = useX ? [a.x, b.x, c.x, d.x] : [a.y, b.y, c.y, d.y];
    const min1 = Math.min(s1, e1), max1 = Math.max(s1, e1), min2 = Math.min(s2, e2), max2 = Math.max(s2, e2);
    if (!(max1 >= min2 && max2 >= min1)) return undefined;
    const lo = Math.max(min1, min2), hi = Math.min(max1, max2);
    if (lo === hi && (lo === min1 || lo === max1) && (lo === min2 || lo === max2)) return undefined;
    const proj = Math.trunc((lo + hi) / 2);
    const [c1s, c1e] = useX ? [a.y, b.y] : [a.x, b.x];
    const other = e1 !== s1 ? c1s + Math.round(((proj - s1) * (c1e - c1s)) / (e1 - s1)) : c1s;
    return useX ? { x: proj, y: other } : { x: other, y: proj };
  }
  const p2 = cross(f, o), p1 = cross(e, o);
  if (det > 0 ? p1 < 0 || p1 > det || p2 < 0 || p2 > det : p1 > 0 || p1 < det || p2 > 0 || p2 < det) return undefined;
  if ((p1 === 0 || p1 === det) && (p2 === 0 || p2 === det)) return undefined;
  return { x: c.x + Math.round((p1 * f.x) / det), y: c.y + Math.round((p1 * f.y) / det) };
}

/** Chain the shapes into outlines: whether they all close and don't cross, and what KiCad reports. */
export function chainOutlines(shapes: Graphic[], epsilonMm = 0.02): { ok: boolean; errors: ChainError[] } {
  const errors: ChainError[] = [];
  if (!shapes.length) return { ok: true, errors };
  const eps = Math.round(epsilonMm * 1e6);
  const endpoints: Array<{ p: P; shape: number }> = [];
  shapes.forEach((g, i) => {
    const [s, e] = ends(g);
    endpoints.push({ p: s, shape: i }, { p: e, shape: i });
  });
  /** The two endpoints nearest a point (KiCad's k-d tree search for two). */
  const nearest2 = (p: P) => {
    let a = -1, b = -1, da = Infinity, db = Infinity;
    endpoints.forEach((ep, k) => {
      const d = d2(ep.p, p);
      if (d < da) (b = a), (db = da), (a = k), (da = d);
      else if (d < db) (b = k), (db = d);
    });
    return [[a, da], [b, db]] as Array<[number, number]>;
  };
  const findNext = (cur: number, p: P): number | undefined => {
    let best: number | undefined, bestD = eps * eps;
    for (const [k, d] of nearest2(p)) {
      if (k < 0) continue;
      const c = endpoints[k]!.shape;
      if (c === cur) continue;
      if (d < bestD) (bestD = d), (best = c);
    }
    return best;
  };
  const used = new Uint8Array(shapes.length);
  const contours: Array<{ pts: P[]; closed: boolean }> = [];
  const reportedGaps = new Set<string>();
  for (let start = 0; start < shapes.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const g = shapes[start]!;
    if (closedKind(g)) {
      contours.push({ pts: closedOutline(g), closed: true });
      continue;
    }
    const chain = [start];
    let closed = false;
    let [frontPt, backPt] = ends(g);
    const extend = (forward: boolean) => {
      let cur = forward ? chain[chain.length - 1]! : chain[0]!;
      let prev = forward ? backPt : frontPt;
      for (;;) {
        const next = findNext(cur, prev);
        if (next !== undefined && !used[next]) {
          used[next] = 1;
          if (forward) chain.push(next);
          else chain.unshift(next);
          const [s, e] = ends(shapes[next]!);
          prev = d2(prev, s) < d2(prev, e) ? e : s;
          cur = next;
          continue;
        }
        if (next !== undefined) {
          const chainEnd = forward ? chain[0]! : chain[chain.length - 1]!;
          const chainPt = forward ? frontPt : backPt;
          if (next === chainEnd && d2(prev, chainPt) <= eps * eps) closed = true;
          else {
            // Reported, though KiCad decides on the outlines alone.
            errors.push({ message: "(self-intersecting)", at: mm(prev), shapes: [cur, next] });
          }
        }
        if (forward) backPt = prev;
        else frontPt = prev;
        break;
      }
    };
    extend(true);
    if (!closed) extend(false);
    // The outline, from the first shape's end away from the second.
    const [fs, fe] = ends(shapes[chain[0]!]!);
    let startPt = fs;
    if (chain.length > 1) {
      const [ss, se] = ends(shapes[chain[1]!]!);
      if (d2(fs, ss) <= eps * eps || d2(fs, se) <= eps * eps) startPt = fe;
    }
    const pts: P[] = [startPt];
    let prevPt = startPt;
    for (const k of chain) {
      const step = along(shapes[k]!, prevPt, eps);
      if (!step) continue;
      for (const q of step.pts) if (!same(q, pts[pts.length - 1]!)) pts.push(q);
      prevPt = step.end;
    }
    const first = pts[0]!, last = pts[pts.length - 1]!;
    if (d2(first, last) <= eps * eps) {
      if (!same(first, last) && pts.length > 2) pts[pts.length - 1] = first;
      if (same(pts[0]!, pts[pts.length - 1]!) && pts.length > 1) pts.pop();
      contours.push({ pts, closed: true });
    } else {
      contours.push({ pts, closed: false });
      const gap = (p: P) => {
        const [na, nb] = nearest2(p);
        const A = endpoints[na![0]]!.shape, B = endpoints[nb![0] < 0 ? na![0] : nb![0]]!.shape;
        const key = `${Math.min(A, B)},${Math.max(A, B)}`;
        if (reportedGaps.has(key)) return;
        reportedGaps.add(key);
        let at = p;
        const [as, ae] = ends(shapes[A]!), [bs, be] = ends(shapes[B]!);
        if (A !== B) {
          const [pa, pb] = nearest(as, ae, bs, be);
          at = { x: Math.trunc((pa.x + pb.x) / 2), y: Math.trunc((pa.y + pb.y) / 2) };
        }
        errors.push({ message: "(not a closed shape)", at: mm(at), shapes: [A, B] });
      };
      gap(first);
      gap(last);
    }
  }
  if (contours.some((c) => !c.closed)) return { ok: false, errors };
  // Every segment of every outline, each from its lexicographically smaller end, sorted.
  const lex = (a: P, b: P) => a.x - b.x || a.y - b.y;
  const segs: Array<[P, P]> = [];
  for (const c of contours)
    c.pts.forEach((a, i) => {
      const b = c.pts[(i + 1) % c.pts.length]!;
      segs.push(lex(a, b) > 0 ? [b, a] : [a, b]);
    });
  segs.sort((s, t) => lex(s[0], t[0]) || lex(s[1], t[1]));
  const norm = (p: P) => p.x * p.x + p.y * p.y;
  let crossing = false;
  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i]!;
    for (let j = i + 1; j < segs.length; j++) {
      const [c, d] = segs[j]!;
      // KiCad stops at the first segment starting "after" this one's end (VECTOR2 compares lengths).
      if (norm(c) > norm(b)) break;
      if ((same(a, c) && same(b, d)) || (same(a, d) && same(b, c))) {
        errors.push({ message: "(self-intersecting)", at: mm(a), shapes: [] });
        crossing = true;
      } else {
        const pt = intersect(a, b, c, d);
        if (pt) {
          errors.push({ message: "(self-intersecting)", at: mm(pt), shapes: [] });
          crossing = true;
        }
      }
    }
  }
  return { ok: !crossing, errors };
}

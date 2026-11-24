/**
 * Differential pairs for interactive routing: finding a net's partner and the
 * partner's pad next to a clicked pad, and turning a routed centreline into
 * two coupled tracks at the pair's gap.
 */
import type { Board, Footprint, Pad } from "./board.js";
import { diffPairBase, netClassOf, type CopperItem, type DesignRules } from "./drc.js";
import type { Point } from "./geometry.js";

/** The other net of a differential pair, if it exists on the board. */
export function diffPartnerOnBoard(board: Board, net: string): string | undefined {
  if (!net) return undefined;
  const nets = new Set(board.footprints.flatMap((f) => f.pads.map((p) => p.net)));
  for (const n of nets) if (n !== net && diffPairBase(net, n) !== undefined) return n;
  return undefined;
}

/** Track width and gap for a pair: the net class's diff-pair values, else its track width and clearance. */
export function diffPairSizes(rules: DesignRules, net: string): { width: number; gap: number; viaGap: number; via: { size: number; drill: number } } {
  const c = netClassOf(rules, net);
  const gap = c.diffPairGap ?? c.clearance;
  return { width: c.diffPairWidth ?? c.trackWidth, gap, viaGap: c.diffPairViaGap ?? gap, via: { size: c.viaDiameter, drill: c.viaDrill } };
}

/** The partner net's pad nearest to `pad` (within `reach` mm), e.g. the other pin of a USB connector's D+/D-. */
export function partnerPad(board: Board, pad: Pad, partner: string, reach = 6): { pad: Pad; footprint: Footprint } | undefined {
  return partnerPads(board, pad, partner, reach)[0];
}

/**
 * The partner net's pads nearest to `pad`, all those equally near (a USB-C D+ pad has a D- pad on
 * each side): which one makes the pair is then the one whose tracks don't cross.
 */
export function partnerPads(board: Board, pad: Pad, partner: string, reach = 6): Array<{ pad: Pad; footprint: Footprint }> {
  const all: Array<{ pad: Pad; footprint: Footprint; d: number }> = [];
  for (const footprint of board.footprints)
    for (const p of footprint.pads) {
      if (p.net !== partner) continue;
      const d = Math.hypot(p.at.x - pad.at.x, p.at.y - pad.at.y);
      if (d <= reach) all.push({ pad: p, footprint, d });
    }
  all.sort((a, b) => a.d - b.d);
  return all.filter((c) => c.d <= all[0]!.d + 0.01).map(({ pad, footprint }) => ({ pad, footprint }));
}

const sub = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const unit = (v: Point) => {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
};

/** A polyline moved sideways by `d` (positive: to the left of travel in a Y-down frame), mitred at corners. */
function offsetLine(pts: Point[], d: number): Point[] {
  if (pts.length < 2) return pts.map((p) => ({ ...p }));
  const normals = pts.slice(1).map((b, i) => {
    const u = unit(sub(b, pts[i]!));
    return { x: u.y, y: -u.x };
  });
  return pts.map((p, i) => {
    const n0 = normals[Math.max(0, i - 1)]!;
    const n1 = normals[Math.min(normals.length - 1, i)]!;
    // Miter: the bisector of the two normals, lengthened so both offset lines meet there.
    const m = unit({ x: n0.x + n1.x, y: n0.y + n1.y });
    const k = d / Math.max(0.2, m.x * n1.x + m.y * n1.y);
    return { x: p.x + m.x * k, y: p.y + m.y * k };
  });
}

/**
 * The two tracks of a pair along `center` (its first and last points between
 * the pads), each at half the pitch (width + gap) from it, with straight
 * fan-outs to the pads. `crossed` when P is left of the centreline at one end
 * and right at the other: the tracks would have to cross (swap with vias).
 */
export function coupledPair(center: Point[], width: number, gap: number, ends: { startP: Point; startN: Point; endP?: Point; endN?: Point }): { p: Point[]; n: Point[]; crossed: boolean } {
  const half = (width + gap) / 2;
  const pts = center.filter((q, i) => i === 0 || Math.hypot(q.x - center[i - 1]!.x, q.y - center[i - 1]!.y) > 1e-9);
  if (pts.length < 2) {
    const p = [ends.startP, ...(ends.endP ? [ends.endP] : [])];
    const n = [ends.startN, ...(ends.endN ? [ends.endN] : [])];
    return { p, n, crossed: false };
  }
  const left = offsetLine(pts, half);
  const right = offsetLine(pts, -half);
  const startSide = cross(sub(pts[1]!, pts[0]!), sub(ends.startP, pts[0]!)) < 0; // P on the left?
  const last = pts.length - 1;
  const endSide = ends.endP ? cross(sub(pts[last]!, pts[last - 1]!), sub(ends.endP, pts[last]!)) < 0 : startSide;
  const [pLine, nLine] = startSide ? [left, right] : [right, left];
  const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
  const join = (pad: Point | undefined, line: Point[], atStart: boolean) => (pad && !near(pad, atStart ? line[0]! : line.at(-1)!) ? (atStart ? [pad, ...line] : [...line, pad]) : line);
  const p = join(ends.endP, join(ends.startP, pLine, true), false);
  const n = join(ends.endN, join(ends.startN, nLine, true), false);
  return { p, n, crossed: startSide !== endSide };
}

export interface CoupledRoute {
  /** Tracks of the first net ("p") and its partner ("n"), per layer run. */
  tracks: Array<{ side: "p" | "n"; layer: string; points: Point[] }>;
  /** Where the pair changes layers: a via for each net. */
  vias: Array<{ p: Point; n: Point }>;
  crossed: boolean;
}

/**
 * A whole pair route from its centreline `runs` (one per layer; each run after
 * the first starts where the previous ended, at a layer change). At each
 * change the two vias sit side by side across the direction of travel,
 * `viaPitch` apart, each on its own net's side; the next run starts between them.
 */
export function coupledRoute(
  runs: Array<{ layer: string; points: Point[] }>,
  width: number,
  gap: number,
  viaPitch: number,
  ends: { startP: Point; startN: Point; endP?: Point; endN?: Point },
): CoupledRoute {
  const out: CoupledRoute = { tracks: [], vias: [], crossed: false };
  let start = { p: ends.startP, n: ends.startN };
  let dirIn: Point | undefined;
  runs.forEach((run0, i) => {
    const last = i === runs.length - 1;
    // Out of a via pair, go on straight for half the via pitch before turning, so the vias
    // sit across the direction of travel on both layers (inside the room cleared for them).
    let run = run0;
    if (i > 0 && dirIn && run.points.length >= 2) {
      const c = run.points[0]!;
      const away = unit(sub(run.points[1]!, c));
      if (Math.abs(cross(away, dirIn)) > 1e-6) {
        const ext = { x: c.x + dirIn.x * viaPitch / 2, y: c.y + dirIn.y * viaPitch / 2 };
        run = { ...run, points: [c, ext, ...run.points.slice(1)] };
      }
    }
    let end: { endP?: Point; endN?: Point } = last ? { endP: ends.endP, endN: ends.endN } : {};
    if (!last) {
      // The vias, side by side `viaPitch` apart: across the direction of travel, or across
      // the way out when the route doubles back here (more than 90°). P takes the via
      // nearer its own incoming track, so the two fan-ins never cross.
      const pts = run.points;
      const c = pts.at(-1)!;
      const prev = [...pts].reverse().find((q) => Math.hypot(q.x - c.x, q.y - c.y) > 1e-9);
      const dir = prev ? unit(sub(c, prev)) : { x: 1, y: 0 };
      const next = runs[i + 1]!.points.find((q) => Math.hypot(q.x - c.x, q.y - c.y) > 1e-9);
      const outDir = next ? unit(sub(next, c)) : dir;
      const sharp = dir.x * outDir.x + dir.y * outDir.y < 0;
      dirIn = sharp ? undefined : dir;
      const across = sharp ? outDir : dir;
      const left = { x: across.y, y: -across.x };
      const half = viaPitch / 2;
      const a = { x: c.x + left.x * half, y: c.y + left.y * half };
      const b = { x: c.x - left.x * half, y: c.y - left.y * half };
      const pEnd = coupledPair(pts, width, gap, { startP: start.p, startN: start.n }).p.at(-1)!;
      const via = Math.hypot(a.x - pEnd.x, a.y - pEnd.y) <= Math.hypot(b.x - pEnd.x, b.y - pEnd.y) ? { p: a, n: b } : { p: b, n: a };
      out.vias.push(via);
      end = { endP: via.p, endN: via.n };
    }
    const pair = coupledPair(run.points, width, gap, { startP: start.p, startN: start.n, ...end });
    out.crossed ||= pair.crossed;
    out.tracks.push({ side: "p", layer: run.layer, points: pair.p }, { side: "n", layer: run.layer, points: pair.n });
    if (!last) start = { p: out.vias.at(-1)!.p, n: out.vias.at(-1)!.n };
  });
  return out;
}

/**
 * Where a pair leaves (or arrives at) two pads: straight out from between
 * them, perpendicular to the line through the pads, far enough that the pair
 * clears them. Routing the centreline from here keeps each fan-out a short
 * step between the pads, never across the partner's pad. Of the two ways out,
 * it takes the one clear of the part's other pads (an IC's pins face out);
 * when both are clear (a connector's middle pins), the one facing `toward`
 * (where the route goes), else away from the part's centre.
 */
export function pairEscape(padP: Pad, padN: Pad, footprint: Footprint, width: number, gap: number, toward?: Point, clearance = 0.2): { mid: Point; escape: Point } {
  const mid = { x: (padP.at.x + padN.at.x) / 2, y: (padP.at.y + padN.at.y) / 2 };
  const axis = unit(sub(padN.at, padP.at));
  const e = { x: -axis.y, y: axis.x };
  // Clear of the pads for the whole pair: past their ends by the clearance and half its width.
  const len = Math.max(padP.size.x, padP.size.y, padN.size.x, padN.size.y) / 2 + clearance + width + gap / 2 + 0.1;
  const at = (k: number) => ({ x: mid.x + e.x * len * k, y: mid.y + e.y * len * k });
  // How close each way out comes to the part's other pads (their outline roughly, by size).
  const others = footprint.pads.filter((q) => q !== padP && q !== padN);
  const room = (q: Point) => Math.min(Infinity, ...others.map((o) => Math.hypot(o.at.x - q.x, o.at.y - q.y) - Math.max(o.size.x, o.size.y) / 2));
  const [ra, rb] = [room(at(1)), room(at(-1))];
  const need = width + gap / 2 + clearance;
  let k: number;
  if ((ra < need) !== (rb < need)) k = ra < need ? -1 : 1;
  else {
    const ref = toward ? sub(toward, mid) : sub(mid, footprint.at);
    k = e.x * ref.x + e.y * ref.y >= 0 ? 1 : -1;
  }
  return { mid, escape: at(k) };
}

/**
 * What a pair's centreline routes around: everything but the partner's
 * copper, with the pads at the pair's ends (by uuid) as obstacles: the
 * centreline and the pair's vias stay off them, the fan-outs reach them.
 */
export function pairObstacles(items: CopperItem[], net: string, partner: string, endPads: Iterable<string> = []): CopperItem[] {
  const ends = new Set(endPads);
  return items
    .filter((it) => it.item.net !== partner || (it.item.kind === "pad" && ends.has(it.item.uuid ?? "")))
    .map((it) => (it.item.kind === "pad" && ends.has(it.item.uuid ?? "") ? { ...it, item: { ...it.item, net: `${net}\u0000end` } } : it));
}

/**
 * How well each differential pair on the board is routed as a pair: for each two nets of a pair that
 * both have tracks, the share of the first net's track length that has the partner's track one pitch
 * (the class's pair width and gap) away on its layer. Near 1 for a pair routed coupled; near 0 for
 * two nets routed apart.
 */
export function pairCoupling(board: Board, rules: DesignRules): Array<{ nets: [string, string]; coupled: number }> {
  const byNet = new Map<string, Board["tracks"]>();
  for (const t of board.tracks) if (t.net) (byNet.get(t.net) ?? byNet.set(t.net, []).get(t.net)!).push(t);
  const dist = (q: Point, a: Point, b: Point) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(a.x + t * dx - q.x, a.y + t * dy - q.y);
  };
  const out: Array<{ nets: [string, string]; coupled: number }> = [];
  for (const [net, mine] of byNet) {
    const partner = [...byNet.keys()].find((n) => n !== net && diffPairBase(net, n) !== undefined);
    if (!partner || partner < net) continue;
    const theirs = byNet.get(partner)!;
    const sz = diffPairSizes(rules, net);
    const pitch = sz.width + sz.gap;
    let total = 0, near = 0;
    for (const t of mine) {
      const len = Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
      const steps = Math.max(1, Math.round(len / 0.1));
      for (let i = 0; i < steps; i++) {
        const q = { x: t.start.x + ((t.end.x - t.start.x) * (i + 0.5)) / steps, y: t.start.y + ((t.end.y - t.start.y) * (i + 0.5)) / steps };
        total += len / steps;
        if (theirs.some((o) => o.layer === t.layer && Math.abs(dist(q, o.start, o.end) - pitch) < 0.02)) near += len / steps;
      }
    }
    if (total > 0) out.push({ nets: [net, partner], coupled: Math.round((near / total) * 100) / 100 });
  }
  return out;
}

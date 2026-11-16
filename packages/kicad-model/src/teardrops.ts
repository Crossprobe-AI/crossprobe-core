/**
 * Teardrops: tapered copper where a track meets a pad or via, so the joint
 * survives drilling and flexing. KiCad stores each as a small zone
 * ($teardrop_padvia$) with its fill; this builds the straight-edged form.
 * The teardrop starts on the track one teardrop-length past the pad's edge,
 * at the track's width, and widens to meet the pad outline. Only where the
 * track is clearly narrower than the pad, and never closer to other nets'
 * copper than the clearance (skipped rather than clipped).
 */
import type { Board, Pad, Track } from "./board.js";
import { buildArea, edgeChains, trackConflicts, type CopperItem, type DesignRules } from "./drc.js";
import type { Point } from "./geometry.js";
import { padCopperCenter, padPolygons } from "./zone-fill.js";

export interface TeardropOptions {
  /** Teardrop length past the pad edge, as a share of the pad's size (KiCad: 0.5), and its cap (mm, KiCad: 1). */
  lengthRatio?: number;
  maxLength?: number;
  /** Width where it meets the pad, as a share of the pad's size (KiCad: 1), and its cap (mm, KiCad: 2). */
  widthRatio?: number;
  maxWidth?: number;
  /** Only where the track is narrower than this share of the pad's size (KiCad: 0.9). */
  filterRatio?: number;
}

export interface Teardrop {
  net: string;
  layer: string;
  outline: Point[];
}

const sub = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
const unit = (v: Point) => {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
};
const inPoly = (p: Point, poly: Point[]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

/** Where a ray from `o` along `u` last leaves the outline (the farthest crossing), if it starts inside. */
function exitAlong(o: Point, u: Point, polys: Point[][]): Point | undefined {
  if (polys.filter((p) => inPoly(o, p)).length % 2 === 0) return undefined;
  let best = -1;
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const c = poly[i]!, d = poly[(i + 1) % poly.length]!;
      const ex = d.x - c.x, ey = d.y - c.y;
      const den = u.x * ey - u.y * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c.x - o.x) * ey - (c.y - o.y) * ex) / den;
      const s = ((c.x - o.x) * u.y - (c.y - o.y) * u.x) / den;
      if (t > 0 && s >= 0 && s <= 1 && t > best) best = t;
    }
  return best > 0 ? { x: o.x + u.x * best, y: o.y + u.y * best } : undefined;
}

function circle(c: Point, r: number, n = 32): Point[] {
  return Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }));
}

/** Teardrops for every track end on a pad or via of its net (straight tracks; arcs are skipped). */
export function computeTeardrops(board: Board, rules: DesignRules, items: CopperItem[], opts: TeardropOptions = {}): Teardrop[] {
  const lengthRatio = opts.lengthRatio ?? 0.5, maxLength = opts.maxLength ?? 1;
  const widthRatio = opts.widthRatio ?? 1, maxWidth = opts.maxWidth ?? 2;
  const filterRatio = opts.filterRatio ?? 0.9;
  const solid = items.filter((it) => it.item.kind !== "zone");
  const out: Teardrop[] = [];
  const index = board.copperLayers;
  const edges = edgeChains(board).flatMap((ch) => ch.slice(1).map((q, i): [Point, Point] => [ch[i]!, q]));
  const edgeClear = rules.copperEdgeClearance ?? 0;
  // What a track end sits on: a via or a pad of its net on its layer.
  const anchorAt = (t: Track, e: Point): { center: Point; size: number; polys: Point[][] } | undefined => {
    for (const v of board.vias) {
      if (v.net !== t.net || Math.hypot(v.at.x - e.x, v.at.y - e.y) > v.size / 2) continue;
      const [a, b] = [index.indexOf(v.layers[0]!), index.indexOf(v.layers[v.layers.length - 1]!)];
      const i = index.indexOf(t.layer);
      if (i < Math.min(a, b) || i > Math.max(a, b)) continue;
      return { center: v.at, size: v.size, polys: [circle(v.at, v.size / 2)] };
    }
    for (const f of board.footprints)
      for (const pad of f.pads as Pad[]) {
        if (pad.net !== t.net || !pad.layers.some((l) => l === t.layer || l === "*.Cu" || (l === "F&B.Cu" && (t.layer === "F.Cu" || t.layer === "B.Cu")))) continue;
        if (pad.shape === "custom") continue;
        const polys = padPolygons(pad, 0);
        if (polys.filter((p) => inPoly(e, p)).length % 2 === 0) continue;
        return { center: padCopperCenter(pad), size: Math.min(pad.size.x, pad.size.y), polys };
      }
    return undefined;
  };
  for (const t of board.tracks) {
    if (t.kind === "arc" || !t.net) continue;
    for (const [e, far] of [[t.start, t.end], [t.end, t.start]] as const) {
      const anchor = anchorAt(t, e);
      if (!anchor || t.width >= filterRatio * anchor.size) continue;
      const { center: c, size, polys } = anchor;
      // Along the track, out of the pad: from its centre when the track ends there, else from the end.
      const fromCentre = Math.hypot(e.x - c.x, e.y - c.y) < 1e-6;
      const o = fromCentre ? c : e;
      const u = unit(sub(far, o));
      const n = { x: -u.y, y: u.x };
      const edge = exitAlong(o, u, polys);
      if (!edge) continue;
      const len = Math.min(maxLength, lengthRatio * size);
      const reach = Math.hypot(far.x - edge.x, far.y - edge.y);
      if (reach < len + 1e-6) continue; // the track is too short past the pad
      const tip = { x: edge.x + u.x * len, y: edge.y + u.y * len };
      const a = { x: tip.x + n.x * (t.width / 2), y: tip.y + n.y * (t.width / 2) };
      const b = { x: tip.x - n.x * (t.width / 2), y: tip.y - n.y * (t.width / 2) };
      // Where the teardrop meets the pad: two lines a teardrop-width apart, as wide as fits.
      let half = Math.min(maxWidth, widthRatio * size) / 2;
      let qa: Point | undefined, qb: Point | undefined;
      for (let k = 0; k < 12 && half > t.width / 2; k++, half *= 0.85) {
        qa = exitAlong({ x: o.x + n.x * half * 0.98, y: o.y + n.y * half * 0.98 }, u, polys);
        qb = exitAlong({ x: o.x - n.x * half * 0.98, y: o.y - n.y * half * 0.98 }, u, polys);
        if (qa && qb) break;
      }
      if (!qa || !qb) continue;
      const outline = [a, qa, o, qb, b];
      // Clear of other nets by the clearance, or none here.
      const clash = outline.some((p, i) => trackConflicts(solid, rules, { a: p, b: outline[(i + 1) % outline.length]!, width: 0, layer: t.layer, net: t.net }).length > 0);
      const nearEdge = outline.some((p, i) => edges.some(([c, d]) => segDist(p, outline[(i + 1) % outline.length]!, c, d) < Math.max(edgeClear, 1e-6)));
      if (clash || nearEdge) continue;
      out.push({ net: t.net, layer: t.layer, outline });
      // Later teardrops keep clear of this one too.
      const area = buildArea(outline);
      solid.push({ shapes: [area], layers: new Set([t.layer]), item: { kind: "graphic", net: t.net, description: `Teardrop [${t.net}]` }, box: area.box });
    }
  }
  return out;
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

/**
 * Board copper connectivity and the ratsnest: which pads, tracks, vias and
 * zone fills of each net actually touch, and which connections are still
 * missing (KiCad's "unconnected items").
 *
 * Items connect when they share a net and a copper layer and one item's
 * anchor point lies inside the other's copper: track ends inside pads, vias,
 * other tracks or zone fills; pad and via centres inside each other or fills.
 * Each net's connected clusters are then linked by their closest anchor pairs
 * (a minimum spanning tree over clusters), which gives the ratsnest lines.
 */
import type { Board, Pad } from "./board.js";
import type { Point } from "./geometry.js";

export interface CopperAnchor {
  kind: "pad" | "track" | "via";
  description: string;
  at: Point;
  layer?: string;
  reference?: string;
}

export interface Unconnected {
  net: string;
  a: CopperAnchor;
  b: CopperAnchor;
}

interface Item {
  kind: "pad" | "track" | "via" | "fill" | "shape";
  layers: string[];
  anchors: Point[];
  /** Is `p` within `extra` mm of the item's copper (on the given layer)? */
  contains: (p: Point, layer: string, extra?: number) => boolean;
  /** How far the item's own copper extends around its anchors (for overlap tests). */
  radius: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  describe: () => CopperAnchor;
  /** Zone fills: outline points, for touching tests against other items. */
  vertices?: Point[];
  /** Extra points tested against zone fills (pad corners, via rims). */
  probes?: Point[];
}

const rot = (p: Point, deg: number): Point => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c };
};

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Arc through three points as a polyline (for hit testing). */
function arcPoints(a: Point, m: Point, b: Point, steps = 16): Point[] {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-9) return [a, b];
  const sq = (p: Point) => p.x * p.x + p.y * p.y;
  const cx = (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d;
  const cy = (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  const tau = Math.PI * 2;
  const norm = (x: number) => ((x % tau) + tau) % tau;
  const a0 = Math.atan2(a.y - cy, a.x - cx);
  const toMid = norm(Math.atan2(m.y - cy, m.x - cx) - a0);
  const toEnd = norm(Math.atan2(b.y - cy, b.x - cx) - a0);
  const span = toMid < toEnd ? toEnd : toEnd - tau;
  return Array.from({ length: steps + 1 }, (_, i) => ({ x: cx + r * Math.cos(a0 + (span * i) / steps), y: cy + r * Math.sin(a0 + (span * i) / steps) }));
}

/** Pad copper test: rectangle-like shapes in the pad's frame, with rounded corners where they apply. */
function padContains(pad: Pad, p: Point, tol: number): boolean {
  const q = rot({ x: p.x - pad.at.x, y: p.y - pad.at.y }, -pad.rotation);
  const hw = pad.size.x / 2 + tol;
  const hh = pad.size.y / 2 + tol;
  if (pad.shape === "circle") return Math.hypot(q.x, q.y) <= pad.size.x / 2 + tol;
  if (Math.abs(q.x) > hw || Math.abs(q.y) > hh) return false;
  const r =
    pad.shape === "oval" ? Math.min(pad.size.x, pad.size.y) / 2 : pad.shape === "roundrect" ? Math.min(pad.size.x, pad.size.y) * (pad.roundrectRatio ?? 0.25) : 0;
  if (r <= 0) return true;
  const cx = Math.max(Math.abs(q.x) - (pad.size.x / 2 - r), 0);
  const cy = Math.max(Math.abs(q.y) - (pad.size.y / 2 - r), 0);
  return Math.hypot(cx, cy) <= r + tol;
}

/** Point-in-polygon with edges bucketed into horizontal bands, so big zone fills stay fast. */
class PolygonIndex {
  private bands = new Map<number, Array<[number, number, number, number]>>();
  readonly bbox: Item["bbox"];
  constructor(pts: Point[], private band = 0.5) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y); x1 = Math.max(x1, a.x); y1 = Math.max(y1, a.y);
      if (a.y === b.y) continue;
      const lo = Math.floor(Math.min(a.y, b.y) / band);
      const hi = Math.floor(Math.max(a.y, b.y) / band);
      for (let k = lo; k <= hi; k++) {
        let list = this.bands.get(k);
        if (!list) this.bands.set(k, (list = []));
        list.push([a.x, a.y, b.x, b.y]);
      }
    }
    this.bbox = { x0, y0, x1, y1 };
  }
  contains(p: Point): boolean {
    if (p.x < this.bbox.x0 || p.x > this.bbox.x1 || p.y < this.bbox.y0 || p.y > this.bbox.y1) return false;
    let inside = false;
    for (const [ax, ay, bx, by] of this.bands.get(Math.floor(p.y / this.band)) ?? []) {
      if (ay > p.y !== by > p.y && p.x < ((bx - ax) * (p.y - ay)) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  }
}

function expandLayers(layers: string[], copper: string[]): string[] {
  const out = new Set<string>();
  for (const l of layers) {
    if (l === "*.Cu") copper.forEach((c) => out.add(c));
    else if (l === "F&B.Cu") ["F.Cu", "B.Cu"].forEach((c) => out.add(c));
    else if (l.endsWith(".Cu")) out.add(l);
  }
  return [...out];
}

/** Via layers: a through via spans every copper layer; blind/buried vias the range between their two layers. */
function viaLayers(layers: string[], copper: string[]): string[] {
  if (layers.length < 2) return copper;
  const i = copper.indexOf(layers[0]!);
  const j = copper.indexOf(layers[1]!);
  if (i < 0 || j < 0) return copper;
  return copper.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Group items by net. */
function netItems(board: Board): Map<string, Item[]> {
  const copper = board.copperLayers.length ? board.copperLayers : ["F.Cu", "B.Cu"];
  const byNet = new Map<string, Item[]>();
  const add = (net: string, item: Item) => {
    if (!net) return;
    let list = byNet.get(net);
    if (!list) byNet.set(net, (list = []));
    list.push(item);
  };
  // Copper that touches within 5 µm counts as connected (fills end exactly on pad edges).
  const tol = 0.005;

  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      if (!pad.net || pad.type === "np_thru_hole") continue;
      const layers = expandLayers(pad.layers, copper);
      if (!layers.length) continue;
      const r = Math.hypot(pad.size.x, pad.size.y) / 2;
      add(pad.net, {
        kind: "pad",
        layers,
        anchors: [pad.at],
        contains: (p, _l, extra = 0) => padContains(pad, p, tol + extra),
        // Corners (slightly inset) so a pour overlapping the pad's edge is found.
        probes: [
          [-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0],
        ].map(([sx, sy]) => {
          const q = rot({ x: (sx! * pad.size.x) / 2 * 0.9, y: (sy! * pad.size.y) / 2 * 0.9 }, pad.rotation);
          return { x: pad.at.x + q.x, y: pad.at.y + q.y };
        }),
        radius: Math.min(pad.size.x, pad.size.y) / 2,
        bbox: { x0: pad.at.x - r, y0: pad.at.y - r, x1: pad.at.x + r, y1: pad.at.y + r },
        describe: () => ({ kind: "pad", description: `Pad ${pad.number} [${pad.net}] of ${fp.reference}`, at: pad.at, reference: fp.reference, layer: layers[0] }),
      });
    }
  }
  for (const t of board.tracks) {
    if (!t.net) continue;
    const pts = t.kind === "arc" && t.mid ? arcPoints(t.start, t.mid, t.end) : [t.start, t.end];
    const hw = t.width / 2;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    add(t.net, {
      kind: "track",
      layers: [t.layer],
      anchors: [t.start, t.end],
      contains: (p, _l, extra = 0) => {
        for (let i = 1; i < pts.length; i++) if (segDist(p, pts[i - 1]!, pts[i]!) <= hw + tol + extra) return true;
        return false;
      },
      radius: hw,
      bbox: { x0: Math.min(...xs) - hw, y0: Math.min(...ys) - hw, x1: Math.max(...xs) + hw, y1: Math.max(...ys) + hw },
      describe: () => {
        const len = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y), 0);
        return { kind: "track", description: `Track [${t.net}] on ${t.layer}, length ${len.toFixed(4)} mm`, at: t.start, layer: t.layer };
      },
    });
  }
  for (const v of board.vias) {
    if (!v.net) continue;
    const r = v.size / 2;
    add(v.net, {
      kind: "via",
      layers: viaLayers(v.layers, copper),
      anchors: [v.at],
      contains: (p, _l, extra = 0) => Math.hypot(p.x - v.at.x, p.y - v.at.y) <= r + tol + extra,
      probes: [0, 90, 180, 270].map((a) => ({ x: v.at.x + 0.9 * r * Math.cos((a * Math.PI) / 180), y: v.at.y + 0.9 * r * Math.sin((a * Math.PI) / 180) })),
      radius: r,
      bbox: { x0: v.at.x - r, y0: v.at.y - r, x1: v.at.x + r, y1: v.at.y + r },
      describe: () => ({ kind: "via", description: `Via [${v.net}]`, at: v.at }),
    });
  }
  // Copper graphics: board shapes with a net, and footprint shapes, which act
  // as copper of the pad they touch.
  const shapeItem = (g: Board["drawings"][number], net: string) => {
    const pts = g.kind === "arc" ? arcPoints(g.points[0]!, g.points[1]!, g.points[2]!) : g.kind === "rect"
      ? [g.points[0]!, { x: g.points[1]!.x, y: g.points[0]!.y }, g.points[1]!, { x: g.points[0]!.x, y: g.points[1]!.y }, g.points[0]!]
      : g.kind === "circle"
        ? Array.from({ length: 33 }, (_, i) => {
            const r = Math.hypot(g.points[1]!.x - g.points[0]!.x, g.points[1]!.y - g.points[0]!.y);
            return { x: g.points[0]!.x + r * Math.cos((i / 32) * Math.PI * 2), y: g.points[0]!.y + r * Math.sin((i / 32) * Math.PI * 2) };
          })
        : g.kind === "poly" ? [...g.points, g.points[0]!] : g.points;
    if (pts.length < 2) return;
    const filled = g.fill && pts.length > 3 ? new PolygonIndex(pts) : undefined;
    const hw = g.width / 2;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    add(net, {
      kind: "shape",
      layers: [g.layer],
      // A handful of anchors is enough to find what a shape touches; logos can have thousands of points.
      anchors: pts.length <= 8 ? pts : Array.from({ length: 8 }, (_, i) => pts[Math.floor((i * (pts.length - 1)) / 7)]!),
      contains: (p, _l, extra = 0) => {
        if (filled?.contains(p)) return true;
        for (let i = 1; i < pts.length; i++) if (segDist(p, pts[i - 1]!, pts[i]!) <= hw + tol + extra) return true;
        return false;
      },
      radius: hw,
      vertices: pts,
      bbox: { x0: Math.min(...xs) - hw, y0: Math.min(...ys) - hw, x1: Math.max(...xs) + hw, y1: Math.max(...ys) + hw },
      describe: () => ({ kind: "track", description: `Shape [${net}] on ${g.layer}`, at: pts[0]!, layer: g.layer }),
    });
  };
  for (const g of board.drawings) if (g.net && g.layer.endsWith(".Cu")) shapeItem(g, g.net);
  for (const fp of board.footprints) {
    for (const g of fp.graphics) {
      if (!g.layer.endsWith(".Cu")) continue;
      const pad = fp.pads.find((p) => p.net && expandLayers(p.layers, copper).includes(g.layer) && g.points.some((q) => padContains(p, q, 0.05)));
      if (pad) shapeItem(g, pad.net);
    }
  }

  for (const z of board.zones) {
    if (!z.net || z.keepout) continue;
    for (const fill of z.fills) {
      if (fill.points.length < 3) continue;
      const poly = new PolygonIndex(fill.points);
      add(z.net, {
        kind: "fill",
        layers: [fill.layer],
        // A fill touches something through that thing's anchor, so it needs none of its own.
        anchors: [],
        contains: (p) => poly.contains(p),
        radius: 0,
        bbox: poly.bbox,
        vertices: fill.points,
        describe: () => ({ kind: "track", description: `Zone [${z.net}] on ${fill.layer}`, at: fill.points[0]!, layer: fill.layer }),
      });
    }
  }
  return byNet;
}

class UF {
  p: number[];
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]!]!;
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p[ra] = rb;
  }
}

/** A net's copper, split into the pieces that are connected to each other (fills not counted alone). */
function clustersOf(items: Item[]): number[][] {
  const uf = new UF(items.length);
  // Coarse grid over item bounding boxes to find candidate pairs.
  const cell = 2;
  const grid = new Map<string, number[]>();
  items.forEach((it, i) => {
    if (it.kind === "fill") return; // fills are tested against anchors below
    // Pad the cells by a margin so overlap tests find their neighbours.
    const m = 1;
    for (let gx = Math.floor((it.bbox.x0 - m) / cell); gx <= Math.floor((it.bbox.x1 + m) / cell); gx++) {
      for (let gy = Math.floor((it.bbox.y0 - m) / cell); gy <= Math.floor((it.bbox.y1 + m) / cell); gy++) {
        const k = `${gx},${gy}`;
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(i);
      }
    }
  });
  const shares = (a: Item, b: Item) => a.layers.some((l) => b.layers.includes(l));
  const fills = items.map((it, j) => [it, j] as const).filter(([it]) => it.kind === "fill");
  items.forEach((it, i) => {
    for (const p of it.probes ?? []) {
      for (const [f, j] of fills) if (it.layers.includes(f.layers[0]!) && f.contains(p, f.layers[0]!)) uf.union(i, j);
    }
    for (const p of it.anchors) {
      for (const j of grid.get(`${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`) ?? []) {
        if (j === i) continue;
        const other = items[j]!;
        if (!shares(it, other)) continue;
        const layer = it.layers.find((l) => other.layers.includes(l))!;
        // Overlap: the anchor's own copper (track half-width, via or pad radius) reaching the other item.
        if (other.contains(p, layer, it.radius)) uf.union(i, j);
      }
      for (const [f, j] of fills) {
        if (!it.layers.includes(f.layers[0]!)) continue;
        if (f.contains(p, f.layers[0]!)) uf.union(i, j);
      }
    }
  });

  // Thermal reliefs: a fill reaches a pad through spokes whose ends lie on
  // the pad, while the pad's centre sits in the relief gap. Test the fill's
  // outline points against each item's copper instead.
  const outlined = items.map((it, j) => [it, j] as const).filter(([it]) => it.vertices);
  outlined.forEach(([f, j]) => {
    const layer = f.layers[0]!;
    for (const v of f.vertices ?? []) {
      for (const i of grid.get(`${Math.floor(v.x / cell)},${Math.floor(v.y / cell)}`) ?? []) {
        const it = items[i]!;
        if (uf.find(i) === uf.find(j) || !it.layers.includes(layer)) continue;
        if (it.contains(v, layer)) uf.union(i, j);
      }
    }
  });

  // Clusters that contain something other than bare zone fill.
  const clusters = new Map<number, number[]>();
  items.forEach((it, i) => {
    if (it.kind === "fill") return;
    const r = uf.find(i);
    let c = clusters.get(r);
    if (!c) clusters.set(r, (c = []));
    c.push(i);
  });
  const list = [...clusters.values()].filter((c) => c.some((i) => items[i]!.kind === "pad" || items[i]!.kind === "track" || items[i]!.kind === "via"));
  return list;
}

/**
 * The connected pieces ("islands") of a net's copper, each as its anchors: pad centres, track ends,
 * vias. A net that's fully connected has one.
 */
export function netIslands(board: Board, net: string): CopperAnchor[][] {
  const items = netItems(board).get(net);
  if (!items) return [];
  return clustersOf(items).map((c) => c.flatMap((i) => items[i]!.anchors.map((at) => ({ ...items[i]!.describe(), at }))));
}

/** Missing connections per net: one entry per ratsnest line. */
export function findUnconnected(board: Board): Unconnected[] {
  const out: Unconnected[] = [];
  for (const [net, items] of netItems(board)) {
    const list = clustersOf(items);
    if (list.length < 2) continue;

    // Prim's algorithm over clusters, using the closest anchors between them.
    const anchorsOf = (c: number[]) => c.flatMap((i) => items[i]!.anchors.map((p) => ({ p, i })));
    const inTree = [list[0]!];
    const rest = list.slice(1);
    while (rest.length) {
      let best = { d: Infinity, r: -1, a: undefined as { p: Point; i: number } | undefined, b: undefined as { p: Point; i: number } | undefined };
      for (const t of inTree) {
        const ta = anchorsOf(t);
        rest.forEach((c, r) => {
          for (const b of anchorsOf(c)) for (const a of ta) {
            const d = Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y);
            if (d < best.d) best = { d, r, a, b };
          }
        });
      }
      const [c] = rest.splice(best.r, 1);
      inTree.push(c!);
      out.push({ net, a: { ...items[best.a!.i]!.describe(), at: best.a!.p }, b: { ...items[best.b!.i]!.describe(), at: best.b!.p } });
    }
  }
  return out;
}

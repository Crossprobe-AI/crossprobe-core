/**
 * Minimum connection width, as KiCad 10's DRC checks it (DRC_TEST_PROVIDER_CONNECTION_WIDTH):
 * each net's copper on each layer (zone fills, tracks, and pads and vias where they have copper)
 * is merged into fractured outlines, and every concave corner is paired with the nearest point
 * of the outline across a neck narrower than the limit, when the copper bulges out to a
 * "substantial" size on both sides of the cut. Each such neck is reported when the items there
 * must keep that width: the board minimum (Board Setup › Constraints › Minimum connection width)
 * or a custom `connection_width` rule.
 *
 * The outline walk follows KiCad's VERTEX_SET (a vertex ring with a Morton-ordered index), in
 * integer nanometres like KiCad's own.
 */
import type { Point } from "./geometry.js";
import type { BoardViolation } from "./drc-checks.js";
import { copperItems, netClassOf, shapeDistance, type CopperItem, type DesignRules, type Shape } from "./drc.js";
import { customConstraint, type RuleItem } from "./drc-rules.js";
import type { Board } from "./board.js";
import { fracturedCopper } from "./zone-fill.js";

interface V {
  /** Index of the point in its outline. */
  i: number;
  x: number;
  y: number;
  z: number;
  prev: V;
  next: V;
  prevZ: V | null;
  nextZ: V | null;
}

/** Concave corners paired across necks narrower than `limit` (nm), on one closed outline. */
export class NeckFinder {
  private verts: V[] = [];
  private box = { x: 0, y: 0, w: 1, h: 1 };
  constructor(private readonly limit: number) {}

  /** Pairs of outline point indices (each a neck), as KiCad's POLYGON_TEST::FindPairs gives them. */
  findPairs(pts: Array<{ x: number; y: number }>): Array<[number, number]> {
    this.verts = [];
    if (pts.length < 3) return [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    this.box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const first = this.createList(pts);
    if (!first) return [];
    this.updateList(first);
    const hits = new Map<string, [number, number]>();
    const all = new Set<V>();
    for (let p = first.next; p !== first; p = p.next) {
      if (all.has(p)) continue;
      const match = this.kink(p);
      if (!match || all.has(match)) continue;
      const key = `${p.i},${match.i}`;
      if (hits.has(key)) continue;
      hits.set(key, [p.i, match.i]);
      for (const v of [p, match, p.next, p.prev, match.next, match.prev]) all.add(v);
    }
    // In KiCad's order (a std::set of index pairs).
    return [...hits.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  /** The ring, clockwise or not as the outline winds (reversed when its signed sum is positive), without repeated points. */
  private createList(pts: Array<{ x: number; y: number }>): V | undefined {
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      sum += (b.x - a.x) * (b.y + a.y);
    }
    let first: V | undefined, tail: V | undefined, last: { x: number; y: number } | undefined;
    const add = (i: number) => {
      const p = pts[i]!;
      if (last && p.x === last.x && p.y === last.y) return;
      const v = { i, x: p.x, y: p.y, z: 0, prevZ: null, nextZ: null } as unknown as V;
      if (!tail) (v.prev = v), (v.next = v), (first = v);
      else (v.next = tail.next), (v.prev = tail), (tail.next.prev = v), (tail.next = v);
      this.verts.push(v);
      tail = v;
      last = p;
    };
    if (sum > 0) for (let i = pts.length - 1; i >= 0; i--) add(i);
    else for (let i = 0; i < pts.length; i++) add(i);
    // The ring's end on its start: drop the start (KiCad removes tail->next).
    if (tail && first && tail !== first && tail.x === first.x && tail.y === first.y) {
      const f = first;
      f.prev.next = f.next;
      f.next.prev = f.prev;
      first = f.next;
    }
    return first;
  }

  private zOrder(x: number, y: number): number {
    const fx = Math.min(1, Math.max(0, (x - this.box.x) / (this.box.w || 1)));
    const fy = Math.min(1, Math.max(0, (y - this.box.y) / (this.box.h || 1)));
    let a = Math.floor(fx * 32767);
    let b = Math.floor(fy * 32767);
    a = (a | (a << 8)) & 0x00ff00ff;
    a = (a | (a << 4)) & 0x0f0f0f0f;
    a = (a | (a << 2)) & 0x33333333;
    a = (a | (a << 1)) & 0x55555555;
    b = (b | (b << 8)) & 0x00ff00ff;
    b = (b | (b << 4)) & 0x0f0f0f0f;
    b = (b | (b << 2)) & 0x33333333;
    b = (b | (b << 1)) & 0x55555555;
    return (a | (b << 1)) >>> 0;
  }

  /** Repeated neighbours out, Morton codes in, and the ring indexed by them (VERTEX::updateList, zSort). */
  private updateList(head: V) {
    let p = head.next;
    while (p !== head) {
      if (p.x === p.next.x && p.y === p.next.y) {
        p = p.prev;
        const gone = p.next;
        p.next = gone.next;
        gone.next.prev = p;
        if (p === p.next) break;
      }
      if (!p.z) p.z = this.zOrder(p.x, p.y);
      p = p.next;
    }
    if (!head.z) head.z = this.zOrder(head.x, head.y);
    const ring: V[] = [head];
    for (let q = head.next; q && q !== head; q = q.next) ring.push(q);
    ring.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y || a.i - b.i);
    ring.forEach((v, k) => {
      v.prevZ = ring[k - 1] ?? null;
      v.nextZ = ring[k + 1] ?? null;
    });
  }

  private area(p: V, q: V, r: V): number {
    return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  }

  private same(a: V | null, b: V | null): boolean {
    return !!a && !!b && a.x === b.x && a.y === b.y;
  }

  /** The next point along the outline, staying on this side at a fracture cut. */
  private nextOnOutline(p: V): V {
    const nz = p.nextZ, pz = p.prevZ;
    if (nz && this.same(p, nz) && this.same(p.next, nz.prev) && p.y === p.next.y) return nz.next;
    if (pz && this.same(p, pz) && this.same(p.next, pz.prev) && p.y === p.next.y) return pz.next;
    return p.next;
  }

  private prevOnOutline(p: V): V {
    const nz = p.nextZ, pz = p.prevZ;
    if (nz && this.same(p, nz) && p.y === p.prev.y) return nz.prev;
    if (pz && this.same(p, pz) && p.y === p.prev.y) return pz.prev;
    return p.prev;
  }

  private locallyInside(a: V, b: V): boolean {
    const an = this.nextOnOutline(a);
    const ap = this.prevOnOutline(a);
    if (this.area(ap, a, an) < 0) return this.area(a, b, an) >= 0 && this.area(a, ap, b) >= 0;
    return this.area(a, b, ap) < 0 || this.area(a, an, b) < 0;
  }

  /**
   * Does the outline, followed from `a` either way until it reaches `b` (or comes round), move
   * more than the limit both across and down? Then the cut a–b leaves real copper on that side.
   */
  private substantial(a: V, b: V): boolean {
    const total = this.verts.length;
    const walk = (step: (v: V) => V): { p: V; x: boolean; y: boolean } | undefined => {
      let x = false, y = false, checked = 0;
      let p = step(a);
      while (!this.same(p, b) && !this.same(p, a) && checked < total && !(x && y)) {
        if (Math.abs(p.x - a.x) > this.limit) x = true;
        if (Math.abs(p.y - a.y) > this.limit) y = true;
        p = step(p);
        checked++;
      }
      return checked < total ? { p, x, y } : undefined;
    };
    const fwd = walk((v) => this.nextOnOutline(v));
    if (!fwd || (!this.same(fwd.p, a) && (!fwd.x || !fwd.y))) return false;
    const back = walk((v) => this.prevOnOutline(v));
    return !!back && (this.same(back.p, a) || (back.x && back.y));
  }

  /** The nearest point across a too-narrow neck from a concave corner, if any. */
  private kink(at: V): V | null {
    if (this.locallyInside(at.prev, at.next)) return null;
    const maxZ = this.zOrder(at.x + this.limit, at.y + this.limit);
    const minZ = this.zOrder(at.x - this.limit, at.y - this.limit);
    const limit2 = this.limit * this.limit;
    let best = Infinity;
    let out: V | null = null;
    const consider = (p: V) => {
      const di = Math.abs(p.i - at.i);
      const d2 = (p.x - at.x) ** 2 + (p.y - at.y) ** 2;
      if (di > 1 && d2 < limit2 && d2 < best && d2 > 0 && this.locallyInside(p, at) && this.substantial(p, at) && this.substantial(at, p)) {
        best = d2;
        out = p;
      }
    };
    for (let p = at.nextZ; p && p.z <= maxZ; p = p.nextZ) consider(p);
    for (let p = at.prevZ; p && p.z >= minZ; p = p.prevZ) consider(p);
    return out;
  }
}

export interface ConnectionWidthViolation {
  type: "connection_width";
  message: string;
  at: Point;
  layer: string;
  items: BoardViolation["items"];
  actual: number;
  required: number;
}

/** KiCad's slack: DRC epsilon, the board's arc error and the fill's extra margin, on each side of a neck. */
const epsilonMm = (maxError: number) => 2 * (0.0005 + maxError + 0.0005);

export function checkConnectionWidth(board: Board, rules: DesignRules, items: CopperItem[] = copperItems(board)): ConnectionWidthViolation[] {
  const custom = rules.custom ?? [];
  const boardMin = rules.minConnection ?? 0;
  const widths = new Set<number>();
  if (boardMin > 0) widths.add(boardMin);
  for (const r of custom) for (const c of r.constraints) if (c.type === "connection_width" && c.min) widths.add(c.min);
  const eps = epsilonMm(rules.maxError ?? 0.005);
  const run = [...widths].filter((w) => w - eps > 0);
  if (!run.length) return [];
  const nets = new Set(board.nets);
  // The copper KiCad's check merges (no graphics); at a neck it hit-tests copper graphics too.
  const copper = items.filter((it) => it.item.kind === "pad" || it.item.kind === "track" || it.item.kind === "via" || it.item.kind === "zone");
  const inPoly = (p: Point, poly: Point[]) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  const ruleItem = (it: CopperItem, at: Point): RuleItem => ({
    type: it.item.kind === "pad" ? "Pad" : it.item.kind === "via" ? "Via" : it.item.kind === "zone" ? "Zone" : it.item.kind === "graphic" ? "Graphic" : "Track",
    netName: it.item.net,
    netClass: netClassOf(rules, it.item.net).name,
    reference: it.item.reference,
    layer: it.ruleLayer,
    layers: it.layers,
    hasNet: (n) => nets.has(n),
    // An area condition is tested at the neck.
    intersectsArea: (name) => board.zones.some((z) => z.name === name && z.outline.length >= 3 && inPoly(at, z.outline)),
  });
  /** The width the items at a neck must keep: KiCad evaluates the rules for the first two items found there. */
  const required = (near: CopperItem[], layer: string, at: Point): { min: number; name: string } => {
    if (custom.length) {
      const c = customConstraint(custom, "connection_width", ruleItem(near[0]!, at), layer, near[1] && ruleItem(near[1], at));
      if (c?.min !== undefined) return { min: c.min, name: c.rule };
    }
    return { min: boardMin, name: "board setup constraints" };
  };
  const arcs = new Map(board.tracks.filter((t) => t.kind === "arc" && t.mid && t.uuid).map((t) => [t.uuid!, { start: t.start, mid: t.mid!, end: t.end, width: t.width }]));
  const out: ConnectionWidthViolation[] = [];
  // KiCad names the layer as the board does (its user name, when it has one).
  const shown = (layer: string) => board.layers.find((l) => l.name === layer)?.userName ?? layer;
  for (const layer of board.copperLayers) {
    const onLayer = items.filter((it) => it.layers.has(layer));
    const byNet = new Map<string, CopperItem[]>();
    for (const it of copper) if (it.layers.has(layer)) (byNet.get(it.item.net) ?? byNet.set(it.item.net, []).get(it.item.net)!).push(it);
    for (const [, list] of byNet) {
      // Arc tracks outlined from their arc, as KiCad does; everything else from its shapes.
      const outlines = fracturedCopper(list.map((it) => (it.item.kind === "track" && arcs.get(it.item.uuid ?? "")) || (it.shapes as Shape[])));
      for (const minWidth of run) {
        const finder = new NeckFinder(Math.round((minWidth - eps) * 1e6));
        for (const outline of outlines) {
          const nm = outline.map((p) => ({ x: Math.round(p.x * 1e6), y: Math.round(p.y * 1e6) }));
          for (const [a, b] of finder.findPairs(nm)) {
            const A = outline[a]!, B = outline[b]!;
            const at = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
            const dist = Math.hypot(nm[a]!.x - nm[b]!.x, nm[a]!.y - nm[b]!.y) / 1e6;
            const here: Shape = { kind: "seg", a: at, b: at, r: 0 };
            // KiCad hit-tests every item on the layer there, whatever its net.
            const near = onLayer.filter((it) => it.box.x0 - minWidth <= at.x && at.x <= it.box.x1 + minWidth && it.box.y0 - minWidth <= at.y && at.y <= it.box.y1 + minWidth && it.shapes.some((s) => shapeDistance(s as Shape, here, minWidth + 1).dist <= minWidth));
            // KiCad lists zones after the other items.
            near.sort((p, q) => Number(p.item.kind === "zone") - Number(q.item.kind === "zone"));
            if (!near.length) continue;
            const c = required(near, layer, at);
            if (Math.abs(c.min - minWidth) > 1e-9) continue;
            out.push({
              type: "connection_width",
              message: `Copper connection too narrow (${c.name} minimum connection width ${minWidth.toFixed(4)} mm; actual ${dist.toFixed(4)} mm) (${shown(layer)})`,
              at,
              layer,
              items: near.map((it) => it.item),
              actual: dist,
              required: minWidth,
            });
          }
        }
      }
    }
  }
  return out;
}

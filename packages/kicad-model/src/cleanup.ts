/**
 * Cleanup Tracks & Vias (KiCad's board cleanup), as a plan the app applies in one edit:
 * - redundant vias: a second via at the same place (same type and layers), or a via in a
 *   through-hole pad of its net (the pad already joins every layer);
 * - zero-length and duplicate segments;
 * - collinear segments of the same net, layer and width joined end to end with nothing else
 *   at the joint (a different-width track at either end keeps a neck-down as it is);
 * - tracks wholly inside one pad;
 * - dangling tracks (an end that touches nothing of its net) and vias connected on one layer
 *   only, repeatedly, since removing one can leave another dangling.
 * Locked items are left alone. Follows KiCad 10's TRACKS_CLEANER and connectivity tests.
 */
import { flashChecker, type Board, type Pad, type Track, type Via } from "./board.js";
import type { Point } from "./geometry.js";
import { onLayer, viaSpan } from "./fab.js";
import { padPolygons } from "./zone-fill.js";

export interface CleanupOptions {
  vias?: boolean;
  merge?: boolean;
  dangling?: boolean;
  danglingVias?: boolean;
  inPads?: boolean;
}

export type CleanupKind = "redundant via" | "zero-length track" | "duplicate track" | "merged tracks" | "track in pad" | "dangling track" | "dangling via";

export interface CleanupPlan {
  /** UUIDs of tracks and vias to delete. */
  remove: string[];
  /** Tracks that become longer (the merges): their new ends. */
  reshape: Array<{ uuid: string; start: Point; end: Point }>;
  /** What was found, for the dialog. */
  items: Array<{ kind: CleanupKind; uuids: string[]; at: Point; net: string }>;
}

const EPS = 1e-6;
const same = (a: Point, b: Point) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function inPoly(p: Point, polys: Point[][]): boolean {
  let inside = false;
  for (const poly of polys)
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  return inside;
}
/** Distance from p to a set of outlines (0 inside). */
function polyDist(p: Point, polys: Point[][]): number {
  if (inPoly(p, polys)) return 0;
  let d = Infinity;
  for (const poly of polys) for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i]!, poly[(i + 1) % poly.length]!));
  return d;
}
/** How far inside the outline p is (negative outside). */
function depth(p: Point, polys: Point[][]): number {
  let d = Infinity;
  for (const poly of polys) for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i]!, poly[(i + 1) % poly.length]!));
  return inPoly(p, polys) ? d : -d;
}
/** Distance from p to the infinite line through a and b. */
const lineDist = (p: Point, a: Point, b: Point) => {
  const l = dist(a, b);
  return l < EPS ? dist(p, a) : Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / l;
};
/** Do two straight tracks lie on one line (within a micron)? */
const collinear = (a: Track, b: Track) => lineDist(b.start, a.start, a.end) < 1e-3 && lineDist(b.end, a.start, a.end) < 1e-3;

/**
 * A fill outline's edges in 1 mm rows and cells, so "how far is p from this pour" looks at the
 * edges near p (and the ones its row crosses, for inside/outside), not all of them.
 */
function edgeIndex(poly: Point[]) {
  const C = 1;
  const rows = new Map<number, number[]>();
  const cells = new Map<string, number[]>();
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    for (let r = Math.floor(Math.min(a.y, b.y) / C); r <= Math.floor(Math.max(a.y, b.y) / C); r++) {
      (rows.get(r) ?? rows.set(r, []).get(r)!).push(i);
      for (let c = Math.floor(Math.min(a.x, b.x) / C); c <= Math.floor(Math.max(a.x, b.x) / C); c++) (cells.get(`${c},${r}`) ?? cells.set(`${c},${r}`, []).get(`${c},${r}`)!).push(i);
    }
  }
  const edge = (i: number) => [poly[i]!, poly[(i + 1) % poly.length]!] as const;
  const inside = (p: Point) => {
    let inn = false;
    for (const i of rows.get(Math.floor(p.y / C)) ?? []) {
      const [a, b] = edge(i);
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inn = !inn;
    }
    return inn;
  };
  return {
    /** Distance from p to the pour (0 inside), exact up to `within` (else ≥ within, maybe Infinity). */
    dist(p: Point, within: number): number {
      if (inside(p)) return 0;
      const reach = Number.isFinite(within) ? Math.ceil(within / C) + 1 : Infinity;
      let d = Infinity;
      if (!Number.isFinite(reach)) {
        for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, ...edge(i)));
        return d;
      }
      const cx = Math.floor(p.x / C), cy = Math.floor(p.y / C);
      for (let x = cx - reach; x <= cx + reach; x++) for (let y = cy - reach; y <= cy + reach; y++) for (const i of cells.get(`${x},${y}`) ?? []) d = Math.min(d, segDist(p, ...edge(i)));
      return d;
    },
  };
}

export function planCleanup(board: Board, o: CleanupOptions = {}): CleanupPlan {
  const opt = { vias: true, merge: true, dangling: true, danglingVias: true, inPads: true, ...o };
  const plan: CleanupPlan = { remove: [], reshape: [], items: [] };
  const dead = new Set<string>();
  const tracks: Track[] = board.tracks.map((t) => ({ ...t }));
  const vias: Via[] = board.vias;
  const flashChecks = flashChecker(board);
  /** Copper of the pad on this layer (it's on the layer, and flashed there). */
  const flashed = (pad: Pad, layer: string) => onLayer(pad.layers, layer) && flashChecks(pad, layer);
  const pads: Array<{ pad: Pad; polys: Point[][] }> = board.footprints.flatMap((f) => f.pads.filter((p) => p.net).map((pad) => ({ pad, polys: padPolygons(pad, 0) })));
  const fills = board.zones.filter((z) => !z.keepout && z.net).flatMap((z) =>
    z.fills.map((f) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of f.points) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      return { net: z.net, layer: f.layer, poly: f.points, box: [x0, y0, x1, y1] as const, index: edgeIndex(f.points) };
    }),
  );
  const kill = (uuid: string) => {
    dead.add(uuid);
    plan.remove.push(uuid);
  };
  const spans = new Map<Via, [number, number]>();
  const layerIndex = new Map(board.copperLayers.map((l, i) => [l, i]));
  const viaOn = (v: Via, layer: string) => {
    let sp = spans.get(v);
    if (!sp) spans.set(v, (sp = viaSpan(board, v).map((l) => layerIndex.get(l)!) as [number, number]));
    const i = layerIndex.get(layer)!;
    return i >= sp[0] && i <= sp[1];
  };
  const live = () => tracks.filter((t) => !dead.has(t.uuid));
  const liveVias = () => vias.filter((v) => !dead.has(v.uuid));
  // Everything by net: each test only looks at its own net's copper.
  const group = <T,>(xs: T[], net: (x: T) => string) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(net(x), [...(m.get(net(x)) ?? []), x]);
    return m;
  };
  const tracksOf = group(tracks, (t) => t.net);
  // Tracks in a 1 mm grid per net and layer (a track goes in every cell its outline reaches).
  const CELL = 1;
  const grid = new Map<string, Set<Track>>();
  const cells = (net: string, layer: string, x0: number, y0: number, x1: number, y1: number) => {
    const out: string[] = [];
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) out.push(`${net}|${layer}|${cx},${cy}`);
    return out;
  };
  const index = (t: Track) => {
    const w = t.width / 2;
    for (const k of cells(t.net, t.layer, Math.min(t.start.x, t.end.x) - w, Math.min(t.start.y, t.end.y) - w, Math.max(t.start.x, t.end.x) + w, Math.max(t.start.y, t.end.y) + w)) (grid.get(k) ?? grid.set(k, new Set()).get(k)!).add(t);
  };
  for (const t of tracks) index(t);
  // Vias and pads in the same kind of grid, per net.
  const vgrid = new Map<string, Via[]>();
  const pgrid = new Map<string, Array<{ pad: Pad; polys: Point[][] }>>();
  const ckey = (net: string, x: number, y: number) => `${net}|${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  for (const v of vias) {
    const r = v.size / 2;
    for (let cx = Math.floor((v.at.x - r) / CELL); cx <= Math.floor((v.at.x + r) / CELL); cx++)
      for (let cy = Math.floor((v.at.y - r) / CELL); cy <= Math.floor((v.at.y + r) / CELL); cy++) {
        const k = `${v.net}|${cx},${cy}`;
        (vgrid.get(k) ?? vgrid.set(k, []).get(k)!).push(v);
      }
  }
  for (const e of pads) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of e.polys) for (const q of poly) (x0 = Math.min(x0, q.x)), (y0 = Math.min(y0, q.y)), (x1 = Math.max(x1, q.x)), (y1 = Math.max(y1, q.y));
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const k = `${e.pad.net}|${cx},${cy}`;
        (pgrid.get(k) ?? pgrid.set(k, []).get(k)!).push(e);
      }
  }
  const around = <T,>(g: Map<string, T[]>, net: string, p: Point, r: number) => {
    const out = new Set<T>();
    for (let cx = Math.floor((p.x - r) / CELL); cx <= Math.floor((p.x + r) / CELL); cx++) for (let cy = Math.floor((p.y - r) / CELL); cy <= Math.floor((p.y + r) / CELL); cy++) for (const x of g.get(`${net}|${cx},${cy}`) ?? []) out.add(x);
    return out;
  };
  void ckey;
  /** Live tracks of a net on a layer whose outlines may come within r of p. */
  const near = (p: Point, r: number, net: string, layer: string) => {
    const out = new Set<Track>();
    for (const k of cells(net, layer, p.x - r, p.y - r, p.x + r, p.y + r)) for (const t of grid.get(k) ?? []) if (!dead.has(t.uuid)) out.add(t);
    return out;
  };
  const viasOf = group(vias, (v) => v.net);
  const padsOf = group(pads, (p) => p.pad.net);
  const fillsOf = group(fills, (f) => f.net);

  // Redundant vias.
  if (opt.vias) {
    const all = board.copperLayers;
    for (const [i, v] of vias.entries()) {
      if (v.locked || dead.has(v.uuid)) continue;
      const twin = (viasOf.get(v.net) ?? []).filter((w) => vias.indexOf(w) < i).find((w) => !dead.has(w.uuid) && same(w.at, v.at) && (w.type ?? "through") === (v.type ?? "through") && viaSpan(board, w).join() === viaSpan(board, v).join());
      const inPad = (padsOf.get(v.net) ?? []).find(({ pad, polys }) => all.every((l) => onLayer(pad.layers, l)) && pad.type !== "smd" && polyDist(v.at, polys) <= v.size / 2);
      if (twin || inPad) {
        kill(v.uuid);
        plan.items.push({ kind: "redundant via", uuids: [v.uuid], at: v.at, net: v.net });
      }
    }
  }

  // Zero-length and duplicate segments.
  if (opt.merge) {
    for (const t of tracks) if (!t.locked && t.kind !== "arc" && same(t.start, t.end)) {
      kill(t.uuid);
      plan.items.push({ kind: "zero-length track", uuids: [t.uuid], at: t.start, net: t.net });
    }
  }
  {
    const seen = new Set<string>();
    const k = (p: Point) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`;
    for (const t of tracks) {
      if (dead.has(t.uuid) || t.kind === "arc") continue;
      const key = `${t.layer}|${Math.round(t.width * 1e5)}|${[k(t.start), k(t.end)].sort().join("|")}`;
      if (seen.has(key) && !t.locked) {
        kill(t.uuid);
        plan.items.push({ kind: "duplicate track", uuids: [t.uuid], at: t.start, net: t.net });
      } else seen.add(key);
    }
  }

  /** Same-net copper on `layer` touching p within r, other than the tracks in `except`. */
  const touches = (p: Point, r: number, net: string, layer: string, except: Set<string>) => {
    /** Each hit, with its distance from a point (to tell which end of a track it's nearer). */
    const hit: Array<{ kind: "track" | "via" | "pad" | "zone"; id: string; d: (q: Point) => number }> = [];
    for (const u of near(p, r, net, layer)) if (!except.has(u.uuid) && segDist(p, u.start, u.end) <= r + u.width / 2) hit.push({ kind: "track", id: u.uuid, d: (q) => segDist(q, u.start, u.end) });
    for (const v of around(vgrid, net, p, r)) if (!dead.has(v.uuid) && viaOn(v, layer) && dist(p, v.at) <= r + v.size / 2) hit.push({ kind: "via", id: v.uuid, d: (q) => dist(q, v.at) });
    for (const { pad, polys } of around(pgrid, net, p, r)) if (flashed(pad, layer) && polyDist(p, polys) <= r) hit.push({ kind: "pad", id: pad.uuid ?? `${pad.number}@${pad.at.x},${pad.at.y}`, d: (q) => dist(q, pad.at) });
    for (const f of fillsOf.get(net) ?? []) if (f.layer === layer && p.x >= f.box[0] - r && p.y >= f.box[1] - r && p.x <= f.box[2] + r && p.y <= f.box[3] + r && f.index.dist(p, r) <= r) hit.push({ kind: "zone", id: "zone", d: (q) => f.index.dist(q, Infinity) });
    return hit;
  };

  // Merge collinear segments, pass after pass until nothing more merges.
  if (opt.merge)
    for (let changed = true; changed; ) {
      changed = false;
      for (const a of tracks) {
        if (dead.has(a.uuid) || a.locked || a.kind === "arc") continue;
        const neighbours = [...new Set([...near(a.start, 0, a.net, a.layer), ...near(a.end, 0, a.net, a.layer)])].filter((b) => b !== a && b.kind !== "arc" && [a.start, a.end].some((p) => same(p, b.start) || same(p, b.end)));
        // A different-width track at an end: a neck-down, left as it is.
        if (neighbours.some((b) => Math.abs(b.width - a.width) > EPS)) continue;
        for (const b of neighbours) {
          if (b.locked || !collinear(a, b)) continue;
          const joint = [a.start, a.end].find((p) => same(p, b.start) || same(p, b.end))!;
          // Nothing else at the joint (no other track, via, pad or zone of the net).
          if (touches(joint, a.width / 2, a.net, a.layer, new Set([a.uuid, b.uuid])).length) continue;
          const ends = [a.start, a.end, b.start, b.end].filter((p) => !same(p, joint));
          if (ends.length !== 2) continue;
          // They must run on from the joint in opposite directions, not double back.
          if ((ends[0]!.x - joint.x) * (ends[1]!.x - joint.x) + (ends[0]!.y - joint.y) * (ends[1]!.y - joint.y) >= 0) continue;
          a.start = ends[0]!;
          a.end = ends[1]!;
          index(a);
          kill(b.uuid);
          plan.items.push({ kind: "merged tracks", uuids: [a.uuid, b.uuid], at: joint, net: a.net });
          changed = true;
          break;
        }
      }
    }

  // Tracks wholly inside one pad of their net.
  if (opt.inPads)
    for (const t of live()) {
      if (t.locked) continue;
      const pad = (padsOf.get(t.net) ?? []).find(({ pad, polys }) => flashed(pad, t.layer) && depth(t.start, polys) >= t.width / 2 - EPS && depth(t.end, polys) >= t.width / 2 - EPS);
      if (pad) {
        kill(t.uuid);
        plan.items.push({ kind: "track in pad", uuids: [t.uuid], at: t.start, net: t.net });
      }
    }

  // Dangling tracks and vias, until none are left: after a removal only what was near it is checked again.
  if (opt.dangling || opt.danglingVias) {
    const dangling = (t: Track): Point | undefined => {
      const r = t.width / 2;
      const s = touches(t.start, r, t.net, t.layer, new Set([t.uuid]));
      const e = touches(t.end, r, t.net, t.layer, new Set([t.uuid]));
      // A zone under both ends: redundant perhaps, but connected.
      if (s.some((x) => x.kind === "zone") && e.some((x) => x.kind === "zone")) return undefined;
      // An item touching both ends (a short stub over a pad) counts for the nearer end only, as KiCad counts it.
      let starts = 0, ends = 0;
      for (const x of s) {
        if (!e.some((y) => y.id === x.id)) starts++;
        else if (x.d(t.start) < x.d(t.end)) starts++;
        else ends++;
      }
      for (const y of e) if (!s.some((x) => x.id === y.id)) ends++;
      return starts > 0 && ends > 0 ? undefined : starts > 0 ? t.end : t.start;
    };
    const viaDangling = (v: Via) => {
      const layers = new Set<string>();
      for (const l of board.copperLayers) {
        if (!viaOn(v, l)) continue;
        if (touches(v.at, v.size / 2, v.net, l, new Set()).some((x) => x.id !== v.uuid)) layers.add(l);
        if (layers.size >= 2) return false;
      }
      return true;
    };
    let work: Array<Track | Via> = [...(opt.dangling ? live() : []), ...(opt.danglingVias ? liveVias() : [])];
    while (work.length) {
      const next = new Set<Track | Via>();
      for (const x of work) {
        if (dead.has(x.uuid) || x.locked) continue;
        const isVia = "drill" in x;
        let at: Point | undefined;
        if (isVia) {
          if (!opt.danglingVias || !x.net || !viaDangling(x as Via)) continue;
          at = (x as Via).at;
        } else {
          if (!opt.dangling) continue;
          at = dangling(x as Track);
          if (!at) continue;
        }
        kill(x.uuid);
        plan.items.push({ kind: isVia ? "dangling via" : "dangling track", uuids: [x.uuid], at, net: x.net });
        // What touched it may dangle now.
        const pts = isVia ? [(x as Via).at] : [(x as Track).start, (x as Track).end];
        const reach = isVia ? (x as Via).size / 2 : (x as Track).width / 2;
        for (const p of pts) {
          for (const l of board.copperLayers) for (const t of near(p, reach + 1, x.net, l)) next.add(t);
          for (const v of around(vgrid, x.net, p, reach + 1)) next.add(v);
        }
      }
      work = [...next];
    }
  }

  for (const [i, t] of tracks.entries()) {
    const orig = board.tracks[i]!;
    if (!dead.has(t.uuid) && (!same(orig.start, t.start) || !same(orig.end, t.end))) plan.reshape.push({ uuid: t.uuid, start: t.start, end: t.end });
  }
  return plan;
}

/**
 * A small grid router for one connection at a time: A* over a fine grid,
 * avoiding other nets' copper (pads, tracks, vias, copper graphics) by the
 * required clearance plus half the track width, copper text, and the board
 * edge with the copper-to-edge clearance. Moves are the eight grid
 * directions, so paths come out as 0/45/90° segments; turns cost extra so
 * routes stay straight. With more than one layer it may change layers
 * through a via wherever one fits on every layer, at a cost, so it prefers
 * to stay on one layer. Zones are ignored (they are refilled around new
 * tracks), as interactive routers do.
 *
 * Results are checked again with the clearance checker before they are used.
 */
import type { Board, Pad } from "./board.js";
import { copperItems, netClassOf, shapeDistance, trackConflicts, type CopperItem, type DesignRules, type Shape } from "./drc.js";
import type { Point } from "./geometry.js";
import { boardArea } from "./zone-fill.js";
import { netIslands, type CopperAnchor } from "./copper.js";
import { textPen, textStrokes } from "./fab.js";

export interface RouteRequest {
  from: Point;
  to: Point;
  net: string;
  layer: string;
  width: number;
  /** Grid pitch (mm); default 0.1. */
  pitch?: number;
}

export interface MultiLayerRequest {
  from: Point;
  to: Point;
  net: string;
  width: number;
  /** Via size and drill for layer changes. */
  via: { size: number; drill: number };
  /** Layers to use (default: all copper layers). */
  layers?: string[];
  pitch?: number;
  /** Layers the route may start / end on (default: where the net's copper reaches the point). */
  fromLayers?: string[];
  toLayers?: string[];
  /**
   * Skip the final clearance check of the route as drawn (for a pair's
   * centreline, whose coupled tracks the caller checks instead).
   */
  unchecked?: boolean;
  /** Layers that cost more to run on, as a factor of the length: another net's pour, which tracks cut up. */
  costly?: Record<string, number>;
}

export interface MultiLayerRoute {
  runs: Array<{ layer: string; points: Point[] }>;
  vias: Point[];
}

const S = 1e5; // boardArea's clipper scale

interface Grid {
  x0: number;
  y0: number;
  W: number;
  H: number;
  pitch: number;
  outline: Point[][];
}

const gridCache = new WeakMap<Board, Map<number, Grid | undefined>>();
function makeGrid(board: Board, pitch: number): Grid | undefined {
  let m = gridCache.get(board);
  if (!m) gridCache.set(board, (m = new Map()));
  if (!m.has(pitch)) m.set(pitch, buildGrid(board, pitch));
  return m.get(pitch);
}

function buildGrid(board: Board, pitch: number): Grid | undefined {
  const outline = (boardArea(board) ?? []).map((p) => p.map((q) => ({ x: q.X / S, y: q.Y / S })));
  if (!outline.length) return undefined;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of outline.flat()) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const W = Math.ceil((x1 - x0) / pitch) + 1;
  const H = Math.ceil((y1 - y0) / pitch) + 1;
  if (W * H > 4e6) return undefined; // board too large for this simple router
  return { x0, y0, W, H, pitch, outline };
}

/**
 * Cells a copper disc of radius `half` can't be centred on, on one layer:
 * `blocked` (other nets' copper, text, edge) and `hard` (text and edge only,
 * which freeing space around the route's own pads must not undo).
 */
function obstacles(g: Grid, board: Board, rules: DesignRules, items: CopperItem[], net: string, layer: string, half: number): { blocked: Uint8Array; hard: Uint8Array } {
  const { x0, y0, W, H, pitch, outline } = g;
  const cx = (i: number) => x0 + i * pitch;
  const cy = (j: number) => y0 + j * pitch;
  // Enough slack that a straight or diagonal step between two free cells stays clear.
  const slack = pitch * 0.75;
  const blocked = new Uint8Array(W * H);
  const hard = new Uint8Array(W * H);

  // Board edge: outside the outline (scanline fill, even-odd) or too close to an edge segment.
  const edge = (rules.copperEdgeClearance ?? 0) + half + slack;
  const segs = outline.flatMap((poly) => poly.map((a, k) => [a, poly[(k + 1) % poly.length]!] as const));
  for (let j = 0; j < H; j++) {
    const y = cy(j);
    const xs: number[] = [];
    for (const [a, b] of segs) if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    xs.sort((p, q) => p - q);
    let k = 0;
    let inside = false;
    for (let i = 0; i < W; i++) {
      const x = cx(i);
      while (k < xs.length && xs[k]! <= x) {
        inside = !inside;
        k++;
      }
      if (!inside) blocked[j * W + i] = hard[j * W + i] = 1;
    }
  }
  for (const [a, b] of segs) {
    const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - edge - x0) / pitch));
    const i1 = Math.min(W - 1, Math.ceil((Math.max(a.x, b.x) + edge - x0) / pitch));
    const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - edge - y0) / pitch));
    const j1 = Math.min(H - 1, Math.ceil((Math.max(a.y, b.y) + edge - y0) / pitch));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const px = cx(i);
        const py = cy(j);
        const t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
        if (Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)) < edge) blocked[j * W + i] = hard[j * W + i] = 1;
      }
  }

  // Other nets' copper on this layer.
  const myClass = netClassOf(rules, net);
  for (const it of items) {
    if (!it.layers.has(layer) || it.item.kind === "zone") continue;
    if (it.item.net === net && net) continue;
    const other = netClassOf(rules, it.item.net);
    const clr = Math.max(it.override ?? 0, myClass.clearance, other.clearance, rules.minClearance) + half + slack;
    const i0 = Math.max(0, Math.floor((it.box.x0 - clr - x0) / pitch));
    const i1 = Math.min(W - 1, Math.ceil((it.box.x1 + clr - x0) / pitch));
    const j0 = Math.max(0, Math.floor((it.box.y0 - clr - y0) / pitch));
    const j1 = Math.min(H - 1, Math.ceil((it.box.y1 + clr - y0) / pitch));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * W + i;
        if (blocked[k]) continue;
        const probe = { kind: "seg" as const, a: { x: cx(i), y: cy(j) }, b: { x: cx(i), y: cy(j) }, r: 0 };
        if (it.shapes.some((s) => shapeDistance(probe, s, clr).dist < clr)) blocked[k] = 1;
      }
  }

  // Rule areas that keep tracks out on this layer.
  // Hard: making room round a route's own pad must not open the area, or a pad beside it would be
  // left through it.
  for (const z of board.zones)
    if (z.noTracks && onLayer(board, z.layers, layer)) {
      blockArea(g, blocked, z.outline, half);
      blockArea(g, hard, z.outline, half);
    }

  // Drilled holes of other nets (unplated ones too, which have no copper): the hole clearance.
  const hc = rules.holeClearance ?? 0;
  if (hc > 0) {
    const holes: Array<{ at: Point; r: number }> = [];
    for (const fp of board.footprints)
      for (const pad of fp.pads) {
        const d = pad.drillSize ? Math.max(pad.drillSize.x, pad.drillSize.y) : pad.drill;
        if (d && !(pad.net && pad.net === net)) holes.push({ at: pad.at, r: d / 2 });
      }
    for (const v of board.vias) if (!(v.net && v.net === net)) holes.push({ at: v.at, r: v.drill / 2 });
    for (const h of holes) {
      const r = h.r + hc + half + slack;
      for (let j = Math.max(0, Math.floor((h.at.y - r - y0) / pitch)); j <= Math.min(H - 1, Math.ceil((h.at.y + r - y0) / pitch)); j++)
        for (let i = Math.max(0, Math.floor((h.at.x - r - x0) / pitch)); i <= Math.min(W - 1, Math.ceil((h.at.x + r - x0) / pitch)); i++)
          if (Math.hypot(cx(i) - h.at.x, cy(j) - h.at.y) < r) blocked[j * W + i] = 1;
    }
  }

  // Copper text: its whole box (the glyphs are KiCad's, so the box is exact).
  const texts = [...board.texts, ...board.footprints.flatMap((f) => f.texts)].filter((t) => t.layer === layer);
  for (const t of texts) {
    const pts = t.outline?.length ? t.outline.flat() : textStrokes(t).flat();
    if (!pts.length) continue;
    const r = textPen(t) / 2 + Math.max(myClass.clearance, rules.minClearance) + half + slack;
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (const p of pts) {
      bx0 = Math.min(bx0, p.x); bx1 = Math.max(bx1, p.x); by0 = Math.min(by0, p.y); by1 = Math.max(by1, p.y);
    }
    for (let j = Math.max(0, Math.floor((by0 - r - y0) / pitch)); j <= Math.min(H - 1, Math.ceil((by1 + r - y0) / pitch)); j++)
      for (let i = Math.max(0, Math.floor((bx0 - r - x0) / pitch)); i <= Math.min(W - 1, Math.ceil((bx1 + r - x0) / pitch)); i++) blocked[j * W + i] = hard[j * W + i] = 1;
  }
  // Solder-mask openings drawn on this side (exposed copper areas): a track under one would be
  // bared and bridge to whatever else is exposed there, so keep clear of their boxes.
  const maskLayer = layer === "F.Cu" ? "F.Mask" : layer === "B.Cu" ? "B.Mask" : undefined;
  if (maskLayer) {
    const graphics = [...board.drawings, ...board.footprints.flatMap((f) => f.graphics)].filter((gr) => gr.layer === maskLayer);
    for (const gr of graphics) {
      let pts = gr.points;
      if (gr.kind === "circle" && pts.length === 2) {
        const rad = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
        pts = [{ x: pts[0]!.x - rad, y: pts[0]!.y - rad }, { x: pts[0]!.x + rad, y: pts[0]!.y + rad }];
      }
      if (!pts.length) continue;
      const r = gr.width / 2 + Math.max(myClass.clearance, rules.minClearance) + half + slack;
      let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
      for (const p of pts) {
        bx0 = Math.min(bx0, p.x); bx1 = Math.max(bx1, p.x); by0 = Math.min(by0, p.y); by1 = Math.max(by1, p.y);
      }
      for (let j = Math.max(0, Math.floor((by0 - r - y0) / pitch)); j <= Math.min(H - 1, Math.ceil((by1 + r - y0) / pitch)); j++)
        for (let i = Math.max(0, Math.floor((bx0 - r - x0) / pitch)); i <= Math.min(W - 1, Math.ceil((bx1 + r - x0) / pitch)); i++) blocked[j * W + i] = hard[j * W + i] = 1;
    }
  }
  return { blocked, hard };
}

/** Does copper of `net` on `layer` reach point p (so a route on that layer can end there)? */
function reaches(items: CopperItem[], net: string, layer: string, p: Point): boolean {
  return items.some((it) => it.layers.has(layer) && it.item.net === net && it.item.kind !== "zone" && it.shapes.some((sh) => shapeDistance({ kind: "seg", a: p, b: p, r: 0 }, sh, 0.01).dist <= 1e-6));
}

const DIRS: Array<[number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, -1, Math.SQRT2],
];
const TURN = 2.5;

/**
 * A* over (layer, cell, direction). `masks[l]` blocks cells on layer l;
 * `via` (optional) marks cells where a via may sit, costing `viaCost`.
 * Returns the cell path as [layer, cell] pairs.
 */
/** Can the goal be reached from the start at all, moving as the search does (vias where allowed)? */
function reachable(g: Grid, masks: Uint8Array[], via: Uint8Array | undefined, start: { cell: number; layers: number[] }, goal: { cell: number; layers: number[] }): boolean {
  const { W, H } = g;
  const C = W * H;
  const seen = new Uint8Array(C * masks.length);
  const stack: number[] = [];
  for (const l of start.layers) if (!masks[l]![start.cell]) (seen[l * C + start.cell] = 1), stack.push(l * C + start.cell);
  const goals = new Set(goal.layers.map((l) => l * C + goal.cell));
  // A goal that is itself shut (a pad inside a keep-out) is known without flooding the board.
  if (goal.layers.every((l) => masks[l]![goal.cell])) return false;
  while (stack.length) {
    const s = stack.pop()!;
    if (goals.has(s)) return true;
    const l = Math.floor(s / C);
    const c = s - l * C;
    const i = c % W;
    const j = (c - i) / W;
    const mask = masks[l]!;
    for (const [dx, dy] of DIRS) {
      const ni = i + dx;
      const nj = j + dy;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nc = nj * W + ni;
      if (mask[nc] || seen[l * C + nc]) continue;
      if (dx && dy && (mask[j * W + ni] || mask[nj * W + i])) continue;
      seen[l * C + nc] = 1;
      stack.push(l * C + nc);
    }
    if (via && via[c])
      for (let nl = 0; nl < masks.length; nl++) {
        if (nl === l || masks[nl]![c] || seen[nl * C + c]) continue;
        seen[nl * C + c] = 1;
        stack.push(nl * C + c);
      }
  }
  return false;
}

/**
 * The cheapest way from start to goal: A* over (layer, cell, direction), see searchWith. It first
 * tries with the straight-line distance as its guide, which finds an open route at once. When that
 * has looked at QUICK states without arriving (something is in the way: a keep-out, a row of pads),
 * the true distance to the goal round every obstacle is worked out and the search is run again with
 * that as its guide, so it heads straight for the way round.
 */
function search(
  g: Grid,
  masks: Uint8Array[],
  via: Uint8Array | undefined,
  viaCost: number,
  start: { cell: number; layers: number[] },
  goal: { cell: number; layers: number[] },
  /** For a caller that would sooner have no route than wait (routing as the pointer moves): give up after this many states. */
  maxExpanded?: number,
  layerCost?: number[],
): Array<[number, number]> | undefined {
  // A flood fill first (no directions, no costs): an unreachable goal is found out cheaply.
  if (!reachable(g, masks, via, start, goal)) return undefined;
  if (maxExpanded !== undefined) {
    const within = searchWith(g, masks, via, viaCost, start, goal, layerCost, undefined, maxExpanded);
    return within === "capped" ? undefined : within;
  }
  const quick = searchWith(g, masks, via, viaCost, start, goal, layerCost, undefined, QUICK);
  if (quick !== "capped") return quick;
  const map = distanceToGoal(g, masks, via, viaCost, goal, layerCost);
  const informed = searchWith(g, masks, via, viaCost, start, goal, layerCost, map, 8 * g.W * g.H * masks.length);
  return informed === "capped" ? undefined : informed;
}

/** States the first, straight-line-guided search may look at before the informed one takes over. */
const QUICK = 60_000;

/**
 * The cost of the cheapest way to the goal from every (layer, cell), without the cost of turns:
 * Dijkstra outwards from the goal. Never more than the real cost, so A* guided by it stays exact.
 */
function distanceToGoal(g: Grid, masks: Uint8Array[], via: Uint8Array | undefined, viaCost: number, goal: { cell: number; layers: number[] }, layerCost?: number[]): Float64Array {
  const { W, H } = g;
  const C = W * H;
  const L = masks.length;
  // In full precision: a distance rounded down on the way into the array would look stale when it comes off the heap.
  const dist = new Float64Array(C * L).fill(Infinity);
  const heapF: number[] = [];
  const heapS: number[] = [];
  const push = (f: number, st: number) => {
    heapF.push(f);
    heapS.push(st);
    let n = heapF.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (heapF[p]! <= heapF[n]!) break;
      [heapF[p], heapF[n]] = [heapF[n]!, heapF[p]!];
      [heapS[p], heapS[n]] = [heapS[n]!, heapS[p]!];
      n = p;
    }
  };
  const pop = (): [number, number] => {
    const top: [number, number] = [heapF[0]!, heapS[0]!];
    const lf = heapF.pop()!;
    const ls = heapS.pop()!;
    if (heapF.length) {
      heapF[0] = lf;
      heapS[0] = ls;
      let n = 0;
      for (;;) {
        const l = 2 * n + 1;
        const r = l + 1;
        let m = n;
        if (l < heapF.length && heapF[l]! < heapF[m]!) m = l;
        if (r < heapF.length && heapF[r]! < heapF[m]!) m = r;
        if (m === n) break;
        [heapF[m], heapF[n]] = [heapF[n]!, heapF[m]!];
        [heapS[m], heapS[n]] = [heapS[n]!, heapS[m]!];
        n = m;
      }
    }
    return top;
  };
  for (const l of goal.layers) {
    if (masks[l]![goal.cell]) continue;
    dist[l * C + goal.cell] = 0;
    push(0, l * C + goal.cell);
  }
  while (heapF.length) {
    const [d, s] = pop();
    if (d > dist[s]!) continue;
    const l = Math.floor(s / C);
    const c = s - l * C;
    const i = c % W;
    const j = (c - i) / W;
    const mask = masks[l]!;
    const dear = layerCost?.[l] ?? 1;
    for (const [dx, dy, step] of DIRS) {
      const ni = i + dx;
      const nj = j + dy;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nc = nj * W + ni;
      if (mask[nc]) continue;
      if (dx && dy && (mask[j * W + ni] || mask[nj * W + i])) continue;
      const nd = d + step * dear;
      if (nd < dist[l * C + nc]!) {
        dist[l * C + nc] = nd;
        push(nd, l * C + nc);
      }
    }
    if (via && via[c])
      for (let nl = 0; nl < L; nl++) {
        if (nl === l || masks[nl]![c]) continue;
        const nd = d + viaCost;
        if (nd < dist[nl * C + c]!) {
          dist[nl * C + c] = nd;
          push(nd, nl * C + c);
        }
      }
  }
  return dist;
}

function searchWith(
  g: Grid,
  masks: Uint8Array[],
  via: Uint8Array | undefined,
  viaCost: number,
  start: { cell: number; layers: number[] },
  goal: { cell: number; layers: number[] },
  layerCost: number[] | undefined,
  /** The exact distance to the goal per (layer, cell), when it has been worked out; else the straight-line estimate is used. */
  toGoal: Float64Array | undefined,
  /** Give up after this many states (and say so), to try again better informed. */
  cap: number,
): Array<[number, number]> | undefined | "capped" {
  const { W, H } = g;
  const C = W * H;
  const L = masks.length;
  const N = C * L * 8;
  const gs = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const ti = goal.cell % W;
  const tj = Math.floor(goal.cell / W);
  const h = (l: number, c: number) => {
    if (toGoal) return toGoal[l * C + c]!;
    const dx = Math.abs((c % W) - ti);
    const dy = Math.abs(Math.floor(c / W) - tj);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  const heapF: number[] = [];
  const heapS: number[] = [];
  const push = (f: number, st: number) => {
    heapF.push(f);
    heapS.push(st);
    let n = heapF.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (heapF[p]! <= heapF[n]!) break;
      [heapF[p], heapF[n]] = [heapF[n]!, heapF[p]!];
      [heapS[p], heapS[n]] = [heapS[n]!, heapS[p]!];
      n = p;
    }
  };
  const pop = (): number => {
    const top = heapS[0]!;
    const lf = heapF.pop()!;
    const ls = heapS.pop()!;
    if (heapF.length) {
      heapF[0] = lf;
      heapS[0] = ls;
      let n = 0;
      for (;;) {
        const l = 2 * n + 1;
        const r = l + 1;
        let m = n;
        if (l < heapF.length && heapF[l]! < heapF[m]!) m = l;
        if (r < heapF.length && heapF[r]! < heapF[m]!) m = r;
        if (m === n) break;
        [heapF[m], heapF[n]] = [heapF[n]!, heapF[m]!];
        [heapS[m], heapS[n]] = [heapS[n]!, heapS[m]!];
        n = m;
      }
    }
    return top;
  };
  const state = (l: number, c: number, d: number) => (l * C + c) * 8 + d;
  for (const l of start.layers) {
    if (masks[l]![start.cell]) continue;
    for (let d = 0; d < 8; d++) {
      gs[state(l, start.cell, d)] = 0;
      push(h(l, start.cell), state(l, start.cell, d));
    }
  }
  const goalLayers = new Set(goal.layers);
  let found = -1;
  let expanded = 0;
  while (heapF.length) {
    const st = pop();
    const d = st % 8;
    const lc = (st - d) / 8;
    const l = Math.floor(lc / C);
    const c = lc % C;
    if (c === goal.cell && goalLayers.has(l)) {
      found = st;
      break;
    }
    if (++expanded > cap) return "capped";
    const base = gs[st]!;
    const i = c % W;
    const j = Math.floor(c / W);
    const mask = masks[l]!;
    const dear = layerCost?.[l] ?? 1;
    for (let nd = 0; nd < 8; nd++) {
      const [dx, dy, step] = DIRS[nd]!;
      const cost = step * dear;
      const ni = i + dx;
      const nj = j + dy;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nc = nj * W + ni;
      if (mask[nc]) continue;
      // No squeezing diagonally between two blocked cells.
      if (dx && dy && (mask[j * W + ni] || mask[nj * W + i])) continue;
      const ng = base + cost + (nd === d ? 0 : TURN);
      const ns = state(l, nc, nd);
      if (ng < gs[ns]!) {
        gs[ns] = ng;
        came[ns] = st;
        push(ng + h(l, nc), ns);
      }
    }
    // Change layers through a via here.
    if (via && via[c]) {
      for (let nl = 0; nl < L; nl++) {
        if (nl === l || masks[nl]![c]) continue;
        const ns = state(nl, c, d);
        const ng = base + viaCost;
        if (ng < gs[ns]!) {
          gs[ns] = ng;
          came[ns] = st;
          push(ng + h(nl, c), ns);
        }
      }
    }
  }
  if (found < 0) return undefined;
  const out: Array<[number, number]> = [];
  for (let st = found; st >= 0; st = came[st]!) {
    const lc = Math.floor(st / 8);
    out.push([Math.floor(lc / C), lc % C]);
  }
  return out.reverse();
}

/** Corners of a cell path on one layer, with exact end points. */
function corners(g: Grid, cells: number[], from: Point, to: Point): Point[] {
  const pt = (c: number) => ({ x: g.x0 + (c % g.W) * g.pitch, y: g.y0 + Math.floor(c / g.W) * g.pitch });
  const raw = [from, ...cells.slice(1, -1).map(pt), to].filter((p, k, a) => k === 0 || Math.hypot(p.x - a[k - 1]!.x, p.y - a[k - 1]!.y) > 1e-9);
  const out: Point[] = [raw[0]!];
  for (let k = 1; k < raw.length - 1; k++) {
    const a = out[out.length - 1]!;
    const b = raw[k]!;
    const c = raw[k + 1]!;
    if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) > 1e-9) out.push(b);
  }
  if (raw.length > 1) out.push(raw[raw.length - 1]!);
  return out;
}

/** Free a small disc around a route end so it can leave its own pad (text and edge stay blocked). */
/**
 * Obstacle maps for one set of copper items, kept while that set is in use (Route all tries many
 * connections, stubs and layers against the same copper): treat the result as read-only.
 */
const obstacleCache = new WeakMap<CopperItem[], Map<string, { blocked: Uint8Array; hard: Uint8Array }>>();
function cachedObstacles(g: Grid, board: Board, rules: DesignRules, items: CopperItem[], net: string, layer: string, half: number) {
  let m = obstacleCache.get(items);
  if (!m) obstacleCache.set(items, (m = new Map()));
  const key = `${net}\0${layer}\0${half}\0${g.pitch}\0${g.x0},${g.y0},${g.W},${g.H}`;
  let o = m.get(key);
  if (!o) m.set(key, (o = obstacles(g, board, rules, items, net, layer, half)));
  return o;
}

function freeAround(g: Grid, m: { blocked: Uint8Array; hard: Uint8Array }, cell: number, half: number) {
  const r = Math.ceil((half + g.pitch) / g.pitch);
  const ci = cell % g.W;
  const cj = Math.floor(cell / g.W);
  for (let dj = -r; dj <= r; dj++)
    for (let di = -r; di <= r; di++) {
      const i = ci + di;
      const j = cj + dj;
      if (di * di + dj * dj <= r * r && i >= 0 && j >= 0 && i < g.W && j < g.H && !m.hard[j * g.W + i]) m.blocked[j * g.W + i] = 0;
    }
}

const cellOf = (g: Grid, p: Point) => {
  const i = Math.round((p.x - g.x0) / g.pitch);
  const j = Math.round((p.y - g.y0) / g.pitch);
  return i < 0 || j < 0 || i >= g.W || j >= g.H ? -1 : j * g.W + i;
};

/** A route from `from` to `to` on one layer, as track vertices, or undefined when there is no clear path. */
export function routeConnection(board: Board, rules: DesignRules, req: RouteRequest, items: CopperItem[] = copperItems(board)): Point[] | undefined {
  const r = routeWithVias(board, rules, { from: req.from, to: req.to, net: req.net, width: req.width, via: { size: 0, drill: 0 }, layers: [req.layer], pitch: req.pitch }, items, false);
  return r?.runs[0]?.points;
}

/**
 * A route over any of the copper layers, changing layers through vias where
 * it has to. Undefined when there is no clear path.
 */
export function routeWithVias(board: Board, rules: DesignRules, req: MultiLayerRequest, items: CopperItem[] = copperItems(board), allowVias = true): MultiLayerRoute | undefined {
  const g = makeGrid(board, req.pitch ?? 0.1);
  if (!g) return undefined;
  const layers = req.layers ?? board.copperLayers;
  const half = req.width / 2;
  const s = cellOf(g, req.from);
  const t = cellOf(g, req.to);
  if (s < 0 || t < 0) return undefined;
  const startLayers = layers.map((l, k) => ((req.fromLayers ? req.fromLayers.includes(l) : reaches(items, req.net, l, req.from)) ? k : -1)).filter((k) => k >= 0);
  const goalLayers = layers.map((l, k) => ((req.toLayers ? req.toLayers.includes(l) : reaches(items, req.net, l, req.to)) ? k : -1)).filter((k) => k >= 0);
  if (!startLayers.length || !goalLayers.length) return undefined;
  const masks = layers.map((l) => {
    const c = cachedObstacles(g, board, rules, items, req.net, l, half);
    const m = { blocked: c.blocked.slice(), hard: c.hard };
    freeAround(g, m, s, half);
    freeAround(g, m, t, half);
    return m.blocked;
  });
  let via: Uint8Array | undefined;
  if (allowVias && layers.length > 1 && req.via.size > 0) {
    // A via fits where its pad clears other nets' copper on every layer.
    via = new Uint8Array(g.W * g.H).fill(1);
    for (const l of layers) {
      const m = cachedObstacles(g, board, rules, items, req.net, l, req.via.size / 2);
      for (let k = 0; k < via.length; k++) if (m.blocked[k]) via[k] = 0;
    }
  }
  const at = (c: number) => ({ x: g.x0 + (c % g.W) * g.pitch, y: g.y0 + Math.floor(c / g.W) * g.pitch });
  // No via where its hole would be too close to another hole. Copper clearance already keeps other
  // nets' holes away; this is for holes of the same net: its through-hole pads, and the vias of
  // routes made before this one (which are in `items`, not on the board yet).
  const madeVias = viaHoles(rules, items);
  const noViaNear = (hole: { at: Point; r: number }) => {
    if (!via) return;
    const reach = hole.r + req.via.drill / 2 + (rules.minHoleToHole ?? 0.25);
    const n = Math.ceil(reach / g.pitch);
    const cx = Math.round((hole.at.x - g.x0) / g.pitch), cy = Math.round((hole.at.y - g.y0) / g.pitch);
    for (let y = Math.max(0, cy - n); y <= Math.min(g.H - 1, cy + n); y++)
      for (let x = Math.max(0, cx - n); x <= Math.min(g.W - 1, cx + n); x++) {
        const p = at(y * g.W + x);
        if (Math.hypot(p.x - hole.at.x, p.y - hole.at.y) < reach - 1e-9) via[y * g.W + x] = 0;
      }
  };
  if (via) for (const h of [...drilledHoles(board), ...madeVias]) noViaNear(h);
  // Nor in a rule area that keeps vias out (a via is on every layer, so any layer of the area counts).
  if (via) {
    const off = new Uint8Array(via.length);
    for (const z of board.zones) if (z.noVias) blockArea(g, off, z.outline, req.via.size / 2);
    for (let k = 0; k < via.length; k++) if (off[k]) via[k] = 0;
  }

  let runs: MultiLayerRoute["runs"] = [];
  let vias: Point[] = [];
  // Two vias of one route can still end up too close to each other: the second is then ruled out and the search run again.
  for (let tries = 0; ; tries++) {
    const path = search(g, masks, via, 25, { cell: s, layers: startLayers }, { cell: t, layers: goalLayers }, undefined, req.costly && layers.map((l) => req.costly![l] ?? 1));
    if (!path) return undefined;
    // Split into runs at layer changes; each change is a via.
    runs = [];
    vias = [];
    let cur: number[] = [path[0]![1]];
    let layer = path[0]![0];
    let runStart = req.from;
    for (let k = 1; k < path.length; k++) {
      const [l, c] = path[k]!;
      if (l !== layer) {
        const v = at(c);
        runs.push({ layer: layers[layer]!, points: corners(g, cur, runStart, v) });
        vias.push(v);
        runStart = v;
        cur = [c];
        layer = l;
      } else cur.push(c);
    }
    runs.push({ layer: layers[layer]!, points: corners(g, cur, runStart, req.to) });
    const close = vias.findIndex((v, k) => !holesClear({ footprints: [], vias: [] }, rules, v, req.via, vias.slice(0, k)));
    if (close < 0 || tries >= 8) break;
    for (const v of vias.slice(0, close)) noViaNear({ at: v, r: req.via.drill / 2 });
  }

  if (req.unchecked) return { runs: runs.filter((r) => r.points.length > 1), vias };
  // Final check with the clearance checker (zones excluded: they are refilled around the route).
  const solid = items.filter((it) => it.item.kind !== "zone");
  for (const run of runs) cutCorners(board, rules, items, solid, run, req.width, req.net);
  for (const run of runs)
    for (let k = 1; k < run.points.length; k++) {
      if (trackConflicts(solid, rules, { a: run.points[k - 1]!, b: run.points[k]!, width: req.width, layer: run.layer, net: req.net }).length) return undefined;
      if (!trackClearsHoles(board, rules, run.points[k - 1]!, run.points[k]!, req.width, req.net) || inNoTrackArea(board, run.points[k - 1]!, run.points[k]!, req.width, run.layer)) return undefined;
    }
  for (const v of vias) {
    for (const l of layers) if (trackConflicts(solid, rules, { a: v, b: v, width: req.via.size, layer: l, net: req.net }).length) return undefined;
    if (!holesClear(board, rules, v, req.via, vias.filter((o) => o !== v), madeVias)) return undefined;
  }
  return { runs: runs.filter((r) => r.points.length > 1), vias };
}

/**
 * One connection as "Route all" does it: on one layer (the front first), else through vias. A pad
 * too fine-pitched for the grid (a USB-C contact, a QFP pin between its neighbours) first gets a
 * straight fan-out stub along its length, away from its part, checked exactly; the grid route
 * starts from the stub's end. When the two nearest pads can't be joined, other pads of the same
 * two pieces of copper are tried.
 */
export function autorouteConnection(board: Board, rules: DesignRules, c: { from: Point; to: Point; net: string }, items: CopperItem[] = copperItems(board), alternates = true): MultiLayerRoute | undefined {
  const cls = netClassOf(rules, c.net);
  const width = cls.trackWidth;
  const via = { size: cls.viaDiameter, drill: cls.viaDrill };
  // Another net's plane layer is no place for tracks (they'd cut it up); vias may pass through it.
  const usable = routingLayers(board, c.net);
  const front = [...usable].sort((a, b) => (a === "F.Cu" ? -1 : b === "F.Cu" ? 1 : 0));
  // A route that needs both sides keeps its length on another net's pour short.
  const costly = Object.fromEntries(pouredLayers(board, c.net).map((l) => [l, POUR_COST]));
  // What a route costs, as the search counts it: its length (dearer on a pour), and some 6 mm a via.
  const price = (r: MultiLayerRoute) => r.runs.reduce((s, run) => s + (costly[run.layer] ?? 1) * run.points.slice(1).reduce((t, p, k) => t + Math.hypot(p.x - run.points[k]!.x, p.y - run.points[k]!.y), 0), 0) + 6 * r.vias.length;
  const attempt = (from: Point, to: Point, fromLayers?: string[], toLayers?: string[]) => {
    let single: MultiLayerRoute | undefined;
    for (const layer of front) {
      if ((fromLayers && !fromLayers.includes(layer)) || (toLayers && !toLayers.includes(layer))) continue;
      single = routeWithVias(board, rules, { from, to, net: c.net, width, via, layers: [layer], fromLayers, toLayers }, items, false);
      if (single) break;
    }
    // One layer is enough when the route is fairly direct. A long way round on one layer is compared
    // with changing layers to get past what is in the way.
    if (single && price(single) <= 1.5 * Math.hypot(from.x - to.x, from.y - to.y) + 4) return single;
    const both = routeWithVias(board, rules, { from, to, net: c.net, width, via, layers: usable, fromLayers, toLayers, costly }, items);
    return single && (!both || price(single) <= price(both)) ? single : both;
  };
  const between = (from: Point, to: Point) => {
    const direct = attempt(from, to);
    if (direct) return direct;
    const as = padStubs(board, rules, items, from, c.net, width);
    const bs = padStubs(board, rules, items, to, c.net, width);
    const combos: Array<[Stub | undefined, Stub | undefined]> = [...as.map((a): [Stub, undefined] => [a, undefined]), ...bs.map((b): [undefined, Stub] => [undefined, b]), ...as.flatMap((a) => bs.map((b): [Stub, Stub] => [a, b]))];
    for (const [sa, sb] of combos) {
      const r = attempt(sa?.end ?? from, sb?.end ?? to, sa && [sa.layer], sb && [sb.layer]);
      if (!r?.runs.length) continue;
      if (sa) r.runs[0]!.points.unshift(sa.start);
      if (sb) r.runs.at(-1)!.points.push(sb.start);
      // Where a stub meets the route is a bend like any other.
      const solid = items.filter((it) => it.item.kind !== "zone");
      if (sa) cutCorners(board, rules, items, solid, r.runs[0]!, width, c.net);
      if (sb && (!sa || r.runs.length > 1)) cutCorners(board, rules, items, solid, r.runs.at(-1)!, width, c.net);
      return r;
    }
    return undefined;
  };
  const r = between(c.from, c.to);
  if (r || !alternates) return r;
  // The nearest pads aren't reachable from each other: any other pad of the two pieces joins them as well.
  const islands = netIslands(board, c.net);
  const islandOf = (p: Point) => islands.find((isl) => isl.some((q) => Math.hypot(q.at.x - p.x, q.at.y - p.y) < 1e-6)) ?? [];
  const pads = (isl: CopperAnchor[]) => isl.filter((q) => q.kind === "pad").map((q) => q.at);
  const tries = [...pads(islandOf(c.to)).map((to) => ({ from: c.from, to })), ...pads(islandOf(c.from)).map((from) => ({ from, to: c.to }))]
    .filter((t) => Math.hypot(t.from.x - t.to.x, t.from.y - t.to.y) > 1e-6 && !(t.from === c.from && t.to === c.to))
    .sort((p, q) => Math.hypot(p.from.x - p.to.x, p.from.y - p.to.y) - Math.hypot(q.from.x - q.to.x, q.from.y - q.to.y))
    .slice(0, 6);
  for (const t of tries) {
    const alt = between(t.from, t.to);
    if (alt) return alt;
  }
  return undefined;
}

/** How much dearer a millimetre of track is on a layer another net pours. */
const POUR_COST = 3;

/** Outer layers that another net pours over at least half the board: tracks there cut the pour up. */
export function pouredLayers(board: Board, net: string): string[] {
  const xs = board.outline.flatMap((o) => o.points);
  if (!xs.length) return [];
  const bw = Math.max(...xs.map((p) => p.x)) - Math.min(...xs.map((p) => p.x));
  const bh = Math.max(...xs.map((p) => p.y)) - Math.min(...xs.map((p) => p.y));
  const area = (pts: Point[]) => Math.abs(pts.reduce((a, p, i) => a + p.x * pts[(i + 1) % pts.length]!.y - pts[(i + 1) % pts.length]!.x * p.y, 0)) / 2;
  const out = new Set<string>();
  for (const z of board.zones) if (!z.keepout && z.net && z.net !== net && area(z.outline) >= 0.5 * bw * bh) for (const l of z.layers) if (!/^In\d+\.Cu$/.test(l)) out.add(l);
  return board.copperLayers.filter((l) => out.has(l));
}

/**
 * Copper layers a net's tracks may use: all but the plane layers of other nets (a pour covering
 * at least half the board on a layer that carries nothing else of note, like In1.Cu = GND).
 */
export function routingLayers(board: Board, net: string): string[] {
  const xs = board.outline.flatMap((o) => o.points);
  if (!xs.length) return board.copperLayers;
  const bw = Math.max(...xs.map((p) => p.x)) - Math.min(...xs.map((p) => p.x));
  const bh = Math.max(...xs.map((p) => p.y)) - Math.min(...xs.map((p) => p.y));
  const area = (pts: Point[]) => Math.abs(pts.reduce((a, p, i) => a + p.x * pts[(i + 1) % pts.length]!.y - pts[(i + 1) % pts.length]!.x * p.y, 0)) / 2;
  const planes = new Set<string>();
  for (const z of board.zones) {
    if (z.keepout || !z.net || z.net === net || area(z.outline) < 0.5 * bw * bh) continue;
    // Only inner layers: outer pours (a GND flood around parts) still take tracks.
    for (const l of z.layers) if (/^In\d+\.Cu$/.test(l)) planes.add(l);
  }
  const out = board.copperLayers.filter((l) => !planes.has(l));
  return out.length ? out : board.copperLayers;
}

/**
 * "Route all": every connection in turn (see autorouteConnection), then one round of rip-up and
 * reroute: a connection that failed may lift one of the routes made before it nearby, take the
 * room, and route the lifted one again; that is kept only if both succeed.
 */
export function autorouteAll(board: Board, rules: DesignRules, connections: Array<{ from: Point; to: Point; net: string }>): Array<MultiLayerRoute | undefined> {
  const base = copperItems(board);
  const routes: Array<MultiLayerRoute | undefined> = [];
  const made = new Map<number, CopperItem[]>();
  const all = () => [...base, ...[...made.values()].flat()];
  const itemsOf = (r: MultiLayerRoute, net: string): CopperItem[] => {
    const cls = netClassOf(rules, net);
    return [
      ...r.runs.map((run) => itemOf(net, run.layer, run.points, cls.trackWidth)),
      ...r.vias.map((v): CopperItem => {
        const h = cls.viaDiameter / 2;
        return { shapes: [{ kind: "seg", a: v, b: v, r: h }], layers: new Set(board.copperLayers), item: { kind: "via", net, description: `Via [${net}]` }, box: { x0: v.x - h, y0: v.y - h, x1: v.x + h, y1: v.y + h } };
      }),
    ];
  };
  connections.forEach((c, i) => {
    const r = autorouteConnection(board, rules, c, all());
    routes[i] = r;
    if (r) made.set(i, itemsOf(r, c.net));
  });
  const near = (r: MultiLayerRoute, p: Point) => Math.min(...r.runs.flatMap((run) => run.points.map((q) => Math.hypot(q.x - p.x, q.y - p.y))));
  connections.forEach((c, i) => {
    if (routes[i]) return;
    // One that cannot be made on an empty board (a pad shut inside a keep-out) is not helped by
    // lifting other routes: say so at once, without trying.
    // (Through any pad of its two pieces, as it would be routed: the nearest pair may be shut in.)
    if (!autorouteConnection(board, rules, c, base)) return;
    const others = [...made.keys()].sort((a, b) => Math.min(near(routes[a]!, c.from), near(routes[a]!, c.to)) - Math.min(near(routes[b]!, c.from), near(routes[b]!, c.to))).slice(0, 4);
    for (const j of others) {
      const lifted = made.get(j)!;
      made.delete(j);
      const ri = autorouteConnection(board, rules, c, all());
      if (ri) {
        made.set(i, itemsOf(ri, c.net));
        // The lifted one may join its net through any of its pads (as at first): the way it went
        // is now taken.
        const rj = autorouteConnection(board, rules, connections[j]!, all());
        if (rj) {
          routes[i] = ri;
          routes[j] = rj;
          made.set(j, itemsOf(rj, connections[j]!.net));
          return;
        }
        made.delete(i);
      }
      made.set(j, lifted);
    }
    // Then everything routed close to its ends at once, rerouted after it in the original order.
    const crowd = [...made.keys()].filter((j) => Math.min(near(routes[j]!, c.from), near(routes[j]!, c.to)) < 3);
    if (crowd.length < 2) return;
    const saved = new Map(crowd.map((j) => [j, made.get(j)!]));
    for (const j of crowd) made.delete(j);
    const ri = autorouteConnection(board, rules, c, all());
    if (ri) {
      made.set(i, itemsOf(ri, c.net));
      const again = new Map<number, MultiLayerRoute>();
      for (const j of crowd) {
        const rj = autorouteConnection(board, rules, connections[j]!, all());
        if (!rj) break;
        again.set(j, rj);
        made.set(j, itemsOf(rj, connections[j]!.net));
      }
      if (again.size === crowd.length) {
        routes[i] = ri;
        for (const [j, rj] of again) routes[j] = rj;
        return;
      }
      made.delete(i);
      for (const j of again.keys()) made.delete(j);
    }
    for (const [j, it] of saved) made.set(j, it);
  });

  // Last, connections that got through but the long way round: the routes in the way of the path
  // each would take on an empty board are lifted, it is routed first, and they are routed again.
  // Kept only when everything still routes and the track in total got shorter.
  const length = (r: MultiLayerRoute) => r.runs.reduce((s, run) => s + run.points.slice(1).reduce((t, p, k) => t + Math.hypot(p.x - run.points[k]!.x, p.y - run.points[k]!.y), 0), 0);
  const direct = (i: number) => Math.hypot(connections[i]!.from.x - connections[i]!.to.x, connections[i]!.from.y - connections[i]!.to.y);
  const isLong = (i: number) => !!routes[i] && length(routes[i]!) > REROUTE.ratio * direct(i) && length(routes[i]!) - direct(i) > REROUTE.excess;
  const excess = (i: number) => length(routes[i]!) - direct(i);
  const queue = connections.map((_, i) => i).filter(isLong).sort((p, q) => excess(q) - excess(p));
  // A route lifted to make room may come back long itself: it is then tried in its turn. Every change
  // kept makes the total shorter, so this ends; `most` bounds the work all the same.
  for (let tries = 0; queue.length && tries < REROUTE.most; tries++) {
    const i = queue.shift()!;
    if (!isLong(i)) continue;
    const c = connections[i]!;
    const was = length(routes[i]!);
    const alone = autorouteConnection(board, rules, c, base, false);
    if (!alone || length(alone) > REROUTE.gain * was) continue;
    const cls = netClassOf(rules, c.net);
    const crosses = (theirs: CopperItem[]) =>
      alone.runs.some((run) => run.points.slice(1).some((p, k) => trackConflicts(theirs, rules, { a: run.points[k]!, b: p, width: cls.trackWidth, layer: run.layer, net: c.net }).length > 0)) ||
      alone.vias.some((v) => board.copperLayers.some((l) => trackConflicts(theirs, rules, { a: v, b: v, width: cls.viaDiameter, layer: l, net: c.net }).length > 0));
    const inWay = [...made.keys()].filter((j) => j !== i && crosses(made.get(j)!));
    if (!inWay.length || inWay.length > REROUTE.lift) continue;
    const lifted = [i, ...inWay];
    const saved = new Map(lifted.map((j) => [j, made.get(j)!]));
    const before = lifted.reduce((s, j) => s + length(routes[j]!), 0);
    for (const j of lifted) made.delete(j);
    const again = new Map<number, MultiLayerRoute>();
    for (const j of lifted) {
      const rj = autorouteConnection(board, rules, connections[j]!, all(), false);
      if (!rj) break;
      again.set(j, rj);
      made.set(j, itemsOf(rj, connections[j]!.net));
    }
    const after = [...again.values()].reduce((s, r) => s + length(r), 0);
    if (again.size === lifted.length && after < before - 1) {
      for (const [j, rj] of again) routes[j] = rj;
      for (const j of inWay) if (isLong(j) && !queue.includes(j)) queue.push(j);
      continue;
    }
    for (const j of again.keys()) made.delete(j);
    for (const [j, it] of saved) made.set(j, it);
  }
  return routes;
}

/**
 * When a routed connection is tried again: more than `ratio` times the straight line and `excess` mm
 * over it, if alone on the board it would take under `gain` of that. At most `most` connections,
 * each lifting at most `lift` others.
 */
const REROUTE = { ratio: 2, excess: 8, gain: 0.7, most: 16, lift: 5 };

/**
 * Pieces of a poured net that the pour doesn't reach (an SMD pad hemmed in by tracks on its own
 * layer, a cut-off fill island): for each, a short track from one of its pads to a via that lands
 * in the net's fill on another layer, as a designer stitches them. Refill the zones afterwards.
 */
export function stitchToPours(board: Board, rules: DesignRules, net: string): MultiLayerRoute[] {
  const fills = board.zones.filter((z) => !z.keepout && z.net === net).flatMap((z) => z.fills);
  if (!fills.length) return [];
  const islands = netIslands(board, net);
  if (islands.length < 2) return [];
  const cls = netClassOf(rules, net);
  const r = cls.viaDiameter / 2;
  const items = copperItems(board).filter((it) => it.item.kind !== "zone");
  // The biggest piece is the one the others join.
  const main = islands.reduce((a, b) => (b.length > a.length ? b : a));
  const out: MultiLayerRoute[] = [];
  const placed: CopperItem[] = [];
  const viaOk = (v: Point, layer: string, others: CopperItem[]) =>
    fills.some((f) => f.layer !== layer && insidePolygon(f.points, v)) &&
    !inNoViaArea(board, v, cls.viaDiameter / 2) &&
    holesClear(board, rules, v, { size: cls.viaDiameter, drill: cls.viaDrill }, out.flatMap((o) => o.vias)) &&
    !board.copperLayers.some((l) => trackConflicts(others, rules, { a: v, b: v, width: cls.viaDiameter, layer: l, net }).length);
  for (const isl of islands) {
    if (isl === main) continue;
    const pads = isl.flatMap((q) => (q.kind === "pad" ? board.footprints.flatMap((f) => f.pads).filter((p) => p.net === net && Math.hypot(p.at.x - q.at.x, p.at.y - q.at.y) < 1e-6) : []));
    const others = [...items, ...placed];
    let best: { points: Point[]; via: Point; layer: string; d: number } | undefined;
    // A straight track to a via just beside a pad.
    for (const pad of pads) {
      const b = viaBeside(pad, cls, rules, net, others, (v, layer) => viaOk(v, layer, others), board.copperLayers, best?.d);
      if (b) best = b;
    }
    // Else a routed track to the nearest free spots in the pour.
    if (!best)
      for (const pad of pads) {
        const layer = pad.layers.find((l) => board.copperLayers.includes(l));
        if (!layer || pad.layers.length > 3) continue;
        const spots: Array<{ v: Point; d: number }> = [];
        for (let dy = -5; dy <= 5; dy += 0.5)
          for (let dx = -5; dx <= 5; dx += 0.5) {
            const d = Math.hypot(dx, dy);
            if (d > 5 || d < 0.8) continue;
            spots.push({ v: { x: pad.at.x + dx, y: pad.at.y + dy }, d });
          }
        spots.sort((p, q) => p.d - q.d);
        let tried = 0;
        for (const { v, d } of spots) {
          if (best && d >= best.d) break;
          if (tried >= 8) break;
          if (!viaOk(v, layer, others)) continue;
          tried++;
          const route = routeWithVias(board, rules, { from: pad.at, to: v, net, width: cls.trackWidth, via: { size: 0, drill: 0 }, layers: [layer], fromLayers: [layer], toLayers: [layer] }, others, false);
          if (route?.runs[0]) best = { points: route.runs[0].points, via: v, layer, d };
        }
      }
    let route: MultiLayerRoute | undefined = best && { runs: [{ layer: best.layer, points: best.points }], vias: [best.via] };
    // Else no pour is in reach: route it to the nearest pad of the main piece instead.
    if (!route) {
      const targets = main.filter((q) => q.kind === "pad");
      const pairs = pads.flatMap((p) => targets.map((t) => ({ from: p.at, to: t.at, d: Math.hypot(p.at.x - t.at.x, p.at.y - t.at.y) }))).sort((a, b) => a.d - b.d).slice(0, 4);
      for (const pr of pairs) if ((route = autorouteConnection(board, rules, { from: pr.from, to: pr.to, net }, others, false))) break;
    }
    if (route) {
      out.push(route);
      for (const v of route.vias) placed.push({ shapes: [{ kind: "seg", a: v, b: v, r }], layers: new Set(board.copperLayers), item: { kind: "via", net, description: `Via [${net}]` }, box: { x0: v.x - r, y0: v.y - r, x1: v.x + r, y1: v.y + r } });
      for (const run of route.runs) placed.push(itemOf(net, run.layer, run.points, cls.trackWidth));
    }
  }
  return out;
}

/** The nearest via spot beside an SMD pad (with the straight track to it) that `ok` accepts, closer than `within`. */
function viaBeside(pad: Pad, cls: { trackWidth: number }, rules: DesignRules, net: string, others: CopperItem[], ok: (v: Point, layer: string) => boolean, copper: string[], within = Infinity): { points: Point[]; via: Point; layer: string; d: number } | undefined {
  const layer = pad.layers.find((l) => copper.includes(l));
  if (!layer || pad.type !== "smd") return undefined; // through-hole pads reach every layer's pour already
  let best: { points: Point[]; via: Point; layer: string; d: number } | undefined;
  // From just off the pad (a via may touch its own pad, not sit in it: solder would wick away) outwards.
  const reach = Math.min(pad.size.x, pad.size.y) / 2 + 0.05;
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    for (let step = 0; step < 30; step++) {
      const d = reach + step * 0.1;
      if (d >= (best?.d ?? within)) break;
      const v = { x: pad.at.x + Math.cos(a) * d, y: pad.at.y + Math.sin(a) * d };
      if (padHas(pad, v) || !ok(v, layer)) continue;
      if (trackConflicts(others, rules, { a: pad.at, b: v, width: cls.trackWidth, layer, net }).length) continue;
      best = { points: [pad.at, v], via: v, layer, d };
      break;
    }
  }
  return best;
}

/**
 * Before routing, as designers fan out the ground pins of fine-pitch parts: each SMD pad of a
 * poured net that has another pad within 1 mm (QFP, QFN, connector contacts) and nothing on it
 * yet gets a via beside it into the net's zone on another layer, so signal routes can't hem it in.
 */
export function fanoutPours(board: Board, rules: DesignRules, net: string): MultiLayerRoute[] {
  const zones = board.zones.filter((z) => !z.keepout && z.net === net);
  if (!zones.length) return [];
  const cls = netClassOf(rules, net);
  const r = cls.viaDiameter / 2;
  const items = copperItems(board).filter((it) => it.item.kind !== "zone");
  const out: MultiLayerRoute[] = [];
  const placed: CopperItem[] = [];
  const used = (p: Point) => board.tracks.some((t) => t.net === net && (Math.hypot(t.start.x - p.x, t.start.y - p.y) < 1e-3 || Math.hypot(t.end.x - p.x, t.end.y - p.y) < 1e-3));
  for (const fp of board.footprints)
    for (const pad of fp.pads) {
      if (pad.net !== net || pad.type !== "smd" || used(pad.at)) continue;
      if (!fp.pads.some((q) => q !== pad && Math.hypot(q.at.x - pad.at.x, q.at.y - pad.at.y) < 1)) continue;
      const others = [...items, ...placed];
      const ok = (v: Point, layer: string) =>
        zones.some((z) => z.layers.some((l) => l !== layer && board.copperLayers.includes(l)) && insidePolygon(z.outline, v)) &&
        !inNoViaArea(board, v, cls.viaDiameter / 2) &&
    holesClear(board, rules, v, { size: cls.viaDiameter, drill: cls.viaDrill }, out.flatMap((o) => o.vias)) &&
        !board.copperLayers.some((l) => trackConflicts(others, rules, { a: v, b: v, width: cls.viaDiameter, layer: l, net }).length);
      const b = viaBeside(pad, cls, rules, net, others, ok, board.copperLayers, 1.5);
      if (!b) continue;
      out.push({ runs: [{ layer: b.layer, points: b.points }], vias: [b.via] });
      placed.push({ shapes: [{ kind: "seg", a: b.via, b: b.via, r }], layers: new Set(board.copperLayers), item: { kind: "via", net, description: `Via [${net}]` }, box: { x0: b.via.x - r, y0: b.via.y - r, x1: b.via.x + r, y1: b.via.y + r } });
      placed.push(itemOf(net, b.layer, b.points, cls.trackWidth));
    }
  return out;
}

/**
 * A right-angle bend is cut across at 45° where the cut is clear: the search weighs length, not
 * the angle of a bend, so it leaves one wherever a straight run meets another or a pad's stub.
 */
function cutCorners(board: Board, rules: DesignRules, items: CopperItem[], solid: CopperItem[], run: { layer: string; points: Point[] }, width: number, net: string): void {
  const pts = run.points;
  // What the grid alone keeps a route from (copper text, the board edge, mask openings, keep-outs):
  // a cut must stay clear of it as the route's own runs do.
  const g = makeGrid(board, 0.1);
  const hard = g && cachedObstacles(g, board, rules, items, net, run.layer, width / 2).hard;
  const shut = (a: Point, b: Point) => {
    if (!g || !hard) return false;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (g.pitch / 2)));
    for (let k = 0; k <= n; k++) {
      const c = cellOf(g, { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
      if (c < 0 || hard[c]) return true;
    }
    return false;
  };
  const same = (m: Point, n: Point) => Math.hypot(m.x - n.x, m.y - n.y) < 1e-6;
  for (let k = 1; k < pts.length - 1; k++) {
    const p = pts[k - 1]!, q = pts[k]!, r = pts[k + 1]!;
    const u = { x: p.x - q.x, y: p.y - q.y }, v = { x: r.x - q.x, y: r.y - q.y };
    const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
    if (lu < 1e-6 || lv < 1e-6 || Math.abs(u.x * v.x + u.y * v.y) > 1e-6 * lu * lv) continue;
    // As far back along each leg as the shorter allows, up to 1 mm; an end point of the run stays where it is.
    // A bend usually goes round something, which is on the inside where the cut goes: then a smaller cut is tried.
    const room = Math.min(k === 1 ? lu / 2 : lu, k === pts.length - 2 ? lv / 2 : lv);
    for (const d of [1, 0.5, 0.25].map((x) => Math.min(x, room)).filter((x, n, all) => x >= 0.2 && all.indexOf(x) === n)) {
      const a = { x: q.x + (u.x / lu) * d, y: q.y + (u.y / lu) * d }, b = { x: q.x + (v.x / lv) * d, y: q.y + (v.y / lv) * d };
      if (trackConflicts(solid, rules, { a, b, width, layer: run.layer, net }).length || !trackClearsHoles(board, rules, a, b, width, net) || inNoTrackArea(board, a, b, width, run.layer) || shut(a, b)) continue;
      pts.splice(k, 1, ...(same(a, p) ? [] : [a]), ...(same(b, r) ? [] : [b]));
      if (!same(a, p)) k++;
      break;
    }
  }
}

/**
 * A track keeps the hole clearance from the holes of other nets and from unplated holes. The grid
 * already keeps routes away from them, but not the first and last stretch beside a pad, nor a pad's
 * fan-out stub: a USB-C contact next to the shell's locating hole.
 */
function trackClearsHoles(board: Board, rules: DesignRules, a: Point, b: Point, width: number, net: string): boolean {
  const hc = rules.holeClearance ?? 0;
  if (hc <= 0) return true;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const dist = (p: Point) => {
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
  };
  for (const fp of board.footprints)
    for (const pad of fp.pads) {
      const d = pad.drillSize ? Math.max(pad.drillSize.x, pad.drillSize.y) : pad.drill;
      if (d && !(pad.net && pad.net === net) && dist(pad.at) - d / 2 - width / 2 < hc - 1e-6) return false;
    }
  for (const v of board.vias) if (!(v.net && v.net === net) && dist(v.at) - v.drill / 2 - width / 2 < hc - 1e-6) return false;
  return true;
}

/** Every drilled pad hole on the board, of any net. */
function drilledHoles(board: Pick<Board, "footprints" | "vias">): Array<{ at: Point; r: number }> {
  const out: Array<{ at: Point; r: number }> = [];
  for (const fp of board.footprints)
    for (const pad of fp.pads) {
      const r = pad.drillSize ? Math.max(pad.drillSize.x, pad.drillSize.y) / 2 : (pad.drill ?? 0) / 2;
      if (r) out.push({ at: pad.at, r });
    }
  for (const v of board.vias) out.push({ at: v.at, r: v.drill / 2 });
  return out;
}

/** The holes of vias among copper items: routes made but not on the board yet. Their drill is their net class's. */
function viaHoles(rules: DesignRules, items: CopperItem[]): Array<{ at: Point; r: number }> {
  const out: Array<{ at: Point; r: number }> = [];
  for (const it of items) {
    const sh = it.shapes[0];
    if (it.item.kind === "via" && sh?.kind === "seg") out.push({ at: sh.a, r: netClassOf(rules, it.item.net ?? "").viaDrill / 2 });
  }
  return out;
}

/** A via's hole keeps the hole-to-hole distance from every other hole, and its copper the hole clearance from bare holes. */
function holesClear(board: Pick<Board, "footprints" | "vias">, rules: DesignRules, v: Point, via: { size: number; drill: number }, extra: Point[] = [], more: Array<{ at: Point; r: number }> = []): boolean {
  const h2h = rules.minHoleToHole ?? 0.25;
  const hc = rules.holeClearance ?? 0;
  for (const fp of board.footprints)
    for (const pad of fp.pads) {
      const r = pad.drillSize ? Math.max(pad.drillSize.x, pad.drillSize.y) / 2 : (pad.drill ?? 0) / 2;
      if (!r) continue;
      const d = Math.hypot(pad.at.x - v.x, pad.at.y - v.y);
      if (d - r - via.drill / 2 < h2h) return false;
      if (pad.type === "np_thru_hole" && d - r - via.size / 2 < hc) return false;
    }
  for (const o of [...board.vias.map((x) => ({ at: x.at, r: x.drill / 2 })), ...extra.map((at) => ({ at, r: via.drill / 2 })), ...more])
    if (Math.hypot(o.at.x - v.x, o.at.y - v.y) - o.r - via.drill / 2 < h2h) return false;
  return true;
}

/** Is the point inside the pad's rectangle? */
function padHas(pad: { at: Point; size: Point; rotation: number }, p: Point): boolean {
  const r = (pad.rotation * Math.PI) / 180;
  const dx = p.x - pad.at.x;
  const dy = p.y - pad.at.y;
  // Into the pad's frame (KiCad angles are counter-clockwise on screen).
  const x = dx * Math.cos(r) - dy * Math.sin(r);
  const y = dx * Math.sin(r) + dy * Math.cos(r);
  return Math.abs(x) <= pad.size.x / 2 && Math.abs(y) <= pad.size.y / 2;
}

/** Whether a track of this width from `a` to `b` would reach into a rule area that keeps tracks off its layer. */
function inNoTrackArea(board: Board, a: Point, b: Point, width: number, layer: string): boolean {
  const cross = (p: Point, q: Point, c: Point, d: Point) => {
    const o = (u: Point, v: Point, w: Point) => Math.sign((v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x));
    return o(p, q, c) !== o(p, q, d) && o(c, d, p) !== o(c, d, q);
  };
  const near = (p: Point, c: Point, d: Point) => {
    const dx = d.x - c.x, dy = d.y - c.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - c.x) * dx + (p.y - c.y) * dy) / l2)) : 0;
    return Math.hypot(p.x - (c.x + t * dx), p.y - (c.y + t * dy));
  };
  return board.zones.some((z) => {
    if (!z.noTracks || z.outline.length < 3 || !onLayer(board, z.layers, layer)) return false;
    if (insidePolygon(z.outline, a) || insidePolygon(z.outline, b)) return true;
    return z.outline.some((c, k) => {
      const d = z.outline[(k + 1) % z.outline.length]!;
      // Crossing an edge, or running closer to one than half the track.
      return cross(a, b, c, d) || Math.min(near(a, c, d), near(b, c, d), near(c, a, b), near(d, a, b)) < width / 2 - 1e-6;
    });
  });
}

/** Whether a via of this radius at `v` would reach into a rule area that keeps vias out. */
function inNoViaArea(board: Board, v: Point, r: number): boolean {
  return board.zones.some(
    (z) =>
      z.noVias &&
      z.outline.length >= 3 &&
      (insidePolygon(z.outline, v) ||
        z.outline.some((p, k) => {
          const q = z.outline[(k + 1) % z.outline.length]!;
          const dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1, ((v.x - p.x) * dx + (v.y - p.y) * dy) / l2)) : 0;
          return Math.hypot(v.x - (p.x + t * dx), v.y - (p.y + t * dy)) < r;
        })),
  );
}

/** Whether a zone's layer list (which may hold "*.Cu" or "F&B.Cu") covers a copper layer. */
function onLayer(board: Board, layers: string[], layer: string): boolean {
  const outer = layer === board.copperLayers[0] || layer === board.copperLayers[board.copperLayers.length - 1];
  return layers.includes(layer) || layers.includes("*.Cu") || (outer && layers.includes("F&B.Cu"));
}

/** Mark the cells where a disc of radius `half` would reach into the polygon. */
function blockArea(g: Grid, cells: Uint8Array, poly: Point[], half: number): void {
  if (poly.length < 3) return;
  const at = (i: number, j: number) => ({ x: g.x0 + i * g.pitch, y: g.y0 + j * g.pitch });
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const i0 = Math.max(0, Math.floor((Math.min(...xs) - half - g.x0) / g.pitch)), i1 = Math.min(g.W - 1, Math.ceil((Math.max(...xs) + half - g.x0) / g.pitch));
  const j0 = Math.max(0, Math.floor((Math.min(...ys) - half - g.y0) / g.pitch)), j1 = Math.min(g.H - 1, Math.ceil((Math.max(...ys) + half - g.y0) / g.pitch));
  const near = (p: Point) =>
    poly.some((a, k) => {
      const b = poly[(k + 1) % poly.length]!;
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) < half;
    });
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const p = at(i, j);
      if (insidePolygon(poly, p) || near(p)) cells[j * g.W + i] = 1;
    }
}

function insidePolygon(poly: Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

interface Stub {
  start: Point;
  end: Point;
  layer: string;
}

/**
 * Straight stubs out of the pad at `at` along its long side, clear of other nets: away from its
 * part first, then inwards (under a connector's body, where there is room behind the pad row).
 */
function padStubs(board: Board, rules: DesignRules, items: CopperItem[], at: Point, net: string, width: number): Stub[] {
  const out: Stub[] = [];
  const solid = items.filter((it) => it.item.kind !== "zone");
  for (const fp of board.footprints)
    for (const pad of fp.pads) {
      if (pad.net !== net || Math.hypot(pad.at.x - at.x, pad.at.y - at.y) > 1e-6) continue;
      const r = (pad.rotation * Math.PI) / 180;
      const along = pad.size.x >= pad.size.y ? { x: Math.cos(r), y: -Math.sin(r) } : { x: Math.sin(r), y: Math.cos(r) };
      const k = along.x * (pad.at.x - fp.at.x) + along.y * (pad.at.y - fp.at.y);
      if (Math.abs(k) < 1e-6) continue;
      const len = Math.max(pad.size.x, pad.size.y) / 2 + netClassOf(rules, net).clearance + width / 2 + 0.05;
      const layers = pad.layers.flatMap((l) => (board.copperLayers.includes(l) ? [l] : l === "*.Cu" || l === "F&B.Cu" ? [board.copperLayers[0]!] : []));
      for (const sign of k > 0 ? [1, -1] : [-1, 1]) {
        const end = { x: pad.at.x + sign * along.x * len, y: pad.at.y + sign * along.y * len };
        const layer = layers.find((l) => !trackConflicts(solid, rules, { a: pad.at, b: end, width, layer: l, net }).length);
        if (layer && trackClearsHoles(board, rules, pad.at, end, width, net) && !inNoTrackArea(board, pad.at, end, width, layer)) out.push({ start: pad.at, end, layer });
      }
    }
  return out;
}

/**
 * Walkaround for interactive routing: paths from the route's last corner to
 * the cursor on one layer, around other nets' copper. Obstacle maps are built
 * once per layer and kept for the whole route (the board doesn't change while
 * a route is being drawn), so each cursor move is just a bounded search.
 */
/** Tracks a shove moves: the runs it removes (by uuid) and their replacements. */
export interface ShoveResult {
  remove: string[];
  add: Array<{ net: string; layer: string; width: number; points: Point[] }>;
}

const ptKey = (p: Point) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;

function itemOf(net: string, layer: string, points: Point[], width: number): CopperItem {
  const shapes: Shape[] = [];
  for (let i = 1; i < points.length; i++) shapes.push({ kind: "seg", a: points[i - 1]!, b: points[i]!, r: width / 2 });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x - width / 2); y0 = Math.min(y0, p.y - width / 2); x1 = Math.max(x1, p.x + width / 2); y1 = Math.max(y1, p.y + width / 2);
  }
  return { shapes, layers: new Set([layer]), item: { kind: "track", net, description: `Track [${net}] on ${layer}` }, ruleLayer: layer, box: { x0, y0, x1, y1 } };
}

/**
 * An interactive router for one net at a time: walkaround (`path`) and shove
 * (`shove`). Obstacle maps are built once per layer and reused while the
 * cursor moves.
 */
export class InteractiveRouter {
  private grid: Grid | undefined;
  private maps = new Map<string, { blocked: Uint8Array; hard: Uint8Array }>();
  /** Why the last `shove` returned undefined, for the user. */
  failure: string | undefined;

  constructor(
    private board: Board,
    private rules: DesignRules,
    private items: CopperItem[],
    private net: string,
    private width: number,
    private pitch = 0.1,
  ) {
    this.grid = makeGrid(board, pitch);
  }

  /** Obstacles on `layer`; with `throughTracks`, other nets' tracks don't count (shove moves them). */
  private map(layer: string, throughTracks = false) {
    const key = `${layer}|${throughTracks}`;
    let m = this.maps.get(key);
    if (!m && this.grid) {
      const items = throughTracks ? this.items.filter((it) => it.item.kind !== "track" || it.item.net === this.net) : this.items;
      this.maps.set(key, (m = obstacles(this.grid, this.board, this.rules, items, this.net, layer, this.width / 2)));
    }
    return m;
  }

  /**
   * Corners of a clear path from `from` to `to` on `layer` (both included),
   * or undefined when there is none within the search budget. With
   * `throughTracks` the path may cross other nets' tracks (for shoving).
   */
  path(from: Point, to: Point, layer: string, opts: { throughTracks?: boolean; maxExpanded?: number } = {}): Point[] | undefined {
    const g = this.grid;
    const m = this.map(layer, opts.throughTracks);
    if (!g || !m) return undefined;
    const s = cellOf(g, from);
    const t = cellOf(g, to);
    if (s < 0 || t < 0) return undefined;
    if (s === t) return [from, to];
    // A copy, freed around both ends (they may sit on our own pads, inside neighbours' halos).
    const work = { blocked: m.blocked.slice(), hard: m.hard };
    freeAround(g, work, s, this.width / 2);
    freeAround(g, work, t, this.width / 2);
    const cells = search(g, [work.blocked], undefined, 0, { cell: s, layers: [0] }, { cell: t, layers: [0] }, opts.maxExpanded ?? 150_000);
    if (!cells) return undefined;
    return corners(g, cells.map(([, c]) => c), from, to);
  }

  /**
   * Push other nets' tracks out of the way of a new route: each run of tracks
   * the route would violate is rerouted between its fixed ends, close to where
   * it was, around the new route. Pads, vias and anything else are never
   * moved, and a run whose bends carry a via, a pad or a branch stays put.
   * Returns what to change ({remove: [], add: []} when nothing is in the way),
   * or undefined when the route can't be made clear this way.
   */
  shove(runs: Array<{ layer: string; points: Point[] }>): ShoveResult | undefined {
    this.failure = undefined;
    const fail = (why: string) => {
      this.failure = why;
      return undefined;
    };
    const ours = runs.filter((r) => r.points.length > 1).map((r) => itemOf(this.net, r.layer, r.points, this.width));
    const removed = new Set<string>();
    const added: CopperItem[] = [];
    const result: ShoveResult = { remove: [], add: [] };
    // Zones are refilled around the result, so they aren't in the way; nor is the route itself
    // (a route without a net would otherwise clash with its own segments).
    const own = new Set(ours.map((o) => o.item));
    const current = () => [...this.items.filter((it) => !removed.has(it.item.uuid ?? "") && it.item.kind !== "zone"), ...ours, ...added];

    for (const run of runs) {
      for (let i = 1; i < run.points.length; i++) {
        const hits = trackConflicts(current(), this.rules, { a: run.points[i - 1]!, b: run.points[i]!, width: this.width, layer: run.layer, net: this.net });
        for (const h of hits) {
          if (own.has(h.with)) continue;
          if (!h.with.uuid && h.with.kind === "track") return fail("no room: two pushed tracks would clash");
          if (h.with.kind !== "track" || !h.with.uuid) return fail(`${h.with.kind === "pad" ? `pad ${h.with.pad ?? ""} of ${h.with.reference ?? "?"}` : h.with.kind} is in the way`);
          if (this.board.tracks.find((t) => t.uuid === h.with.uuid)?.mid) return fail(`an arc of ${h.with.net} is in the way`);
          if (removed.has(h.with.uuid)) continue;
          const moved = this.pushRun(h.with.uuid, run.layer, ours, removed, added, 0);
          if (typeof moved === "string") return fail(moved);
          result.remove.push(...moved.remove);
          result.add.push(...moved.add);
        }
      }
    }
    // Everything changed must be clear of everything else.
    const all = current();
    for (const it of [...ours, ...added]) {
      const layer = [...it.layers][0]!;
      for (const sh of it.shapes) {
        if (sh.kind !== "seg") continue;
        const left = trackConflicts(all, this.rules, { a: sh.a, b: sh.b, width: sh.r * 2, layer, net: it.item.net }).filter((h) => h.with !== it.item && !(own.has(it.item) && own.has(h.with)));
        if (left.length) return fail(`no room: ${left[0]!.with.description} would be too close`);
      }
    }
    return result;
  }

  /**
   * Reroute the run of `net` tracks around track `uuid`, clear of `ours` and earlier shoves. When
   * other nets' tracks leave it no room, it may push those in turn (up to three deep), each
   * around everything moved before it; a branch that can't be made clear is undone.
   */
  private pushRun(uuid: string, layer: string, ours: CopperItem[], removed: Set<string>, added: CopperItem[], depth: number): ShoveResult | string {
    const first = this.board.tracks.find((t) => t.uuid === uuid);
    if (!first) return "track not found";
    const net = first.net;
    const width = first.width;
    const tracks = this.board.tracks.filter((t) => t.net === net && t.layer === layer && !t.mid && !removed.has(t.uuid ?? ""));
    // Degree of each vertex among this net's tracks on the layer, plus anything else of the net there.
    const degree = new Map<string, number>();
    for (const t of tracks) for (const p of [t.start, t.end]) degree.set(ptKey(p), (degree.get(ptKey(p)) ?? 0) + 1);
    const anchored = (p: Point) =>
      degree.get(ptKey(p)) !== 2 ||
      this.items.some((it) => it.item.net === net && (it.item.kind === "via" || it.item.kind === "pad") && it.layers.has(layer) && it.shapes.some((sh) => shapeDistance({ kind: "seg", a: p, b: p, r: 0 }, sh, 0.01).dist <= 1e-6));
    const tooClose = (p: Point) => {
      const probe = itemOf(net, layer, [p, p], width);
      return ours.some((o) => o.layers.has(layer) && o.shapes.some((s) => probe.shapes.some((q) => shapeDistance(q, s, 1).dist < Math.max(this.rules.minClearance, netClassOf(this.rules, net).clearance, netClassOf(this.rules, this.net).clearance) - 0.0005)));
    };
    // Grow the run from the hit track: through plain bends that are themselves in the way,
    // and through every bend that ours crosses between them.
    const run = new Set([first]);
    let ends = [first.start, first.end];
    for (let guard = 0; guard < 50; guard++) {
      let grew = false;
      ends = ends.map((e) => {
        if (anchored(e) || !tooClose(e)) return e;
        const next = tracks.find((t) => !run.has(t) && (ptKey(t.start) === ptKey(e) || ptKey(t.end) === ptKey(e)));
        if (!next) return e;
        run.add(next);
        grew = true;
        return ptKey(next.start) === ptKey(e) ? next.end : next.start;
      });
      if (!grew) break;
    }
    if (ends.some(tooClose)) return `${net} is held in place (a via, pad or branch) too close to the route`;
    const [a, b] = ends as [Point, Point];
    // Anything else of the net touching the run (a track ending on its middle, a pad it
    // passes over) must touch it at one of the fixed ends, or moving the run would cut it off.
    const runUuids = new Set([...run].map((t) => t.uuid));
    const runShapes = [...run].map((t): Shape => ({ kind: "seg", a: t.start, b: t.end, r: t.width / 2 }));
    const at = (p: Point): Shape => ({ kind: "seg", a: p, b: p, r: 0 });
    for (const it of this.items) {
      if (it.item.net !== net || !it.layers.has(layer) || it.item.kind === "zone" || runUuids.has(it.item.uuid ?? "")) continue;
      const touches = it.shapes.some((sh) => runShapes.some((r) => shapeDistance(r, sh, 0.01).dist <= 0));
      if (!touches) continue;
      if (!it.shapes.some((sh) => shapeDistance(at(a), sh, 0.01).dist <= 1e-6 || shapeDistance(at(b), sh, 0.01).dist <= 1e-6)) return `${net} has a connection along the track`;
    }

    // Reroute in a window around the run.
    const margin = 3;
    const pts = [...run].flatMap((t) => [t.start, t.end]);
    const g0 = this.grid;
    if (!g0) return "no board outline";
    const p = this.pitch;
    const wx0 = Math.max(g0.x0, Math.floor((Math.min(...pts.map((q) => q.x)) - margin - g0.x0) / p) * p + g0.x0);
    const wy0 = Math.max(g0.y0, Math.floor((Math.min(...pts.map((q) => q.y)) - margin - g0.y0) / p) * p + g0.y0);
    const wx1 = Math.max(...pts.map((q) => q.x)) + margin;
    const wy1 = Math.max(...pts.map((q) => q.y)) + margin;
    const win: Grid = { x0: wx0, y0: wy0, W: Math.ceil((wx1 - wx0) / p) + 1, H: Math.ceil((wy1 - wy0) / p) + 1, pitch: p, outline: g0.outline };
    for (const t of run) removed.add(t.uuid ?? "");
    const items = [...this.items.filter((it) => !removed.has(it.item.uuid ?? "") && it.item.kind !== "zone"), ...ours, ...added];
    const m = obstacles(win, this.board, this.rules, items, net, layer, width / 2);
    const s = cellOf(win, a);
    const t = cellOf(win, b);
    if (s < 0 || t < 0) return "off the board";
    freeAround(win, m, s, width / 2);
    freeAround(win, m, t, width / 2);
    const cells = search(win, [m.blocked], undefined, 0, { cell: s, layers: [0] }, { cell: t, layers: [0] }, 60_000);
    const mine = [...run].map((t) => t.uuid ?? "");
    if (cells) {
      const points = corners(win, cells.map(([, c]) => c), a, b);
      added.push(itemOf(net, layer, points, width));
      return { remove: mine, add: [{ net, layer, width, points }] };
    }
    if (depth >= 2) return `no room to move ${net}`;
    // No room among the other tracks: go through them, and push those that end up in the way.
    // Their ends stay where they are (that's where they connect), so those stay obstacles.
    const passable = (it: CopperItem) => it.item.kind === "track" && it.item.net !== net && !!it.item.uuid && !added.includes(it);
    const endsOf = items.filter(passable).flatMap((it) =>
      it.shapes.flatMap((sh): CopperItem[] => (sh.kind === "seg" ? [sh.a, sh.b].map((q) => ({ ...it, shapes: [{ kind: "seg" as const, a: q, b: q, r: sh.r }], box: { x0: q.x - sh.r, y0: q.y - sh.r, x1: q.x + sh.r, y1: q.y + sh.r } })) : [])),
    );
    const free = obstacles(win, this.board, this.rules, [...items.filter((it) => !passable(it)), ...endsOf], net, layer, width / 2);
    freeAround(win, free, s, width / 2);
    freeAround(win, free, t, width / 2);
    const through = search(win, [free.blocked], undefined, 0, { cell: s, layers: [0] }, { cell: t, layers: [0] }, 60_000);
    if (!through) return `no room to move ${net}`;
    const points = corners(win, through.map(([, c]) => c), a, b);
    const me = itemOf(net, layer, points, width);
    const keepRemoved = new Set(removed);
    const keepAdded = added.length;
    added.push(me);
    const out: ShoveResult = { remove: mine, add: [{ net, layer, width, points }] };
    const undo = (why: string) => {
      removed.clear();
      for (const u of keepRemoved) removed.add(u);
      added.length = keepAdded;
      return why;
    };
    for (let k = 1; k < points.length; k++) {
      const current = [...this.items.filter((it) => !removed.has(it.item.uuid ?? "") && it.item.kind !== "zone"), ...ours, ...added];
      for (const h of trackConflicts(current, this.rules, { a: points[k - 1]!, b: points[k]!, width, layer, net })) {
        if (h.with === me.item || h.with.net === net) continue;
        if (h.with.kind !== "track" || !h.with.uuid || removed.has(h.with.uuid)) return undo(`no room to move ${net}`);
        if (this.board.tracks.find((x) => x.uuid === h.with.uuid)?.mid) return undo(`an arc of ${h.with.net} is in the way`);
        const next = this.pushRun(h.with.uuid, layer, [...ours, me], removed, added, depth + 1);
        if (typeof next === "string") return undo(next);
        out.remove.push(...next.remove);
        out.add.push(...next.add);
      }
    }
    return out;
  }
}

/**
 * Length constraints from custom rules, as KiCad's DRC checks them
 * (DRC_TEST_PROVIDER_MATCHED_LENGTH, reimplemented from its behaviour):
 *
 * - Every track, arc, via and pad takes the length (or skew) constraint of the
 *   last rule whose condition holds for it. A rule's items are grouped by net;
 *   each group is measured as KiCad's length calculation measures it (tracks
 *   merged and trimmed at vias and pads, vias by the span of the tracks they
 *   join) and checked against the rule's min and max (length_out_of_range),
 *   or against the longest of the rule's groups (skew_out_of_range).
 * - `A.fromTo('IC14-*', 'IC13-*')` holds for the items on the path between a
 *   pad matching the first pattern and the one connected pad matching the
 *   second (KiCad's FROM_TO_CACHE: pads answer to "REF-PAD" and "REF"; zones
 *   don't join; the path is KiCad's breadth-first one).
 *
 * Against KiCad's DRC on vme-wren: whole nets and acyclic point-to-point paths
 * measure as KiCad's to the micrometre; on some routes KiCad's from-to path
 * leaves out a little more than ours (up to ~0.7 mm), so findings near a
 * rule's limit can differ.
 */
import type { Board, Pad, Track, Via } from "./board.js";
import { flashChecker } from "./board.js";
import { netClassOf, type DesignRules, type DrcItem } from "./drc.js";
import { customConstraint, type DruRule, type RuleItem } from "./drc-rules.js";
import type { Point } from "./geometry.js";
import { layerDistance, netLayerLengths } from "./net-stats.js";
import { onLayer } from "./fab.js";
import { padPolygons } from "./zone-fill.js";

type Node = { kind: "track"; t: Track } | { kind: "via"; v: Via } | { kind: "pad"; pad: Pad; ref: string; uuid: string };
const idOf = (n: Node) => (n.kind === "track" ? n.t.uuid : n.kind === "via" ? n.v.uuid : n.uuid);

function inPolys(p: Point, polys: Point[][]): boolean {
  let inside = false;
  for (const poly of polys)
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  return inside;
}

/** Distance from p to the arc through a, m, b (its ends when p is outside the arc's sweep). */
function arcDist(p: Point, a: Point, m: Point, b: Point): number {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  const ends = Math.min(Math.hypot(p.x - a.x, p.y - a.y), Math.hypot(p.x - b.x, p.y - b.y));
  if (Math.abs(d) < 1e-12) return ends;
  const s2 = (q: Point) => q.x * q.x + q.y * q.y;
  const c = { x: (s2(a) * (m.y - b.y) + s2(m) * (b.y - a.y) + s2(b) * (a.y - m.y)) / d, y: (s2(a) * (b.x - m.x) + s2(m) * (a.x - b.x) + s2(b) * (m.x - a.x)) / d };
  const r = Math.hypot(a.x - c.x, a.y - c.y);
  const ang = (q: Point) => Math.atan2(q.y - c.y, q.x - c.x);
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const t0 = ang(a);
  const ccw = norm(ang(m) - t0) <= norm(ang(b) - t0);
  const sweep = ccw ? norm(ang(b) - t0) : norm(t0 - ang(b));
  const off = ccw ? norm(ang(p) - t0) : norm(t0 - ang(p));
  return off <= sweep ? Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - r) : ends;
}

/**
 * A net's connection graph as KiCad's connectivity builds it (CN items): two
 * items on a shared copper layer join when an anchor of one (a track's ends, a
 * via's or pad's centre) lies on the other's copper (a track with its width, a
 * via's disc, a pad flashed on that layer). Zones are left out.
 */
function netGraph(board: Board, net: string): { nodes: Node[]; adj: number[][] } {
  const nodes: Node[] = [];
  for (const t of board.tracks) if (t.net === net) nodes.push({ kind: "track", t });
  for (const v of board.vias) if (v.net === net) nodes.push({ kind: "via", v });
  for (const fp of board.footprints) fp.pads.forEach((pad, k) => pad.net === net && nodes.push({ kind: "pad", pad, ref: fp.reference, uuid: `${fp.uuid}#${k}` }));
  const copper = board.copperLayers;
  const flashed = flashChecker(board);
  const polys = new Map<Pad, Point[][]>();
  const padPolys = (p: Pad) => polys.get(p) ?? polys.set(p, padPolygons(p, 0)).get(p)!;
  const layersOf = (n: Node): string[] => {
    if (n.kind === "track") return [n.t.layer];
    if (n.kind === "via") {
      const [a, b] = [copper.indexOf(n.v.layers[0]!), copper.indexOf(n.v.layers[n.v.layers.length - 1]!)];
      return copper.slice(Math.min(a, b), Math.max(a, b) + 1);
    }
    return copper.filter((l) => onLayer(n.pad.layers, l) && flashed(n.pad, l));
  };
  const anchors = (n: Node): Point[] => (n.kind === "track" ? [n.t.start, n.t.end] : n.kind === "via" ? [n.v.at] : [n.pad.at]);
  const segDist = (p: Point, a: Point, b: Point) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const u = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
  };
  const covers = (n: Node, p: Point): boolean => {
    if (n.kind === "track") {
      if (n.t.kind === "arc" && n.t.mid) return arcDist(p, n.t.start, n.t.mid, n.t.end) <= n.t.width / 2 + 1e-6;
      return segDist(p, n.t.start, n.t.end) <= n.t.width / 2 + 1e-6;
    }
    if (n.kind === "via") return Math.hypot(p.x - n.v.at.x, p.y - n.v.at.y) <= n.v.size / 2 + 1e-6;
    return inPolys(p, padPolys(n.pad));
  };
  const L = nodes.map(layersOf);
  const A = nodes.map(anchors);
  const box = nodes.map((n) => {
    const pts = n.kind === "track" ? [n.t.start, n.t.end, ...(n.t.mid ? [n.t.mid] : [])] : n.kind === "via" ? [n.v.at] : padPolys(n.pad).flat();
    const r = n.kind === "track" ? n.t.width / 2 : n.kind === "via" ? n.v.size / 2 : 0;
    return { x0: Math.min(...pts.map((q) => q.x)) - r, y0: Math.min(...pts.map((q) => q.y)) - r, x1: Math.max(...pts.map((q) => q.x)) + r, y1: Math.max(...pts.map((q) => q.y)) + r };
  });
  const adj: number[][] = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = box[i]!, b = box[j]!;
      if (a.x0 > b.x1 || b.x0 > a.x1 || a.y0 > b.y1 || b.y0 > a.y1) continue;
      if (!L[i]!.some((l) => L[j]!.includes(l))) continue;
      if (A[i]!.some((p) => covers(nodes[j]!, p)) || A[j]!.some((p) => covers(nodes[i]!, p))) {
        adj[i]!.push(j);
        adj[j]!.push(i);
      }
    }
  return { nodes, adj };
}

/** KiCad's uniquePathBetweenNodes: breadth-first over whole paths, a vertex never revisited on its path nor taken by a queued one. */
function pathBetween(adj: number[][], u: number, v: number): number[] | undefined {
  const Q: number[][] = [[u]];
  let found: number[] | undefined;
  while (Q.length) {
    const path = Q.shift()!;
    const last = path[path.length - 1]!;
    if (last === v) {
      if (found) return path;
      found = path;
    }
    for (const c of adj[last]!) {
      if (path.includes(c) || Q.some((p) => p.includes(c))) continue;
      Q.push([...path, c]);
    }
  }
  return found;
}

/** KiCad's WildCompareString, case-insensitive. */
function wild(pattern: string, s: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return re.test(s);
}

/** The from-to paths of a board: which items lie on a path from a `from` pad to its one `to` pad. */
export function fromToCache(board: Board) {
  const graphs = new Map<string, ReturnType<typeof netGraph>>();
  const graph = (net: string) => graphs.get(net) ?? graphs.set(net, netGraph(board, net)).get(net)!;
  const cache = new Map<string, Set<string>>();
  const paths = (from: string, to: string): Set<string> => {
    const key = `${from}\0${to}`;
    let on = cache.get(key);
    if (on) return on;
    on = new Set();
    cache.set(key, on);
    for (const fp of board.footprints)
      for (const pad of fp.pads) {
        if (!pad.net) continue;
        // Each pad answers to "REF-PAD" and to "REF": a path for each name that matches.
        const names = [`${fp.reference}-${pad.number}`, fp.reference].filter((n) => wild(from, n));
        if (!names.length) continue;
        const g = graph(pad.net);
        const u = g.nodes.findIndex((n) => n.kind === "pad" && n.pad === pad);
        // The pads connected to it (zones don't join), and the one matching `to`.
        const seen = new Set([u]);
        const queue = [u];
        for (let h = 0; h < queue.length; h++) for (const c of g.adj[queue[h]!]!) if (!seen.has(c)) (seen.add(c), queue.push(c));
        let target = -1, count = 0;
        for (const j of seen) {
          const n = g.nodes[j]!;
          if (j === u || n.kind !== "pad") continue;
          for (const name of [`${n.ref}-${n.pad.number}`, n.ref]) if (wild(to, name)) (count++, (target = j));
        }
        if (count !== 1) continue;
        const p = pathBetween(g.adj, u, target);
        if (p) for (const i of p) on.add(idOf(g.nodes[i]!));
      }
    return on;
  };
  return { isOnFromToPath: (uuid: string, from: string, to: string) => paths(from, to).has(uuid) };
}

export interface LengthViolation {
  type: "length_out_of_range" | "skew_out_of_range";
  rule: string;
  net: string;
  /** The measured length (mm), and the skew against the rule's longest net for skews. */
  actual: number;
  min?: number;
  max?: number;
  at: Point;
  message: string;
  items: DrcItem[];
}

/**
 * Length and skew constraints of the custom rules (KiCad's length_out_of_range
 * and skew_out_of_range), measured per rule and net.
 */
export function checkLengthRules(board: Board, rules: DesignRules, custom: DruRule[]): LengthViolation[] {
  const withLength = custom.filter((r) => r.constraints.some((c) => c.type === "length" || c.type === "skew"));
  if (!withLength.length) return [];
  const ft = fromToCache(board);
  const nets = new Set(board.nets);
  const groups = new Map<string, { rule: string; net: string; tracks: Track[]; vias: Via[]; pads: Pad[] }>();
  const add = (type: "length" | "skew", item: RuleItem & { uuid: string }, net: string, put: (g: { tracks: Track[]; vias: Via[]; pads: Pad[] }) => void) => {
    const c = customConstraint(custom, type, item, item.layer);
    if (!c) return;
    const key = `${type}\0${c.rule}\0${net}`;
    const g = groups.get(key) ?? groups.set(key, { rule: c.rule, net, tracks: [], vias: [], pads: [] }).get(key)!;
    put(g);
  };
  const base = (type: RuleItem["type"], net: string, uuid: string, layers: string[], layer?: string, reference?: string): RuleItem & { uuid: string } => ({
    type,
    uuid,
    netName: net,
    netClass: netClassOf(rules, net).name,
    layer,
    layers: new Set(layers),
    reference,
    hasNet: (n) => nets.has(n),
    intersectsArea: () => false,
    fromTo: (from, to) => ft.isOnFromToPath(uuid, from, to),
  });
  for (const type of ["length", "skew"] as const) {
    if (!withLength.some((r) => r.constraints.some((c) => c.type === type))) continue;
    for (const t of board.tracks) if (t.net) add(type, base("Track", t.net, t.uuid, [t.layer], t.layer), t.net, (g) => g.tracks.push(t));
    for (const v of board.vias) if (v.net) add(type, base("Via", v.net, v.uuid, v.layers), v.net, (g) => g.vias.push(v));
    for (const fp of board.footprints)
      fp.pads.forEach((pad, k) => {
        if (pad.net) add(type, base("Pad", pad.net, `${fp.uuid}#${k}`, pad.layers, undefined, fp.reference), pad.net, (g) => g.pads.push(pad));
      });
  }
  const copper = board.copperLayers;
  const lengthOf = (g: { tracks: Track[]; vias: Via[]; pads: Pad[] }) => {
    const track = Object.values(netLayerLengths(board, "", { tracks: g.tracks, vias: g.vias, pads: g.pads.map((pad) => ({ pad })) })).reduce((a, b) => a + b, 0);
    // A via counts the stackup between the outermost layers of the tracks that end in it (no via-in-pad inference).
    let via = 0;
    for (const v of g.vias) {
      const r = v.size / 2 + 1e-9;
      const used = new Set(g.tracks.filter((t) => [t.start, t.end].some((q) => Math.hypot(q.x - v.at.x, q.y - v.at.y) <= r)).map((t) => t.layer));
      const span = copper.filter((l) => used.has(l));
      if (span.length >= 2) via += layerDistance(board, span[0]!, span[span.length - 1]!);
    }
    const dieLength = g.pads.reduce((s, p) => s + (p.dieLength ?? 0), 0);
    return track + via + dieLength;
  };
  const out: LengthViolation[] = [];
  const byRule = new Map<string, Array<{ g: { rule: string; net: string; tracks: Track[]; vias: Via[]; pads: Pad[] }; total: number }>>();
  for (const [key, g] of groups) {
    const type = key.split("\0")[0] as "length" | "skew";
    const total = lengthOf(g);
    if (type === "skew") (byRule.get(g.rule) ?? byRule.set(g.rule, []).get(g.rule)!).push({ g, total });
    else {
      const c = custom.find((r) => r.name === g.rule)!.constraints.find((x) => x.type === "length")!;
      const low = c.min !== undefined && total < c.min;
      const high = !low && c.max !== undefined && total > c.max;
      if (low || high) out.push(violation("length_out_of_range", g, total, c.min, c.max, `Track length out of range (rule '${g.rule}' ${low ? `min length ${c.min!.toFixed(4)}` : `max length ${c.max!.toFixed(4)}`} mm; actual ${total.toFixed(4)} mm)`));
    }
  }
  for (const [rule, list] of byRule) {
    const c = custom.find((r) => r.name === rule)!.constraints.find((x) => x.type === "skew")!;
    const longest = Math.max(...list.map((e) => e.total));
    for (const { g, total } of list) {
      const skew = Math.abs(total - longest);
      if ((c.max !== undefined && skew > c.max) || (c.min !== undefined && skew < c.min))
        out.push(violation("skew_out_of_range", g, skew, c.min, c.max, `Skew between traces out of range (rule '${rule}' ${c.max !== undefined && skew > c.max ? `max skew ${c.max.toFixed(4)}` : `min skew ${c.min!.toFixed(4)}`} mm; actual ${skew.toFixed(4)} mm)`));
    }
  }
  return out;
}

function violation(type: LengthViolation["type"], g: { rule: string; net: string; tracks: Track[]; vias: Via[]; pads: Pad[] }, actual: number, min: number | undefined, max: number | undefined, message: string): LengthViolation {
  const at = g.tracks[0]?.start ?? g.vias[0]?.at ?? g.pads[0]?.at ?? { x: 0, y: 0 };
  const items: DrcItem[] = [
    ...g.tracks.map((t): DrcItem => ({ kind: "track", net: t.net, uuid: t.uuid, description: `Track [${t.net}] on ${t.layer}` })),
    ...g.vias.map((v): DrcItem => ({ kind: "via", net: v.net, uuid: v.uuid, at: v.at, description: `Via [${v.net}]` })),
  ];
  return { type, rule: g.rule, net: g.net, actual, min, max, at, message, items };
}

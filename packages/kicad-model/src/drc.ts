/**
 * Copper clearance checks (a subset of KiCad's DRC): pads, tracks and vias
 * of different nets that are closer than their net classes allow, and
 * shorts between them. Net classes, patterns and the board minimum come from
 * the .kicad_pro, as in KiCad. Zone fills, custom rules and hole/edge
 * clearances are not checked yet.
 *
 * Shapes are reduced to convex cores plus a radius (a track is a segment of
 * radius w/2, a round-rect pad a smaller rectangle of radius r), so the
 * distance between two items is the core distance minus both radii.
 */
import { flashChecker, padCorners, unplatedCopper, type Board, type Footprint, type Graphic, type Pad } from "./board.js";
import { customClearance, type DruRule, type RuleItem } from "./drc-rules.js";
import type { Point } from "./geometry.js";

export interface NetClass {
  name: string;
  clearance: number;
  /** The project leaves this class's clearance unset (it falls back to Default's; KiCad's job file counts it as 0). */
  clearanceUnset?: boolean;
  trackWidth: number;
  viaDiameter: number;
  viaDrill: number;
  /** Gap between the two nets of a differential pair. */
  diffPairGap?: number;
  /** Track width of a differential pair. */
  diffPairWidth?: number;
  /** Gap between a differential pair's two vias. */
  diffPairViaGap?: number;
  /** Lower comes first when classes combine (KiCad's priority; Default is last). */
  priority?: number;
  /** The values the project sets for this class (the others come from Default). */
  defines?: string[];
  /** A net in several classes: the classes, by priority, that make this combined one. */
  constituents?: string[];
}

export interface DesignRules {
  classes: Map<string, NetClass>;
  /** Net class patterns in order (KiCad wildcards * and ?). */
  patterns: Array<{ pattern: string; netclass: string }>;
  /** Explicit net → class assignments (KiCad keeps the classes the schematic gives each net here). */
  assignments: Map<string, string[]>;
  minClearance: number;
  /** Copper to board edge (min_copper_edge_clearance). */
  copperEdgeClearance?: number;
  /** Copper to holes (min_hole_clearance). */
  holeClearance?: number;
  /** Custom rules from the project's .kicad_dru. */
  custom?: DruRule[];
  /** Per-check severity from Board Setup ("error", "warning", "ignore"). */
  severities?: Record<string, string>;
  /** Violations the designer excluded: "type|x|y|uuid|uuid" (positions in nm). */
  exclusions?: string[];
  /** Board minimums from Board Setup → Constraints (KiCad's defaults when absent). */
  minHoleSize?: number;
  minViaAnnular?: number;
  minHoleToHole?: number;
  minTrackWidth?: number;
  /** Narrowest copper neck allowed (min_connection); 0 = not checked. */
  minConnection?: number;
  /** Largest arc approximation error (max_error), mm. */
  maxError?: number;
  minViaDiameter?: number;
  minResolvedSpokes?: number;
  minTextHeight?: number;
  /** Silkscreen to silkscreen and to the board edge (min_silk_clearance). */
  minSilkClearance?: number;
  minTextThickness?: number;
}

const DEFAULT_CLASS: NetClass = { name: "Default", clearance: 0.2, trackWidth: 0.25, viaDiameter: 0.8, viaDrill: 0.4 };

/** Design rules from a .kicad_pro (KiCad's defaults when absent). */
export function projectDesignRules(proText?: string): DesignRules {
  const rules: DesignRules = { classes: new Map([["Default", DEFAULT_CLASS]]), patterns: [], assignments: new Map(), minClearance: 0 };
  if (!proText) return rules;
  try {
    const pro = JSON.parse(proText);
    const ns = pro.net_settings ?? {};
    for (const c of ns.classes ?? []) {
      if (!c?.name) continue;
      const base = rules.classes.get("Default")!;
      rules.classes.set(c.name, {
        name: c.name,
        priority: c.name === "Default" ? Number.MAX_SAFE_INTEGER : typeof c.priority === "number" ? c.priority : 0,
        defines: NET_CLASS_FIELDS.filter((k) => typeof c[k] === "number"),
        clearance: num(c.clearance, base.clearance),
        ...(typeof c.clearance !== "number" && c.name !== "Default" ? { clearanceUnset: true } : {}),
        trackWidth: num(c.track_width, base.trackWidth),
        viaDiameter: num(c.via_diameter, base.viaDiameter),
        viaDrill: num(c.via_drill, base.viaDrill),
        diffPairGap: typeof c.diff_pair_gap === "number" ? c.diff_pair_gap : undefined,
        diffPairWidth: typeof c.diff_pair_width === "number" ? c.diff_pair_width : undefined,
        diffPairViaGap: typeof c.diff_pair_via_gap === "number" ? c.diff_pair_via_gap : undefined,
      });
    }
    for (const p of ns.netclass_patterns ?? []) if (p?.pattern && p?.netclass) rules.patterns.push({ pattern: p.pattern, netclass: p.netclass });
    for (const [net, cls] of Object.entries(ns.netclass_assignments ?? {})) {
      const list = (Array.isArray(cls) ? cls : [cls]).filter((c): c is string => typeof c === "string" && c !== "");
      if (list.length) rules.assignments.set(net, list);
    }
    const r = pro.board?.design_settings?.rules;
    rules.minClearance = num(r?.min_clearance, 0);
    rules.copperEdgeClearance = num(r?.min_copper_edge_clearance, 0);
    rules.holeClearance = num(r?.min_hole_clearance, 0);
    rules.minHoleSize = num(r?.min_through_hole_diameter, 0.3);
    rules.minViaAnnular = num(r?.min_via_annular_width, 0.1);
    rules.minHoleToHole = num(r?.min_hole_to_hole, 0.25);
    rules.minTrackWidth = num(r?.min_track_width, 0);
    rules.minConnection = num(r?.min_connection, 0);
    rules.maxError = num(r?.max_error, 0.005);
    rules.minViaDiameter = num(r?.min_via_diameter, 0.5);
    rules.minResolvedSpokes = num(r?.min_resolved_spokes, 2);
    rules.minTextHeight = num(r?.min_text_height, 0.8);
    rules.minTextThickness = num(r?.min_text_thickness, 0.08);
    rules.minSilkClearance = num(r?.min_silk_clearance, 0);
    const ds = pro.board?.design_settings ?? {};
    if (ds.rule_severities && typeof ds.rule_severities === "object") rules.severities = ds.rule_severities;
    if (Array.isArray(ds.drc_exclusions)) rules.exclusions = ds.drc_exclusions.map((e: unknown) => (Array.isArray(e) ? String(e[0]) : String(e)));
  } catch {
    // A project file we can't read leaves KiCad's defaults.
  }
  return rules;
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

const wildcardCache = new Map<string, RegExp>();
function wildcard(pattern: string): RegExp {
  const hit = wildcardCache.get(pattern);
  if (hit) return hit;
  const re = compileWildcard(pattern);
  wildcardCache.set(pattern, re);
  return re;
}
function compileWildcard(pattern: string): RegExp {
  // A net class pattern is a wildcard ("osc*") or a regular expression ("in\d+") that matches the whole name.
  const glob = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  try {
    return new RegExp(`^(?:${glob}|${pattern})$`);
  } catch {
    return new RegExp(`^${glob}$`);
  }
}

/** The net class of a net: explicit assignment, then the first matching pattern, else Default. */
const classCache = new WeakMap<DesignRules, Map<string, NetClass>>();
export function netClassOf(rules: DesignRules, net: string): NetClass {
  let cache = classCache.get(rules);
  if (!cache) classCache.set(rules, (cache = new Map()));
  let c = cache.get(net);
  if (!c) cache.set(net, (c = resolveNetClass(rules, net)));
  return c;
}
/**
 * A net's class as KiCad 10 makes it: every class assigned to the net (by the schematic) and
 * every class whose pattern matches its name. One that sets all its values is the class itself;
 * several, or one that leaves values unset, combine: values from the highest priority class
 * that sets them, the rest from Default, named after the classes in priority order ("A,B,Default").
 * A class named in the schematic but not set up is an empty one, just above Default.
 */
function resolveNetClass(rules: DesignRules, net: string): NetClass {
  const fallback = rules.classes.get("Default") ?? DEFAULT_CLASS;
  const found = new Map<string, NetClass>();
  const take = (name: string) => {
    if (found.has(name)) return;
    found.set(name, rules.classes.get(name) ?? { ...fallback, name, priority: Number.MAX_SAFE_INTEGER - 1, defines: [] });
  };
  for (const name of rules.assignments.get(net) ?? []) take(name);
  const short = net.slice(net.lastIndexOf("/") + 1);
  for (const p of rules.patterns) {
    const re = wildcard(p.pattern);
    if (re.test(net) || re.test(short)) take(p.netclass);
  }
  if (!found.size) return fallback;
  const order = [...found.values()].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const defined = (c: NetClass) => c.defines ?? NET_CLASS_FIELDS;
  const needsDefault = !order.some((c) => c.name === "Default") && REQUIRED_FIELDS.some((k) => !order.some((c) => defined(c).includes(k)));
  if (order.length === 1 && !needsDefault) return order[0]!;
  const all = needsDefault ? [...order, fallback] : order;
  // Each value from the first class (by priority) that sets it.
  const pick = <K extends keyof NetClass>(field: (typeof NET_CLASS_FIELDS)[number], key: K): NetClass[K] => (all.find((c) => defined(c).includes(field)) ?? fallback)[key];
  return {
    name: all.map((c) => c.name).join(","),
    clearance: pick("clearance", "clearance"),
    trackWidth: pick("track_width", "trackWidth"),
    viaDiameter: pick("via_diameter", "viaDiameter"),
    viaDrill: pick("via_drill", "viaDrill"),
    diffPairGap: pick("diff_pair_gap", "diffPairGap"),
    diffPairWidth: pick("diff_pair_width", "diffPairWidth"),
    diffPairViaGap: pick("diff_pair_via_gap", "diffPairViaGap"),
    // Only Default sets the clearance: as for a single class that leaves it unset.
    ...(!order.some((c) => c.name !== "Default" && defined(c).includes("clearance")) && order.some((c) => c.clearanceUnset) ? { clearanceUnset: true } : {}),
    constituents: all.map((c) => c.name),
  };
}

/** The values a net class can set, by their project file names. */
const NET_CLASS_FIELDS = ["clearance", "track_width", "via_diameter", "via_drill", "microvia_diameter", "microvia_drill", "diff_pair_width", "diff_pair_gap", "diff_pair_via_gap", "wire_width", "bus_width"] as const;
/**
 * The values a class must set to stand alone; one missing brings Default in. (KiCad lists the via
 * gap of a pair too, but a class that leaves only that unset stands alone in its netlists.)
 */
const REQUIRED_FIELDS: ReadonlyArray<(typeof NET_CLASS_FIELDS)[number]> = ["clearance", "track_width", "via_diameter", "via_drill", "microvia_diameter", "microvia_drill", "diff_pair_width", "diff_pair_gap"];

/**
 * The base name if `a` and `b` are the two nets of a differential pair, as
 * KiCad recognises them: names differing only in a final +/- or P/N.
 */
export function diffPairBase(a: string, b: string): string | undefined {
  if (a.length !== b.length || a.length < 2) return undefined;
  const base = a.slice(0, -1);
  if (base !== b.slice(0, -1)) return undefined;
  const pair = [a.at(-1), b.at(-1)].sort().join("");
  return pair === "+-" || pair === "NP" ? base : undefined;
}

// ---------------------------------------------------------------------------
// Geometry: convex cores with a radius
// ---------------------------------------------------------------------------

export type Shape = { kind: "seg"; a: Point; b: Point; r: number } | { kind: "poly"; pts: Point[]; r: number } | Area;

/**
 * An arbitrary simple polygon (e.g. a zone fill in KiCad's fractured form),
 * with its edges indexed in a grid for nearest-edge and inside queries.
 */
interface Area {
  kind: "area";
  pts: Point[];
  r: 0;
  grid: Map<number, number[]>;
  /** Per-edge stamps, to de-duplicate edges found in several cells without a Set. */
  stamp: Uint32Array;
  box: { x0: number; y0: number; x1: number; y1: number };
  /** Edges are an open chain (board edges), not a closed polygon. */
  open?: boolean;
}

const AREA_CELL = 1;

/** Numeric key of a grid cell (cells are ints well inside ±2^20). */
const cellKey = (x: number, y: number) => (x + 1048576) * 2097152 + (y + 1048576);
let stampCounter = 0;

export function buildArea(pts: Point[], open = false): Area {
  const grid = new Map<number, number[]>();
  const n = open ? pts.length - 1 : pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const x0 = Math.floor(Math.min(a.x, b.x) / AREA_CELL), x1 = Math.floor(Math.max(a.x, b.x) / AREA_CELL);
    const y0 = Math.floor(Math.min(a.y, b.y) / AREA_CELL), y1 = Math.floor(Math.max(a.y, b.y) / AREA_CELL);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = cellKey(x, y);
        const l = grid.get(k);
        if (l) l.push(i);
        else grid.set(k, [i]);
      }
  }
  // (Loops, not Math.min(...): fills can have hundreds of thousands of points.)
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of pts) {
    if (p.x < box.x0) box.x0 = p.x;
    if (p.x > box.x1) box.x1 = p.x;
    if (p.y < box.y0) box.y0 = p.y;
    if (p.y > box.y1) box.y1 = p.y;
  }
  return { kind: "area", pts, r: 0, grid, stamp: new Uint32Array(pts.length), open, box };
}

/** Indices of an area's edges near a box. */
function areaEdgesNear(A: Area, x0: number, y0: number, x1: number, y1: number): number[] {
  const out: number[] = [];
  const stamp = ++stampCounter >>> 0 || ++stampCounter;
  const cx1 = Math.floor(x1 / AREA_CELL), cy0 = Math.floor(y0 / AREA_CELL), cy1 = Math.floor(y1 / AREA_CELL);
  for (let x = Math.floor(x0 / AREA_CELL); x <= cx1; x++)
    for (let y = cy0; y <= cy1; y++) {
      const l = A.grid.get(cellKey(x, y));
      if (!l) continue;
      for (const i of l)
        if (A.stamp[i] !== stamp) {
          A.stamp[i] = stamp;
          out.push(i);
        }
    }
  return out;
}

/** Even-odd inside test with a ray to +x, through the grid row only. */
function inArea(A: Area, p: Point): boolean {
  if (A.open || p.x < A.box.x0 || p.x > A.box.x1 || p.y < A.box.y0 || p.y > A.box.y1) return false;
  let inside = false;
  for (const i of areaEdgesNear(A, p.x, p.y, A.box.x1, p.y)) {
    const a = A.pts[i]!;
    const b = A.pts[(i + 1) % A.pts.length]!;
    if (a.y > p.y !== b.y > p.y && p.x < a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y)) inside = !inside;
  }
  return inside;
}

const areaEdge = (A: Area, i: number): [Point, Point] => [A.pts[i]!, A.pts[(i + 1) % A.pts.length]!];

const sub = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const lerp = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Closest points between segments ab and cd. */
function segSeg(a: Point, b: Point, c: Point, d: Point): { dist: number; p: Point; q: Point } {
  // Intersection first.
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) > 1e-12) {
    const t = cross(sub(c, a), s) / den;
    const u = cross(sub(c, a), r) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const p = lerp(a, b, t);
      return { dist: 0, p, q: p };
    }
  }
  const cands = [ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b)];
  const best = [
    { dist: cands[0]!.dist, p: a, q: cands[0]!.q },
    { dist: cands[1]!.dist, p: b, q: cands[1]!.q },
    { dist: cands[2]!.dist, p: cands[2]!.q, q: c },
    { dist: cands[3]!.dist, p: cands[3]!.q, q: d },
  ];
  return best.reduce((m, x) => (x.dist < m.dist ? x : m));
}

function ptSeg(p: Point, a: Point, b: Point): { dist: number; q: Point } {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2)) : 0;
  const q = lerp(a, b, t);
  return { dist: Math.hypot(p.x - q.x, p.y - q.y), q };
}

function inPoly(p: Point, pts: Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const c = cross(sub(pts[(i + 1) % pts.length]!, pts[i]!), sub(p, pts[i]!));
    if (Math.abs(c) < 1e-12) continue;
    const sgn = Math.sign(c);
    if (sign && sgn !== sign) return false;
    sign = sgn;
  }
  // A degenerate polygon (e.g. a round rect whose core collapsed to a point) contains nothing.
  return sign !== 0;
}

const edges = (s: Exclude<Shape, Area>): Array<[Point, Point]> =>
  s.kind === "seg" ? [[s.a, s.b]] : s.pts.map((p, i) => [p, s.pts[(i + 1) % s.pts.length]!] as [Point, Point]);

export function shapeBox(s: Shape) {
  if (s.kind === "area") return s.box;
  const pts = s.kind === "seg" ? [s.a, s.b] : s.pts;
  return {
    x0: Math.min(...pts.map((p) => p.x)) - s.r,
    y0: Math.min(...pts.map((p) => p.y)) - s.r,
    x1: Math.max(...pts.map((p) => p.x)) + s.r,
    y1: Math.max(...pts.map((p) => p.y)) + s.r,
  };
}

/**
 * Distance between two shapes' copper (negative: overlap), with the closest
 * point pair. Areas only look at edges within `reach` (beyond it the result
 * is just "far enough").
 */
export function shapeDistance(A: Shape, B: Shape, reach = 1): { dist: number; at: Point } {
  if (A.kind === "area" && B.kind !== "area") return shapeDistance(B, A, reach);
  if (B.kind === "area") {
    const firstA = A.kind === "seg" ? A.a : A.pts[0]!;
    // Containment by an interior point (the centre, nudged off any exact
    // vertex height: fractured fills have zero-width bridges at those).
    const c = A.kind === "seg" ? lerp(A.a, A.b, 0.5) : A.kind === "poly" ? { x: A.pts.reduce((t, p) => t + p.x, 0) / A.pts.length, y: A.pts.reduce((t, p) => t + p.y, 0) / A.pts.length } : A.pts[0]!;
    const probe = { x: c.x + 1.37e-7, y: c.y + 2.91e-7 };
    if (A.kind !== "area" && inArea(B, probe)) return { dist: -A.r, at: c };
    if (A.kind === "area" && inArea(A, B.pts[0]!)) return { dist: 0, at: B.pts[0]! };
    if (A.kind === "poly" && inPoly(B.pts[0]!, A.pts)) return { dist: -A.r, at: B.pts[0]! };
    let best = { dist: Infinity, p: firstA, q: firstA };
    const aEdges = A.kind === "area" ? A.pts.map((_, i) => areaEdge(A, i)).slice(0, A.open ? -1 : undefined) : edges(A);
    for (const [a, b] of aEdges) {
      const g = reach + A.r;
      for (const i of areaEdgesNear(B, Math.min(a.x, b.x) - g, Math.min(a.y, b.y) - g, Math.max(a.x, b.x) + g, Math.max(a.y, b.y) + g)) {
        const [c, d] = areaEdge(B, i);
        const r = segSeg(a, b, c, d);
        if (r.dist < best.dist) best = r;
      }
    }
    return { dist: best.dist - A.r, at: lerp(best.p, best.q, 0.5) };
  }
  return convexDistance(A as Exclude<Shape, Area>, B);
}

function convexDistance(A: Exclude<Shape, Area>, B: Exclude<Shape, Area>): { dist: number; at: Point } {
  // A core inside the other polygon → overlapping.
  const firstA = A.kind === "seg" ? A.a : A.pts[0]!;
  const firstB = B.kind === "seg" ? B.a : B.pts[0]!;
  if (B.kind === "poly" && inPoly(firstA, B.pts)) return { dist: -A.r - B.r, at: firstA };
  if (A.kind === "poly" && inPoly(firstB, A.pts)) return { dist: -A.r - B.r, at: firstB };
  let best = { dist: Infinity, p: firstA, q: firstB };
  for (const [a, b] of edges(A)) for (const [c, d] of edges(B)) {
    const r = segSeg(a, b, c, d);
    if (r.dist < best.dist) best = r;
  }
  return { dist: best.dist - A.r - B.r, at: lerp(best.p, best.q, 0.5) };
}

const rot = (p: Point, deg: number): Point => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c };
};

/** A pad's copper as shapes: its main shape, plus a custom pad's primitives (in the pad frame). */
export function padShapes(pad: Pad): Shape[] {
  const main = padShape(pad);
  if (pad.shape !== "custom" || !pad.primitives?.length) return [main];
  const at = pad.offset ? (() => {
    const o = rot(pad.offset!, pad.rotation);
    return { x: pad.at.x + o.x, y: pad.at.y + o.y };
  })() : pad.at;
  const place = (p: Point) => {
    const q = rot(p, pad.rotation);
    return { x: at.x + q.x, y: at.y + q.y };
  };
  const out: Shape[] = pad.size.x > 0 && pad.size.y > 0 ? [main] : [];
  for (const pr of pad.primitives) {
    const r = pr.width / 2;
    const pts = pr.points.map(place);
    if (pr.kind === "poly" && pts.length >= 3) out.push({ kind: "poly", pts, r });
    else if (pr.kind === "rect" && pr.points.length === 2) {
      const [a, b] = pr.points as [Point, Point];
      out.push({ kind: "poly", pts: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }].map(place), r });
    } else if (pr.kind === "circle" && pts.length === 2) {
      const rad = Math.hypot(pr.points[1]!.x - pr.points[0]!.x, pr.points[1]!.y - pr.points[0]!.y);
      out.push({ kind: "seg", a: pts[0]!, b: pts[0]!, r: pr.fill ? rad + r : rad + r });
    } else if (pr.kind === "arc" && pts.length === 3) {
      const arc = arcPoints(pts[0]!, pts[1]!, pts[2]!).pts;
      for (let k = 1; k < arc.length; k++) out.push({ kind: "seg", a: arc[k - 1]!, b: arc[k]!, r });
    } else if (pts.length >= 2) for (let k = 1; k < pts.length; k++) out.push({ kind: "seg", a: pts[k - 1]!, b: pts[k]!, r });
  }
  return out;
}

function padShape(pad: Pad): Shape {
  const { x: w, y: h } = pad.size;
  // The copper is centred on the hole plus the pad's offset.
  const at = pad.offset ? (() => {
    const o = rot(pad.offset!, pad.rotation);
    return { x: pad.at.x + o.x, y: pad.at.y + o.y };
  })() : pad.at;
  const place = (p: Point) => {
    const q = rot(p, pad.rotation);
    return { x: at.x + q.x, y: at.y + q.y };
  };
  if (pad.shape === "circle") return { kind: "seg", a: at, b: at, r: w / 2 };
  if (pad.shape === "oval") {
    const r = Math.min(w, h) / 2;
    const half = w > h ? { x: w / 2 - r, y: 0 } : { x: 0, y: h / 2 - r };
    return { kind: "seg", a: place({ x: -half.x, y: -half.y }), b: place(half), r };
  }
  // Chamfered (octagon-like): a convex polygon.
  if (pad.chamfer && (pad.shape === "rect" || pad.shape === "roundrect")) return { kind: "poly", pts: padCorners(pad).map(place), r: 0 };
  // Round rect: a smaller rectangle with the corner radius as the shape radius.
  const r = pad.shape === "roundrect" ? Math.min(w, h) * (pad.roundrectRatio ?? 0.25) : 0;
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  return { kind: "poly", pts: [place({ x: -hw, y: -hh }), place({ x: hw, y: -hh }), place({ x: hw, y: hh }), place({ x: -hw, y: hh })], r };
}

// ---------------------------------------------------------------------------

/** One side of a violation: what it is, for display and for matching KiCad's report. */
export interface DrcItem {
  kind: "pad" | "track" | "via" | "zone" | "graphic" | "edge";
  net: string;
  description: string;
  reference?: string;
  pad?: string;
  /** Tracks: length in mm (arcs: arc length). */
  length?: number;
  /** Vias: position. */
  at?: Point;
  /** The board item's UUID (pad, track, via, footprint), for DRC exclusions. */
  uuid?: string;
}

export interface ClearanceViolation {
  /** "edge": copper closer to the board edge than the copper-to-edge clearance; "hole": copper too close to another item's drilled hole. */
  type: "clearance" | "short" | "edge" | "hole";
  layer: string;
  at: Point;
  /** Actual copper gap in mm (0 for a short). */
  actual: number;
  required: number;
  nets: [string, string];
  items: [DrcItem, DrcItem];
  /** The custom rule that set the requirement, if one did. */
  rule?: string;
}

export interface CopperItem {
  shapes: Shape[];
  layers: Set<string>;
  item: DrcItem;
  /** Local clearance override (pad, else footprint). */
  override?: number;
  /** Pads: "<footprint uuid>\0<pad number>" — pads sharing it are one logical pad. */
  logicalPad?: string;
  /** The item's own layer as rule conditions see it (A.Layer); multi-layer pads and vias have none. */
  ruleLayer?: string;
  /** An unplated pad's copper: its hole, as checkClearance keys it (KiCad reports one of copper and hole clearance). */
  hole?: string;
  box: { x0: number; y0: number; x1: number; y1: number };
}

function boxOf(shapes: Shape[]) {
  const bs = shapes.map(shapeBox);
  return {
    x0: Math.min(...bs.map((b) => b.x0)),
    y0: Math.min(...bs.map((b) => b.y0)),
    x1: Math.max(...bs.map((b) => b.x1)),
    y1: Math.max(...bs.map((b) => b.y1)),
  };
}

/** A graphic's copper as shapes (strokes as segments, filled shapes as areas). */
export function graphicShapes(g: Graphic): Shape[] {
  const r = g.width / 2;
  const pts = g.points;
  const strokes = (path: Point[]): Shape[] => path.slice(1).map((b, i) => ({ kind: "seg", a: path[i]!, b, r }));
  switch (g.kind) {
    case "line":
      return strokes(pts.slice(0, 2));
    case "arc":
      return strokes(arcPoints(pts[0]!, pts[1]!, pts[2]!).pts);
    case "circle": {
      const rad = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
      if (g.fill) return [{ kind: "seg", a: pts[0]!, b: pts[0]!, r: rad + r }];
      const ring = Array.from({ length: 65 }, (_, i) => ({ x: pts[0]!.x + rad * Math.cos((i * Math.PI) / 32), y: pts[0]!.y + rad * Math.sin((i * Math.PI) / 32) }));
      return strokes(ring);
    }
    case "rect": {
      const [a, b] = [pts[0]!, pts[1]!];
      const loop = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
      return g.fill ? [buildArea(loop), ...(r ? strokes([...loop, a]) : [])] : strokes([...loop, a]);
    }
    default:
      if (pts.length < 2) return [];
      return g.fill || g.kind === "poly" ? [buildArea(pts), ...(r ? strokes([...pts, pts[0]!]) : [])] : strokes(pts);
  }
}

/** Copper layers a pad or via is on. */
function copperLayers(layers: string[], copper: string[], through: boolean): Set<string> {
  if (through) return new Set(copper);
  const out = new Set<string>();
  for (const l of layers) {
    if (l === "*.Cu" || l === "F&B.Cu") copper.forEach((c) => (l === "*.Cu" || c === "F.Cu" || c === "B.Cu") && out.add(c));
    else if (copper.includes(l)) out.add(l);
  }
  return out;
}

/** An arc through start, mid and end as points along the true circle (and its length). */
export function arcPoints(a: Point, m: Point, b: Point, maxSeg = 0.25): { pts: Point[]; length: number } {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-12) return { pts: [a, b], length: Math.hypot(b.x - a.x, b.y - a.y) };
  const sq = (p: Point) => p.x * p.x + p.y * p.y;
  const c = {
    x: (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d,
    y: (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d,
  };
  const r = Math.hypot(a.x - c.x, a.y - c.y);
  const ang = (p: Point) => Math.atan2(p.y - c.y, p.x - c.x);
  const a0 = ang(a);
  let sweep = ang(b) - a0;
  let viaMid = ang(m) - a0;
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  sweep = norm(sweep);
  viaMid = norm(viaMid);
  // Go the way that passes through the midpoint.
  if (viaMid > sweep) sweep -= 2 * Math.PI;
  const length = Math.abs(sweep) * r;
  // Enough chords that each sags less than 0.1 µm from the true arc.
  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - 0.0001 / r)));
  const n = Math.min(512, Math.max(2, Math.ceil(length / maxSeg), Math.ceil(Math.abs(sweep) / maxStep)));
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const t = a0 + (sweep * i) / n;
    return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) };
  });
  pts[0] = a;
  pts[n] = b;
  return { pts, length };
}

/** A pad's hole as checkClearance keys it: its logical pad, or where it is when it has no number. */
const holeKey = (fp: Footprint, pad: Pad) => (pad.number ? `${fp.uuid}\0${pad.number}` : `${fp.uuid}\0@${pad.at.x},${pad.at.y}`);

export function copperItems(board: Board): CopperItem[] {
  const copper = board.copperLayers;
  const items: CopperItem[] = [];
  const flashed = flashChecker(board);
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      // An unplated pad is a bare hole (checkClearance's hole check), unless it has a ring of copper.
      const npth = pad.type === "np_thru_hole";
      if (npth && !unplatedCopper(pad)) continue;
      const layers = new Set([...copperLayers(pad.layers, copper, pad.type === "thru_hole")].filter((l) => npth || flashed(pad, l)));
      if (!layers.size) continue;
      const shapes = padShapes(pad);
      const description = npth ? `NPTH pad${pad.number ? ` ${pad.number}` : ""} of ${fp.reference || "?"}` : `Pad ${pad.number} [${pad.net || "<no net>"}] of ${fp.reference || "?"}`;
      items.push({
        shapes,
        layers,
        item: { kind: "pad", net: pad.net, reference: fp.reference, pad: pad.number, uuid: pad.uuid, description },
        override: pad.clearance ?? fp.clearance,
        logicalPad: pad.number ? `${fp.uuid}\0${pad.number}` : undefined,
        // An SMD pad has a layer (A.Layer); through-hole pads span layers and don't.
        ruleLayer: pad.type === "smd" && layers.size === 1 ? [...layers][0] : undefined,
        hole: npth ? holeKey(fp, pad) : undefined,
        box: boxOf(shapes),
      });
    }
  }
  for (const t of board.tracks) {
    if (!copper.includes(t.layer)) continue;
    const arc = t.kind === "arc" && t.mid ? arcPoints(t.start, t.mid, t.end) : undefined;
    const pts = arc ? arc.pts : [t.start, t.end];
    const shapes: Shape[] = pts.slice(1).map((b, i) => ({ kind: "seg", a: pts[i]!, b, r: t.width / 2 }));
    const length = arc ? arc.length : Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
    items.push({
      shapes,
      layers: new Set([t.layer]),
      ruleLayer: t.layer,
      item: { kind: "track", net: t.net, length, uuid: t.uuid, description: `Track [${t.net || "<no net>"}] on ${t.layer}, length ${length.toFixed(4)} mm` },
      box: boxOf(shapes),
    });
  }
  for (const v of board.vias) {
    const shapes: Shape[] = [{ kind: "seg", a: v.at, b: v.at, r: v.size / 2 }];
    // Through vias span the whole stack; blind/buried ones their listed range.
    const idx = v.layers.map((l) => copper.indexOf(l)).filter((i) => i >= 0);
    const span = idx.length === 2 ? copper.slice(Math.min(...idx), Math.max(...idx) + 1) : copper;
    const layers = new Set(span.filter((l) => flashed(v, l)));
    items.push({ shapes, layers, item: { kind: "via", net: v.net, at: v.at, uuid: v.uuid, description: `Via [${v.net || "<no net>"}]` }, box: boxOf(shapes) });
  }
  // Zone fills (as KiCad last filled them), one item per zone and layer.
  for (const z of board.zones) {
    if (z.keepout) continue;
    const byLayer = new Map<string, Point[][]>();
    for (const f of z.fills) if (copper.includes(f.layer) && f.points.length >= 3) byLayer.set(f.layer, [...(byLayer.get(f.layer) ?? []), f.points]);
    for (const [layer, polys] of byLayer) {
      const shapes: Shape[] = polys.map((p) => buildArea(p));
      items.push({
        shapes,
        layers: new Set([layer]),
        ruleLayer: z.layers.flatMap((l) => (l === "*.Cu" ? copper : l === "F&B.Cu" ? ["F.Cu", "B.Cu"] : [l]))[0],
        item: { kind: "zone", net: z.net, uuid: z.uuid, description: `Zone [${z.net || "<no net>"}] on ${layer}${z.teardrop ? " (teardrop)" : ""}` },
        // A zone's own clearance acts like a local override (teardrops have none).
        override: z.clearance > 0 ? z.clearance : undefined,
        box: boxOf(shapes),
      });
    }
  }
  // Copper graphics: footprint and board drawings on copper layers.
  const graphic = (g: Graphic, owner: string) => {
    if (!copper.includes(g.layer)) return;
    const shapes = graphicShapes(g);
    if (!shapes.length) return;
    const kind = g.kind === "poly" ? "Polygon" : g.kind === "rect" ? "Rectangle" : g.kind === "circle" ? "Circle" : g.kind === "arc" ? "Arc" : "Segment";
    items.push({ shapes, layers: new Set([g.layer]), ruleLayer: g.layer, item: { kind: "graphic", net: g.net ?? "", reference: owner || undefined, description: `${kind} [${g.net || "<no net>"}]${owner ? ` of ${owner}` : ""} on ${g.layer}` }, box: boxOf(shapes) });
  };
  // Net-tie footprints' copper deliberately joins their pads: KiCad doesn't check it.
  for (const fp of board.footprints) if (!fp.netTie) for (const g of fp.graphics) graphic(g, fp.reference);
  for (const g of board.drawings) graphic(g, "");
  return items;
}

/** The board edge (Edge.Cuts) as open chains of points. */
export function edgeChains(board: Board): Point[][] {
  const out: Point[][] = [];
  for (const s of board.outline) {
    const p = s.points;
    if (s.kind === "line") out.push([p[0]!, p[1]!]);
    else if (s.kind === "arc") out.push(arcPoints(p[0]!, p[1]!, p[2]!).pts);
    else if (s.kind === "rect") out.push([p[0]!, { x: p[1]!.x, y: p[0]!.y }, p[1]!, { x: p[0]!.x, y: p[1]!.y }, p[0]!]);
    else if (s.kind === "circle") {
      const r = Math.hypot(p[1]!.x - p[0]!.x, p[1]!.y - p[0]!.y);
      out.push(Array.from({ length: 129 }, (_, i) => ({ x: p[0]!.x + r * Math.cos((i * Math.PI) / 64), y: p[0]!.y + r * Math.sin((i * Math.PI) / 64) })));
    } else if (p.length >= 2) out.push(s.kind === "poly" ? [...p, p[0]!] : p);
  }
  return out;
}

/**
 * Whether a pad's hole is a slot: milled, as the board outline is, rather than drilled. KiCad keeps
 * the board's edge clearance from an unplated one, in its DRC and its zone filler.
 */
export function slotted(pad: Pick<Pad, "drillSize">): boolean {
  return !!pad.drillSize && Math.abs(pad.drillSize.x - pad.drillSize.y) > 1e-9;
}

/** A pad's hole as a shape: round, or a slot along its longer side, turned with the pad. */
export function holeShape(pad: Pick<Pad, "at" | "drill" | "drillSize" | "rotation">): Shape | undefined {
  if (!pad.drill && !pad.drillSize) return undefined;
  const ds = pad.drillSize ?? { x: pad.drill!, y: pad.drill! };
  const half = Math.abs(ds.x - ds.y) / 2;
  const a = (pad.rotation * Math.PI) / 180;
  const dir = ds.x >= ds.y ? { x: Math.cos(a), y: -Math.sin(a) } : { x: Math.sin(a), y: Math.cos(a) };
  return { kind: "seg", a: { x: pad.at.x - dir.x * half, y: pad.at.y - dir.y * half }, b: { x: pad.at.x + dir.x * half, y: pad.at.y + dir.y * half }, r: Math.min(ds.x, ds.y) / 2 };
}

/**
 * Check copper clearances; one violation per offending item pair.
 * The required clearance follows KiCad's precedence: local overrides (pad,
 * then footprint) replace net classes; otherwise the larger of the two net
 * classes; never below the board minimum.
 */
export function checkClearance(board: Board, rules: DesignRules, limit = 5000): ClearanceViolation[] {
  const items = copperItems(board);
  const classOf = new Map<string, number>();
  const cl = (net: string) => {
    let c = classOf.get(net);
    if (c === undefined) classOf.set(net, (c = netClassOf(rules, net).clearance));
    return c;
  };
  const custom = rules.custom?.filter((r) => r.constraints.some((c) => c.type === "clearance" && c.min !== undefined)) ?? [];
  const maxClear = Math.max(
    rules.minClearance,
    ...[...rules.classes.values()].map((c) => c.clearance),
    ...items.map((i) => i.override ?? 0),
    ...custom.flatMap((r) => r.constraints.filter((c) => c.type === "clearance").map((c) => c.min ?? 0)),
  );
  // Rule areas (named zones) for intersectsArea(), and each item's view for rule conditions.
  const areas = new Map<string, Area[]>();
  if (custom.length) for (const z of board.zones) if (z.name && z.outline.length >= 3) areas.set(z.name, [...(areas.get(z.name) ?? []), buildArea(z.outline)]);
  const ruleItems = new Map<CopperItem, RuleItem>();
  const boardNets = new Set(board.nets);
  const ruleItem = (it: CopperItem, layer: string): RuleItem => {
    let r = ruleItems.get(it);
    if (!r) {
      const hits = new Map<string, boolean>();
      const type = ({ pad: "Pad", track: "Track", via: "Via", zone: "Zone", graphic: "Graphic", edge: "Graphic" } as const)[it.item.kind];
      r = {
        hasNet: (n) => boardNets.has(n),
        type,
        netName: it.item.net,
        netClass: netClassOf(rules, it.item.net).name,
        layer: it.ruleLayer,
        reference: it.item.reference,
        layers: it.layers,
        intersectsArea: (name) => {
          let h = hits.get(name);
          if (h === undefined) {
            h = (areas.get(name) ?? []).some((a) => it.shapes.some((sh) => shapeDistance(sh, a, 0).dist <= 0 || (sh.kind !== "area" && inArea(a, sh.kind === "seg" ? sh.a : sh.pts[0]!))));
            hits.set(name, h);
          }
          return h;
        },
      };
      ruleItems.set(it, r);
    }
    void layer;
    return r;
  };
  // Spatial hash on item boxes.
  const CELL = 2.5;
  const grid = new Map<string, number[]>();
  const cells = (b: CopperItem["box"], grow: number) => {
    const out: string[] = [];
    for (let x = Math.floor((b.x0 - grow) / CELL); x <= Math.floor((b.x1 + grow) / CELL); x++)
      for (let y = Math.floor((b.y0 - grow) / CELL); y <= Math.floor((b.y1 + grow) / CELL); y++) out.push(`${x},${y}`);
    return out;
  };
  items.forEach((it, i) => {
    for (const c of cells(it.box, 0)) grid.set(c, [...(grid.get(c) ?? []), i]);
  });

  // Items on one net keep no clearance from each other. As in KiCad, every item without a net is on
  // one, "no net", but a footprint's copper drawings have no net at all: they keep clearance from
  // everything except each other.
  const netOf = (it: CopperItem) => (it.item.kind === "graphic" && it.item.reference ? undefined : it.item.net);
  const out: ClearanceViolation[] = [];
  // Copper too close to an unplated pad's ring, by hole and item: KiCad reports that, not its hole clearance too.
  const ringHit = new Set<string>();
  for (let i = 0; i < items.length && out.length < limit; i++) {
    const A = items[i]!;
    const cand = new Set<number>();
    for (const c of cells(A.box, maxClear)) for (const j of grid.get(c) ?? []) if (j > i) cand.add(j);
    for (const j of cand) {
      const B = items[j]!;
      if (netOf(A) === netOf(B)) continue;
      // Pads with the same number in one footprint are one logical pad (as in KiCad):
      // no clearance between them, only a short if they carry two different real nets.
      if (A.logicalPad && A.logicalPad === B.logicalPad) {
        const unconnected = (n: string) => n.slice(n.lastIndexOf("/") + 1).startsWith("unconnected-(");
        if (!A.item.net || !B.item.net || (unconnected(A.item.net) && unconnected(B.item.net))) continue;
        out.push({ type: "short", layer: [...A.layers].find((l) => B.layers.has(l)) ?? "", at: A.item.at ?? { x: (A.box.x0 + A.box.x1) / 2, y: (A.box.y0 + A.box.y1) / 2 }, actual: 0, required: 0, nets: [A.item.net, B.item.net], items: [A.item, B.item] });
        continue;
      }
      // A footprint's own copper graphics together form one shape.
      if (A.item.kind === "graphic" && B.item.kind === "graphic" && A.item.reference && A.item.reference === B.item.reference) continue;
      const layer = [...A.layers].find((l) => B.layers.has(l));
      if (!layer) continue;
      // Precedence: a pad/footprint override, then a zone's own clearance (with the
      // net classes), then the net classes alone.
      const itemOverrides = [A, B].filter((x) => x.item.kind !== "zone" && x.override !== undefined).map((x) => x.override!);
      const zoneOverrides = [A, B].filter((x) => x.item.kind === "zone" && x.override !== undefined).map((x) => x.override!);
      const overrides = itemOverrides.length ? itemOverrides : zoneOverrides;
      let base = itemOverrides.length
        ? Math.max(...itemOverrides)
        : Math.max(...zoneOverrides, cl(A.item.net), cl(B.item.net));
      // The two nets of a differential pair may sit at the pair's gap.
      if (!overrides.length && diffPairBase(A.item.net, B.item.net) !== undefined) {
        const gap = netClassOf(rules, A.item.net).diffPairGap;
        if (gap !== undefined) base = Math.min(base, gap);
      }
      let required = Math.max(rules.minClearance, base);
      // KiCad's order: pad/footprint overrides first; then rules, where a matching
      // custom rule is final (no zone clearance, no board-minimum floor).
      const rule = custom.length && !itemOverrides.length ? customClearance(custom, ruleItem(A, layer), ruleItem(B, layer), layer) : undefined;
      if (rule) required = rule.value;
      if (A.box.x0 > B.box.x1 + required || B.box.x0 > A.box.x1 + required || A.box.y0 > B.box.y1 + required || B.box.y0 > A.box.y1 + required) continue;
      let best = { dist: Infinity, at: { x: 0, y: 0 } };
      for (const sa of A.shapes) for (const sb of B.shapes) {
        const d = shapeDistance(sa, sb, required);
        if (d.dist < best.dist) best = d;
      }
      // KiCad's DRC epsilon (0.5 µm): a hair under the limit is still fine.
      if (best.dist >= required - 0.0005) continue;
      if (A.hole) ringHit.add(`${A.hole}|${j}`);
      if (B.hole) ringHit.add(`${B.hole}|${i}`);
      out.push({
        type: best.dist <= 0 ? "short" : "clearance",
        layer,
        at: { x: Math.round(best.at.x * 1e4) / 1e4, y: Math.round(best.at.y * 1e4) / 1e4 },
        actual: Math.max(0, Math.round(best.dist * 1e4) / 1e4),
        required,
        nets: [A.item.net, B.item.net],
        items: [A.item, B.item],
        rule: rule?.rule,
      });
    }
  }

  // Copper to holes (KiCad's hole_clearance): every drilled hole (plated, unplated, via) against
  // other items' copper on other nets, measured to the hole itself. Zone fills keep it already.
  // An unplated hole's own clearance (its pad's or footprint's) applies to it when it is more, as in
  // KiCad, and so does the other item's: an unplated hole has no copper of its own to keep it. One
  // with a ring of copper has (copperItems); what comes too close to the ring is reported there only.
  const hc = rules.holeClearance ?? 0;
  const holes: Array<{ shape: Shape; net: string; item: DrcItem; owner?: string; layers?: Set<string>; override?: number }> = [];
  let mostOverride = 0;
  for (const it of items) mostOverride = Math.max(mostOverride, it.override ?? 0);
  for (const fp of board.footprints)
    for (const pad of fp.pads) {
      if (!pad.drill && !pad.drillSize) continue;
      const ds = pad.drillSize ?? { x: pad.drill!, y: pad.drill! };
      const r = Math.min(ds.x, ds.y) / 2;
      const half = Math.abs(ds.x - ds.y) / 2;
      const a = (pad.rotation * Math.PI) / 180;
      const dir = ds.x >= ds.y ? { x: Math.cos(a), y: -Math.sin(a) } : { x: Math.sin(a), y: Math.cos(a) };
      const c = pad.at;
      const shape: Shape = { kind: "seg", a: { x: c.x - dir.x * half, y: c.y - dir.y * half }, b: { x: c.x + dir.x * half, y: c.y + dir.y * half }, r };
      const npth = pad.type === "np_thru_hole";
      const description = npth ? `NPTH pad${pad.number ? ` ${pad.number}` : ""} of ${fp.reference || "?"}` : `Pad ${pad.number} [${pad.net || "<no net>"}] of ${fp.reference || "?"}`;
      holes.push({ shape, net: pad.net, owner: holeKey(fp, pad), item: { kind: "pad", net: pad.net, reference: fp.reference, pad: pad.number, uuid: pad.uuid, description }, override: npth ? (pad.clearance ?? fp.clearance ?? 0) : undefined });
    }
  for (const v of board.vias) holes.push({ shape: { kind: "seg", a: v.at, b: v.at, r: v.drill / 2 }, net: v.net, owner: v.uuid, item: { kind: "via", net: v.net, at: v.at, uuid: v.uuid, description: `Via [${v.net || "<no net>"}]` } });
  for (const H of holes) {
    if (out.length >= limit) break;
    const hb = shapeBox(H.shape);
    const seenHole = new Set<CopperItem>();
    const reach = H.override === undefined ? hc : Math.max(hc, H.override, mostOverride);
    for (const c of cells({ x0: hb.x0, y0: hb.y0, x1: hb.x1, y1: hb.y1 }, reach)) {
      for (const j of grid.get(c) ?? []) {
        const B = items[j]!;
        if (B.item.kind === "zone") continue;
        if (H.net === netOf(B)) continue;
        if (H.owner && ringHit.has(`${H.owner}|${j}`)) continue;
        // The hole's own pad or via.
        if ((B.logicalPad && B.logicalPad === H.owner) || (B.item.uuid && B.item.uuid === H.item.uuid)) continue;
        if (B.item.kind === "pad" && B.item.reference === H.item.reference && B.item.pad === H.item.pad && Math.abs((B.box.x0 + B.box.x1) / 2 - (hb.x0 + hb.x1) / 2) < 0.01 && Math.abs((B.box.y0 + B.box.y1) / 2 - (hb.y0 + hb.y1) / 2) < 0.01) continue;
        const need = H.override === undefined ? hc : Math.max(hc, H.override, B.override ?? 0);
        if (B.box.x0 > hb.x1 + need || hb.x0 > B.box.x1 + need || B.box.y0 > hb.y1 + need || hb.y0 > B.box.y1 + need) continue;
        if (seenHole.has(B)) continue;
        seenHole.add(B);
        let best = { dist: Infinity, at: { x: 0, y: 0 } };
        for (const sb of B.shapes) {
          const d = shapeDistance(H.shape, sb, need);
          if (d.dist < best.dist) best = d;
        }
        if (best.dist >= need - 0.0005 && best.dist > 0) continue;
        out.push({
          type: "hole",
          layer: [...B.layers][0] ?? "",
          at: { x: Math.round(best.at.x * 1e4) / 1e4, y: Math.round(best.at.y * 1e4) / 1e4 },
          actual: Math.max(0, Math.round(best.dist * 1e4) / 1e4),
          required: need,
          nets: [B.item.net, H.net],
          items: [B.item, H.item],
        });
      }
    }
  }

  // Copper to board edge.
  // (With no edge clearance set, copper crossing the edge still counts.)
  const edgeClear = rules.copperEdgeClearance ?? 0;
  // An unplated slot is an edge too, as in KiCad: it is milled, as the outline is. (A round hole is
  // drilled, and keeps the hole clearance only.)
  const slots = board.footprints.flatMap((fp) =>
    fp.pads.filter((p) => p.type === "np_thru_hole" && slotted(p)).map((p) => {
      const shape = holeShape(p)!;
      const item: DrcItem = { kind: "pad", net: "", reference: fp.reference, pad: p.number, uuid: p.uuid, description: `NPTH pad${p.number ? ` ${p.number}` : ""} of ${fp.reference || "?"}` };
      return { shape, box: shapeBox(shape), item, at: p.at };
    }),
  );
  if (board.outline.length || slots.length) {
    const edgeAreas = edgeChains(board).map((c) => buildArea(c, true));
    const edgeItem: DrcItem = { kind: "edge", net: "", description: "Board edge (Edge.Cuts)" };
    for (const A of items) {
      if (out.length >= limit) break;
      let best = { dist: Infinity, at: { x: 0, y: 0 } };
      let edge = edgeItem;
      for (const E of edgeAreas) {
        if (A.box.x0 > E.box.x1 + edgeClear || E.box.x0 > A.box.x1 + edgeClear || A.box.y0 > E.box.y1 + edgeClear || E.box.y0 > A.box.y1 + edgeClear) continue;
        for (const sa of A.shapes) {
          const d = shapeDistance(sa, E, edgeClear);
          if (d.dist < best.dist) best = d;
        }
      }
      for (const S of slots) {
        if (A.box.x0 > S.box.x1 + edgeClear || S.box.x0 > A.box.x1 + edgeClear || A.box.y0 > S.box.y1 + edgeClear || S.box.y0 > A.box.y1 + edgeClear) continue;
        // Not the slot's own pad, when it has copper round the hole.
        const own = A.item.kind === "pad" && A.item.reference === S.item.reference && A.item.pad === S.item.pad && (A.item.uuid && S.item.uuid ? A.item.uuid === S.item.uuid : Math.abs((A.box.x0 + A.box.x1) / 2 - S.at.x) < 0.01 && Math.abs((A.box.y0 + A.box.y1) / 2 - S.at.y) < 0.01);
        if (own) continue;
        for (const sa of A.shapes) {
          const d = shapeDistance(sa, S.shape, edgeClear);
          if (d.dist < best.dist) {
            best = d;
            edge = S.item;
          }
        }
      }
      if (best.dist >= edgeClear - 0.0005 && !(best.dist <= 0)) continue;
      out.push({
        type: "edge",
        layer: [...A.layers][0] ?? "",
        at: { x: Math.round(best.at.x * 1e4) / 1e4, y: Math.round(best.at.y * 1e4) / 1e4 },
        actual: Math.max(0, Math.round(best.dist * 1e4) / 1e4),
        required: edgeClear,
        nets: [A.item.net, ""],
        items: [A.item, edge],
      });
    }
  }
  return out;
}

/**
 * Clearance conflicts of a proposed track segment (e.g. while routing)
 * against existing copper. `items` comes from copperItems(board).
 */
export function trackConflicts(
  items: CopperItem[],
  rules: DesignRules,
  seg: { a: Point; b: Point; width: number; layer: string; net: string },
): Array<{ at: Point; actual: number; required: number; with: DrcItem }> {
  const shape: Shape = { kind: "seg", a: seg.a, b: seg.b, r: seg.width / 2 };
  const box = boxOf([shape]);
  const mine = netClassOf(rules, seg.net).clearance;
  const out: Array<{ at: Point; actual: number; required: number; with: DrcItem }> = [];
  for (const B of items) {
    if (!B.layers.has(seg.layer)) continue;
    if (seg.net && B.item.net === seg.net) continue;
    let required = Math.max(rules.minClearance, B.override ?? Math.max(mine, netClassOf(rules, B.item.net).clearance));
    // The two nets of a differential pair may sit at the pair's gap (as in checkClearance).
    if (B.override === undefined && diffPairBase(seg.net, B.item.net) !== undefined) {
      const gap = netClassOf(rules, seg.net).diffPairGap;
      if (gap !== undefined) required = Math.max(rules.minClearance, Math.min(required, gap));
    }
    if (box.x0 > B.box.x1 + required || B.box.x0 > box.x1 + required || box.y0 > B.box.y1 + required || B.box.y0 > box.y1 + required) continue;
    for (const sb of B.shapes) {
      const d = shapeDistance(shape, sb, required);
      if (d.dist < required - 0.0005) {
        out.push({ at: d.at, actual: Math.max(0, d.dist), required, with: B.item });
        break;
      }
    }
  }
  return out;
}

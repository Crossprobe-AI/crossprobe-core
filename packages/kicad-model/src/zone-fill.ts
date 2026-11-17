/**
 * Copper zone filling, following KiCad's zone filler:
 *
 *   fill = (zone outline ∩ board, kept clear of the edge)
 *          − other-net copper grown by clearance (pads, tracks, vias, holes,
 *            copper graphics, higher-priority zones, keepouts)
 *          − same-net pads with thermal relief, grown by the thermal gap
 *          + thermal spokes
 *   then thin necks (< min thickness) are removed and unconnected islands
 *   dropped, per the zone's settings.
 *
 * Polygons use Clipper (integer coordinates, 10 nm). Results are compared
 * against the fills KiCad saved in its demo boards (see the test).
 */
import ClipperLib from "clipper-lib";
import { flashChecker, padCorners, type Board, type Footprint, type Graphic, type Pad, type Via, type Zone } from "./board.js";
import { arcPoints, netClassOf, type DesignRules } from "./drc.js";
import type { Point } from "./geometry.js";

type Path = ClipperLib.Path;
type Paths = ClipperLib.Paths;

const S = 1e5; // Clipper units per mm
const ARC_ERROR = 0.005; // mm, KiCad's default maximum arc approximation error
/** Clipper's round offsets fall up to ~0.02 mm inside the curve (measured): margin for them. */
const CLIPPER_ERROR = 0.02;

const ip = (p: Point): ClipperLib.IntPoint => ({ X: Math.round(p.x * S), Y: Math.round(p.y * S) });
const toPath = (pts: Point[]): Path => pts.map(ip);
const fromPath = (p: Path): Point[] => p.map((q) => ({ x: q.X / S, y: q.Y / S }));

function offset(paths: Paths, delta: number, open = false): Paths {
  if (!paths.length) return [];
  const co = new ClipperLib.ClipperOffset(2, ARC_ERROR * S);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, open ? ClipperLib.EndType.etOpenRound : ClipperLib.EndType.etClosedPolygon);
  const out: Paths = [];
  co.Execute(out, delta * S);
  return out;
}

/**
 * Paths ordered by their lowest point (largest Y). Clipper keeps local minima
 * in a sorted linked list; adding in this order makes each insertion O(1)
 * instead of a walk, which otherwise turns thousands of knockouts quadratic.
 */
function byBottom(paths: Paths): Paths {
  if (paths.length < 64) return paths;
  const keyed = paths.map((p) => {
    let m = -Infinity;
    for (const q of p) if (q.Y > m) m = q.Y;
    return { p, m };
  });
  keyed.sort((a, b) => a.m - b.m);
  return keyed.map((k) => k.p);
}

function clip(type: ClipperLib.ClipType, subject: Paths, clipPaths: Paths, fill = ClipperLib.PolyFillType.pftNonZero): Paths {
  const c = new ClipperLib.Clipper();
  c.AddPaths(byBottom(subject), ClipperLib.PolyType.ptSubject, true);
  if (clipPaths.length) c.AddPaths(byBottom(clipPaths), ClipperLib.PolyType.ptClip, true);
  const out: Paths = [];
  c.Execute(type, out, fill, fill);
  return out;
}
const union = (a: Paths, fill = ClipperLib.PolyFillType.pftNonZero) => clip(ClipperLib.ClipType.ctUnion, a, [], fill);
const difference = (a: Paths, b: Paths) => (b.length ? clip(ClipperLib.ClipType.ctDifference, a, b) : a);
const intersection = (a: Paths, b: Paths) => clip(ClipperLib.ClipType.ctIntersection, a, b);

/** Area in mm² of a set of paths (holes are negative). */
export function pathsArea(paths: Paths): number {
  return paths.reduce((a, p) => a + ClipperLib.Clipper.Area(p), 0) / (S * S);
}

const rot = (p: Point, deg: number): Point => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c };
};

/*
 * Round shapes are built as circumscribed polygons (vertices just outside
 * the true curve, at most ARC_ERROR away), so copper is never closer than
 * the rule. Clipper's own round offsets fall inside the curve.
 */
const stepsFor = (r: number, sweep: number) => Math.max(2, Math.ceil(sweep / (2 * Math.acos(Math.max(-1, 1 - ARC_ERROR / Math.max(r, ARC_ERROR))))));

function circle(c: Point, r: number): Paths {
  if (r <= 0) return [];
  const n = Math.max(8, stepsFor(r, 2 * Math.PI));
  const R = r / Math.cos(Math.PI / n);
  return [toPath(Array.from({ length: n }, (_, k) => ({ x: c.x + R * Math.cos((2 * Math.PI * k) / n), y: c.y + R * Math.sin((2 * Math.PI * k) / n) })))];
}

function capsule(a: Point, b: Point, r: number): Paths {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-9) return circle(a, r);
  if (r <= 0) return [];
  const m = Math.max(2, stepsFor(r, Math.PI));
  const R = r / Math.cos(Math.PI / (2 * m));
  const al = Math.atan2(b.y - a.y, b.x - a.x);
  const pts: Point[] = [];
  for (let k = 0; k <= m; k++) {
    const t = al - Math.PI / 2 + (Math.PI * k) / m;
    pts.push({ x: b.x + R * Math.cos(t), y: b.y + R * Math.sin(t) });
  }
  for (let k = 0; k <= m; k++) {
    const t = al + Math.PI / 2 + (Math.PI * k) / m;
    pts.push({ x: a.x + R * Math.cos(t), y: a.y + R * Math.sin(t) });
  }
  return [toPath(pts)];
}

/** A thick polyline: capsules along it (merged by the clip that uses them). */
const polyline = (pts: Point[], r: number): Paths => (pts.length === 1 ? circle(pts[0]!, r) : pts.slice(1).flatMap((b, i) => capsule(pts[i]!, b, r)));

/** A rectangle (half sizes hw, hh) with round corners of radius rad, rotated and placed. */
function roundRect(place: (p: Point) => Point, hw: number, hh: number, rad: number): Paths {
  if (rad <= 0) return [toPath([place({ x: -hw, y: -hh }), place({ x: hw, y: -hh }), place({ x: hw, y: hh }), place({ x: -hw, y: hh })])];
  const q = Math.max(1, stepsFor(rad, Math.PI / 2));
  const R = rad / Math.cos(Math.PI / (4 * q));
  const pts: Point[] = [];
  const corners: Array<[number, number, number]> = [
    [hw, hh, 0],
    [-hw, hh, Math.PI / 2],
    [-hw, -hh, Math.PI],
    [hw, -hh, (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, start] of corners) {
    for (let k = 0; k <= q; k++) {
      const t = start + ((Math.PI / 2) * k) / q;
      pts.push(place({ x: cx + R * Math.cos(t), y: cy + R * Math.sin(t) }));
    }
  }
  return [toPath(pts)];
}

/** A pad's copper centre (hole position plus its rotated offset). */
function padCenter(pad: Pad): Point {
  if (!pad.offset) return pad.at;
  const o = rot(pad.offset, pad.rotation);
  return { x: pad.at.x + o.x, y: pad.at.y + o.y };
}

/** A pad's copper outline grown by `grow` mm (round corners, like KiCad's clearance outlines). */
function padPaths(pad: Pad, grow: number): Paths {
  const c = padCenter(pad);
  const { x: w, y: h } = pad.size;
  const place = (p: Point) => {
    const q = rot(p, pad.rotation);
    return { x: c.x + q.x, y: c.y + q.y };
  };
  if (pad.shape === "custom" && pad.primitives?.length) {
    // Anchor plus primitives, all in the pad frame, grown together.
    const anchor = pad.size.x > 0 ? roundRect(place, w / 2, h / 2, 0) : [];
    const parts: Paths = [...anchor];
    for (const pr of pad.primitives) {
      const pts = pr.points.map(place);
      const r = pr.width / 2;
      if (pr.kind === "poly") parts.push(toPath(pts), ...(r > 0 ? polyline([...pts, pts[0]!], r) : []));
      else if (pr.kind === "circle") {
        const rad = Math.hypot(pr.points[1]!.x - pr.points[0]!.x, pr.points[1]!.y - pr.points[0]!.y);
        parts.push(...(pr.fill ? circle(pts[0]!, rad + r) : []));
      } else if (pr.kind === "rect") {
        const [a, b] = [pr.points[0]!, pr.points[1]!];
        parts.push(toPath([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }].map(place)));
      } else if (pr.kind === "arc") parts.push(...polyline(arcPoints(pts[0]!, pts[1]!, pts[2]!).pts, r));
      else parts.push(...capsule(pts[0]!, pts[1]!, r));
    }
    const merged = union(parts);
    // Growing a polygon: Clipper's round joins fall inside the curve, so add a little.
    return grow > 0 ? offset(merged, grow + CLIPPER_ERROR) : merged;
  }
  if (pad.shape === "circle") return circle(c, w / 2 + grow);
  if (pad.shape === "oval") {
    const r = Math.min(w, h) / 2;
    const half = w > h ? { x: w / 2 - r, y: 0 } : { x: 0, y: h / 2 - r };
    return capsule(place({ x: -half.x, y: -half.y }), place(half), r + grow);
  }
  if (pad.chamfer && (pad.shape === "rect" || pad.shape === "roundrect")) {
    const poly = [toPath(padCorners(pad).map(place))];
    return grow > 0 ? offset(poly, grow + CLIPPER_ERROR) : poly;
  }
  const r = pad.shape === "roundrect" ? Math.min(w, h) * (pad.roundrectRatio ?? 0.25) : 0;
  return roundRect(place, w / 2 - r, h / 2 - r, r + grow);
}

/** A pad's drilled hole grown by `grow`. */
function holePaths(pad: Pad, grow: number): Paths {
  if (pad.drillSize && pad.drillSize.x !== pad.drillSize.y) {
    const { x: w, y: h } = pad.drillSize;
    const r = Math.min(w, h) / 2;
    const half = rot(w > h ? { x: w / 2 - r, y: 0 } : { x: 0, y: h / 2 - r }, pad.rotation);
    return capsule({ x: pad.at.x - half.x, y: pad.at.y - half.y }, { x: pad.at.x + half.x, y: pad.at.y + half.y }, r + grow);
  }
  return pad.drill ? circle(pad.at, pad.drill / 2 + grow) : [];
}

/** A graphic's copper, grown by `grow`. */
function graphicPaths(g: Graphic, grow: number): Paths {
  const r = g.width / 2 + grow;
  const pts = g.points;
  switch (g.kind) {
    case "line":
      return capsule(pts[0]!, pts[1]!, r);
    case "arc":
      return polyline(arcPoints(pts[0]!, pts[1]!, pts[2]!).pts, r);
    case "circle": {
      const rad = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
      if (g.fill) return circle(pts[0]!, rad + r);
      const ring = Array.from({ length: 72 }, (_, i) => ({ x: pts[0]!.x + rad * Math.cos((i * Math.PI) / 36), y: pts[0]!.y + rad * Math.sin((i * Math.PI) / 36) }));
      return polyline([...ring, ring[0]!], r);
    }
    case "rect": {
      const [a, b] = [pts[0]!, pts[1]!];
      const loop = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
      return g.fill ? [...[toPath(loop)], ...polyline([...loop, a], r)] : polyline([...loop, a], r);
    }
    default: {
      if (pts.length < 2) return [];
      return g.fill || g.kind === "poly" ? [toPath(pts), ...polyline([...pts, pts[0]!], r)] : polyline(pts, r);
    }
  }
}

// ---------------------------------------------------------------------------
// Board outline
// ---------------------------------------------------------------------------

/** The board's area from its Edge.Cuts: outer outline minus cut-outs. */
export function boardArea(board: Board): Paths | undefined {
  const loops: Point[][] = [];
  const open: Point[][] = [];
  for (const s of board.outline) {
    const p = s.points;
    if (s.kind === "line") open.push([p[0]!, p[1]!]);
    else if (s.kind === "arc") open.push(arcPoints(p[0]!, p[1]!, p[2]!).pts);
    else if (s.kind === "curve") open.push(p);
    else if (s.kind === "rect") loops.push([p[0]!, { x: p[1]!.x, y: p[0]!.y }, p[1]!, { x: p[0]!.x, y: p[1]!.y }]);
    else if (s.kind === "circle") {
      const r = Math.hypot(p[1]!.x - p[0]!.x, p[1]!.y - p[0]!.y);
      const n = Math.max(16, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - ARC_ERROR / r))));
      loops.push(Array.from({ length: n }, (_, i) => ({ x: p[0]!.x + r * Math.cos((2 * Math.PI * i) / n), y: p[0]!.y + r * Math.sin((2 * Math.PI * i) / n) })));
    } else if (s.kind === "poly") loops.push(p);
  }
  // Chain open segments into closed loops by matching endpoints, within KiCad's chaining
  // tolerance (outlines drawn by hand or in footprints often miss by a few microns).
  const EPS = 0.02;
  const close = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= EPS;
  const pending = open.filter((o) => o.length >= 2);
  while (pending.length) {
    let chain = pending.pop()!;
    for (;;) {
      const end = chain.at(-1)!;
      if (close(end, chain[0]!) && chain.length > 2) {
        loops.push(chain);
        break;
      }
      // The nearest piece that starts or ends at this end.
      let best = -1, bestD = Infinity, flip = false;
      pending.forEach((o, i) => {
        const a = Math.hypot(o[0]!.x - end.x, o[0]!.y - end.y), b = Math.hypot(o.at(-1)!.x - end.x, o.at(-1)!.y - end.y);
        if (a <= EPS && a < bestD) [best, bestD, flip] = [i, a, false];
        if (b <= EPS && b < bestD) [best, bestD, flip] = [i, b, true];
      });
      if (best < 0) break; // an open outline: ignore it
      const next = pending.splice(best, 1)[0]!;
      chain = [...chain, ...(flip ? [...next].reverse() : next).slice(1)];
    }
  }
  if (!loops.length) return undefined;
  // Even-odd: nested loops are cut-outs.
  return union(loops.map(toPath), ClipperLib.PolyFillType.pftEvenOdd);
}

// ---------------------------------------------------------------------------
// Filling
// ---------------------------------------------------------------------------

/** Copper layers of a zone, pad or via, expanded. */
function expandLayers(layers: string[], copper: string[]): string[] {
  const out = new Set<string>();
  for (const l of layers) {
    if (l === "*.Cu") copper.forEach((c) => out.add(c));
    else if (l === "F&B.Cu") ["F.Cu", "B.Cu"].forEach((c) => copper.includes(c) && out.add(c));
    else if (copper.includes(l)) out.add(l);
  }
  return [...out];
}

const padOnLayer = (pad: Pad, layer: string, copper: string[]) => pad.type !== "np_thru_hole" && (pad.type === "thru_hole" || expandLayers(pad.layers, copper).includes(layer));

export interface ZoneFill {
  zone: Zone;
  layer: string;
  /** Filled areas: outer outlines with holes (Clipper paths, outer CCW / holes CW). */
  paths: Paths;
}

interface FillContext {
  board: Board;
  rules: DesignRules;
  copper: string[];
  boardArea?: Paths;
  /** Fills computed so far (higher priorities first), per layer. */
  done: ZoneFill[];
  /** Does a pad or via have copper on a layer (unused-layer removal)? */
  flashed: (item: Pad | Via, layer: string) => boolean;
}

export function connectionOf(pad: Pad, fp: Footprint, zone: Zone): "thermal" | "solid" | "none" {
  // Heatsink pads (e.g. thermal vias in an exposed pad) connect solidly, as in KiCad.
  if (pad.property === "heatsink" && !pad.zoneConnect) return "solid";
  const mode = pad.zoneConnect ?? fp.zoneConnect ?? zone.connect;
  if (mode === "tht") return pad.type === "thru_hole" ? "thermal" : "solid";
  return mode;
}

/**
 * Direction of a pad's first spoke. KiCad writes thermal_bridge_angle only
 * when it isn't the default 90° (orthogonal spokes); round pads ignore their
 * rotation.
 */
function spokeBase(pad: Pad): number {
  const round = pad.shape === "circle" || (pad.shape === "oval" && pad.size.x === pad.size.y);
  return (round ? 0 : pad.rotation) + (pad.thermalAngle ?? 90);
}

/** Thermal spokes of a pad: rectangles from its centre across the thermal gap. */
function spokes(pad: Pad, gap: number, width: number): Paths {
  const c = padCenter(pad);
  const base = spokeBase(pad);
  const reach = Math.hypot(pad.size.x, pad.size.y) / 2 + gap + width;
  const out: Paths = [];
  for (let k = 0; k < 4; k++) {
    const d = rot({ x: 1, y: 0 }, base + 90 * k);
    const n = { x: -d.y, y: d.x };
    const hw = width / 2;
    const tip = { x: c.x + d.x * reach, y: c.y + d.y * reach };
    out.push(
      toPath([
        { x: c.x + n.x * hw, y: c.y + n.y * hw },
        { x: tip.x + n.x * hw, y: tip.y + n.y * hw },
        { x: tip.x - n.x * hw, y: tip.y - n.y * hw },
        { x: c.x - n.x * hw, y: c.y - n.y * hw },
      ]),
    );
  }
  return out;
}

function fillZoneLayer(zone: Zone, layer: string, ctx: FillContext): Paths {
  const { board, rules, copper } = ctx;
  const net = zone.net;
  const zoneClass = netClassOf(rules, net).clearance;
  // Knockouts are polygons whose round parts sit inside the true curve by up to
  // ARC_ERROR: grow them by that much so the real gap is never under the rule (as KiCad does).
  const clearanceTo = (otherNet: string, override?: number) =>
    Math.max(rules.minClearance, zone.clearance, zoneClass, override ?? netClassOf(rules, otherNet).clearance) + ARC_ERROR;

  let area: Paths = union([toPath(zone.outline)]);
  if (ctx.boardArea) {
    // The board edge needs only the copper-to-edge clearance, as in KiCad.
    // Plus the arc error: curved edges are polygons whose sides can fall outside a cut-out.
    // (Clipper's own offset is less exact: allow for that too.)
    const edge = (rules.copperEdgeClearance ?? 0) + CLIPPER_ERROR;
    area = intersection(area, edge > 0 ? offset(ctx.boardArea, -edge) : ctx.boardArea);
  }
  if (!area.length) return [];

  const holes: Paths = [];
  const reliefs: Paths = [];
  const drills: Paths = [];
  const thermal: Array<{ pad: Pad; gap: number; width: number }> = [];
  const anchors: Point[] = [];
  const same = (n: string) => !!net && n === net;

  // Only items near the zone matter: test bounding boxes first.
  const xs = zone.outline.map((p) => p.x);
  const ys = zone.outline.map((p) => p.y);
  const minOf = (v: number[]) => v.reduce((m, x) => (x < m ? x : m), Infinity);
  const maxOf = (v: number[]) => v.reduce((m, x) => (x > m ? x : m), -Infinity);
  const margin = 2 + Math.max(zone.clearance, zone.thermalGap, zoneClass, rules.minClearance, rules.holeClearance ?? 0, ...[...rules.classes.values()].map((c) => c.clearance));
  const zx0 = minOf(xs) - margin, zx1 = maxOf(xs) + margin, zy0 = minOf(ys) - margin, zy1 = maxOf(ys) + margin;
  const near = (pts: Point[], r: number) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    return x1 + r >= zx0 && x0 - r <= zx1 && y1 + r >= zy0 && y0 - r <= zy1;
  };

  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      if (!near([pad.at], Math.max(pad.size.x, pad.size.y) + Math.hypot(pad.offset?.x ?? 0, pad.offset?.y ?? 0))) continue;
      // Holes knock out on every layer.
      if (pad.drill && pad.type === "np_thru_hole") {
        // A copper-less hole keeps the hole clearance; one with a copper ring is a pad like any other.
        const ring = pad.size.x > (pad.drill ?? 0) + 1e-6 && expandLayers(pad.layers, copper).includes(layer);
        // A pad or footprint clearance override applies to the hole too.
        holes.push(...(ring ? padPaths(pad, clearanceTo(pad.net, pad.clearance ?? fp.clearance)) : holePaths(pad, Math.max(rules.holeClearance ?? 0, pad.clearance ?? fp.clearance ?? 0) + ARC_ERROR)));
      } else if (pad.drill && !same(pad.net)) holes.push(...holePaths(pad, Math.max(rules.holeClearance ?? 0, clearanceTo(pad.net, pad.clearance ?? fp.clearance))));
      else if (pad.drill) drills.push(...holePaths(pad, 0)); // copper never covers a drill
      if (!padOnLayer(pad, layer, copper)) continue;
      // No copper here (unused-layer removal): only its hole matters, handled above.
      if (pad.type === "thru_hole" && !same(pad.net) && !ctx.flashed(pad, layer)) continue;
      if (same(pad.net)) {
        const mode = connectionOf(pad, fp, zone);
        if (mode === "solid") anchors.push(padCenter(pad));
        else if (mode === "none") holes.push(...padPaths(pad, clearanceTo(pad.net, pad.clearance ?? fp.clearance)));
        else {
          const gap = pad.thermalGap ?? zone.thermalGap;
          reliefs.push(...padPaths(pad, gap));
          thermal.push({ pad, gap, width: pad.thermalWidth ?? zone.thermalWidth });
        }
      } else {
        holes.push(...padPaths(pad, clearanceTo(pad.net, pad.clearance ?? fp.clearance)));
      }
    }
    for (const g of fp.graphics) if (g.layer === layer && !(g.net && same(g.net)) && near(g.points, g.width + 50)) holes.push(...graphicPaths(g, clearanceTo(g.net ?? "")));
  }
  for (const t of board.tracks) {
    if (t.layer !== layer || !near(t.mid ? [t.start, t.end, t.mid] : [t.start, t.end], t.width)) continue;
    if (same(t.net)) {
      anchors.push(t.start, t.end);
      continue;
    }
    const pts = t.kind === "arc" && t.mid ? arcPoints(t.start, t.mid, t.end).pts : [t.start, t.end];
    holes.push(...polyline(pts, t.width / 2 + clearanceTo(t.net)));
  }
  for (const v of board.vias) {
    if (!near([v.at], v.size)) continue;
    const idx = v.layers.map((l) => copper.indexOf(l)).filter((i) => i >= 0);
    const on = idx.length === 2 ? copper.slice(Math.min(...idx), Math.max(...idx) + 1).includes(layer) : true;
    if (same(v.net)) {
      if (on) anchors.push(v.at);
      continue;
    }
    if (on && ctx.flashed(v, layer)) holes.push(...circle(v.at, v.size / 2 + clearanceTo(v.net)));
    // Not on this layer, or no copper here: just the drilled hole.
    else holes.push(...circle(v.at, v.drill / 2 + Math.max(rules.holeClearance ?? 0, clearanceTo(v.net))));
  }
  // Texts on copper knock out their bounding box, as KiCad's filler does.
  for (const t of board.texts) {
    if (t.layer !== layer || !t.text.trim()) continue;
    const lines = t.text.split("\n");
    // A generous estimate of KiCad's stroke-font extent.
    const w = Math.max(...lines.map((l) => l.length)) * t.size.x * 1.15 + t.thickness * 2;
    const h = lines.length * t.size.y * 1.62 - t.size.y * 0.42 + t.thickness * 2;
    const ax = t.justify.includes("left") ? 0 : t.justify.includes("right") ? -w : -w / 2;
    const ay = t.justify.includes("top") ? 0 : t.justify.includes("bottom") ? -h : -h / 2;
    // Descenders reach below the (cap-height) box KiCad aligns on.
    const desc = t.size.y * 0.45;
    const corners = [
      { x: ax, y: ay },
      { x: ax + w, y: ay },
      { x: ax + w, y: ay + h + desc },
      { x: ax, y: ay + h + desc },
    ].map((c) => {
      const q = rot(t.justify.includes("mirror") ? { x: -c.x, y: c.y } : c, t.rotation);
      return { x: t.at.x + q.x, y: t.at.y + q.y };
    });
    if (near(corners, 0)) holes.push(...offset([toPath(corners)], clearanceTo("")));
  }
  for (const g of board.drawings) if (g.layer === layer && !(g.net && same(g.net)) && near(g.points, g.width + 50)) holes.push(...graphicPaths(g, clearanceTo(g.net ?? "")));
  // Higher-priority zones of other nets (their fills), and keepouts.
  for (const f of ctx.done) {
    if (f.layer !== layer || f.zone === zone || same(f.zone.net)) continue;
    // Both zones' own clearances count; Clipper's round offset needs its margin.
    if (f.zone.priority > zone.priority || f.zone.teardrop) {
      // Only the part of the other fill near this zone matters: crop before growing it.
      const g = Math.max(clearanceTo(f.zone.net), f.zone.clearance + ARC_ERROR) + CLIPPER_ERROR;
      const crop = [toPath([{ x: zx0 - g, y: zy0 - g }, { x: zx1 + g, y: zy0 - g }, { x: zx1 + g, y: zy1 + g }, { x: zx0 - g, y: zy1 + g }])];
      const near = intersection(f.paths, crop);
      if (near.length) holes.push(...offset(near, g));
    }
  }
  for (const k of board.zones) {
    if (k.noCopperPour && expandLayers(k.layers, copper).includes(layer)) holes.push(toPath(k.outline));
  }

  // Fill tile by tile: each tile (with a margin) only sees the copper near it,
  // which keeps every polygon operation small. Clipper's cost grows much faster
  // than linearly with polygon size, so this makes big boards practical.
  const TILE = 8;
  const half = zone.minThickness / 2 - 0.0001;
  // A hatched zone's tiles also hold their whole holes, with the deflation around them.
  // (Holes reaching into a tile come from up to a hole's diagonal away, and are cut whole.)
  const holeReach = zone.hatch ? Math.SQRT2 * (zone.hatch.gap + zone.minThickness) : 0;
  const tileMargin = zone.minThickness + 0.5 + (zone.hatch ? 2 * holeReach + zone.hatch.thickness : 0);
  const hatchOutline = zone.hatch ? offset(union([toPath(zone.outline)]), -zone.minThickness) : [];
  const bounds = (paths: Paths) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of paths) for (const q of p) {
      if (q.X < x0) x0 = q.X;
      if (q.X > x1) x1 = q.X;
      if (q.Y < y0) y0 = q.Y;
      if (q.Y > y1) y1 = q.Y;
    }
    return { x0, y0, x1, y1 };
  };
  const indexed = (paths: Paths) => paths.map((p) => ({ p, b: bounds([p]) }));
  const iHoles = indexed(holes);
  const iCuts = indexed([...holes, ...reliefs]);
  // A hatched zone puts a ring of copper, a spoke wide, around each thermal relief, for the
  // hatch to meet (KiCad's buildHatchZoneThermalRings); other nets' clearances still cut it.
  const rings: Paths = [];
  if (zone.hatch)
    for (const t of thermal) {
      const width = Math.min(t.width, t.pad.size.x, t.pad.size.y);
      if (width < zone.minThickness) continue;
      rings.push(...difference(padPaths(t.pad, t.gap + width), padPaths(t.pad, t.gap)));
    }
  const iRings = indexed(rings);
  const iHoleCuts = indexed(holes);
  const iReliefs = indexed(reliefs);
  const iDrills = indexed(drills);
  const ab = bounds(area);
  const tiles: Array<{ rect: Path; grown: Path; base: Paths; inBase: (p: Point) => boolean; x0: number; y0: number }> = [];
  // Hatched zones have wide margins (whole holes): bigger tiles keep the overlap in proportion.
  const T = (zone.hatch ? Math.max(TILE, 2 * tileMargin) : TILE) * S;
  const M = tileMargin * S;
  const rectPath = (x0: number, y0: number, x1: number, y1: number): Path => [
    { X: x0, Y: y0 },
    { X: x1, Y: y0 },
    { X: x1, Y: y1 },
    { X: x0, Y: y1 },
  ];
  const nearBox = (items: Array<{ p: Path; b: ReturnType<typeof bounds> }>, x0: number, y0: number, x1: number, y1: number) =>
    items.filter((h) => h.b.x1 >= x0 && h.b.x0 <= x1 && h.b.y1 >= y0 && h.b.y0 <= y1).map((h) => h.p);
  for (let tx = Math.floor(ab.x0 / T) * T; tx < ab.x1; tx += T) {
    for (let ty = Math.floor(ab.y0 / T) * T; ty < ab.y1; ty += T) {
      const grown = rectPath(tx - M, ty - M, tx + T + M, ty + T + M);
      const tileArea = intersection(area, [grown]);
      if (!tileArea.length) continue;
      const box = [tx - M, ty - M, tx + T + M, ty + T + M] as const;
      const tileRings = nearBox(iRings, ...box);
      const base = tileRings.length
        ? difference(union([...difference(tileArea, nearBox(iReliefs, ...box)), ...intersection(tileRings, tileArea)]), nearBox(iHoleCuts, ...box))
        : difference(tileArea, nearBox(iCuts, ...box));
      tiles.push({ rect: rectPath(tx, ty, tx + T, ty + T), grown, base, inBase: pointTester(base), x0: tx, y0: ty });
    }
  }
  const tileAt = (p: Point) => {
    const X = p.x * S;
    const Y = p.y * S;
    return tiles.find((t) => X >= t.x0 && X < t.x0 + T && Y >= t.y0 && Y < t.y0 + T);
  };
  // Thermal spokes bridge the relief gap, from the pad edge to the fill. Like
  // KiCad, keep only spokes whose outer end reaches the fill.
  const sp: Paths = [];
  for (const t of thermal) {
    let connected = false;
    const tips = spokeTips(t.pad, t.gap);
    spokes(t.pad, t.gap, t.width).forEach((one, k) => {
      const tip = tips[k]!;
      if (!tileAt(tip)?.inBase(tip)) return;
      sp.push(...intersection([one], padPaths(t.pad, t.gap + t.width / 2)));
      anchors.push(tip);
      connected = true;
    });
    // An SMD pad's own copper is part of the fill, as KiCad stores it.
    if (connected && t.pad.type === "smd") sp.push(...padPaths(t.pad, 0));
  }
  const iSpokes = indexed(sp);
  const pieces: Paths = [];
  for (const t of tiles) {
    const gx0 = t.x0 - M, gy0 = t.y0 - M, gx1 = t.x0 + T + M, gy1 = t.y0 + T + M;
    let fill = t.base;
    const tileSpokes = nearBox(iSpokes, gx0, gy0, gx1, gy1);
    // Spokes mustn't cross other-net clearances.
    if (tileSpokes.length) fill = union([...fill, ...difference(intersection(tileSpokes, intersection(area, [t.grown])), nearBox(iHoles, gx0, gy0, gx1, gy1))]);
    const tileDrills = nearBox(iDrills, gx0, gy0, gx1, gy1);
    if (tileDrills.length) fill = difference(fill, tileDrills);
    // Remove copper narrower than the minimum thickness (the margin keeps tile edges exact),
    // cutting a hatched zone's holes while it is deflated (as KiCad does).
    if (half > 0) fill = offset(fill, -half);
    if (zone.hatch) fill = cutHatch(fill, hatchHoles(zone.hatch, zone.minThickness, t.x0 / S - holeReach, t.y0 / S - holeReach, (t.x0 + T) / S + holeReach, (t.y0 + T) / S + holeReach), zone.hatch, zone.minThickness, hatchOutline, [...nearBox(iCuts, gx0, gy0, gx1, gy1), ...nearBox(iRings, gx0, gy0, gx1, gy1)]);
    if (half > 0) fill = offset(fill, half);
    pieces.push(...intersection(fill, [t.rect]));
  }
  const fill = union(pieces);
  return removeIslands(fill, zone, anchors);
}

type Hatch = NonNullable<Zone["hatch"]>;

/** KiCad's RotatePoint (counter-clockwise on screen, y down), degrees. */
function rotKi(p: Point, deg: number): Point {
  if (!deg) return p;
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: p.x * c + p.y * s, y: p.y * c - p.x * s };
}

/**
 * One hatch hole at the origin, as KiCad builds it (ZONE_FILLER::addHatchFillTypeOnZone): a
 * square of the gap plus the minimum thickness (the fill is deflated by half of that when holes
 * are cut), its corners chamfered or rounded by the smoothing settings. Also the error its
 * rounded corners allow, mm.
 */
function hatchHoleBase(h: Hatch, minThickness: number): { pts: Point[]; size: number } {
  const size = h.gap + minThickness;
  const square = [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }];
  let smooth = Math.round((h.gap * h.smoothingValue * 1e6) / 2) / 1e6;
  let level = h.smoothingLevel;
  if (level <= 0 || smooth <= 0.02) return { pts: square, size };
  if (smooth < 0.04 && level > 1) level = 1;
  smooth = Math.min(smooth + minThickness / 2, h.gap / 2);
  let err = Math.max(ARC_ERROR * 2, smooth / 20);
  if (h.smoothingLevel > 2) err /= 2;
  // Corners in order, with the directions of their two edges.
  const corners = [
    { c: square[0]!, a: { x: 0, y: 1 }, b: { x: 1, y: 0 } },
    { c: square[1]!, a: { x: -1, y: 0 }, b: { x: 0, y: 1 } },
    { c: square[2]!, a: { x: 0, y: -1 }, b: { x: -1, y: 0 } },
    { c: square[3]!, a: { x: 1, y: 0 }, b: { x: 0, y: -1 } },
  ];
  const pts: Point[] = [];
  for (const { c, a, b } of corners) {
    const from = { x: c.x + a.x * smooth, y: c.y + a.y * smooth }, to = { x: c.x + b.x * smooth, y: c.y + b.y * smooth };
    if (level === 1) pts.push(from, to);
    else {
      // A quarter circle from `from` to `to` around the corner's inset centre.
      const centre = { x: c.x + (a.x + b.x) * smooth, y: c.y + (a.y + b.y) * smooth };
      const n = Math.max(2, Math.ceil((Math.PI / 2) / (2 * Math.acos(Math.max(-1, 1 - err / smooth)))));
      const a0 = Math.atan2(from.y - centre.y, from.x - centre.x), a1 = Math.atan2(to.y - centre.y, to.x - centre.x);
      let d = a1 - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      for (let i = 0; i <= n; i++) pts.push({ x: centre.x + smooth * Math.cos(a0 + (d * i) / n), y: centre.y + smooth * Math.sin(a0 + (d * i) / n) });
    }
  }
  return { pts, size };
}

/**
 * The hatch holes whose grid corner falls in the rectangle [x0, x1) × [y0, y1) (mm). KiCad's
 * grid sits on multiples of (thickness + gap) in the hatch's own rotated frame, so each tile
 * can take its own holes.
 */
function hatchHoles(h: Hatch, minThickness: number, x0: number, y0: number, x1: number, y1: number): Point[][] {
  const thickness = Math.max(h.thickness, minThickness + 0.001);
  const grid = thickness + h.gap;
  const base = hatchHoleBase(h, minThickness).pts;
  // The tile in the hatch's frame: where its grid corners can be.
  const local = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }].map((p) => rotKi(p, -h.orientation));
  const lx0 = Math.min(...local.map((p) => p.x)), lx1 = Math.max(...local.map((p) => p.x));
  const ly0 = Math.min(...local.map((p) => p.y)), ly1 = Math.max(...local.map((p) => p.y));
  const out: Point[][] = [];
  for (let i = Math.floor(lx0 / grid) - 1; i * grid <= lx1 + grid; i++)
    for (let j = Math.floor(ly0 / grid) - 1; j * grid <= ly1 + grid; j++) {
      const corner = rotKi({ x: i * grid, y: j * grid }, h.orientation);
      if (corner.x < x0 || corner.x >= x1 || corner.y < y0 || corner.y >= y1) continue;
      out.push(base.map((p) => rotKi({ x: p.x + i * grid, y: p.y + j * grid }, h.orientation)));
    }
  return out;
}

/**
 * Cut the hatch into a (deflated) fill, as KiCad does: the holes are clipped to the fill
 * deflated by the hatch thickness beyond the minimum, and to the zone outline deflated by the
 * minimum thickness; holes left smaller than the minimum hole area go, and so do holes that
 * would wholly enclose a pad's relief or another net's clearance (keeping it connected).
 */
function cutHatch(fill: Paths, holes: Point[][], h: Hatch, minThickness: number, outline: Paths, rings: Paths): Paths {
  if (!holes.length || !fill.length) return fill;
  const size = hatchHoleBase(h, minThickness).size;
  const minArea = size * size * h.holeMinArea * S * S;
  const deflated = offset(fill, -Math.max(h.thickness - minThickness, ARC_ERROR * 2));
  const c = new ClipperLib.Clipper();
  c.AddPaths(intersection(holes.map(toPath), deflated), ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(outline, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctIntersection, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const kept: Paths = [];
  for (const piece of ClipperLib.JS.PolyTreeToExPolygons(tree)) {
    if (Math.abs(ClipperLib.Clipper.Area(piece.outer)) < minArea) continue;
    const encloses = rings.some((r) => r.length && r.every((q) => ClipperLib.Clipper.PointInPolygon(q, piece.outer) === 1));
    if (encloses) continue;
    kept.push(piece.outer, ...piece.holes);
  }
  return kept.length ? difference(fill, kept) : fill;
}

/** Points just outside a thermal pad's relief, where its spokes meet the fill (found by stepping outwards). */
function spokeTips(pad: Pad, gap: number): Point[] {
  const c = padCenter(pad);
  const relief = padPaths(pad, gap);
  const inside = (p: Point) => relief.some((r) => ClipperLib.Clipper.PointInPolygon(ip(p), r) !== 0);
  const base = spokeBase(pad);
  const out: Point[] = [];
  for (let k = 0; k < 4; k++) {
    const d = rot({ x: 1, y: 0 }, base + 90 * k);
    let lo = 0;
    let hi = Math.hypot(pad.size.x, pad.size.y) / 2 + gap + Math.hypot(pad.offset?.x ?? 0, pad.offset?.y ?? 0) + 0.1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inside({ x: c.x + d.x * mid, y: c.y + d.y * mid })) lo = mid;
      else hi = mid;
    }
    const reach = hi + 0.02;
    out.push({ x: c.x + d.x * reach, y: c.y + d.y * reach });
  }
  return out;
}

/** A fast "is this point inside the filled area" test (outlines with holes). */
function pointTester(fill: Paths): (p: Point) => boolean {
  const c = new ClipperLib.Clipper();
  c.AddPaths(fill, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const polys = ClipperLib.JS.PolyTreeToExPolygons(tree).map((poly) => {
    const xs = poly.outer.map((q) => q.X);
    const ys = poly.outer.map((q) => q.Y);
    return { poly, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  });
  return (p) => {
    const q = ip(p);
    return polys.some(
      ({ poly, x0, x1, y0, y1 }) =>
        q.X >= x0 && q.X <= x1 && q.Y >= y0 && q.Y <= y1 && ClipperLib.Clipper.PointInPolygon(q, poly.outer) === 1 && !poly.holes.some((h) => ClipperLib.Clipper.PointInPolygon(q, h) !== 0),
    );
  };
}

/** Drop islands not connected to the zone's net, per its island-removal mode. */
function removeIslands(fill: Paths, zone: Zone, anchors: Point[]): Paths {
  if (!zone.net || zone.islandMode === 1 || !fill.length) return fill;
  const c = new ClipperLib.Clipper();
  c.AddPaths(fill, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const polys = ClipperLib.JS.PolyTreeToExPolygons(tree);
  const pts = anchors.map(ip);
  const out: Paths = [];
  const touches = (poly: ClipperLib.ExPolygon) =>
    pts.some((p) => ClipperLib.Clipper.PointInPolygon(p, poly.outer) !== 0 && !poly.holes.some((h) => ClipperLib.Clipper.PointInPolygon(p, h) === 1));
  // A pour with nothing connected anywhere on this layer is kept as it is (as KiCad does).
  if (!polys.some(touches)) return fill;
  for (const poly of polys) {
    const inside = (p: ClipperLib.IntPoint) => ClipperLib.Clipper.PointInPolygon(p, poly.outer) !== 0 && !poly.holes.some((h) => ClipperLib.Clipper.PointInPolygon(p, h) === 1);
    const connected = pts.some(inside);
    const area = (ClipperLib.Clipper.Area(poly.outer) + poly.holes.reduce((a, h) => a + ClipperLib.Clipper.Area(h), 0)) / (S * S);
    if (connected || (zone.islandMode === 2 && Math.abs(area) >= zone.islandAreaMin)) out.push(poly.outer, ...poly.holes);
  }
  return out;
}

/**
 * Fill every copper zone of the board. Zones fill in priority order (highest
 * first), so lower-priority zones keep clear of them. Keepouts and KiCad's
 * teardrop zones are not refilled (teardrops keep their fills).
 */
export function fillZones(board: Board, rules: DesignRules): ZoneFill[] {
  const copper = board.copperLayers;
  const ctx: FillContext = { board, rules, copper, boardArea: boardArea(board), done: [], flashed: flashChecker(board) };
  // Teardrops keep KiCad's fills, but other zones must keep clear of them.
  for (const z of board.zones.filter((z) => z.teardrop)) {
    for (const f of z.fills) ctx.done.push({ zone: z, layer: f.layer, paths: union([toPath(f.points)]) });
  }
  const zones = board.zones.filter((z) => !z.keepout && !z.teardrop && z.outline.length >= 3).sort((a, b) => b.priority - a.priority);
  const out: ZoneFill[] = [];
  for (const zone of zones) {
    for (const layer of expandLayers(zone.layers, copper)) {
      const f: ZoneFill = { zone, layer, paths: fillZoneLayer(zone, layer, ctx) };
      ctx.done.push(f);
      out.push(f);
    }
  }
  return out;
}

/**
 * KiCad stores fills as simple polygons: each hole is joined to its outline
 * by a zero-width cut. Fracture outer/hole paths into that form.
 */
export function fracture(paths: Paths): Point[][] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return ClipperLib.JS.PolyTreeToExPolygons(tree).map((poly) => fractureOne(fromPath(poly.outer), poly.holes.map(fromPath)));
}

/**
 * One outline with its holes as a single loop. Holes go in order of their leftmost point: a ray
 * to the left from it can only meet the outline or a hole before it, so every hole is joined to
 * the nearest edge it meets there, by a cut along the ray (out and back). The loop is then
 * written in one walk, each hole (with the holes joined to it) inserted after its edge.
 */
function fractureOne(outer: Point[], holePts: Point[][]): Point[] {
  const rings: Point[][] = [outer];
  const start: number[] = [0];
  const holes = holePts.map((h) => {
    let i = 0;
    h.forEach((p, k) => (p.x < h[i]!.x ? (i = k) : 0));
    return { h, i };
  });
  holes.sort((a, b) => a.h[a.i]!.x - b.h[b.i]!.x);
  for (const { h, i } of holes) {
    rings.push(h);
    start.push(i);
  }
  // Edges by 1 mm rows of y, for the ray tests.
  const ROW = 1;
  const rows = new Map<number, Array<{ r: number; k: number }>>();
  rings.forEach((ring, r) =>
    ring.forEach((a, k) => {
      const b = ring[(k + 1) % ring.length]!;
      if (a.y === b.y) return;
      for (let y = Math.floor(Math.min(a.y, b.y) / ROW); y <= Math.floor(Math.max(a.y, b.y) / ROW); y++) (rows.get(y) ?? rows.set(y, []).get(y)!).push({ r, k });
    }),
  );
  // What each edge has joined to it: [hole ring, where along the edge, the cut's end on the edge].
  const joined = new Map<string, Array<{ ring: number; t: number; at: Point }>>();
  for (let r = 1; r < rings.length; r++) {
    const p = rings[r]![start[r]!]!;
    let best: { r: number; k: number; x: number } | undefined;
    for (const { r: er, k } of rows.get(Math.floor(p.y / ROW)) ?? []) {
      if (er >= r) continue; // the hole itself and later holes (all right of it)
      const ring = rings[er]!;
      const a = ring[k]!, b = ring[(k + 1) % ring.length]!;
      if ((a.y > p.y) === (b.y > p.y)) continue;
      const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (x <= p.x && (!best || x > best.x)) best = { r: er, k, x };
    }
    if (!best) continue; // shouldn't happen for a hole inside its outline
    const ring = rings[best.r]!;
    const a = ring[best.k]!;
    const key = `${best.r}:${best.k}`;
    (joined.get(key) ?? joined.set(key, []).get(key)!).push({ ring: r, t: Math.hypot(best.x - a.x, p.y - a.y), at: { x: best.x, y: p.y } });
  }
  const out: Point[] = [];
  // Write ring r from point `from` once round (a hole also back to its first point), with what is joined to each edge.
  const write = (r: number, from: number) => {
    const ring = rings[r]!;
    for (let n = 0; n < ring.length; n++) {
      const k = (from + n) % ring.length;
      out.push(ring[k]!);
      const js = joined.get(`${r}:${k}`);
      if (!js) continue;
      for (const j of js.sort((x, y) => x.t - y.t)) {
        out.push(j.at);
        write(j.ring, start[j.ring]!);
        out.push(j.at);
      }
    }
    if (r > 0) out.push(ring[from]!);
  };
  write(0, 0);
  return out;
}

/** Compare a computed fill with KiCad's stored fill: area of the difference relative to KiCad's area. */
export function fillDifference(ours: Paths, kicadPolys: Point[][]): { kicadArea: number; oursArea: number; xorArea: number } {
  const theirs = union(kicadPolys.map(toPath));
  const xor = clip(ClipperLib.ClipType.ctXor, union(ours), theirs);
  return { kicadArea: pathsArea(theirs), oursArea: pathsArea(union(ours)), xorArea: pathsArea(xor) };
}

/** A pad's copper outline grown (or shrunk, for negative `grow`) by `grow` mm, as polygons in mm. */
export function padPolygons(pad: Pad, grow = 0): Point[][] {
  const paths = grow < 0 ? offset(padPaths(pad, 0), grow) : padPaths(pad, grow);
  // Simple polygons (any hole joined to its outline), ready to plot as regions.
  return fracture(paths);
}

/** A pad's centre of copper (its hole position plus the drill offset). */
export const padCopperCenter = (pad: Pad): Point => padCenter(pad);

// ---------------------------------------------------------------------------
// An outline made from a rectangle
// ---------------------------------------------------------------------------

export interface RectCutout {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Corner radius of the cut-out, mm. */
  radius?: number;
}

/** A rectangle with rounded corners as a polygon; arcs are within `ARC_ERROR` of round. */
function roundedRect(x: number, y: number, w: number, h: number, radius = 0): Point[] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r < 1e-6) return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const n = Math.max(4, Math.ceil(Math.PI / 2 / Math.acos(Math.max(-1, 1 - ARC_ERROR / r))));
  const out: Point[] = [];
  // Corner centres, clockwise from the top left (y down), each with the angle its arc starts at.
  const corners: Array<[number, number, number]> = [
    [x + r, y + r, Math.PI],
    [x + w - r, y + r, 1.5 * Math.PI],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 0.5 * Math.PI],
  ];
  for (const [cx, cy, a0] of corners) for (let k = 0; k <= n; k++) out.push({ x: cx + r * Math.cos(a0 + (k * Math.PI) / 2 / n), y: cy + r * Math.sin(a0 + (k * Math.PI) / 2 / n) });
  return out;
}

/**
 * A board outline that is a rectangle at (x, y) with rounded corners and rectangles cut out of it:
 * one that reaches the edge is a notch, one inside is a hole. Returns the outer boundaries (more
 * than one if the cut-outs split the board) and the holes, as polygons.
 */
export function rectangleOutline(x: number, y: number, width: number, height: number, o: { cornerRadius?: number; cutouts?: RectCutout[] } = {}): { outer: Point[][]; holes: Point[][] } {
  const board = [toPath(roundedRect(x, y, width, height, o.cornerRadius))];
  // A cut-out that reaches an edge is carried on past it, so that its rounded corners fall outside
  // the board and the notch meets the edge squarely.
  const cuts = (o.cutouts ?? []).map((c) => {
    const far = (c.radius ?? 0) + 1;
    const x0 = c.x <= 1e-6 ? c.x - far : c.x, y0 = c.y <= 1e-6 ? c.y - far : c.y;
    const x1 = c.x + c.width >= width - 1e-6 ? c.x + c.width + far : c.x + c.width, y1 = c.y + c.height >= height - 1e-6 ? c.y + c.height + far : c.y + c.height;
    return toPath(roundedRect(x + x0, y + y0, x1 - x0, y1 - y0, c.radius));
  });
  const left = difference(board, union(cuts));
  const outer: Point[][] = [], holes: Point[][] = [];
  for (const p of left) (ClipperLib.Clipper.Orientation(p) ? outer : holes).push(fromPath(ClipperLib.Clipper.CleanPolygon(p, 2)));
  return { outer, holes };
}

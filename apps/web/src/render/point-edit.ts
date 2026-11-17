/**
 * The point editor (KiCad's PCB_POINT_EDITOR) for one selected zone or board
 * graphic: its handles, what dragging one does, and adding or removing a
 * corner. Pure functions over the board model; the view draws the handles and
 * turns the results into edit operations.
 *
 * - Zones and polygons: a handle on each corner, and one in the middle of each
 *   edge that moves the edge across itself, its corners sliding along the
 *   neighbouring edges (KiCad's converging mode). Add Corner splits the edge nearest the
 *   cursor at its nearest point (its middle if that is a corner); Remove
 *   Corner needs four corners or more (KiCad removes a zone left with fewer).
 * - Lines: their ends. Rectangles: corners (the opposite one stays) and edges
 *   (one side moves). Circles: the centre moves the circle, the rim sets the
 *   radius. Arcs: start, middle and end.
 */
import type { Board } from "@crossprobe/kicad-model";

type Point = { x: number; y: number };

export type EditShape =
  | { kind: "zone"; uuid: string; points: Point[] }
  | { kind: "poly"; uuid: string; points: Point[] }
  | { kind: "line"; uuid: string; points: Point[] }
  | { kind: "rect"; uuid: string; points: Point[] }
  | { kind: "circle"; uuid: string; points: Point[] }
  | { kind: "arc"; uuid: string; points: Point[] };

/** A handle: a corner (or a shape's own point) by index, or the middle of an edge (i to i+1). */
export type Handle = { type: "corner"; index: number; at: Point } | { type: "edge"; index: number; at: Point };

/** The editable shape of a zone or board graphic, by UUID. */
export function editShape(board: Board, uuid: string): EditShape | undefined {
  const z = board.zones.find((x) => x.uuid === uuid);
  if (z) return z.outline.length >= 3 ? { kind: "zone", uuid, points: z.outline } : undefined;
  const g = board.drawings.find((x) => x.uuid === uuid);
  if (!g) return undefined;
  if (g.kind === "poly" && g.points.length >= 3) return { kind: "poly", uuid, points: g.points };
  if (g.kind === "line" && g.points.length === 2) return { kind: "line", uuid, points: g.points };
  if (g.kind === "rect" && g.points.length === 2) return { kind: "rect", uuid, points: g.points };
  if (g.kind === "circle" && g.points.length === 2) return { kind: "circle", uuid, points: g.points };
  if (g.kind === "arc" && g.points.length === 3) return { kind: "arc", uuid, points: g.points };
  return undefined;
}

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Rectangle corners in order: start, (end.x, start.y), end, (start.x, end.y). */
const rectCorners = ([a, b]: Point[]): Point[] => [a!, { x: b!.x, y: a!.y }, b!, { x: a!.x, y: b!.y }];

export function handles(s: EditShape): Handle[] {
  if (s.kind === "zone" || s.kind === "poly" || s.kind === "rect") {
    const c = s.kind === "rect" ? rectCorners(s.points) : s.points;
    return [...c.map((at, index): Handle => ({ type: "corner", index, at })), ...c.map((p, index): Handle => ({ type: "edge", index, at: mid(p, c[(index + 1) % c.length]!) }))];
  }
  return s.points.map((at, index) => ({ type: "corner", index, at }));
}

/** The handle within `tol` of `p`, nearest first. */
export function handleAt(s: EditShape, p: Point, tol: number): Handle | undefined {
  let best: Handle | undefined;
  let bd = tol;
  for (const h of handles(s)) {
    const d = Math.hypot(h.at.x - p.x, h.at.y - p.y);
    if (d <= bd) (best = h), (bd = d);
  }
  return best;
}

/** The shape's points with handle `h` dragged to `to` (the points as the edit operation takes them). */
export function dragHandle(s: EditShape, h: Handle, to: Point): Point[] {
  const pts = s.points.map((p) => ({ ...p }));
  if (s.kind === "zone" || s.kind === "poly") {
    if (h.type === "corner") pts[h.index] = to;
    else convergeEdge(pts, h.index, to);
    return pts;
  }
  if (s.kind === "rect") {
    const c = rectCorners(pts);
    if (h.type === "corner") {
      // The opposite corner stays.
      const o = c[(h.index + 2) % 4]!;
      return [o, to];
    }
    // An edge: only its side moves (top, right, bottom, left from the start corner round).
    const [a, b] = pts as [Point, Point];
    const side = [c[0]!, c[1]!, c[2]!, c[3]!][h.index]!;
    const next = c[(h.index + 1) % 4]!;
    const horizontal = side.y === next.y;
    const move = (p: Point) => (horizontal ? (p.y === side.y ? { ...p, y: to.y } : p) : p.x === side.x ? { ...p, x: to.x } : p);
    return [move(a), move(b)];
  }
  if (s.kind === "circle") {
    const [c, r] = pts as [Point, Point];
    if (h.index === 0) return [to, { x: r.x + to.x - c.x, y: r.y + to.y - c.y }];
    return [c, to];
  }
  pts[h.index] = to;
  return pts;
}

/** Where lines p + t·u and q + s·v cross, if they do. */
function cross(p: Point, u: Point, q: Point, v: Point): Point | undefined {
  const d = u.x * v.y - u.y * v.x;
  if (Math.abs(d) < 1e-12) return undefined;
  const t = ((q.x - p.x) * v.y - (q.y - p.y) * v.x) / d;
  return { x: p.x + t * u.x, y: p.y + t * u.y };
}

/** The angle between two directions as lines (0 to 90°). */
const lineAngle = (u: Point, v: Point) => {
  const a = Math.abs(Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y)) * (180 / Math.PI);
  return Math.min(a, 180 - a);
};

/**
 * Drag edge i (corner i to i+1) by its middle, as KiCad's EC_CONVERGING: the
 * edge stays parallel and moves only across itself, to where `to` is across;
 * its corners slide along the neighbouring edges (not past where those meet).
 * When both neighbours run on in line with it, the edge just moves across.
 */
function convergeEdge(pts: Point[], i: number, to: Point): void {
  const n = pts.length;
  const o = pts[i]!, e = pts[(i + 1) % n]!;
  const prev = pts[(i - 1 + n) % n]!, next = pts[(i + 2) % n]!;
  const v = { x: e.x - o.x, y: e.y - o.y };
  const c = { x: (o.x + e.x) / 2, y: (o.y + e.y) / 2 };
  const perp = { x: -v.y, y: v.x };
  const pp = perp.x * perp.x + perp.y * perp.y;
  if (!pp) return;
  const k = ((to.x - c.x) * perp.x + (to.y - c.y) * perp.y) / pp;
  let nc = { x: c.x + k * perp.x, y: c.y + k * perp.y };
  const oDir = { x: o.x - prev.x, y: o.y - prev.y };
  const eDir = { x: e.x - next.x, y: e.y - next.y };
  // Not past the point where the neighbouring edges meet.
  const conv = cross(o, oDir, e, eDir);
  if (conv) {
    const toConv = (conv.x - c.x) * perp.x + (conv.y - c.y) * perp.y;
    if (toConv && ((nc.x - c.x) * perp.x + (nc.y - c.y) * perp.y) / toConv > 1) nc = conv;
  }
  const shift = { x: nc.x - c.x, y: nc.y - c.y };
  if (lineAngle(v, oDir) < 10 && lineAngle(v, eDir) < 10) {
    pts[i] = { x: o.x + shift.x, y: o.y + shift.y };
    pts[(i + 1) % n] = { x: e.x + shift.x, y: e.y + shift.y };
    return;
  }
  const a = cross(nc, v, prev, oDir);
  const b = cross(nc, v, next, eDir);
  if (a) pts[i] = a;
  if (b) pts[(i + 1) % n] = b;
}

/**
 * Add a corner to a zone or polygon where `p` is nearest its outline:
 * KiCad's Add Corner (the nearest edge, split at the nearest point; its
 * middle when that point is a corner).
 */
export function addCorner(points: Point[], p: Point): Point[] {
  let best = 0;
  let bd = Infinity;
  let at: Point = points[0]!;
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const u = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const q = { x: a.x + u * dx, y: a.y + u * dy };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bd) (bd = d), (best = i), (at = u <= 0 || u >= 1 ? mid(a, b) : q);
  });
  const out = points.slice();
  out.splice(best + 1, 0, at);
  return out;
}

/** Remove corner `index`: undefined when that would leave fewer than three (KiCad then removes a zone). */
export function removeCorner(points: Point[], index: number): Point[] | undefined {
  if (points.length <= 3) return undefined;
  return points.filter((_, i) => i !== index);
}

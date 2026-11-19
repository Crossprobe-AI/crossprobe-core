/**
 * The board outline (KiCad's invalid_outline): Edge.Cuts shapes chained into outlines as KiCad
 * builds a board's outline, each problem reported as KiCad's DRC reports it.
 *
 * - Shapes of almost no size (1 µm or less) are reported first, with their size in nm.
 * - A footprint's own Edge.Cuts shapes that close into a cut-out (more than one outline, or pads
 *   outside it) are holes and left out; the rest join the board's shapes.
 * - The board's shapes are chained with a 0.01 mm reach (outlines.chainOutlines); each error
 *   names the two shapes it involves. The mark goes where their strokes overlap, else midway
 *   across the gap between them, and the gap is given ("(gap 0.1000 mm)") when it is measured.
 * - No Edge.Cuts shapes at all: "(no edges found on Edge.Cuts layer)".
 */
import type { Point } from "./geometry.js";
import type { Board, Graphic } from "./board.js";
import type { BoardViolation } from "./drc-checks.js";
import { arcPoints, shapeDistance, type DrcItem, type Shape } from "./drc.js";
import { chainOutlines } from "./outline-chain.js";

interface Edge {
  g: Graphic;
  item: DrcItem;
}

const KIND: Record<Graphic["kind"], string> = { line: "Segment", arc: "Arc", circle: "Circle", rect: "Rectangle", poly: "Polygon", curve: "Bezier Curve" };

/** A shape's stroke as segments of its width (KiCad's effective shape for an outline). */
function strokes(g: Graphic): Array<Extract<Shape, { kind: "seg" }>> {
  const r = g.width / 2;
  const p = g.points;
  let path: Point[];
  if (g.kind === "arc") path = arcPoints(p[0]!, p[1]!, p[2]!).pts;
  else if (g.kind === "circle") {
    const rad = Math.hypot(p[1]!.x - p[0]!.x, p[1]!.y - p[0]!.y);
    path = Array.from({ length: 65 }, (_, i) => ({ x: p[0]!.x + rad * Math.cos((i * Math.PI) / 32), y: p[0]!.y + rad * Math.sin((i * Math.PI) / 32) }));
  } else if (g.kind === "rect" && p.length < 4) path = [p[0]!, { x: p[1]!.x, y: p[0]!.y }, p[1]!, { x: p[0]!.x, y: p[1]!.y }, p[0]!];
  else if (g.kind === "poly" || g.kind === "rect") path = [...p, p[0]!];
  else path = p;
  if (path.length === 1) return [{ kind: "seg", a: path[0]!, b: path[0]!, r }];
  return path.slice(1).map((b, i) => ({ kind: "seg", a: path[i]!, b, r }));
}

function box(g: Graphic) {
  const s = strokes(g);
  return {
    x0: Math.min(...s.map((q) => Math.min(q.a.x, q.b.x) - q.r)),
    y0: Math.min(...s.map((q) => Math.min(q.a.y, q.b.y) - q.r)),
    x1: Math.max(...s.map((q) => Math.max(q.a.x, q.b.x) + q.r)),
    y1: Math.max(...s.map((q) => Math.max(q.a.y, q.b.y) + q.r)),
  };
}

/** The gap between two shapes' strokes (0 where they touch or overlap), and the point midway across it. */
function gapBetween(a: Graphic, b: Graphic): { gap: number; at: Point } {
  let best = { gap: Infinity, at: a.points[0]! };
  for (const s of strokes(a))
    for (const t of strokes(b)) {
      const d = shapeDistance(s, t, 1e9);
      if (Math.max(0, d.dist) < best.gap) best = { gap: Math.max(0, d.dist), at: d.at };
    }
  return best;
}

/** Size of a shape, as KiCad measures it to find ones of almost none (nm), or undefined for kinds it doesn't. */
function sizeNm(g: Graphic): number | undefined {
  const p = g.points.map((q) => ({ x: Math.round(q.x * 1e6), y: Math.round(q.y * 1e6) }));
  const len = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.trunc(Math.hypot(a.x - b.x, a.y - b.y));
  if (g.kind === "line" || (g.kind === "rect" && p.length < 4)) return len(p[0]!, p[1]!);
  if (g.kind === "rect") return len(p[0]!, p[2]!);
  if (g.kind === "circle") return len(p[0]!, p[1]!);
  if (g.kind === "arc") return len(p[1]!, p[0]!) + len(p[2]!, p[1]!);
  return undefined;
}

export function checkBoardOutline(board: Board): BoardViolation[] {
  const out: BoardViolation[] = [];
  const edges: Edge[] = [];
  const holes = new Set<Edge>();
  // KiCad collects footprints' shapes before the board's own drawings.
  for (const fp of board.footprints) {
    const own = fp.graphics
      .filter((g) => g.layer === "Edge.Cuts" && g.points.length)
      .map((g) => ({ g, item: { kind: "graphic", net: "", reference: fp.reference, uuid: g.uuid, description: `${KIND[g.kind]} of ${fp.reference} on Edge.Cuts` } as DrcItem }));
    edges.push(...own);
    if (!own.length) continue;
    const r = chainOutlines(own.map((e) => e.g), 0.01);
    if (!r.ok) continue;
    const inside = (p: Point) => r.outlines.some((o) => {
      let c = false;
      for (let i = 0, j = o.length - 1; i < o.length; j = i++) if (o[i]!.y > p.y !== o[j]!.y > p.y && p.x < ((o[j]!.x - o[i]!.x) * (p.y - o[i]!.y)) / (o[j]!.y - o[i]!.y) + o[i]!.x) c = !c;
      return c;
    });
    // Holes when it makes several outlines or has copper outside its one.
    if (r.outlines.length > 1 || fp.pads.some((pad) => !inside(pad.at))) for (const e of own) holes.add(e);
  }
  for (const g of board.drawings) if (g.layer === "Edge.Cuts" && g.points.length) edges.push({ g, item: { kind: "graphic", net: "", uuid: g.uuid, description: `${KIND[g.kind]} on Edge.Cuts` } });
  if (!edges.length) {
    out.push({ type: "invalid_outline", severity: "error", message: "Board has malformed outline (no edges found on Edge.Cuts layer)", at: { x: 0, y: 0 }, items: [{ kind: "graphic", net: "", description: "PCB" }] });
    return out;
  }
  /** The two shapes of all of them that come closest (KiCad's fallback when an error names fewer than two). */
  let closest: [Edge, Edge] | undefined;
  const closestPair = () => {
    if (closest) return closest;
    let best = Infinity;
    for (let i = 0; i < edges.length; i++)
      for (let j = i + 1; j < edges.length; j++) {
        const d = gapBetween(edges[i]!.g, edges[j]!.g).gap;
        if (d < best) (best = d), (closest = [edges[i]!, edges[j]!]);
      }
    return closest;
  };
  const report = (msg: string, a: Edge | undefined, b: Edge | undefined, at: Point) => {
    if (!a) [a, b] = [b, a];
    if (!a || !b) [a, b] = closestPair() ?? [a, b];
    let text = msg;
    if (a && b) {
      const A = box(a.g), B = box(b.g);
      const w = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0), h = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
      if (w > 1e-9 && h > 1e-9) at = { x: Math.max(A.x0, B.x0) + w / 2, y: Math.max(A.y0, B.y0) + h / 2 };
      else {
        const g = gapBetween(a.g, b.g);
        at = g.at;
        text = `${msg} (gap ${g.gap.toFixed(4)} mm)`;
      }
    }
    out.push({ type: "invalid_outline", severity: "error", message: `Board has malformed outline ${text}`, at, items: [a, b].filter((e): e is Edge => !!e).map((e) => e.item) });
  };
  for (const e of edges) {
    const n = sizeNm(e.g);
    if (n !== undefined && n <= 1000) report(`(${e.g.kind === "line" ? "segment" : e.g.kind === "rect" ? "rectangle" : e.g.kind} has null or very small ${e.g.kind === "line" ? "length" : e.g.kind === "circle" ? "radius" : "size"}: ${n} nm)`, e, undefined, e.g.points[0]!);
  }
  const used = edges.filter((e) => !holes.has(e));
  const r = chainOutlines(used.map((e) => e.g), 0.01);
  for (const err of r.errors) report(err.message, used[err.shapes[0] ?? -1], used[err.shapes[1] ?? -1], err.at);
  return out;
}

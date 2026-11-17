/**
 * Board editing helpers for the view: picking items, box selection,
 * attached track ends, and 45° route shapes. Pure functions over the board
 * model; the view turns them into edit operations.
 */
import type { Board, Footprint, Pad } from "@crossprobe/kicad-model";

type Point = { x: number; y: number };
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type BoardItem =
  /** A footprint; `pad` is the pad it was picked by (its number), if any. */
  | { kind: "footprint"; uuid: string; reference: string; pad?: string }
  | { kind: "track"; uuid: string; net: string }
  | { kind: "via"; uuid: string; net: string }
  | { kind: "zone"; uuid: string; net: string }
  | { kind: "graphic"; uuid: string; layer: string; net?: string }
  | { kind: "text"; uuid: string; layer: string }
  /** A footprint's own text (its reference, value…): moved on its own, as in KiCad. */
  | { kind: "fptext"; uuid: string; layer: string; footprint: string; reference: string };

/** A board text's corners (approximate: stroke glyphs average ~0.9 of their height in width). */
export function textCorners(t: Board["texts"][number]): Point[] {
  const lines = t.text.split("\n");
  const w = Math.max(...lines.map((l) => l.length)) * t.size.x * 0.9;
  const h = t.size.y * (1 + (lines.length - 1) * 1.62);
  const j = t.justify;
  const x0 = j.includes("left") ? 0 : j.includes("right") ? -w : -w / 2;
  const y0 = j.includes("top") ? 0 : j.includes("bottom") ? -h : -h / 2;
  const a = (t.rotation * Math.PI) / 180;
  const m = j.includes("mirror") ? -1 : 1;
  return [
    { x: x0, y: y0 },
    { x: x0 + w, y: y0 },
    { x: x0 + w, y: y0 + h },
    { x: x0, y: y0 + h },
  ].map((p) => ({ x: t.at.x + m * p.x * Math.cos(a) + p.y * Math.sin(a), y: t.at.y - m * p.x * Math.sin(a) + p.y * Math.cos(a) }));
}

const rot = (p: Point, deg: number): Point => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c };
};

export function inPad(pad: Pad, p: Point, tol = 0): boolean {
  const q = rot({ x: p.x - pad.at.x, y: p.y - pad.at.y }, -pad.rotation);
  return Math.abs(q.x) <= pad.size.x / 2 + tol && Math.abs(q.y) <= pad.size.y / 2 + tol;
}

const boxCache = new WeakMap<Footprint, Box>();
/** A footprint's extent: its courtyard if it has one, else pads and graphics. */
export function footprintBox(fp: Footprint): Box {
  const cached = boxCache.get(fp);
  if (cached) return cached;
  const court = fp.graphics.filter((g) => g.layer.endsWith("CrtYd"));
  const pts: Point[] = [];
  for (const g of court.length ? court : fp.graphics.filter((g) => !g.layer.endsWith(".Cu"))) pts.push(...g.points);
  for (const p of fp.pads) {
    const r = Math.max(p.size.x, p.size.y) / 2;
    pts.push({ x: p.at.x - r, y: p.at.y - r }, { x: p.at.x + r, y: p.at.y + r });
  }
  if (!pts.length) pts.push(fp.at);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  boxCache.set(fp, box);
  return box;
}

const inBox = (b: Box, p: Point, tol = 0) => p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;

function trackDistance(t: Board["tracks"][number], p: Point): number {
  const dx = t.end.x - t.start.x;
  const dy = t.end.y - t.start.y;
  const len2 = dx * dx + dy * dy;
  const u = len2 ? Math.max(0, Math.min(1, ((p.x - t.start.x) * dx + (p.y - t.start.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (t.start.x + u * dx), p.y - (t.start.y + u * dy));
}

function segDistance(a: Point, b: Point, p: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const u = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}

/** The edges of a board graphic, as a closed or open polyline. */
export function graphicPath(g: Board["drawings"][number]): Point[] {
  const [a, b] = g.points;
  if (g.kind === "rect" && a && b) return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
  if (g.kind === "circle" && a && b) {
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    return Array.from({ length: 49 }, (_, i) => ({ x: a.x + r * Math.cos((i / 48) * 2 * Math.PI), y: a.y + r * Math.sin((i / 48) * 2 * Math.PI) }));
  }
  if (g.kind === "poly") return [...g.points, g.points[0]!];
  return g.points;
}

const nearPath = (pts: Point[], p: Point, tol: number) => pts.some((q, i) => i > 0 && segDistance(pts[i - 1]!, q, p) <= tol);

/**
 * The item under a point. Vias and tracks first (they sit on top of pads),
 * then footprints by pad, then the smallest footprint whose extent contains it.
 * `layers` limits tracks to visible layers.
 */
/**
 * Every item under a point, in pick order (what a click would take first):
 * for KiCad's "clarify selection" when items overlap.
 */
export function pickAll(board: Board, p: Point, tol: number, layers?: Set<string>): BoardItem[] {
  const out: BoardItem[] = [];
  const seen = new Set<string>();
  const add = (it: BoardItem) => !seen.has(it.uuid + (it.kind === "footprint" ? it.pad ?? "" : "")) && (seen.add(it.uuid + (it.kind === "footprint" ? it.pad ?? "" : "")), out.push(it));
  for (const v of board.vias) if (Math.hypot(p.x - v.at.x, p.y - v.at.y) <= v.size / 2 + tol) add({ kind: "via", uuid: v.uuid, net: v.net });
  for (const fp of board.footprints) {
    const pad = fp.pads.find((q) => inPad(q, p, tol));
    if (pad) add({ kind: "footprint", uuid: fp.uuid, reference: fp.reference, pad: pad.number });
  }
  for (const t of board.tracks) {
    if (layers && !layers.has(t.layer)) continue;
    if (trackDistance(t, p) <= t.width / 2 + tol) add({ kind: "track", uuid: t.uuid, net: t.net });
  }
  for (const fp of board.footprints)
    for (const t of fp.texts) if (t.uuid && (!layers || layers.has(t.layer)) && inPolygon(textCorners(t), p)) add({ kind: "fptext", uuid: t.uuid, layer: t.layer, footprint: fp.uuid, reference: fp.reference });
  for (const fp of board.footprints) if (inBox(footprintBox(fp), p, tol)) add({ kind: "footprint", uuid: fp.uuid, reference: fp.reference });
  for (const t of board.texts) {
    if (!t.uuid || (layers && !layers.has(t.layer))) continue;
    const c = textCorners(t);
    let inside = false;
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      if (c[i]!.y > p.y !== c[j]!.y > p.y && p.x < ((c[j]!.x - c[i]!.x) * (p.y - c[i]!.y)) / (c[j]!.y - c[i]!.y) + c[i]!.x) inside = !inside;
    }
    if (inside) add({ kind: "text", uuid: t.uuid, layer: t.layer });
  }
  for (const z of board.zones) {
    if (layers && !z.layers.some((l) => layers.has(l))) continue;
    if (nearPath([...z.outline, z.outline[0]!], p, tol + 0.1)) add({ kind: "zone", uuid: z.uuid, net: z.net });
  }
  for (const g of board.drawings) {
    if (!g.uuid || (layers && !layers.has(g.layer))) continue;
    if (nearPath(graphicPath(g), p, g.width / 2 + tol)) add({ kind: "graphic", uuid: g.uuid, layer: g.layer, net: g.net });
  }
  return out;
}

function inPolygon(c: Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
    if (c[i]!.y > p.y !== c[j]!.y > p.y && p.x < ((c[j]!.x - c[i]!.x) * (p.y - c[i]!.y)) / (c[j]!.y - c[i]!.y) + c[i]!.x) inside = !inside;
  }
  return inside;
}

export function pickItem(board: Board, p: Point, tol: number, layers?: Set<string>): BoardItem | undefined {
  for (const v of board.vias) if (Math.hypot(p.x - v.at.x, p.y - v.at.y) <= v.size / 2 + tol) return { kind: "via", uuid: v.uuid, net: v.net };
  // Inside a pad, the footprint wins over the tracks ending on it.
  for (const fp of board.footprints) {
    const pad = fp.pads.find((q) => inPad(q, p));
    if (pad) return { kind: "footprint", uuid: fp.uuid, reference: fp.reference, pad: pad.number };
  }
  for (const t of board.tracks) {
    if (layers && !layers.has(t.layer)) continue;
    if (trackDistance(t, p) <= t.width / 2 + tol) return { kind: "track", uuid: t.uuid, net: t.net };
  }
  // A footprint's text under the cursor beats a pad that's merely near.
  for (const fp of board.footprints)
    for (const t of fp.texts) {
      if (!t.uuid || (layers && !layers.has(t.layer))) continue;
      if (inPolygon(textCorners(t), p)) return { kind: "fptext", uuid: t.uuid, layer: t.layer, footprint: fp.uuid, reference: fp.reference };
    }
  for (const fp of board.footprints) {
    const pad = fp.pads.find((q) => inPad(q, p, tol));
    if (pad) return { kind: "footprint", uuid: fp.uuid, reference: fp.reference, pad: pad.number };
  }
  let best: Footprint | undefined;
  for (const fp of board.footprints) {
    const b = footprintBox(fp);
    if (inBox(b, p, tol) && (!best || b.w * b.h < footprintBox(best).w * footprintBox(best).h)) best = fp;
  }
  if (best) return { kind: "footprint", uuid: best.uuid, reference: best.reference };
  // Board texts by their box.
  for (const t of board.texts) {
    if (!t.uuid || (layers && !layers.has(t.layer))) continue;
    if (inPolygon(textCorners(t), p)) return { kind: "text", uuid: t.uuid, layer: t.layer };
  }
  // Zones and board graphics by their edges, as KiCad picks them.
  for (const z of board.zones) {
    if (layers && !z.layers.some((l) => layers.has(l))) continue;
    if (nearPath([...z.outline, z.outline[0]!], p, tol + 0.1)) return { kind: "zone", uuid: z.uuid, net: z.net };
  }
  for (const g of board.drawings) {
    if (!g.uuid || (layers && !layers.has(g.layer))) continue;
    if (nearPath(graphicPath(g), p, g.width / 2 + tol)) return { kind: "graphic", uuid: g.uuid, layer: g.layer, net: g.net };
  }
  return undefined;
}

/** The pad under a point, with its footprint. */
export function padAt(board: Board, p: Point, tol: number): { pad: Pad; fp: Footprint } | undefined {
  for (const fp of board.footprints) for (const pad of fp.pads) if (inPad(pad, p, tol)) return { pad, fp };
  return undefined;
}

/** Items entirely inside a box. */
export function itemsInBox(board: Board, b: Box): BoardItem[] {
  const out: BoardItem[] = [];
  for (const fp of board.footprints) {
    const f = footprintBox(fp);
    if (inBox(b, { x: f.x, y: f.y }) && inBox(b, { x: f.x + f.w, y: f.y + f.h })) out.push({ kind: "footprint", uuid: fp.uuid, reference: fp.reference });
  }
  for (const t of board.tracks) if (inBox(b, t.start) && inBox(b, t.end)) out.push({ kind: "track", uuid: t.uuid, net: t.net });
  for (const v of board.vias) if (inBox(b, v.at)) out.push({ kind: "via", uuid: v.uuid, net: v.net });
  for (const z of board.zones) if (z.outline.every((q) => inBox(b, q))) out.push({ kind: "zone", uuid: z.uuid, net: z.net });
  for (const g of board.drawings) if (g.uuid && graphicPath(g).every((q) => inBox(b, q))) out.push({ kind: "graphic", uuid: g.uuid, layer: g.layer, net: g.net });
  for (const t of board.texts) if (t.uuid && inBox(b, t.at)) out.push({ kind: "text", uuid: t.uuid, layer: t.layer });
  return out;
}

/**
 * Ends of unselected tracks attached to what is being moved (pads of moved
 * footprints, moved vias, ends of moved tracks), so they can stretch along.
 */
export function attachedTrackEnds(board: Board, uuids: Set<string>): Array<{ uuid: string; index: 0 | 1; at: Point }> {
  const anchors: Array<{ at: Point; r: number; pad?: Pad }> = [];
  for (const fp of board.footprints) if (uuids.has(fp.uuid)) for (const pad of fp.pads) anchors.push({ at: pad.at, r: 0, pad });
  for (const v of board.vias) if (uuids.has(v.uuid)) anchors.push({ at: v.at, r: 0.001 });
  for (const t of board.tracks) if (uuids.has(t.uuid)) anchors.push({ at: t.start, r: 0.001 }, { at: t.end, r: 0.001 });
  const out: Array<{ uuid: string; index: 0 | 1; at: Point }> = [];
  for (const t of board.tracks) {
    if (uuids.has(t.uuid)) continue;
    ([t.start, t.end] as const).forEach((end, index) => {
      // A track end belongs to a pad it lies in on the same net; to a via or track end it touches.
      const hit = anchors.some((a) => (a.pad ? inPad(a.pad, end) && a.pad.net === t.net : Math.hypot(end.x - a.at.x, end.y - a.at.y) <= a.r));
      if (hit) out.push({ uuid: t.uuid, index: index as 0 | 1, at: end });
    });
  }
  return out;
}

/**
 * A 45° route from a to b: a straight run then a diagonal, or the other
 * way round (`diagonalFirst`), as KiCad's router postures do.
 */
export function route45(a: Point, b: Point, diagonalFirst = false): Point[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 1e-9 || ay < 1e-9 || Math.abs(ax - ay) < 1e-9) return [a, b];
  const d = Math.min(ax, ay);
  const diag = { x: Math.sign(dx) * d, y: Math.sign(dy) * d };
  const mid = diagonalFirst ? { x: a.x + diag.x, y: a.y + diag.y } : { x: b.x - diag.x, y: b.y - diag.y };
  return [a, mid, b];
}

export const snap = (p: Point, grid: number): Point => ({ x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid });

/**
 * The trace(s) the picked tracks and vias belong to: every track and via of
 * the same net reachable through track ends and vias (KiCad's "select
 * connected", U). Pads end the walk, so each pad-to-pad route stays separate.
 */
export function connectedTrace(board: Board, picked: BoardItem[]): BoardItem[] {
  const tracks = board.tracks;
  const vias = board.vias;
  const near = (a: Point, b: Point, r: number) => Math.hypot(a.x - b.x, a.y - b.y) <= r + 1e-6;
  const seenT = new Set<number>();
  const seenV = new Set<number>();
  const queue: Array<{ kind: "t" | "v"; i: number }> = [];
  for (const p of picked) {
    if (p.kind === "track") {
      const i = tracks.findIndex((t) => t.uuid === p.uuid);
      if (i >= 0 && !seenT.has(i)) seenT.add(i), queue.push({ kind: "t", i });
    } else if (p.kind === "via") {
      const i = vias.findIndex((v) => v.uuid === p.uuid);
      if (i >= 0 && !seenV.has(i)) seenV.add(i), queue.push({ kind: "v", i });
    }
  }
  while (queue.length) {
    const cur = queue.pop()!;
    const net = cur.kind === "t" ? tracks[cur.i]!.net : vias[cur.i]!.net;
    const ends = cur.kind === "t" ? [{ p: tracks[cur.i]!.start, layer: tracks[cur.i]!.layer }, { p: tracks[cur.i]!.end, layer: tracks[cur.i]!.layer }] : [{ p: vias[cur.i]!.at, layer: "*" }];
    for (const e of ends) {
      tracks.forEach((t, i) => {
        if (seenT.has(i) || t.net !== net || (e.layer !== "*" && t.layer !== e.layer)) return;
        const r = cur.kind === "v" ? vias[cur.i]!.size / 2 : 0.001;
        if (near(t.start, e.p, r) || near(t.end, e.p, r)) seenT.add(i), queue.push({ kind: "t", i });
      });
      vias.forEach((v, i) => {
        if (seenV.has(i) || v.net !== net) return;
        if (near(v.at, e.p, v.size / 2)) seenV.add(i), queue.push({ kind: "v", i });
      });
    }
  }
  return [
    ...[...seenT].map((i) => ({ kind: "track" as const, uuid: tracks[i]!.uuid, net: tracks[i]!.net })),
    ...[...seenV].map((i) => ({ kind: "via" as const, uuid: vias[i]!.uuid, net: vias[i]!.net })),
  ];
}

/** The selectable item a UUID names (footprints, tracks, vias, zones, drawings, texts). */
export function boardItemOf(board: Board, uuid: string): BoardItem | undefined {
  const fp = board.footprints.find((f) => f.uuid === uuid);
  if (fp) return { kind: "footprint", uuid, reference: fp.reference };
  const t = board.tracks.find((x) => x.uuid === uuid);
  if (t) return { kind: "track", uuid, net: t.net };
  const v = board.vias.find((x) => x.uuid === uuid);
  if (v) return { kind: "via", uuid, net: v.net };
  const z = board.zones.find((x) => x.uuid === uuid);
  if (z) return { kind: "zone", uuid, net: z.net };
  const g = board.drawings.find((x) => x.uuid === uuid);
  if (g) return { kind: "graphic", uuid, layer: g.layer, net: g.net };
  const tx = board.texts.find((x) => x.uuid === uuid);
  if (tx) return { kind: "text", uuid, layer: tx.layer };
  return undefined;
}

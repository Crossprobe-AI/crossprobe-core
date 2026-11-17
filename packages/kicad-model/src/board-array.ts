/**
 * Create Array, as KiCad's board editor does it (pcbnew's ARRAY_TOOL and
 * ARRAY_OPTIONS, reimplemented from their behaviour):
 *
 * - A grid of nx × ny cells `dx`/`dy` apart, each row (or column) shifted by
 *   `offsetX`/`offsetY`, optionally staggered, filled row by row or column
 *   by column (alternate rows reversed if asked). The selection is cell 0,
 *   or the array is centred on it.
 * - A circle of `count` cells around `center`, `angle` apart (0: spread over
 *   the full circle), starting `offset` on, either way round; items turn
 *   with the circle when `rotateItems` is set.
 * - Each other cell gets copies of the selection (footprints keep their nets,
 *   and are reannotated to the next free reference after their own unless
 *   annotations are kept). Or, with `arrange`, the selected items themselves
 *   are laid out one per cell, in selection order.
 */
import { arg, findChild, findChildren, headOf, isList, parse, serialize, setArg, str, walk, type List } from "@crossprobe/kicad-sexpr";
import { findBoardItem, insertBoardItem, moveBoardItem, newBoardUuid, rotateBoardItem, rotatePoint, setLocked } from "./board-edit.js";
import type { Point } from "./geometry.js";

export interface GridArray {
  kind: "grid";
  nx: number;
  ny: number;
  /** Spacing between columns (x) and rows (y), mm. */
  dx: number;
  dy: number;
  /** Shift of each row along x (offsetX) and of each column along y (offsetY), mm. */
  offsetX?: number;
  offsetY?: number;
  /** Stagger every `stagger` rows (or columns): 1 for none. */
  stagger?: number;
  staggerRows?: boolean;
  /** Fill order: along rows first (KiCad's default), or down columns. */
  horizontalFirst?: boolean;
  /** Snake: every other row runs the other way. */
  reverseAlternate?: boolean;
  /** Centre the array on the selection instead of starting at it. */
  centred?: boolean;
}

export interface CircularArray {
  kind: "circular";
  count: number;
  center: Point;
  /** Angle between cells, degrees; 0 spreads them over the full circle. */
  angle: number;
  /** Angle of the first cell, degrees. */
  offset?: number;
  clockwise?: boolean;
  rotateItems?: boolean;
}

export type ArrayOptions = GridArray | CircularArray;

export const arraySize = (o: ArrayOptions) => (o.kind === "grid" ? o.nx * o.ny : o.count);

// KiCad works in integer nanometres.
const nm = (v: number) => Math.round(v * 1e6);
const mm = (v: number) => v / 1e6;

/** ARRAY_GRID_OPTIONS::getGridCoords: the cell's column and row in fill order. */
function gridCoords(o: GridArray, n: number): Point {
  const axis = o.horizontalFirst === false ? o.ny : o.nx;
  let x = n % axis;
  const y = Math.trunc(n / axis);
  if (o.reverseAlternate && y % 2) x = axis - x - 1;
  return { x, y };
}

/**
 * Where cell `n` puts an item that is at `pos`: the move, and the turn about
 * the item's new position (degrees, KiCad's: counter-clockwise on screen).
 */
export function arrayTransform(o: ArrayOptions, n: number, pos: Point): { dx: number; dy: number; rotation: number } {
  if (o.kind === "grid") {
    const c = gridCoords(o, n);
    if (o.horizontalFirst === false) [c.x, c.y] = [c.y, c.x];
    const dx = nm(o.dx), dy = nm(o.dy), ox = nm(o.offsetX ?? 0), oy = nm(o.offsetY ?? 0);
    let x = c.x * dx + c.y * ox;
    let y = c.y * dy + c.x * oy;
    const stagger = Math.abs(o.stagger ?? 1);
    if (stagger > 1) {
      const rows = o.staggerRows ?? true;
      const idx = (rows ? c.y : c.x) % stagger;
      const sign = Math.sign(o.stagger ?? 1);
      x += Math.trunc(((rows ? dx : ox) * idx * sign) / stagger);
      y += Math.trunc(((rows ? oy : dy) * idx * sign) / stagger);
    }
    if (o.centred) {
      x -= Math.trunc(((o.nx - 1) * dx + (o.ny - 1) * ox) / 2);
      y -= Math.trunc(((o.ny - 1) * dy + (o.nx - 1) * oy) / 2);
    }
    return { dx: mm(x), dy: mm(y), rotation: 0 };
  }
  let angle = o.angle === 0 ? (360 * n) / o.count : o.angle * n;
  angle += o.offset ?? 0;
  if (o.clockwise) angle = -angle;
  const p = rotatePoint(pos, o.center, angle);
  return { dx: p.x - pos.x, dy: p.y - pos.y, rotation: o.rotateItems ? angle : 0 };
}

const getXY = (n: List | undefined): Point => ({ x: Number(arg(n, 0) ?? 0), y: Number(arg(n, 1) ?? 0) });

/** An item's position as KiCad's GetPosition gives it. */
function itemPosition(node: List): Point {
  const head = headOf(node) ?? "";
  if (head === "segment" || head === "gr_line" || head === "gr_rect" || head === "gr_circle") return getXY(findChild(node, "start") ?? findChild(node, "center"));
  if (head === "arc") return getXY(findChild(node, "start"));
  if (head === "gr_arc") {
    const [a, m, b] = ["start", "mid", "end"].map((h) => getXY(findChild(node, h)));
    const d = 2 * (a!.x * (m!.y - b!.y) + m!.x * (b!.y - a!.y) + b!.x * (a!.y - m!.y));
    if (!d) return a!;
    const s = (p: Point) => p.x * p.x + p.y * p.y;
    return { x: (s(a!) * (m!.y - b!.y) + s(m!) * (b!.y - a!.y) + s(b!) * (a!.y - m!.y)) / d, y: (s(a!) * (b!.x - m!.x) + s(m!) * (a!.x - b!.x) + s(b!) * (m!.x - a!.x)) / d };
  }
  if (head === "gr_poly" || head === "zone") {
    let first: Point | undefined;
    walk(node, (n) => {
      if (!first && headOf(n) === "xy") first = getXY(n);
      return !first;
    });
    return first ?? { x: 0, y: 0 };
  }
  return getXY(findChild(node, "at"));
}

/** Move by the cell's offset, then turn about the new position (KiCad's TransformItem). */
function transformItem(node: List, o: ArrayOptions, n: number): void {
  const pos = itemPosition(node);
  const t = arrayTransform(o, n, pos);
  moveBoardItem(node, t.dx, t.dy);
  if (t.rotation) rotateBoardItem(node, t.rotation, { x: pos.x + t.dx, y: pos.y + t.dy });
}

const refField = (fp: List) => findChildren(fp, "property").find((q) => arg(q, 0) === "Reference") ?? findChildren(fp, "fp_text").find((q) => arg(q, 0) === "reference");
const refOf = (fp: List) => String(arg(refField(fp), 1) ?? "");

/** KiCad's StrNumCmp, enough for references: text parts by text, number parts by value. */
function strNumCmp(a: string, b: string): number {
  const pa = a.match(/\d+|\D+/g) ?? [], pb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!, y = pb[i]!;
    const d = /^\d/.test(x) && /^\d/.test(y) ? Number(x) - Number(y) : x.toUpperCase() < y.toUpperCase() ? -1 : x.toUpperCase() > y.toUpperCase() ? 1 : 0;
    if (d) return d;
  }
  return pa.length - pb.length;
}

/**
 * Lay out the items `uuids` (top-level board items) as an array. Returns the
 * UUIDs of the copies made (none when arranging).
 */
export function createBoardArray(root: List, uuids: string[], o: ArrayOptions, opts: { reannotate?: boolean; arrange?: boolean } = {}): string[] {
  const nodes = uuids.map((u) => findBoardItem(root, u)).filter((n): n is List => !!n);
  const size = arraySize(o);
  if (opts.arrange) {
    // One item per cell: each starts from where the first item ended up, then takes its cell.
    const first = nodes[0];
    nodes.slice(0, size).forEach((node, i) => {
      if (i > 0) {
        const a = itemPosition(first!), b = itemPosition(node);
        moveBoardItem(node, a.x - b.x, a.y - b.y);
      }
      transformItem(node, o, i);
    });
    return [];
  }
  const used = new Set(findChildren(root, "footprint").map(refOf));
  const fresh: string[] = [];
  for (let cell = 1; cell < size; cell++) {
    const copies = nodes.map((n) => parse(serialize(n)).children.find(isList)!).filter(Boolean);
    // References are handed out in KiCad's order: by reference, then lowest, then leftmost.
    const fps = copies
      .filter((c) => headOf(c) === "footprint")
      .sort((a, b) => {
        const d = strNumCmp(refOf(a), refOf(b));
        if (d) return d;
        const pa = itemPosition(a), pb = itemPosition(b);
        return pa.y !== pb.y ? pb.y - pa.y : pa.x - pb.x;
      });
    for (const copy of copies) {
      walk(copy, (n) => {
        if (headOf(n) === "uuid" || headOf(n) === "tstamp") setArg(n, 0, str(newBoardUuid()));
        return true;
      });
      const id = String(arg(findChild(copy, "uuid") ?? findChild(copy, "tstamp"), 0));
      fresh.push(id);
      if (headOf(copy) === "footprint") setLocked(copy, false);
      transformItem(copy, o, cell);
    }
    if (opts.reannotate !== false)
      for (const fp of fps) {
        const field = refField(fp);
        if (!field) continue;
        const ref = refOf(fp);
        const stem = ref.replace(/\d+$/, "");
        let value = /\d+$/.test(ref) ? Number(/\d+$/.exec(ref)![0]) : 0;
        let next = ref;
        while (used.has(next)) next = `${stem}${++value}`;
        used.add(next);
        setArg(field, 1, str(next));
      }
    for (const copy of copies) insertBoardItem(root, copy);
  }
  return fresh;
}

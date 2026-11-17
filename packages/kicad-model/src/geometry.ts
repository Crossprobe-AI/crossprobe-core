/** Schematic geometry helpers. Coordinates are millimetres, Y pointing down. */

export interface Point {
  x: number;
  y: number;
}

/**
 * KiCad stores schematic coordinates in 100 nm internal units, so rounding
 * to 1e-4 mm gives exact point identity without floating-point noise.
 */
export function pointKey(p: Point): string {
  return `${Math.round(p.x * 10000)},${Math.round(p.y * 10000)}`;
}

/** Orientation of a placed symbol: rotation in degrees (0/90/180/270) plus mirroring. */
export interface Orientation {
  rotation: number;
  mirrorX: boolean; // flip vertically (about the X axis)
  mirrorY: boolean; // flip horizontally (about the Y axis)
}

/**
 * Map a point from symbol-library space (Y up) to sheet space (Y down),
 * relative to the symbol anchor. KiCad applies rotation first, then mirror.
 */
export function transformLibPoint(p: Point, o: Orientation, origin: Point): Point {
  // Library Y is up; flip to sheet Y-down first.
  let x = p.x;
  let y = -p.y;
  const r = ((o.rotation % 360) + 360) % 360;
  // Counter-clockwise on screen (Y down) for positive angles.
  switch (r) {
    case 90:
      [x, y] = [y, -x];
      break;
    case 180:
      [x, y] = [-x, -y];
      break;
    case 270:
      [x, y] = [-y, x];
      break;
  }
  if (o.mirrorX) y = -y;
  if (o.mirrorY) x = -x;
  return { x: origin.x + x, y: origin.y + y };
}

/** True when `p` lies on segment a–b (inclusive of endpoints). Axis-aligned or diagonal. */
/** Is the point inside the polygon (even-odd), or on its outline? */
export function inPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (onSegment(p, a, b)) return true;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Does the segment a–b touch the polygon: an end inside it, or crossing its outline? */
export function segmentInPolygon(a: Point, b: Point, poly: Point[]): boolean {
  if (inPolygon(a, poly) || inPolygon(b, poly)) return true;
  const cross = (o: Point, p: Point, q: Point) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const c = poly[j]!;
    const d = poly[i]!;
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
  }
  return false;
}

export function onSegment(p: Point, a: Point, b: Point, eps = 1e-4): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y) <= eps;
  if (Math.abs(cross) / len > eps) return false;
  const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
  return dot >= -eps * len && dot <= len * len + eps * len;
}

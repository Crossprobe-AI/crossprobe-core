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
export function onSegment(p: Point, a: Point, b: Point, eps = 1e-4): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y) <= eps;
  if (Math.abs(cross) / len > eps) return false;
  const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
  return dot >= -eps * len && dot <= len * len + eps * len;
}

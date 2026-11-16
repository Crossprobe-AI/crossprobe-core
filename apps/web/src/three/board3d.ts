/**
 * The 3D board: the Edge.Cuts outline extruded to the board thickness, with
 * drill holes and cutouts, textured top and bottom with solder mask, copper,
 * exposed pads and silkscreen drawn by the 2D renderer. Footprint models are
 * placed with KiCad's own transform order.
 */
import * as THREE from "three";
import { boardBodyThickness, type Board, type Footprint, type OutlineShape, type Point } from "@crossprobe/kicad-model";
import { buildScene, drawKnockouts, padLayers, padPath } from "../render/board";

// ---------------------------------------------------------------------------
// Outline → closed loops
// ---------------------------------------------------------------------------

function arcPoints(a: Point, m: Point, b: Point, steps = 24): Point[] {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-9) return [a, b];
  const sq = (p: Point) => p.x * p.x + p.y * p.y;
  const cx = (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d;
  const cy = (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  const tau = Math.PI * 2;
  const norm = (x: number) => ((x % tau) + tau) % tau;
  const a0 = Math.atan2(a.y - cy, a.x - cx);
  const toMid = norm(Math.atan2(m.y - cy, m.x - cx) - a0);
  const toEnd = norm(Math.atan2(b.y - cy, b.x - cx) - a0);
  const span = toMid < toEnd ? toEnd : toEnd - tau;
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = a0 + (span * i) / steps;
    out.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  out[0] = a;
  out[out.length - 1] = b;
  return out;
}

function circlePoints(c: Point, r: number, steps = 48): Point[] {
  return Array.from({ length: steps }, (_, i) => ({ x: c.x + r * Math.cos((i / steps) * Math.PI * 2), y: c.y + r * Math.sin((i / steps) * Math.PI * 2) }));
}

const area = (pts: Point[]) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]!; return s + p.x * q.y - q.x * p.y; }, 0) / 2;
const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 0.02;

/** Chain Edge.Cuts segments into closed loops (largest first). */
export function outlineLoops(shapes: OutlineShape[]): Point[][] {
  const loops: Point[][] = [];
  const open: Point[][] = [];
  for (const s of shapes) {
    const p = s.points;
    if (s.kind === "circle") loops.push(circlePoints(p[0]!, Math.hypot(p[1]!.x - p[0]!.x, p[1]!.y - p[0]!.y)));
    else if (s.kind === "rect") loops.push([p[0]!, { x: p[1]!.x, y: p[0]!.y }, p[1]!, { x: p[0]!.x, y: p[1]!.y }]);
    else if (s.kind === "poly") loops.push(p);
    else if (s.kind === "arc") open.push(arcPoints(p[0]!, p[1]!, p[2]!));
    else if (p.length >= 2) open.push(p);
  }
  while (open.length) {
    const chain = open.shift()!;
    let grew = true;
    while (grew && !near(chain[0]!, chain[chain.length - 1]!)) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const seg = open[i]!;
        const end = chain[chain.length - 1]!;
        if (near(seg[0]!, end)) chain.push(...seg.slice(1));
        else if (near(seg[seg.length - 1]!, end)) chain.push(...seg.slice(0, -1).reverse());
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (chain.length > 2) loops.push(near(chain[0]!, chain[chain.length - 1]!) ? chain.slice(0, -1) : chain);
  }
  return loops.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

export const COLORS3D = {
  mask: "#1f5c34",
  copperUnderMask: "#2f7a46",
  pad: "#d8b46a", // ENIG-style gold
  silk: "#f4f4f0",
  hole: "#141414",
  substrate: "#c8b88a",
};

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

function sideTexture(board: Board, side: "F" | "B", bounds: Bounds, scene: ReturnType<typeof buildScene>): THREE.CanvasTexture {
  const ppm = Math.min(24, 4096 / Math.max(bounds.w, bounds.h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.ceil(bounds.w * ppm));
  canvas.height = Math.max(2, Math.ceil(bounds.h * ppm));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = COLORS3D.mask;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(ppm, 0, 0, ppm, -bounds.x * ppm, -bounds.y * ppm);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const copper = scene.layers.get(`${side}.Cu`);
  if (copper) {
    ctx.fillStyle = ctx.strokeStyle = COLORS3D.copperUnderMask;
    ctx.fill(copper.fills, "evenodd");
    for (const [w, path] of copper.strokes) {
      ctx.lineWidth = w;
      ctx.stroke(path);
    }
  }
  // Pads with a mask opening on this side are exposed copper.
  const exposed = new Path2D();
  const all = board.copperLayers.length ? board.copperLayers : ["F.Cu", "B.Cu"];
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      const layers = padLayers(pad, all);
      if (layers.includes(`${side}.Mask`) && (layers.includes(`${side}.Cu`) || pad.type === "np_thru_hole")) padPath(exposed, pad);
    }
  }
  ctx.fillStyle = COLORS3D.pad;
  ctx.fill(exposed);

  const silk = scene.layers.get(`${side}.SilkS`);
  if (silk) {
    ctx.fillStyle = ctx.strokeStyle = COLORS3D.silk;
    ctx.fill(silk.fills, "evenodd");
    for (const [w, path] of silk.strokes) {
      ctx.lineWidth = w;
      ctx.stroke(path);
    }
    drawKnockouts(ctx, silk, COLORS3D.silk, COLORS3D.mask);
  }
  ctx.fillStyle = COLORS3D.hole;
  ctx.fill(scene.holes);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  // Shape UVs are (x, -y) in mm; map them onto the canvas.
  tex.repeat.set(1 / bounds.w, 1 / bounds.h);
  tex.offset.set(-bounds.x / bounds.w, (bounds.y + bounds.h) / bounds.h);
  return tex;
}

// ---------------------------------------------------------------------------
// Board mesh
// ---------------------------------------------------------------------------

const toShapePts = (pts: Point[]) => pts.map((p) => new THREE.Vector2(p.x, -p.y));

export interface Board3D {
  group: THREE.Group;
  /** The board's height, outer copper included; it spans z = −B.Cu … body + F.Cu. */
  thickness: number;
  bounds: Bounds;
  seat: Seat;
}

/** Where models sit: on the solder paste above F.Cu (top) and below B.Cu (bottom), as in KiCad's 3D viewer. */
export interface Seat {
  top: number;
  bottom: number;
}

/** KiCad's 3D viewer's paste layer, which models stand on (mm). */
const PASTE = 0.04;

/**
 * KiCad's 3D viewer layout: the body (dielectrics and inner copper) from z = 0 up, F.Cu on
 * top of it and B.Cu under it; models stand on the paste, 0.04 mm over the outer copper.
 */
export function boardSeat(board: Board): { body: number; cuF: number; cuB: number; seat: Seat } {
  const body = boardBodyThickness(board);
  const cuF = Math.max(board.copperThickness?.["F.Cu"] ?? 0.035, 0.001);
  const cuB = Math.max(board.copperThickness?.["B.Cu"] ?? 0.035, 0.001);
  return { body, cuF, cuB, seat: { top: body + cuF + PASTE, bottom: -(cuB + PASTE) } };
}

export function buildBoard3D(board: Board): Board3D {
  const { body, cuF, cuB, seat } = boardSeat(board);
  const thickness = body + cuF + cuB;
  const scene = buildScene(board);
  let loops = outlineLoops(board.outline);
  if (!loops.length) {
    const b = scene.bbox;
    loops = [[{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }]];
  }
  const outer = loops[0]!;
  const xs = outer.map((p) => p.x);
  const ys = outer.map((p) => p.y);
  const bounds = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };

  const shape = new THREE.Shape(toShapePts(area(outer) > 0 ? outer : [...outer].reverse()));
  const inside = (p: Point) => p.x > bounds.x && p.x < bounds.x + bounds.w && p.y > bounds.y && p.y < bounds.y + bounds.h;
  for (const loop of loops.slice(1)) if (inside(loop[0]!)) shape.holes.push(new THREE.Path(toShapePts(loop)));
  // Through-holes for pads (vias are only drawn on the texture, to keep triangulation fast).
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      if (!pad.drill || (pad.type !== "thru_hole" && pad.type !== "np_thru_hole") || !inside(pad.at)) continue;
      const r = (pad.drillSize ? Math.min(pad.drillSize.x, pad.drillSize.y) : pad.drill) / 2;
      const h = new THREE.Path();
      h.absarc(pad.at.x, -pad.at.y, r, 0, Math.PI * 2, true);
      shape.holes.push(h);
    }
  }

  const group = new THREE.Group();
  const edge = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 12 });
  edge.translate(0, 0, -cuB);
  const sideMat = new THREE.MeshStandardMaterial({ color: COLORS3D.substrate, roughness: 0.8 });
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  group.add(new THREE.Mesh(edge, [hidden, sideMat]));

  const capGeom = new THREE.ShapeGeometry(shape, 12);
  const top = new THREE.Mesh(capGeom, new THREE.MeshStandardMaterial({ map: sideTexture(board, "F", bounds, scene), roughness: 0.55, metalness: 0.05 }));
  top.position.z = body + cuF + 0.002;
  const bottom = new THREE.Mesh(capGeom, new THREE.MeshStandardMaterial({ map: sideTexture(board, "B", bounds, scene), roughness: 0.55, metalness: 0.05, side: THREE.BackSide }));
  bottom.position.z = -cuB - 0.002;
  group.add(top, bottom);
  return { group, thickness, bounds, seat };
}

// ---------------------------------------------------------------------------
// Footprint placement
// ---------------------------------------------------------------------------

const deg = THREE.MathUtils.degToRad;

/**
 * KiCad's model transform: footprint position and rotation, a flip for
 * bottom-side parts, then the model's own offset, rotation (Z, Y, X, negated)
 * and scale.
 */
export function modelMatrix(fp: Footprint, model: Footprint["models"][number], seat: Seat): THREE.Matrix4 {
  const bottom = fp.layer === "B.Cu";
  const m = new THREE.Matrix4().makeTranslation(fp.at.x, -fp.at.y, bottom ? seat.bottom : seat.top);
  m.multiply(new THREE.Matrix4().makeRotationZ(deg(fp.rotation)));
  if (bottom) {
    m.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
    m.multiply(new THREE.Matrix4().makeRotationZ(Math.PI));
  }
  m.multiply(new THREE.Matrix4().makeTranslation(model.offset[0], model.offset[1], model.offset[2]));
  m.multiply(new THREE.Matrix4().makeRotationZ(deg(-model.rotate[2])));
  m.multiply(new THREE.Matrix4().makeRotationY(deg(-model.rotate[1])));
  m.multiply(new THREE.Matrix4().makeRotationX(deg(-model.rotate[0])));
  m.multiply(new THREE.Matrix4().makeScale(model.scale[0], model.scale[1], model.scale[2]));
  return m;
}

const boxMaterial = new THREE.MeshStandardMaterial({ color: "#2a2d33", roughness: 0.7 });

/** A stand-in box for footprints without an available model: courtyard (or pad) extent, 1 mm tall. */
export function placeholderBox(fp: Footprint, seat: Seat): THREE.Mesh | undefined {
  let pts = fp.graphics.filter((g) => g.layer.endsWith("CrtYd")).flatMap((g) => g.points);
  if (pts.length < 2) pts = fp.pads.flatMap((p) => [{ x: p.at.x - p.size.x / 2, y: p.at.y - p.size.y / 2 }, { x: p.at.x + p.size.x / 2, y: p.at.y + p.size.y / 2 }]);
  if (pts.length < 2) return undefined;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const d = Math.max(...ys) - Math.min(...ys);
  if (w <= 0 || d <= 0) return undefined;
  const h = Math.min(1, Math.max(0.3, Math.min(w, d) * 0.4));
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, d * 0.9, h), boxMaterial);
  const bottom = fp.layer === "B.Cu";
  mesh.position.set((Math.min(...xs) + Math.max(...xs)) / 2, -(Math.min(...ys) + Math.max(...ys)) / 2, bottom ? seat.bottom - h / 2 : seat.top + h / 2);
  return mesh;
}

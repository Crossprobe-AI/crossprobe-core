/**
 * Footprints against their library copies, as KiCad's DRC checks them
 * (DRC_TEST_PROVIDER_LIBRARY_PARITY and FOOTPRINT::FootprintNeedsUpdate,
 * reimplemented from their behaviour). The library footprint is placed where
 * the board's is (same side, position and angle, as Update Footprint from
 * Library places it), then:
 *
 * - its type (SMD / through-hole) and "allow bridged solder mask" must match;
 * - its graphics (not texts; each line's ends in order; identical ones once)
 *   must match one for one in KiCad's sort order: kind, layer, fill, points
 *   within 10 nm (an arc's middle within 0.5 µm), and the line width on copper;
 * - its pads, sorted by number, position and size, must match one for one:
 *   number, position, side and layers, type, fabrication property, angle,
 *   shape, size, rounded and chamfered corners, offset, hole and primitives.
 *
 * Texts, net-tie groups' contents beyond their count, 3D models and
 * clearance overrides are not compared (KiCad's DRC leaves them out too, or
 * only reports them). A library file that doesn't read cleanly gets no verdict.
 */
import { parse, serialize, type List } from "@crossprobe/kicad-sexpr";
import { parseBoard, type Footprint, type Graphic, type Pad } from "./board.js";
import { boardRoot } from "./board-edit.js";
import { updateFootprintFromLibrary } from "./board-update.js";
import type { Point } from "./geometry.js";

// KiCad's tolerances: 10 nm for points (EPSILON), 1e-5 for ratios and angles (EPSILON_D).
const EPS = 10e-6 + 1e-9;
const EPS_D = 1e-5;
const near = (a: Point, b: Point, e = EPS) => Math.abs(a.x - b.x) <= e && Math.abs(a.y - b.y) <= e;
const eq = (a: number | undefined, b: number | undefined) => Math.abs((a ?? 0) - (b ?? 0)) < 1e-9;

/** StrNumCmp, enough for pad numbers: text by text, numbers by value. */
function strNumCmp(a: string, b: string): number {
  const pa = a.match(/\d+|\D+/g) ?? [], pb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!, y = pb[i]!;
    const d = /^\d/.test(x) && /^\d/.test(y) ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (d) return d;
  }
  return pa.length - pb.length;
}

const cmpPt = (a: Point | undefined, b: Point | undefined) => (!a || !b ? 0 : a.x !== b.x ? a.x - b.x : a.y - b.y);

/** A graphic normalised as KiCad compares it: a line's ends left to right (top to bottom), a rectangle's corners ordered. */
function normalise(g: Graphic): Graphic {
  if (g.kind === "line" && g.points.length === 2) {
    const [s, e] = g.points as [Point, Point];
    return s.x > e.x || (s.x === e.x && s.y < e.y) ? { ...g, points: [e, s] } : g;
  }
  if (g.kind === "rect" && g.points.length === 2) {
    const [s, e] = g.points as [Point, Point];
    return { ...g, points: [{ x: Math.min(s.x, e.x), y: Math.min(s.y, e.y) }, { x: Math.max(s.x, e.x), y: Math.max(s.y, e.y) }] };
  }
  return g;
}

/** FOOTPRINT::cmp_drawings, for our graphics: layer, kind, start, end, then the rest of the points. */
function cmpGraphic(a: Graphic, b: Graphic): number {
  if (a.layer !== b.layer) return a.layer < b.layer ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.kind !== "poly") {
    const s = cmpPt(a.points[0], b.points[0]) || cmpPt(a.points.at(-1), b.points.at(-1));
    if (s) return s;
  }
  for (let i = 0; i < Math.min(a.points.length, b.points.length); i++) {
    const d = cmpPt(a.points[i], b.points[i]);
    if (d) return d;
  }
  if (a.points.length !== b.points.length) return a.points.length - b.points.length;
  if (a.width !== b.width) return a.width - b.width;
  return Number(a.fill) - Number(b.fill);
}

/** Whether two closed point loops are the same, from any starting point (SHAPE_LINE_CHAIN::CompareGeometry, cyclic). */
function sameLoop(a: Point[], b: Point[]): boolean {
  if (a.length !== b.length) return false;
  if (!a.length) return true;
  for (let k = 0; k < b.length; k++) if (a.every((p, i) => near(p, b[(i + k) % b.length]!))) return true;
  return false;
}

/** KiCad's shapeNeedsUpdate (on normalised shapes). */
function graphicDiffers(a: Graphic, b: Graphic): boolean {
  if (a.kind !== b.kind || a.layer !== b.layer || a.fill !== b.fill) return true;
  if (a.kind === "poly") {
    if (!sameLoop(a.points, b.points)) return true;
  } else if (a.kind === "arc") {
    if (!near(a.points[0]!, b.points[0]!) || !near(a.points[2]!, b.points[2]!)) return true;
    // An arc's middle is computed, so may round differently when its parents turn differently.
    if (Math.hypot(a.points[1]!.x - b.points[1]!.x, a.points[1]!.y - b.points[1]!.y) > 0.0005) return true;
  } else if (a.points.length !== b.points.length || a.points.some((p, i) => !near(p, b.points[i]!))) return true;
  // The line itself only counts on copper.
  if (a.layer.endsWith(".Cu") && !eq(a.width, b.width)) return true;
  return false;
}

/** A pad's layers as the board has them: wildcards expanded, only the board's layers kept. */
function padLayers(p: Pad, layers: string[], copper: string[]): string {
  const out = new Set<string>();
  for (const l of p.layers) {
    if (l === "*.Cu") copper.forEach((c) => out.add(c));
    else if (l === "F&B.Cu") ["F.Cu", "B.Cu"].forEach((c) => out.add(c));
    else if (l.startsWith("*.")) ["F", "B"].forEach((s) => out.add(`${s}.${l.slice(2)}`));
    else out.add(l);
  }
  return [...out].filter((l) => !layers.length || layers.includes(l)).sort().join(",");
}

/** FOOTPRINT::cmp_pads: number, position, size, shape, layers. */
function cmpPad(a: Pad, b: Pad): number {
  if (a.number !== b.number) return strNumCmp(a.number, b.number);
  return cmpPt(a.at, b.at) || a.size.x - b.size.x || a.size.y - b.size.y || (a.shape < b.shape ? -1 : a.shape > b.shape ? 1 : 0) || (a.layers.join() < b.layers.join() ? -1 : a.layers.join() > b.layers.join() ? 1 : 0);
}

const norm360 = (a: number) => ((a % 360) + 360) % 360;

/** KiCad's padNeedsUpdate (both footprints placed alike, so absolute angles compare as relative ones). */
function padDifference(a: Pad, b: Pad, layers: string[], copper: string[]): string | undefined {
  if (!near(a.at, b.at) || a.number !== b.number) return "position or number";
  if (!!a.unusedLayers !== !!b.unusedLayers || (a.unusedLayers && a.unusedLayers.keepEnds !== b.unusedLayers!.keepEnds)) return "unused-layer removal";
  if (padLayers(a, layers, copper) !== padLayers(b, layers, copper)) return "layers";
  if (a.type !== b.type || (a.property ?? "") !== (b.property ?? "")) return "type or property";
  if (Math.abs(norm360(a.rotation) - norm360(b.rotation)) > EPS_D && Math.abs(Math.abs(norm360(a.rotation) - norm360(b.rotation)) - 360) > EPS_D) return "angle";
  if (a.shape !== b.shape || !eq(a.size.x, b.size.x) || !eq(a.size.y, b.size.y)) return "shape or size";
  if ((a.shape === "roundrect" || a.chamfer) && Math.abs((a.roundrectRatio ?? 0.25) - (b.roundrectRatio ?? 0.25)) > EPS_D) return "corner rounding";
  if (!!a.chamfer !== !!b.chamfer) return "chamfer";
  if (a.chamfer && (Math.abs(a.chamfer.ratio - b.chamfer!.ratio) > EPS_D || [...a.chamfer.corners].sort().join() !== [...b.chamfer!.corners].sort().join())) return "chamfer size";
  if (!near(a.offset ?? { x: 0, y: 0 }, b.offset ?? { x: 0, y: 0 })) return "offset";
  if (!!a.drillSize !== !!b.drillSize || !eq(a.drill, b.drill) || (a.drillSize && (!eq(a.drillSize.x, b.drillSize!.x) || !eq(a.drillSize.y, b.drillSize!.y)))) return "hole";
  const pa = a.primitives ?? [], pb = b.primitives ?? [];
  if (pa.length !== pb.length) return "primitives";
  for (let i = 0; i < pa.length; i++) {
    const x = pa[i]!, y = pb[i]!;
    if (x.kind !== y.kind || x.fill !== y.fill || !eq(x.width, y.width) || x.points.length !== y.points.length || x.points.some((p, k) => !near(p, y.points[k]!))) return "primitive";
  }
  return undefined;
}

/** Whether a placed footprint (its board `node`) differs from its library copy `modText` (KiCad's lib_footprint_mismatch). */
export function footprintNeedsUpdate(node: List, modText: string, board: { layers: string[]; copperLayers: string[] }): boolean {
  return footprintDifference(node, modText, board) !== undefined;
}

/** How a placed footprint first differs from its library copy, or undefined when it doesn't. */
export function footprintDifference(node: List, modText: string, board: { layers: string[]; copperLayers: string[] }): string | undefined {
  const wrap = (n: List) => `(kicad_pcb (version 20260206)\n${serialize(n)}\n)`;
  const cur = parseBoard(wrap(node)).footprints[0];
  if (!cur) return undefined;
  // A library file that only reads with repairs (KiCad's reader copes with more): no verdict.
  if (parse(modText, { recover: true }).diagnostics.length) return undefined;
  const doc = parse(wrap(node), { recover: true });
  const root = boardRoot(doc);
  if (!updateFootprintFromLibrary(root, cur.uuid, modText)) return "unreadable library footprint";
  const lib: Footprint | undefined = parseBoard(serialize(doc)).footprints[0];
  if (!lib) return "unreadable library footprint";
  if (cur.attributes.mount !== lib.attributes.mount) return "footprint type";
  if (!!cur.attributes.allowMaskBridges !== !!lib.attributes.allowMaskBridges) return "bridged solder mask setting";
  if (!!cur.netTie !== !!lib.netTie) return "net-tie pad groups";
  // Graphics: shapes only (not dimensions), normalised, identical ones once, in KiCad's order.
  const shapes = (f: Footprint) => {
    const sorted = f.graphics.filter((g) => !g.dimension).map(normalise).sort(cmpGraphic);
    return sorted.filter((g, i) => i === 0 || cmpGraphic(g, sorted[i - 1]!) !== 0);
  };
  const ga = shapes(cur), gb = shapes(lib);
  if (ga.length !== gb.length) return `graphic count ${ga.length} vs ${gb.length}`;
  const gi = ga.findIndex((g, i) => graphicDiffers(g, gb[i]!));
  if (gi >= 0) return `graphic ${ga[gi]!.kind} on ${ga[gi]!.layer} ${JSON.stringify(ga[gi]!.points)} vs ${JSON.stringify(gb[gi]!.points)}`;
  const pa = [...cur.pads].sort(cmpPad), pb = [...lib.pads].sort(cmpPad);
  if (pa.length !== pb.length) return `pad count ${pa.length} vs ${pb.length}`;
  for (let i = 0; i < pa.length; i++) {
    const d = padDifference(pa[i]!, pb[i]!, board.layers, board.copperLayers);
    if (d) return `pad ${pa[i]!.number}: ${d}`;
  }
  return undefined;
}

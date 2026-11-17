/**
 * Reading a .kicad_pcb file into a typed board model: layers, footprints
 * with pads and nets, tracks, vias, zones and the board outline.
 *
 * Coordinates are millimetres in board space (Y down). Pad positions are
 * resolved to board coordinates so checks don't need footprint transforms.
 * Supports KiCad 6–10; KiCad 10 writes nets by name only (`(net "GND")`),
 * earlier versions as `(net 3 "GND")`.
 */
import { arcPoints } from "./drc.js";
import { arg, atomText, findChild, findChildren, headOf, isAtom, isList, parse, type List } from "@crossprobe/kicad-sexpr";
import type { Point } from "./geometry.js";

export interface BoardLayer {
  id: number;
  name: string;
  type: string; // signal, power, mixed, jumper, user
  userName?: string;
}

export type PadType = "smd" | "thru_hole" | "np_thru_hole" | "connect";

export interface Pad {
  number: string;
  type: PadType;
  shape: string;
  /** Board coordinates. */
  at: Point;
  /** Absolute orientation in degrees (KiCad stores it including the footprint's). */
  rotation: number;
  size: Point;
  /** Corner radius as a fraction of the smaller side, for roundrect pads. */
  roundrectRatio?: number;
  drill?: number;
  /** Oval drill size when the hole is slotted. */
  drillSize?: Point;
  /** Local clearance override (mm), if the pad sets one. */
  clearance?: number;
  /** Zone connection override for this pad. */
  zoneConnect?: ZoneConnection;
  thermalGap?: number;
  /** Local solder-mask expansion (mm) and paste margin (mm) / ratio, overriding footprint and board. */
  maskMargin?: number;
  pasteMargin?: number;
  pasteRatio?: number;
  thermalWidth?: number;
  /** Thermal spoke angle (degrees). */
  thermalAngle?: number;
  /** Fabrication property, e.g. "heatsink" (pad_prop_heatsink). */
  property?: string;
  /** Unused-layer removal: copper only where something connects (plus end layers if kept). */
  unusedLayers?: UnusedLayers;
  /** Chamfered corners (rect/roundrect): size as a fraction of the smaller side, and which corners. */
  chamfer?: { ratio: number; corners: Array<"top_left" | "top_right" | "bottom_left" | "bottom_right"> };
  /** Custom pads: extra shapes in the pad's frame (relative to its centre, unrotated). */
  primitives?: Array<{ kind: "poly" | "line" | "circle" | "rect" | "arc"; points: Point[]; width: number; fill: boolean }>;
  /** Offset of the copper shape from the hole (pad frame, unrotated); KiCad's (drill … (offset x y)). */
  offset?: Point;
  layers: string[];
  net: string;
  pinFunction?: string;
  pinType?: string;
  uuid?: string;
}

export interface Footprint {
  uuid: string;
  /** Locked (KiCad's (locked yes)): not to be moved or deleted by accident. */
  locked?: boolean;
  libId: string;
  reference: string;
  value: string;
  at: Point;
  rotation: number;
  /** "F.Cu" or "B.Cu". */
  layer: string;
  /** Local clearance override for all its pads (mm), if set. */
  clearance?: number;
  /** Zone connection override for all its pads. */
  zoneConnect?: ZoneConnection;
  /** Net-tie footprint (net_tie_pad_groups): its copper graphics may join its pads' nets. */
  netTie?: boolean;
  maskMargin?: number;
  pasteMargin?: number;
  pasteRatio?: number;
  /** Symbol path, "/<sheet uuids…>/<symbol uuid>" (root sheet omitted). */
  path: string;
  sheetName: string;
  sheetFile: string;
  properties: Record<string, string>;
  attributes: {
    mount: "smd" | "through_hole" | "unspecified";
    boardOnly: boolean;
    excludeFromBom: boolean;
    excludeFromPosFiles: boolean;
    dnp: boolean;
    /** Its pads may share solder-mask openings (fine-pitch parts). */
    allowMaskBridges?: boolean;
  };
  pads: Pad[];
  /** Footprint graphics in board coordinates (silkscreen, fab, courtyard, copper…). */
  graphics: Graphic[];
  /** Visible texts: reference/value fields and free texts. */
  texts: BoardText[];
  /** 3D models, with paths as written (may contain ${KICAD10_3DMODEL_DIR} etc). */
  models: Model3D[];
}

export interface Model3D {
  path: string;
  offset: [number, number, number];
  scale: [number, number, number];
  rotate: [number, number, number];
  hidden: boolean;
  opacity: number;
}

export interface Graphic {
  layer: string;
  kind: "line" | "arc" | "circle" | "rect" | "poly" | "curve";
  /** line/rect: start, end · arc: start, mid, end · circle: center, point on circle · poly/curve: points. */
  points: Point[];
  width: number;
  fill: boolean;
  /** Copper shapes can carry a net (KiCad 7+). */
  net?: string;
  /** One of a dimension's lines. */
  dimension?: boolean;
  /** Its UUID: board drawings have one; footprint graphics when the file gives them one (the footprint editor does). */
  uuid?: string;
}

export interface BoardText {
  uuid?: string;
  layer: string;
  text: string;
  at: Point;
  rotation: number;
  /** Character height and width. */
  size: Point;
  thickness: number;
  justify: string[];
  /** Knockout text: drawn as a filled box with the letters cut out. */
  knockout?: boolean;
  /** Bold: KiCad's stroke font draws it with a heavier pen. */
  bold?: boolean;
  /**
   * TrueType text: KiCad's rendered glyph outlines (its render cache), in
   * board coordinates, filled even-odd (holes are separate loops).
   */
  outline?: Point[][];
  /** Footprint texts are drawn readable (rotated into (-90, 90]) unless unlocked. */
  keepUpright?: boolean;
}

export interface Track {
  uuid: string;
  locked?: boolean;
  kind: "segment" | "arc";
  start: Point;
  end: Point;
  mid?: Point;
  width: number;
  layer: string;
  net: string;
}

/** KiCad's remove_unused_layers / keep_end_layers / zone_layer_connections. */
export interface UnusedLayers {
  keepEnds: boolean;
  zoneLayers: string[];
}

export type ViaType = "through" | "blind" | "buried" | "micro";

export interface Via {
  uuid: string;
  /** Through (the default), or blind/buried/micro: those span `layers` only. */
  type?: ViaType;
  locked?: boolean;
  unusedLayers?: UnusedLayers;
  at: Point;
  size: number;
  drill: number;
  layers: string[];
  net: string;
}

export interface Zone {
  uuid: string;
  net: string;
  name: string;
  layers: string[];
  /** Outline polygon as drawn (not the filled area). */
  outline: Point[];
  keepout: boolean;
  /** Copper fill as last computed by KiCad, per layer. */
  fills: Array<{ layer: string; points: Point[] }>;
  /** Fill settings (KiCad's zone properties). */
  priority: number;
  /** The zone's own clearance (connect_pads clearance). */
  clearance: number;
  /** How same-net pads connect: thermal reliefs, solid, not at all, or thermal for through-hole only. */
  connect: ZoneConnection;
  minThickness: number;
  fillEnabled: boolean;
  thermalGap: number;
  thermalWidth: number;
  /** 0: always remove islands, 1: never, 2: below islandAreaMin (mm²). */
  islandMode: number;
  islandAreaMin: number;
  /** Rule area forbidding copper pours. */
  noCopperPour: boolean;
  /** Rule area forbidding tracks, and vias. */
  noTracks: boolean;
  noVias: boolean;
  /** Teardrop zones are generated by KiCad's teardrop tool. */
  teardrop: boolean;
  /** Hatched (grid) fill instead of solid. */
  hatched: boolean;
}

export type ZoneConnection = "thermal" | "solid" | "none" | "tht";

export interface OutlineShape {
  kind: "line" | "arc" | "circle" | "rect" | "poly" | "curve";
  points: Point[];
  /** Line width (mm). */
  width?: number;
}

/** One stackup layer; a dielectric can have sublayers, each with its own values. */
export interface StackupItem {
  /** The board layer ("F.Mask", "F.Cu") or the dielectric's name ("dielectric 1"). */
  layer: string;
  /** "Top Silk Screen", "Top Solder Paste", "Top Solder Mask", "copper", "core", "prepreg", … */
  type: string;
  sub: Array<{ thickness?: number; material?: string; color?: string; epsilonR?: number; lossTangent?: number }>;
}

export interface Board {
  version: number;
  /** The title block's revision, when it gives one. */
  revision?: string;
  thickness?: number;
  /** Copper thickness per layer (mm), from the stackup when the board has one. */
  copperThickness?: Record<string, number>;
  /** The physical stackup, front to back, when the board has one (copper and dielectrics). */
  stackup?: Array<{ name: string; type: string; thickness: number; epsilonR?: number }>;
  /** The whole stackup as the file gives it, front to back (silkscreen, paste, mask, copper, dielectrics), and its fab specs. */
  stackupFull?: { items: StackupItem[]; finish?: string; dielectricConstraints: boolean; edgePlating: boolean; edgeConnector?: "yes" | "bevelled" };
  layers: BoardLayer[];
  /** Copper layer names, front to back. */
  copperLayers: string[];
  nets: string[];
  footprints: Footprint[];
  tracks: Track[];
  vias: Via[];
  zones: Zone[];
  /** Graphic items on Edge.Cuts, including those inside footprints. */
  outline: OutlineShape[];
  /** Board-level graphics on all layers. */
  drawings: Graphic[];
  texts: BoardText[];
  /** Board setup for fabrication outputs: mask and paste margins, via tenting. */
  setup: { maskMargin: number; pasteMargin: number; pasteRatio: number; tentFront: boolean; tentBack: boolean; allowMaskBridgesInFootprints?: boolean; /** Drill/place origin (fab outputs' 0,0 when used). */ auxOrigin?: Point; /** Grid origin (Position Relative's reference). */ gridOrigin?: Point };
  warnings: string[];
}

// ---------------------------------------------------------------------------

/** A (pts …) list: xy points and arcs (start/mid/end, approximated by points), in order. */
function ptsOf(pts: List): Point[] {
  const out: Point[] = [];
  for (const c of pts.children) {
    if (!isList(c)) continue;
    const h = headOf(c);
    if (h === "xy") out.push(pt(c));
    else if (h === "arc") {
      const a = arcPoints(pt(findChild(c, "start")), pt(findChild(c, "mid")), pt(findChild(c, "end"))).pts;
      // Consecutive arcs/points share ends: skip a duplicate start.
      const last = out.at(-1);
      out.push(...(last && Math.abs(last.x - a[0]!.x) < 1e-9 && Math.abs(last.y - a[0]!.y) < 1e-9 ? a.slice(1) : a));
    }
  }
  return out;
}

/** A custom pad's primitives (gr_poly, gr_line, gr_circle, gr_rect, gr_arc), in the pad frame. */
function primitivesOf(pad: List): Pad["primitives"] {
  const prims = findChild(pad, "primitives");
  if (!prims) return undefined;
  const kinds: Record<string, "poly" | "line" | "circle" | "rect" | "arc"> = { gr_poly: "poly", gr_line: "line", gr_circle: "circle", gr_rect: "rect", gr_arc: "arc" };
  const out: NonNullable<Pad["primitives"]> = [];
  for (const c of prims.children) {
    if (!isList(c)) continue;
    const kind = kinds[headOf(c) ?? ""];
    if (!kind) continue;
    const width = numOf(c, "width") ?? 0;
    const fillNode = findChild(c, "fill");
    const fill = kind === "poly" ? !fillNode || String(arg(fillNode, 0)) !== "no" : !!fillNode && ["yes", "solid"].includes(String(arg(fillNode, 0)));
    const points =
      kind === "poly"
        ? ptsOf(findChild(c, "pts") ?? c)
        : kind === "circle"
          ? [pt(findChild(c, "center")), pt(findChild(c, "end"))]
          : kind === "arc"
            ? [pt(findChild(c, "start")), pt(findChild(c, "mid")), pt(findChild(c, "end"))]
            : [pt(findChild(c, "start")), pt(findChild(c, "end"))];
    out.push({ kind, points, width, fill });
  }
  return out.length ? out : undefined;
}

function unusedLayersOf(n: List): UnusedLayers | undefined {
  if (str(findChild(n, "remove_unused_layers")) !== "yes" && !n.children.some((c) => isAtom(c) && c.raw === "remove_unused_layers")) return undefined;
  const z = findChild(n, "zone_layer_connections");
  return {
    keepEnds: str(findChild(n, "keep_end_layers")) === "yes" || n.children.some((c) => isAtom(c) && c.raw === "keep_end_layers"),
    zoneLayers: z ? z.children.slice(1).filter(isAtom).map(atomText) : [],
  };
}

const numOf = (n: List, head: string): number | undefined => {
  const c = findChild(n, head);
  const v = c ? Number(arg(c, 0)) : NaN;
  return Number.isFinite(v) ? v : undefined;
};
/** KiCad's zone_connect codes: 0 none, 1 thermal, 2 solid, 3 thermal for through-hole only. */
function zoneConnectOf(n: List): ZoneConnection | undefined {
  const v = numOf(n, "zone_connect");
  return v === 0 ? "none" : v === 1 ? "thermal" : v === 2 ? "solid" : v === 3 ? "tht" : undefined;
}
const itemUuid = (n: List) => String(arg(findChild(n, "uuid") ?? findChild(n, "tstamp"), 0) ?? "");
const pt = (n: List | undefined): Point => ({ x: Number(arg(n, 0) ?? 0), y: Number(arg(n, 1) ?? 0) });
const str = (n: List | undefined, i = 0): string => String(arg(n, i) ?? "");

/** Net name from `(net "X")` (v10) or `(net 3 "X")` (≤ v9). */
function netOf(node: List): string {
  const net = findChild(node, "net");
  return net ? netName(net) : "";
}

/**
 * Net number → name, from the board's `(net N "name")` table. KiCad 9 writes
 * tracks and vias with the number only; set while a board is being parsed.
 */
let netNumbers = new Map<number, string>();

/** The net name of a `(net …)` node, whichever version wrote it. */
function netName(net: List): string {
  const s = net.children.slice(1).find((a) => isAtom(a) && a.kind === "string");
  if (s && isAtom(s)) return atomText(s);
  const n = net.children.slice(1).find((a) => isAtom(a) && a.kind === "number");
  return n && isAtom(n) ? (netNumbers.get(Number(n.raw)) ?? "") : "";
}

function layersOf(node: List): string[] {
  const l = findChild(node, "layers");
  if (l) return l.children.slice(1).filter(isAtom).map(atomText);
  const single = findChild(node, "layer");
  return single ? [str(single)] : [];
}

/** Rotate a footprint-local point into board space (KiCad: positive = CCW on screen). */
function toBoard(local: Point, origin: Point, degrees: number): Point {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const x = local.x * c + local.y * s;
  const y = -local.x * s + local.y * c;
  return { x: round(origin.x + x), y: round(origin.y + y) };
}
const round = (v: number) => Math.round(v * 1e6) / 1e6;

function shapePoints(node: List, kind: OutlineShape["kind"]): Point[] {
  switch (kind) {
    case "line":
    case "rect":
      return [pt(findChild(node, "start")), pt(findChild(node, "end"))];
    case "arc":
      return [pt(findChild(node, "start")), pt(findChild(node, "mid")), pt(findChild(node, "end"))];
    case "circle":
      return [pt(findChild(node, "center")), pt(findChild(node, "end"))];
    default:
      return ptsOf(findChild(node, "pts") ?? node);
  }
}

export interface DimensionParams {
  type: "aligned" | "orthogonal" | "leader" | "center" | "radial";
  start: Point;
  end: Point;
  /** Offset of the crossbar from the measured points (signed, mm). */
  height: number;
  /** Orthogonal: measure vertically. */
  vertical?: boolean;
  width?: number;
  arrowLength?: number;
  extensionOffset?: number;
  extensionHeight?: number;
  inward?: boolean;
}

/**
 * The lines KiCad draws for a dimension: extension lines, the crossbar and
 * its arrowheads (27.5° wings); a leader's line and arrow; a centre mark's
 * cross. Also where the crossbar runs, for placing the text.
 */
export function dimensionGeometry(p: DimensionParams): { lines: Array<[Point, Point]>; crossbar?: [Point, Point] } {
  const arrow = p.arrowLength ?? 1.27;
  const extOffset = p.extensionOffset ?? 0.5;
  const extHeight = p.extensionHeight ?? 0.58642;
  const { start, end, height } = p;
  const lines: Array<[Point, Point]> = [];
  let bar: [Point, Point] | undefined;
  const add = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y) > 1e-9 && lines.push([a, b]);
  const unitOf = (v: Point) => {
    const l = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / l, y: v.y / l };
  };
  const along = (q: Point, u: Point, k: number) => ({ x: q.x + u.x * k, y: q.y + u.y * k });
  const turn = (u: Point, deg: number) => {
    const r = (deg * Math.PI) / 180;
    return { x: u.x * Math.cos(r) - u.y * Math.sin(r), y: u.x * Math.sin(r) + u.y * Math.cos(r) };
  };
  // An arrowhead at `q`, its wings opening along `u`, with an optional tail behind it.
  const head = (q: Point, u: Point, tail = 0) => {
    if (tail) add(q, along(q, u, -tail));
    add(q, along(q, turn(u, 27.5), arrow));
    add(q, along(q, turn(u, -27.5), arrow));
  };
  const crossbar = (cs: Point, ce: Point) => {
    bar = [cs, ce];
    add(cs, ce);
    const u = unitOf({ x: ce.x - cs.x, y: ce.y - cs.y });
    const back = { x: -u.x, y: -u.y };
    // Outward arrows point at the extension lines; inward ones sit outside with tails.
    if (p.inward) {
      head(cs, back, 2 * arrow);
      head(ce, u, 2 * arrow);
    } else {
      head(cs, u);
      head(ce, back);
    }
  };
  if (p.type === "aligned" || p.type === "orthogonal") {
    const sgn = height < 0 ? -1 : 1;
    if (p.type === "aligned") {
      const d = { x: end.x - start.x, y: end.y - start.y };
      const perp = unitOf({ x: -d.y, y: d.x });
      const ext = { x: perp.x * sgn, y: perp.y * sgn };
      for (const q of [start, end]) add(along(q, ext, extOffset), along(q, ext, Math.abs(height) + extHeight));
      crossbar(along(start, perp, height), along(end, perp, height));
    } else {
      const off = p.vertical ? { x: height, y: 0 } : { x: 0, y: height };
      const ext = unitOf(off);
      add(along(start, ext, extOffset), along(start, ext, Math.abs(height) + extHeight));
      const cs = { x: start.x + off.x, y: start.y + off.y };
      const ce = p.vertical ? { x: cs.x, y: end.y } : { x: end.x, y: cs.y };
      const toEnd = { x: end.x - ce.x, y: end.y - ce.y };
      if (Math.hypot(toEnd.x, toEnd.y) > 1e-9) {
        const u2 = unitOf(toEnd);
        add(along(ce, u2, -extHeight), along(end, u2, -extOffset));
      }
      crossbar(cs, ce);
    }
  } else if (p.type === "leader") {
    add(start, end);
    head(start, unitOf({ x: end.x - start.x, y: end.y - start.y }));
  } else if (p.type === "center") {
    const v = { x: end.x - start.x, y: end.y - start.y };
    add({ x: start.x - v.x, y: start.y - v.y }, end);
    add({ x: start.x + v.y, y: start.y - v.x }, { x: start.x - v.y, y: start.y + v.x });
  }
  return { lines, crossbar: bar };
}

/** A dimension as its lines (on its layer) and its text (stored as placed). */
function dimensionOf(node: List): { graphics: Graphic[]; text?: BoardText } {
  const type = String(arg(findChild(node, "type") ?? node, 0) ?? "aligned") as DimensionParams["type"];
  const layer = str(findChild(node, "layer"));
  const pts = ptsOf(findChild(node, "pts") ?? node);
  const style = findChild(node, "style");
  const opt = (name: string) => {
    const v = arg(findChild(style ?? node, name) ?? node, 0);
    return v === undefined ? undefined : Number(v);
  };
  const width = opt("thickness") || 0.1;
  const graphics: Graphic[] = [];
  if (pts[0] && pts[1] && type !== "radial") {
    const { lines } = dimensionGeometry({
      type,
      start: pts[0],
      end: pts[1],
      height: Number(arg(findChild(node, "height") ?? node, 0) ?? 0) || 0,
      vertical: Number(arg(findChild(node, "orientation") ?? node, 0) ?? 0) === 1,
      arrowLength: opt("arrow_length"),
      extensionOffset: opt("extension_offset"),
      extensionHeight: opt("extension_height"),
      inward: String(arg(findChild(style ?? node, "arrow_direction") ?? node, 0) ?? "") === "inward",
    });
    for (const [a, b] of lines) graphics.push({ layer, kind: "line", points: [a, b], width, fill: false });
  }
  const gt = findChild(node, "gr_text");
  const text = gt && type !== "center" && !isHidden(gt) ? textOf(gt, str(gt, 0), (q) => q) : undefined;
  if (text && !text.layer) text.layer = layer;
  return { graphics, text };
}

function graphicOf(node: List, kind: Graphic["kind"], transform: (p: Point) => Point): Graphic {
  const stroke = findChild(node, "stroke");
  const width = Number(arg(findChild(stroke ?? node, "width"), 0) ?? 0);
  const fillNode = findChild(node, "fill");
  const fillValue = fillNode ? String(arg(findChild(fillNode, "type") ?? fillNode, 0) ?? "") : "";
  return {
    layer: str(findChild(node, "layer")),
    kind,
    points: shapePoints(node, kind).map(transform),
    width,
    fill: fillValue === "yes" || fillValue === "solid",
    net: netOf(node) || undefined,
  };
}

/** KiCad's lock: (locked yes), or a bare `locked` token in older files. */
function isLocked(node: List): boolean {
  return node.children.some((c) => (isAtom(c) && c.raw === "locked") || (headOf(c) === "locked" && arg(c as List, 0) !== "no"));
}

function isHidden(node: List): boolean {
  const effects = findChild(node, "effects");
  for (const n of [node, effects]) {
    if (!n) continue;
    for (const c of n.children) {
      if (isAtom(c) && c.raw === "hide") return true;
      if (headOf(c) === "hide") return arg(c as List, 0) !== "no";
    }
  }
  return false;
}

function textOf(node: List, text: string, transform: (p: Point) => Point): BoardText {
  const atNode = findChild(node, "at");
  const effects = findChild(node, "effects");
  const font = effects && findChild(effects, "font");
  const size = pt(font && findChild(font, "size"));
  const justify = effects && findChild(effects, "justify");
  return {
    layer: str(findChild(node, "layer")),
    knockout: findChild(node, "layer")?.children.some((c) => isAtom(c) && c.raw === "knockout") || undefined,
    text,
    at: transform(pt(atNode)),
    rotation: Number(arg(atNode, 2) ?? 0),
    // KiCad writes (size height width).
    size: { x: size.y || 1, y: size.x || 1 },
    // Without a thickness KiCad draws with a pen of 1/8 of the text size (bold makes it heavier; see textPen).
    thickness: (() => {
      const t = arg(font && findChild(font, "thickness"), 0);
      return t !== undefined ? Number(t) : (size.y || 1) / 8;
    })(),
    justify: justify ? justify.children.slice(1).filter(isAtom).map(atomText) : [],
    bold: (!!font && (font.children.some((c) => isAtom(c) && c.raw === "bold") || arg(findChild(font, "bold"), 0) === "yes")) || undefined,
    // A TrueType face is drawn from KiCad's cached outlines (the stroke font stands in without them).
    outline: font && findChild(font, "face") && findChild(node, "render_cache") ? findChildren(findChild(node, "render_cache")!, "polygon").flatMap((pg) => findChildren(pg, "pts").map((p) => ptsOf(p).map(transform))) : undefined,
  };
}

const OUTLINE_KINDS: Record<string, OutlineShape["kind"]> = {
  gr_line: "line", gr_arc: "arc", gr_circle: "circle", gr_rect: "rect", gr_poly: "poly", gr_curve: "curve",
  fp_line: "line", fp_arc: "arc", fp_circle: "circle", fp_rect: "rect", fp_poly: "poly", fp_curve: "curve",
};

function parseFootprint(node: List, outline: OutlineShape[]): Footprint {
  const atNode = findChild(node, "at");
  const at = pt(atNode);
  const rotation = Number(arg(atNode, 2) ?? 0);
  const properties: Record<string, string> = {};
  for (const p of findChildren(node, "property")) properties[str(p, 0)] = str(p, 1);
  // KiCad ≤ 7 stored reference/value as fp_text.
  for (const t of findChildren(node, "fp_text")) {
    const kind = str(t, 0);
    if (kind === "reference" && !("Reference" in properties)) properties["Reference"] = str(t, 1);
    if (kind === "value" && !("Value" in properties)) properties["Value"] = str(t, 1);
  }

  const attr = findChild(node, "attr");
  const flags = new Set(attr ? attr.children.slice(1).filter(isAtom).map(atomText) : []);

  const pads: Pad[] = findChildren(node, "pad").map((p) => {
    const padAt = findChild(p, "at");
    const drill = findChild(p, "drill");
    const drillNums = drill ? drill.children.slice(1).filter((c) => isAtom(c) && c.kind === "number").map((c) => Number((c as { raw: string }).raw)) : [];
    const oval = drill?.children.some((c) => isAtom(c) && c.raw === "oval");
    const rr = findChild(p, "roundrect_rratio");
    return {
      number: str(p, 0),
      uuid: str(findChild(p, "uuid")) || undefined,
      type: str(p, 1) as PadType,
      shape: str(p, 2),
      at: toBoard(pt(padAt), at, rotation),
      rotation: Number(arg(padAt, 2) ?? 0),
      size: pt(findChild(p, "size")),
      roundrectRatio: rr ? Number(arg(rr, 0)) : undefined,
      drill: drillNums[0],
      drillSize: oval && drillNums.length > 1 ? { x: drillNums[0]!, y: drillNums[1]! } : undefined,
      offset: drill && findChild(drill, "offset") ? pt(findChild(drill, "offset")) : undefined,
      clearance: findChild(p, "clearance") ? Number(arg(findChild(p, "clearance"), 0)) : undefined,
      zoneConnect: zoneConnectOf(p),
      thermalGap: numOf(p, "thermal_gap"),
      maskMargin: numOf(p, "solder_mask_margin"),
      pasteMargin: numOf(p, "solder_paste_margin"),
      pasteRatio: numOf(p, "solder_paste_margin_ratio") ?? numOf(p, "solder_paste_ratio"),
      thermalWidth: numOf(p, "thermal_bridge_width") ?? numOf(p, "thermal_width"),
      thermalAngle: numOf(p, "thermal_bridge_angle"),
      primitives: primitivesOf(p),
      unusedLayers: unusedLayersOf(p),
      chamfer: (() => {
        const c = findChild(p, "chamfer");
        const corners = c ? (c.children.slice(1).filter(isAtom).map(atomText) as NonNullable<Pad["chamfer"]>["corners"]) : [];
        const ratio = numOf(p, "chamfer_ratio") ?? 0.2;
        return corners.length && ratio > 0 ? { ratio, corners } : undefined;
      })(),
      property: findChild(p, "property") ? str(findChild(p, "property")).replace(/^pad_prop_/, "") || undefined : undefined,
      layers: layersOf(p),
      net: netOf(p),
      pinFunction: findChild(p, "pinfunction") ? str(findChild(p, "pinfunction")) : undefined,
      pinType: findChild(p, "pintype") ? str(findChild(p, "pintype")) : undefined,
    };
  });

  const transform = (p: Point) => toBoard(p, at, rotation);
  const graphics: Graphic[] = [];
  const texts: BoardText[] = [];
  const reference = properties["Reference"] ?? "";
  const expand = (t: string) =>
    t.replace(/\$\{REFERENCE\}/g, reference).replace(/\$\{VALUE\}/g, properties["Value"] ?? "");
  for (const c of node.children) {
    if (!isList(c)) continue;
    const head = headOf(c) ?? "";
    const kind = OUTLINE_KINDS[head];
    if (kind) {
      const g = graphicOf(c, kind, transform);
      const gid = itemUuid(c);
      if (gid) g.uuid = gid;
      if (kind === "rect" && rotation % 90 !== 0) {
        // Rectangles are axis-aligned in the footprint frame: show all four corners.
        const [p, q] = [pt(findChild(c, "start")), pt(findChild(c, "end"))];
        g.kind = "poly";
        g.points = [p, { x: q.x, y: p.y }, q, { x: p.x, y: q.y }].map(transform);
      }
      graphics.push(g);
      if (layersOf(c).includes("Edge.Cuts")) outline.push({ kind, points: g.points, width: g.width });
    } else if (head === "dimension") {
      // Footprint dimensions are stored in board coordinates.
      const d = dimensionOf(c);
      graphics.push(...d.graphics.map((g) => ({ ...g, dimension: true })));
      if (d.text) texts.push(d.text);
    } else if ((head === "property" || head === "fp_text") && !isHidden(c) && findChild(c, "layer")) {
      const text = head === "property" ? str(c, 1) : str(c, 1);
      // Older files have no UUID on footprint fields: the footprint's and the field's place stand in.
      if (text) texts.push({ ...textOf(c, expand(text), transform), keepUpright: arg(findChild(c, "unlocked"), 0) !== "yes", uuid: itemUuid(c) || `${itemUuid(node)}#${node.children.indexOf(c)}` });
    }
  }

  return {
    uuid: str(findChild(node, "uuid")) || str(findChild(node, "tstamp")),
    locked: isLocked(node) || undefined,
    libId: str(node, 0),
    reference: properties["Reference"] ?? "",
    value: properties["Value"] ?? "",
    at,
    rotation,
    layer: str(findChild(node, "layer")),
    clearance: findChild(node, "clearance") ? Number(arg(findChild(node, "clearance"), 0)) : undefined,
    zoneConnect: zoneConnectOf(node),
    netTie: !!findChild(node, "net_tie_pad_groups") || undefined,
    maskMargin: numOf(node, "solder_mask_margin"),
    pasteMargin: numOf(node, "solder_paste_margin"),
    pasteRatio: numOf(node, "solder_paste_margin_ratio") ?? numOf(node, "solder_paste_ratio"),
    path: str(findChild(node, "path")),
    sheetName: str(findChild(node, "sheetname")),
    sheetFile: str(findChild(node, "sheetfile")),
    properties,
    attributes: {
      mount: flags.has("smd") ? "smd" : flags.has("through_hole") ? "through_hole" : "unspecified",
      boardOnly: flags.has("board_only"),
      excludeFromBom: flags.has("exclude_from_bom"),
      excludeFromPosFiles: flags.has("exclude_from_pos_files"),
      dnp: flags.has("dnp"),
      allowMaskBridges: flags.has("allow_soldermask_bridges"),
    },
    pads,
    graphics,
    texts,
    models: findChildren(node, "model").map((m) => {
      const xyz = (name: string, d: number): [number, number, number] => {
        const n = findChild(findChild(m, name) ?? m, "xyz");
        return n ? [Number(arg(n, 0) ?? d), Number(arg(n, 1) ?? d), Number(arg(n, 2) ?? d)] : [d, d, d];
      };
      const hidden = m.children.some((c) => (isAtom(c) && c.raw === "hide") || (headOf(c) === "hide" && arg(c as List, 0) !== "no"));
      return {
        path: str(m, 0),
        offset: xyz("offset", 0),
        scale: xyz("scale", 1),
        rotate: xyz("rotate", 0),
        hidden,
        opacity: Number(arg(findChild(m, "opacity"), 0) ?? 1),
      };
    }),
  };
}

export function parseBoard(source: string): Board {
  const doc = parse(source, { recover: true });
  const root = doc.children.find(isList);
  if (!root || headOf(root) !== "kicad_pcb") throw new Error("Not a KiCad board");

  const board: Board = {
    version: Number(arg(findChild(root, "version"), 0) ?? 0),
    thickness: Number(arg(findChild(findChild(root, "general") ?? root, "thickness"), 0)) || undefined,
    revision: str(findChild(findChild(root, "title_block") ?? root, "rev")) || undefined,
    stackup: (() => {
      const st = findChild(findChild(root, "setup") ?? root, "stackup");
      if (!st) return undefined;
      return findChildren(st, "layer")
        .filter((l) => ["copper", "core", "prepreg"].includes(str(findChild(l, "type"))))
        // A dielectric with sublayers ("addsublayer") lists a thickness for each: they add up.
        .map((l) => ({ name: String(arg(l, 0)), type: str(findChild(l, "type")), thickness: findChildren(l, "thickness").reduce((n, t) => n + (Number(arg(t, 0)) || 0), 0), epsilonR: Number(arg(findChild(l, "epsilon_r"), 0)) || undefined }));
    })(),
    stackupFull: (() => {
      const st = findChild(findChild(root, "setup") ?? root, "stackup");
      if (!st) return undefined;
      const items = findChildren(st, "layer").map((l): StackupItem => {
        const sub: StackupItem["sub"] = [{}];
        for (const c of l.children.slice(1)) {
          if (!isList(c)) {
            if (isAtom(c) && atomText(c) === "addsublayer") sub.push({});
            continue;
          }
          const cur = sub[sub.length - 1]!;
          const h = headOf(c);
          if (h === "thickness") cur.thickness = Number(arg(c, 0));
          else if (h === "material") cur.material = str(c);
          else if (h === "color") cur.color = str(c);
          else if (h === "epsilon_r") cur.epsilonR = Number(arg(c, 0));
          else if (h === "loss_tangent") cur.lossTangent = Number(arg(c, 0));
        }
        return { layer: String(arg(l, 0)), type: str(findChild(l, "type")), sub };
      });
      const yes = (k: string) => String(arg(findChild(st, k), 0)) === "yes";
      const ec = arg(findChild(st, "edge_connector"), 0);
      return { items, finish: findChild(st, "copper_finish") ? str(findChild(st, "copper_finish")) : undefined, dielectricConstraints: yes("dielectric_constraints"), edgePlating: yes("edge_plating"), edgeConnector: ec === "yes" || ec === "bevelled" ? ec : undefined };
    })(),
    copperThickness: (() => {
      const st = findChild(findChild(root, "setup") ?? root, "stackup");
      if (!st) return undefined;
      const out: Record<string, number> = {};
      for (const l of findChildren(st, "layer")) if (str(findChild(l, "type")) === "copper") out[String(arg(l, 0))] = Number(arg(findChild(l, "thickness"), 0)) || 0.035;
      return out;
    })(),
    layers: [],
    copperLayers: [],
    nets: [],
    footprints: [],
    tracks: [],
    vias: [],
    zones: [],
    outline: [],
    drawings: [],
    texts: [],
    setup: { maskMargin: 0, pasteMargin: 0, pasteRatio: 0, tentFront: true, tentBack: true },
    warnings: doc.diagnostics.map((d) => `${d.line}:${d.column}: ${d.message}`),
  };

  const layers = findChild(root, "layers");
  for (const l of layers?.children.filter(isList) ?? []) {
    // Layer entries are `(0 "F.Cu" signal ["user name"])`: the head is the id.
    const head = l.children[0];
    const layer: BoardLayer = { id: isAtom(head) ? Number(head.raw) : -1, name: str(l, 0), type: str(l, 1) };
    const userName = arg(l, 2);
    if (userName !== undefined) layer.userName = String(userName);
    board.layers.push(layer);
  }
  board.copperLayers = board.layers.filter((l) => l.name.endsWith(".Cu")).map((l) => l.name);
  const setup = findChild(root, "setup");
  if (setup) {
    const tenting = findChild(setup, "tenting");
    const yes = (side: string) => {
      if (!tenting) return true;
      const n = findChild(tenting, side);
      // Older boards: (tenting front back) lists the tented sides.
      return n ? arg(n, 0) !== "no" : tenting.children.some((c) => isAtom(c) && c.raw === side);
    };
    board.setup = {
      maskMargin: numOf(setup, "pad_to_mask_clearance") ?? 0,
      pasteMargin: numOf(setup, "pad_to_paste_clearance") ?? 0,
      pasteRatio: numOf(setup, "pad_to_paste_clearance_ratio") ?? 0,
      tentFront: yes("front"),
      tentBack: yes("back"),
      allowMaskBridgesInFootprints: arg(findChild(setup, "allow_soldermask_bridges_in_footprints") ?? setup, 0) === "yes",
      auxOrigin: (() => {
        const o = findChild(setup, "aux_axis_origin");
        return o ? { x: Number(arg(o, 0)), y: Number(arg(o, 1)) } : undefined;
      })(),
      gridOrigin: (() => {
        const o = findChild(setup, "grid_origin");
        return o ? { x: Number(arg(o, 0)), y: Number(arg(o, 1)) } : undefined;
      })(),
    };
  }

  // A stray ")" can close the root early (KiCad tolerates this); treat the
  // forms that follow it as belonging to the root.
  netNumbers = new Map();
  for (const n of root.children) {
    if (headOf(n) !== "net") continue;
    const num = arg(n as List, 0);
    const name = arg(n as List, 1);
    if (typeof num === "number" && typeof name === "string") netNumbers.set(num, name);
  }
  const forms = [...root.children];
  const orphans = doc.children.filter((c) => isList(c) && c !== root);
  if (orphans.length) {
    board.warnings.push(`${orphans.length} items found after the end of the board; treating them as part of it`);
    forms.push(...orphans);
  }

  const nets = new Set<string>();
  for (const node of forms) {
    if (!isList(node)) continue;
    const head = headOf(node)!;
    switch (head) {
      case "net": {
        const name = netName(node);
        if (name) nets.add(name);
        break;
      }
      case "footprint":
      case "module": // KiCad ≤ 5 boards converted by later versions
        board.footprints.push(parseFootprint(node, board.outline));
        break;
      case "segment":
      case "arc":
        board.tracks.push({
          uuid: itemUuid(node),
          locked: isLocked(node) || undefined,
          kind: head,
          start: pt(findChild(node, "start")),
          end: pt(findChild(node, "end")),
          mid: head === "arc" ? pt(findChild(node, "mid")) : undefined,
          width: Number(arg(findChild(node, "width"), 0) ?? 0),
          layer: str(findChild(node, "layer")),
          net: netOf(node),
        });
        break;
      case "via":
        board.vias.push({
          uuid: itemUuid(node),
          type: (() => {
            const t = node.children.slice(1).find((c) => isAtom(c) && ["blind", "buried", "micro"].includes(c.raw));
            return t && isAtom(t) ? (t.raw as ViaType) : undefined;
          })(),
          locked: isLocked(node) || undefined,
          unusedLayers: unusedLayersOf(node),
          at: pt(findChild(node, "at")),
          size: Number(arg(findChild(node, "size"), 0) ?? 0),
          drill: Number(arg(findChild(node, "drill"), 0) ?? 0),
          layers: layersOf(node),
          net: netOf(node),
        });
        break;
      case "zone": {
        const cp = findChild(node, "connect_pads");
        const cpMode = cp ? cp.children.slice(1).find(isAtom) : undefined;
        const fill = findChild(node, "fill");
        const keep = findChild(node, "keepout");
        board.zones.push({
          priority: numOf(node, "priority") ?? 0,
          clearance: (cp && numOf(cp, "clearance")) ?? 0,
          connect: !cpMode ? "thermal" : cpMode.raw === "yes" ? "solid" : cpMode.raw === "no" ? "none" : cpMode.raw === "thru_hole_only" ? "tht" : "thermal",
          minThickness: numOf(node, "min_thickness") ?? 0.25,
          fillEnabled: !!fill && fill.children.slice(1).some((c) => isAtom(c) && c.raw === "yes"),
          thermalGap: (fill && numOf(fill, "thermal_gap")) ?? 0.5,
          thermalWidth: (fill && numOf(fill, "thermal_bridge_width")) ?? 0.5,
          islandMode: (fill && numOf(fill, "island_removal_mode")) ?? 0,
          islandAreaMin: (fill && numOf(fill, "island_area_min")) ?? 10,
          noCopperPour: !!keep && str(findChild(keep, "copperpour")) === "not_allowed",
          noTracks: !!keep && str(findChild(keep, "tracks")) === "not_allowed",
          noVias: !!keep && str(findChild(keep, "vias")) === "not_allowed",
          teardrop: !!findChild(findChild(node, "attr") ?? node, "teardrop"),
          hatched: !!fill && str(findChild(fill, "mode")) === "hatch",
          uuid: itemUuid(node),
          net: str(findChild(node, "net_name")) || netOf(node),
          name: str(findChild(node, "name")),
          layers: layersOf(node),
          outline: ptsOf(findChild(findChild(node, "polygon") ?? node, "pts") ?? node),
          keepout: !!findChild(node, "keepout"),
          fills: findChildren(node, "filled_polygon").map((f) => ({
            layer: str(findChild(f, "layer")),
            points: ptsOf(findChild(f, "pts") ?? f),
          })),
        });
        break;
      }
      case "gr_text":
        if (!isHidden(node)) board.texts.push({ ...textOf(node, str(node, 0), (p) => p), uuid: itemUuid(node) });
        break;
      case "dimension": {
        const d = dimensionOf(node);
        const uuid = itemUuid(node);
        for (const g of d.graphics) board.drawings.push({ ...g, uuid });
        if (d.text) board.texts.push({ ...d.text, uuid });
        break;
      }
      default: {
        const kind = OUTLINE_KINDS[head];
        if (!kind) break;
        const g = graphicOf(node, kind, (p) => p);
        g.uuid = itemUuid(node);
        board.drawings.push(g);
        if (layersOf(node).includes("Edge.Cuts")) board.outline.push({ kind, points: g.points, width: g.width });
      }
    }
  }
  for (const f of board.footprints) for (const p of f.pads) if (p.net) nets.add(p.net);
  for (const t of board.tracks) if (t.net) nets.add(t.net);
  board.nets = [...nets].sort();
  return board;
}

/**
 * The outline of a rectangular pad in its own frame (centred, unrotated, y
 * down): corners rounded (radius r) and/or chamfered. Round corners are
 * returned as their centres with radius r; chamfers as straight cuts.
 */
export function padCorners(pad: Pad): Point[] {
  const hw = pad.size.x / 2;
  const hh = pad.size.y / 2;
  const c = pad.chamfer ? pad.chamfer.ratio * Math.min(pad.size.x, pad.size.y) : 0;
  const has = (k: NonNullable<Pad["chamfer"]>["corners"][number]) => !!pad.chamfer?.corners.includes(k);
  // Corners that aren't chamfered keep the round-rect radius (if any).
  const r = pad.shape === "roundrect" ? Math.min(pad.size.x, pad.size.y) * (pad.roundrectRatio ?? 0.25) : 0;
  const pts: Point[] = [];
  const corner = (x: number, y: number, k: NonNullable<Pad["chamfer"]>["corners"][number], first: Point, second: Point, start: number) => {
    if (has(k) && c > 0) pts.push(first, second);
    else if (r > 0) {
      // Quarter arc around the corner's centre (sx, sy), from `start` (radians, y down).
      const cx = x - Math.sign(x) * r;
      const cy = y - Math.sign(y) * r;
      for (let i = 0; i <= 8; i++) {
        const t = start + (Math.PI / 2) * (i / 8);
        pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
      }
    } else pts.push({ x, y });
  };
  corner(-hw, -hh, "top_left", { x: -hw, y: -hh + c }, { x: -hw + c, y: -hh }, Math.PI);
  corner(hw, -hh, "top_right", { x: hw - c, y: -hh }, { x: hw, y: -hh + c }, (3 * Math.PI) / 2);
  corner(hw, hh, "bottom_right", { x: hw, y: hh - c }, { x: hw - c, y: hh }, 0);
  corner(-hw, hh, "bottom_left", { x: -hw + c, y: hh }, { x: -hw, y: hh - c }, Math.PI / 2);
  return pts;
}

/**
 * Which copper layers a through-hole pad or via actually has copper on.
 * With unused-layer removal, KiCad keeps copper only on the end layers (if
 * asked), on layers where a zone connects, and where a track of its net
 * ends on it. Elsewhere there is just the drilled hole.
 */
export function flashChecker(board: Board): (item: Pad | Via, layer: string) => boolean {
  // One index per board, rebuilt when a copy of it has other tracks, vias, zones or footprints.
  const c = flashCache.get(board);
  if (c && c.tracks === board.tracks && c.vias === board.vias && c.zones === board.zones && c.footprints === board.footprints) return c.check;
  const check = buildFlashChecker(board);
  flashCache.set(board, { tracks: board.tracks, vias: board.vias, zones: board.zones, footprints: board.footprints, check });
  return check;
}
const flashCache = new WeakMap<Board, { tracks: Board["tracks"]; vias: Board["vias"]; zones: Board["zones"]; footprints: Board["footprints"]; check: (item: Pad | Via, layer: string) => boolean }>();

function buildFlashChecker(board: Board): (item: Pad | Via, layer: string) => boolean {
  // Track ends per layer and net, for "a track connects here".
  // Indexed by layer, net and 1 mm cell.
  const ends = new Map<string, Point[]>();
  const key = (layer: string, net: string, x: number, y: number) => `${layer}\0${net}\0${x}\0${y}`;
  for (const t of board.tracks) {
    if (!t.net) continue;
    for (const p of [t.start, t.end]) {
      const k = key(t.layer, t.net, Math.floor(p.x), Math.floor(p.y));
      const l = ends.get(k);
      if (l) l.push(p);
      else ends.set(k, [p]);
    }
  }
  const outer = (l: string) => l === "F.Cu" || l === "B.Cu";
  return (item, layer) => {
    const u = item.unusedLayers;
    if (!u) return true;
    if (u.keepEnds && outer(layer)) return true;
    if (u.zoneLayers.includes(layer)) return true;
    const reach = "size" in item && typeof item.size === "number" ? item.size / 2 : Math.max((item as Pad).size.x, (item as Pad).size.y) / 2;
    const at = item.at;
    for (let x = Math.floor(at.x - reach); x <= Math.floor(at.x + reach); x++)
      for (let y = Math.floor(at.y - reach); y <= Math.floor(at.y + reach); y++)
        for (const p of ends.get(key(layer, item.net, x, y)) ?? []) if (Math.hypot(p.x - at.x, p.y - at.y) <= reach + 1e-6) return true;
    return false;
  };
}

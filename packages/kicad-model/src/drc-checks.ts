/**
 * Board checks beyond copper clearance, following KiCad's DRC semantics:
 * hole sizes, annular rings, dangling tracks and vias, overlapping
 * courtyards, and holes too close together (or drilled twice).
 */
import ClipperLib from "clipper-lib";
import type { Board, Footprint, Graphic, Pad, Via } from "./board.js";
import { buildArea, copperItems, edgeChains, graphicShapes, padShapes, shapeBox, shapeDistance, type CopperItem, type DesignRules, type DrcItem, type Shape } from "./drc.js";
import { hasCopper, knockoutText, onLayer, textOutline, textPen, textStrokes } from "./fab.js";
import type { Point } from "./geometry.js";
import { boardArea, connectionOf, padPolygons } from "./zone-fill.js";
import { flashChecker } from "./board.js";
import { customConstraint, type RuleItem } from "./drc-rules.js";
import { checkLengthRules } from "./drc-length.js";
import { netClassOf } from "./drc.js";

export type BoardCheck = "drill_out_of_range" | "annular_width" | "track_dangling" | "via_dangling" | "courtyards_overlap" | "holes_co_located" | "hole_to_hole" | "starved_thermal" | "text_height" | "text_thickness" | "track_width" | "via_diameter" | "mirrored_text_on_front_layer" | "nonmirrored_text_on_back_layer" | "silk_edge_clearance" | "silk_over_copper" | "solder_mask_bridge" | "silk_overlap" | "items_not_allowed" | "pth_inside_courtyard" | "npth_inside_courtyard" | "zones_intersect" | "footprint_type_mismatch" | "length_out_of_range" | "skew_out_of_range";

export interface BoardViolation {
  type: BoardCheck;
  severity: "error" | "warning";
  message: string;
  at: Point;
  items: DrcItem[];
  actual?: number;
  required?: number;
}

const padItem = (fp: Footprint, pad: Pad): DrcItem => ({
  kind: "pad",
  uuid: pad.uuid,
  net: pad.net,
  reference: fp.reference,
  pad: pad.number,
  // As KiCad words it: NPTH pads carry no net.
  description: pad.type === "np_thru_hole" ? `NPTH pad${pad.number ? ` ${pad.number}` : ""} of ${fp.reference || "?"}` : `${pad.type === "smd" ? "SMD" : "PTH"} pad ${pad.number} [${pad.net || "<no net>"}] of ${fp.reference || "?"}`,
});
const viaItem = (v: Via): DrcItem => ({ kind: "via", net: v.net, at: v.at, uuid: v.uuid, description: `Via [${v.net || "<no net>"}]` });
const fmt = (v: number) => v.toFixed(4);

// ---------------------------------------------------------------------------
// Holes and annular rings
// ---------------------------------------------------------------------------

interface Hole {
  at: Point;
  /** Slot axis end (for oval holes), else equal to `at`. */
  to: Point;
  r: number;
  item: DrcItem;
  /** Pads of one footprint: holes there may sit together by design. */
  owner?: string;
}

function holesOf(board: Board): Hole[] {
  const out: Hole[] = [];
  for (const v of board.vias) out.push({ at: v.at, to: v.at, r: v.drill / 2, item: viaItem(v) });
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      if (!pad.drill) continue;
      const item = padItem(fp, pad);
      if (pad.drillSize && Math.abs(pad.drillSize.x - pad.drillSize.y) > 1e-9) {
        const { x: w, y: h } = pad.drillSize;
        const d = Math.min(w, h);
        const half = (Math.max(w, h) - d) / 2;
        const a = (pad.rotation * Math.PI) / 180;
        const axis = w > h ? { x: Math.cos(a), y: -Math.sin(a) } : { x: Math.sin(a), y: Math.cos(a) };
        out.push({ at: { x: pad.at.x - axis.x * half, y: pad.at.y - axis.y * half }, to: { x: pad.at.x + axis.x * half, y: pad.at.y + axis.y * half }, r: d / 2, item, owner: fp.uuid });
      } else out.push({ at: pad.at, to: pad.at, r: pad.drill / 2, item, owner: fp.uuid });
    }
  }
  return out;
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function segSegDist(a: Point, b: Point, c: Point, d: Point): number {
  return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b));
}

function pointInPoly(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Bounding box of polygons (a loop: fills can have too many points to spread). */
const boxOf = (polys: Point[][]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polys)
    for (const p of poly) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
  return { x0, y0, x1, y1 };
};
type Box = ReturnType<typeof boxOf>;
const boxesMeet = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
const boxHolds = (a: Box, b: Box) => a.x0 <= b.x0 && a.y0 <= b.y0 && a.x1 >= b.x1 && a.y1 >= b.y1;

/**
 * A plated pad's annular ring, as KiCad measures it. Simple shapes with a
 * centred hole use the exact width; otherwise (or with same-numbered pads
 * overlapping it) the distance from the hole to the copper outline, where
 * same-numbered pads add copper and their holes take it away. Undefined: no
 * finding (KiCad's shortcut when another pad covers the thin side).
 */
function padRing(pad: Pad, sameNum: Pad[]): number | undefined {
  const drill = pad.drillSize ?? { x: pad.drill!, y: pad.drill! };
  const simple =
    !pad.offset &&
    (pad.chamfer ? pad.chamfer.ratio <= 0.3 : pad.shape === "circle" || pad.shape === "oval" || pad.shape === "rect" || pad.shape === "roundrect");
  const fast = Math.min((pad.size.x - drill.x) / 2, (pad.size.y - drill.y) / 2);
  const own = padPolygons(pad, 0);
  const box = boxOf(own);
  const overlapping = sameNum.filter((p) => boxesMeet(boxOf(padPolygons(p, 0)), box));
  const covered = overlapping.some((p) => boxHolds(boxOf(padPolygons(p, 0)), box));
  const holeCuts = overlapping.some((p) => {
    if (!p.drill) return false;
    const r = Math.max(p.drillSize?.x ?? p.drill, p.drillSize?.y ?? p.drill) / 2;
    return boxesMeet({ x0: p.at.x - r, y0: p.at.y - r, x1: p.at.x + r, y1: p.at.y + r }, box);
  });
  if (simple && !overlapping.length) return Math.max(0, fast);
  if (simple && !holeCuts && !covered) return pad.shape === "circle" ? undefined : fast;
  const hole = holesOf({ footprints: [{ pads: [pad] }], vias: [] } as unknown as Board)[0]!;
  if (!sameNum.length) return ringWidth(hole, own);
  const copper = unionPolys([...own, ...sameNum.flatMap((p) => padPolygons(p, 0))]);
  const otherHoles = sameNum.filter((p) => p.drill).flatMap((p) => holeOutline(p));
  return ringWidth(hole, difference(copper, otherHoles));
}

function holeOutline(p: Pad): Point[][] {
  const h = holesOf({ footprints: [{ pads: [p] }], vias: [] } as unknown as Board)[0]!;
  const out: Point[] = [];
  const a = Math.atan2(h.to.y - h.at.y, h.to.x - h.at.x);
  for (let k = 0; k <= 24; k++) out.push({ x: h.to.x + h.r * Math.cos(a - Math.PI / 2 + (Math.PI * k) / 24), y: h.to.y + h.r * Math.sin(a - Math.PI / 2 + (Math.PI * k) / 24) });
  for (let k = 0; k <= 24; k++) out.push({ x: h.at.x + h.r * Math.cos(a + Math.PI / 2 + (Math.PI * k) / 24), y: h.at.y + h.r * Math.sin(a + Math.PI / 2 + (Math.PI * k) / 24) });
  return [out];
}

function difference(a: Point[][], b: Point[][]): Point[][] {
  const c = new ClipperLib.Clipper();
  const toP = (ps: Point[][]) => ps.map((p) => p.map((q) => ({ X: Math.round(q.x * S), Y: Math.round(q.y * S) })));
  c.AddPaths(toP(a), ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(toP(b), ClipperLib.PolyType.ptClip, true);
  const out: ClipperLib.IntPoint[][] = [];
  c.Execute(ClipperLib.ClipType.ctDifference, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out.map((p) => p.map((q) => ({ x: q.X / S, y: q.Y / S })));
}

/** The ring around a hole: distance from the hole's edge to the copper outline (0 when the hole breaks out). */
function ringWidth(hole: { at: Point; to: Point; r: number }, copper: Point[][]): number {
  // Outlines and holes together: inside when an odd number of them contain the centre.
  if (copper.filter((poly) => pointInPoly(hole.at, poly)).length % 2 === 0) return 0;
  let best = Infinity;
  for (const poly of copper) for (let i = 0; i < poly.length; i++) best = Math.min(best, segSegDist(hole.at, hole.to, poly[i]!, poly[(i + 1) % poly.length]!));
  return Math.max(0, best - hole.r);
}

/** How a via or pad appears to custom rule conditions (A.Type, A.NetName, A.intersectsArea(…), …). */
function holeRuleItem(board: Board, rules: DesignRules, kind: "Via" | "Pad", net: string, at: Point, layers: string[], reference?: string): RuleItem {
  return {
    hasNet: (n) => board.nets.includes(n),
    type: kind,
    netName: net,
    netClass: netClassOf(rules, net).name,
    reference,
    layers: new Set(layers),
    intersectsArea: (name) => board.zones.some((z) => z.name === name && z.outline.length >= 3 && pointInPoly(at, z.outline)),
  };
}

function checkHoles(board: Board, rules: DesignRules, out: BoardViolation[]) {
  const custom = rules.custom ?? [];
  // A custom rule's minimum, else the board's.
  const minFor = (type: string, fallback: number, item: () => RuleItem) => {
    if (!custom.length) return fallback;
    const c = customConstraint(custom, type, item());
    return c?.min ?? fallback;
  };
  const viaRule = (v: Via) => () => holeRuleItem(board, rules, "Via", v.net, v.at, board.copperLayers);
  const padRule = (fp: Footprint, p: Pad) => () => holeRuleItem(board, rules, "Pad", p.net, p.at, p.layers, fp.reference);
  for (const v of board.vias) {
    const minHole = minFor("hole_size", rules.minHoleSize ?? 0.3, viaRule(v));
    const minRing = minFor("annular_width", rules.minViaAnnular ?? 0.1, viaRule(v));
    if (v.drill < minHole - 1e-9)
      out.push({ type: "drill_out_of_range", severity: "error", message: `Hole size out of range (min ${fmt(minHole)} mm; actual ${fmt(v.drill)} mm)`, at: v.at, items: [viaItem(v)], actual: v.drill, required: minHole });
    const ring = (v.size - v.drill) / 2;
    if (ring < minRing - 1e-9)
      out.push({ type: "annular_width", severity: "error", message: `Annular width (min ${fmt(minRing)} mm; actual ${fmt(Math.max(0, ring))} mm)`, at: v.at, items: [viaItem(v)], actual: Math.max(0, ring), required: minRing });
  }
  for (const fp of board.footprints) {
    // Pads sharing a number are one copper area (KiCad aggregates them).
    const groups = new Map<string, Pad[]>();
    for (const pad of fp.pads) {
      const key = pad.number || `\0${pad.uuid ?? groups.size}`;
      groups.set(key, [...(groups.get(key) ?? []), pad]);
    }
    for (const pad of fp.pads) {
      if (!pad.drill) continue;
      const d = pad.drillSize ? Math.min(pad.drillSize.x, pad.drillSize.y) : pad.drill;
      const minHole = minFor("hole_size", rules.minHoleSize ?? 0.3, padRule(fp, pad));
      if (d < minHole - 1e-9)
        out.push({ type: "drill_out_of_range", severity: "error", message: `Hole size out of range (min ${fmt(minHole)} mm; actual ${fmt(d)} mm)`, at: pad.at, items: [padItem(fp, pad)], actual: d, required: minHole });
    }
    for (const pads of groups.values()) {
      for (const pad of pads) {
        // Plated holes only; same-numbered pads (SMD ones too) add copper.
        if (!pad.drill || pad.type !== "thru_hole") continue;
        const ring = padRing(pad, pads.filter((p) => p !== pad));
        if (ring === undefined) continue;
        const minRing = minFor("annular_width", rules.minViaAnnular ?? 0.1, padRule(fp, pad));
        if (ring < minRing - 1e-9)
          out.push({ type: "annular_width", severity: "error", message: `Annular width (min ${fmt(minRing)} mm; actual ${fmt(ring)} mm)`, at: pad.at, items: [padItem(fp, pad)], actual: ring, required: minRing });
      }
    }
  }

  // Hole to hole, and the same hole drilled twice.
  const minGap = rules.minHoleToHole ?? 0.25;
  const holes = holesOf(board);
  const cell = 2;
  const grid = new Map<string, number[]>();
  holes.forEach((h, i) => {
    const k = `${Math.floor(h.at.x / cell)},${Math.floor(h.at.y / cell)}`;
    grid.set(k, [...(grid.get(k) ?? []), i]);
  });
  holes.forEach((h, i) => {
    const cx = Math.floor(h.at.x / cell);
    const cy = Math.floor(h.at.y / cell);
    for (let dx = -2; dx <= 2; dx++)
      for (let dy = -2; dy <= 2; dy++)
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j <= i) continue;
          const o = holes[j]!;
          if (Math.hypot(h.at.x - o.at.x, h.at.y - o.at.y) < 1e-6 && Math.hypot(h.to.x - o.to.x, h.to.y - o.to.y) < 1e-6) {
            out.push({ type: "holes_co_located", severity: "warning", message: "Drilled holes co-located", at: h.at, items: [h.item, o.item] });
            continue;
          }
          // Holes of one footprint are placed together on purpose; KiCad checks those between items.
          if (h.owner && h.owner === o.owner) continue;
          const gap = segSegDist(h.at, h.to, o.at, o.to) - h.r - o.r;
          if (gap < minGap - 1e-9)
            out.push({ type: "hole_to_hole", severity: "error", message: `Hole to hole clearance (min ${fmt(minGap)} mm; actual ${fmt(Math.max(0, gap))} mm)`, at: h.at, items: [h.item, o.item], actual: Math.max(0, gap), required: minGap });
        }
  });
}

const S = 1e5;
function unionPolys(polys: Point[][]): Point[][] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(polys.map((p) => p.map((q) => ({ X: Math.round(q.x * S), Y: Math.round(q.y * S) }))), ClipperLib.PolyType.ptSubject, true);
  const out: ClipperLib.IntPoint[][] = [];
  c.Execute(ClipperLib.ClipType.ctUnion, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out.map((p) => p.map((q) => ({ x: q.X / S, y: q.Y / S })));
}

// ---------------------------------------------------------------------------
// Dangling tracks and vias
// ---------------------------------------------------------------------------

const near = (a: CopperItem, b: CopperItem, slack = 0) => a.box.x0 <= b.box.x1 + slack && b.box.x0 <= a.box.x1 + slack && a.box.y0 <= b.box.y1 + slack && b.box.y0 <= a.box.y1 + slack;

/** Does a copper item reach point p (on `layer`), within `tol`? */
function covers(item: CopperItem, p: Point, layer: string, tol = 0): boolean {
  if (!item.layers.has(layer)) return false;
  const g = tol + 1e-6;
  if (p.x < item.box.x0 - g || p.x > item.box.x1 + g || p.y < item.box.y0 - g || p.y > item.box.y1 + g) return false;
  const probe = { kind: "seg" as const, a: p, b: p, r: 0 };
  return item.shapes.some((s) => shapeDistance(probe, s, tol + 0.01).dist <= g);
}

function checkDangling(board: Board, items: CopperItem[], out: BoardViolation[]) {
  // Spatial buckets of every copper item, by layer.
  const cell = 5;
  const buckets = new Map<string, CopperItem[]>();
  for (const it of items) {
    for (const layer of it.layers) {
      for (let x = Math.floor(it.box.x0 / cell); x <= Math.floor(it.box.x1 / cell); x++)
        for (let y = Math.floor(it.box.y0 / cell); y <= Math.floor(it.box.y1 / cell); y++) {
          const k = `${layer}\0${x}\0${y}`;
          const l = buckets.get(k);
          if (l) l.push(it);
          else buckets.set(k, [it]);
        }
    }
  }
  const at = (layer: string, p: Point) => buckets.get(`${layer}\0${Math.floor(p.x / cell)}\0${Math.floor(p.y / cell)}`) ?? [];

  // Anchors, as KiCad's connectivity sees them: track ends, via and pad centres.
  const trackItems = items.filter((i) => i.item.kind === "track");
  const onCopper = board.tracks.filter((t) => board.copperLayers.includes(t.layer));
  const anchorsOf = new Map<CopperItem, Point[]>();
  trackItems.forEach((it, i) => anchorsOf.set(it, [onCopper[i]!.start, onCopper[i]!.end]));
  for (const it of items) if (it.item.kind === "via") anchorsOf.set(it, [it.item.at!]);
  const padCentres = new Map<string, Point>();
  for (const fp of board.footprints) for (const pad of fp.pads) if (pad.uuid) padCentres.set(pad.uuid, pad.at);
  for (const it of items) if (it.item.kind === "pad" && it.item.uuid && padCentres.has(it.item.uuid)) anchorsOf.set(it, [padCentres.get(it.item.uuid)!]);

  // KiCad's connectivity: items touch when their copper overlaps on a shared layer. Items
  // of different nets connect only if one of them takes its net from connectivity
  // (tracks and vias); zones connect to anchors in their fill, and to overlapping pads and vias.
  const canChangeNet = (i: CopperItem) => i.item.kind === "track" || i.item.kind === "via";
  const overlap = (a: CopperItem, b: CopperItem) => a.shapes.some((x) => b.shapes.some((y) => shapeDistance(x, y, 0.01).dist <= 1e-6));
  const connected = (a: CopperItem, b: CopperItem, layer: string) => {
    if (!a.layers.has(layer) || !b.layers.has(layer)) return false;
    if (a.item.net !== b.item.net && !canChangeNet(a) && !canChangeNet(b)) return false;
    const zone = a.item.kind === "zone" ? a : b.item.kind === "zone" ? b : undefined;
    if (zone) {
      const other = zone === a ? b : a;
      if (other.item.kind === "zone") return false;
      if ((anchorsOf.get(other) ?? []).some((p) => covers(zone, p, layer))) return true;
      return (other.item.kind === "via" || other.item.kind === "pad") && overlap(other, zone);
    }
    return overlap(a, b);
  };
  const neighbours = (self: CopperItem, layer: string, probes: Point[]) => {
    const seen = new Set<CopperItem>();
    for (const p of probes) for (const o of at(layer, p)) if (o !== self && !seen.has(o) && near(o, self, 0.01) && connected(self, o, layer)) seen.add(o);
    return seen;
  };

  onCopper.forEach((t, ti) => {
    const self = trackItems[ti];
    if (!self) return;
    const tol = t.width / 2;
    let start = 0;
    let end = 0;
    let ok = false;
    for (const o of neighbours(self, t.layer, [t.start, t.end, ...(t.mid ? [t.mid] : [])])) {
      const hitStart = covers(o, t.start, t.layer, tol);
      const hitEnd = covers(o, t.end, t.layer, tol);
      if (hitStart && hitEnd) {
        // Both ends in one zone, pad or via: redundant perhaps, but not dangling.
        if (o.item.kind === "zone" || o.item.kind === "pad" || o.item.kind === "via") {
          ok = true;
          break;
        }
        // Another track reaching both ends of a short one connects only the end nearer its own ends.
        const anchors = anchorsOf.get(o) ?? [];
        const d = (p: Point) => Math.min(...anchors.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
        if (d(t.start) < d(t.end)) start++;
        else end++;
      } else if (hitStart) start++;
      else if (hitEnd) end++;
      if (start > 0 && end > 0) {
        ok = true;
        break;
      }
    }
    if (!ok) out.push({ type: "track_dangling", severity: "warning", message: "Track has unconnected end", at: start === 0 ? t.start : t.end, items: [self.item] });
  });

  // Vias: connected on at least two layers (a via with a net and nothing on it counts too).
  const viaItems = items.filter((i) => i.item.kind === "via");
  board.vias.forEach((v, vi) => {
    const self = viaItems[vi];
    if (!self) return;
    const layers = new Set<string>();
    let any = false;
    for (const layer of self.layers) {
      for (const o of neighbours(self, layer, [v.at])) {
        any = true;
        // KiCad compares the connected items' layers: a multi-layer item counts as its first layer.
        layers.add(o.layers.size === 1 ? layer : [...o.layers][0]!);
      }
    }
    if (any ? layers.size < 2 : !!v.net) out.push({ type: "via_dangling", severity: "warning", message: "Via is not connected or connected on only one layer", at: v.at, items: [self.item] });
  });
}

// ---------------------------------------------------------------------------
// Courtyards
// ---------------------------------------------------------------------------

function checkCourtyards(board: Board, out: BoardViolation[]) {
  for (const side of ["F.CrtYd", "B.CrtYd"]) {
    const yards: Array<{ fp: Footprint; polys: ClipperLib.Paths; box: { x0: number; y0: number; x1: number; y1: number } }> = [];
    for (const fp of board.footprints) {
      const shapes = fp.graphics.filter((g) => g.layer === side).map((g) => ({ kind: g.kind, points: g.points }));
      if (!shapes.length) continue;
      const polys = boardArea({ ...board, outline: shapes });
      if (!polys?.length) continue;
      const xs = polys.flat().map((p) => p.X / S);
      const ys = polys.flat().map((p) => p.Y / S);
      yards.push({ fp, polys, box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } });
    }
    for (let i = 0; i < yards.length; i++)
      for (let j = i + 1; j < yards.length; j++) {
        const a = yards[i]!;
        const b = yards[j]!;
        if (a.box.x0 >= b.box.x1 || b.box.x0 >= a.box.x1 || a.box.y0 >= b.box.y1 || b.box.y0 >= a.box.y1) continue;
        const c = new ClipperLib.Clipper();
        c.AddPaths(a.polys, ClipperLib.PolyType.ptSubject, true);
        c.AddPaths(b.polys, ClipperLib.PolyType.ptClip, true);
        const inter: ClipperLib.Paths = [];
        c.Execute(ClipperLib.ClipType.ctIntersection, inter, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
        const area = inter.reduce((s, p) => s + Math.abs(ClipperLib.Clipper.Area(p)), 0) / (S * S);
        const perim = inter.reduce((s, p) => s + p.reduce((t, q, i) => t + Math.hypot(q.X - p[(i + 1) % p.length]!.X, q.Y - p[(i + 1) % p.length]!.Y), 0), 0) / S;
        // Overlap thickness (≈ 2·area/perimeter). Against KiCad's DRC on the demo boards,
        // overlaps thinner than ~6 µm are never reported and those from ~12 µm always are.
        const thick = perim > 0 ? (2 * area) / perim : 0;
        if (thick > 0.01) {
          const p = inter[0]![0]!;
          const item = (fp: Footprint): DrcItem => ({ kind: "pad", net: "", reference: fp.reference, uuid: fp.uuid, description: `Footprint ${fp.reference}` });
          out.push({ type: "courtyards_overlap", severity: "error", actual: area, message: "Courtyards overlap", at: { x: p.X / S, y: p.Y / S }, items: [item(a.fp), item(b.fp)] });
        }
      }
  }
}

/** Whether a pad's hole (a circle, or a slot as a segment of its width) touches a filled outline. */
function holeInArea(pad: Pad, polys: ClipperLib.Paths): boolean {
  const hole = pad.drillSize ?? (pad.drill ? { x: pad.drill, y: pad.drill } : undefined);
  if (!hole || hole.x <= 0) return false;
  const r = Math.min(hole.x, hole.y) / 2;
  const half = hole.x > hole.y ? { x: hole.x / 2 - r, y: 0 } : { x: 0, y: hole.y / 2 - r };
  const t = (pad.rotation * Math.PI) / 180;
  const o = { x: half.x * Math.cos(t) + half.y * Math.sin(t), y: -half.x * Math.sin(t) + half.y * Math.cos(t) };
  const a = { x: pad.at.x - o.x, y: pad.at.y - o.y }, b = { x: pad.at.x + o.x, y: pad.at.y + o.y };
  const loops = polys.map((p) => p.map((q) => ({ x: q.X / S, y: q.Y / S })));
  // Inside (even-odd over all loops, holes included)…
  let inside = false;
  for (const loop of loops)
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const p = loop[i]!, q = loop[j]!;
      if (p.y > a.y !== q.y > a.y && a.x < ((q.x - p.x) * (a.y - p.y)) / (q.y - p.y) + p.x) inside = !inside;
    }
  if (inside) return true;
  // …or within the hole's radius of an edge.
  const seg = { kind: "seg" as const, a, b, r };
  return loops.some((loop) => loop.some((p, i) => shapeDistance(seg, { kind: "seg", a: p, b: loop[(i + 1) % loop.length]!, r: 0 }).dist <= 0));
}

/**
 * Plated and unplated holes inside another footprint's courtyard (KiCad's
 * pth_inside_courtyard / npth_inside_courtyard): a hole that touches the
 * other part's front courtyard, else its back one. Heatsink pads are left out,
 * as are via holes.
 */
function checkCourtyardHoles(board: Board, out: BoardViolation[]) {
  const yards = new Map<Footprint, { front?: ClipperLib.Paths; back?: ClipperLib.Paths; box: { x0: number; y0: number; x1: number; y1: number } }>();
  for (const fp of board.footprints) {
    const y: { front?: ClipperLib.Paths; back?: ClipperLib.Paths } = {};
    for (const [side, key] of [["F.CrtYd", "front"], ["B.CrtYd", "back"]] as const) {
      const shapes = fp.graphics.filter((g) => g.layer === side).map((g) => ({ kind: g.kind, points: g.points }));
      const polys = shapes.length ? boardArea({ ...board, outline: shapes }) : undefined;
      if (polys?.length) y[key] = polys;
    }
    const all = [...(y.front ?? []), ...(y.back ?? [])].flat();
    if (!all.length) continue;
    const xs = all.map((p) => p.X / S), ys = all.map((p) => p.Y / S);
    yards.set(fp, { ...y, box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } });
  }
  const test = (pad: Pad, owner: Footprint, fp: Footprint) => {
    const y = yards.get(fp);
    if (!y || pad.property === "heatsink") return;
    const type = pad.type === "thru_hole" ? "pth_inside_courtyard" : pad.type === "np_thru_hole" ? "npth_inside_courtyard" : undefined;
    if (!type) return;
    const reach = Math.max(pad.drillSize?.x ?? 0, pad.drillSize?.y ?? 0, pad.drill ?? 0);
    if (pad.at.x + reach < y.box.x0 || pad.at.x - reach > y.box.x1 || pad.at.y + reach < y.box.y0 || pad.at.y - reach > y.box.y1) return;
    const side = y.front && holeInArea(pad, y.front) ? "F.CrtYd" : y.back && holeInArea(pad, y.back) ? "B.CrtYd" : undefined;
    if (!side) return;
    const fpItem: DrcItem = { kind: "pad", net: "", reference: fp.reference, uuid: fp.uuid, description: `Footprint ${fp.reference}` };
    out.push({ type, severity: "error", message: `${type === "pth_inside_courtyard" ? "PTH" : "NPTH"} inside courtyard`, at: pad.at, items: [padItem(owner, pad), fpItem] });
  };
  // KiCad's pair order: by UUID, each pair once, the second's pads against the first and back.
  const fps = [...board.footprints].sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
  for (let i = 0; i < fps.length; i++)
    for (let j = i + 1; j < fps.length; j++) {
      const a = fps[i]!, b = fps[j]!;
      for (const pad of b.pads) test(pad, b, a);
      for (const pad of a.pads) test(pad, a, b);
    }
}

/**
 * Footprints whose type (SMD or through-hole) isn't what their pads say
 * (KiCad's footprint_type_mismatch, FOOTPRINT::GetLikelyAttribute): any
 * plated through-hole pad makes it through-hole, else copper SMD pads make it
 * SMD; fiducial, heatsink, castellated and mechanical pads don't count.
 */
function checkFootprintTypes(board: Board, out: BoardViolation[]) {
  const skip = new Set(["fiducial_glob", "fiducial_loc", "heatsink", "castellated", "mechanical"]);
  for (const fp of board.footprints) {
    const set = fp.attributes.mount;
    if (set === "unspecified") continue;
    let tht = 0, smd = 0;
    for (const pad of fp.pads) {
      if (pad.property && skip.has(pad.property)) continue;
      if (pad.type === "thru_hole") tht++;
      else if (pad.type === "smd" && pad.layers.some((l) => l.endsWith(".Cu"))) smd++;
    }
    const likely = tht ? "through_hole" : smd ? "smd" : undefined;
    if (likely && likely !== set)
      out.push({
        type: "footprint_type_mismatch",
        severity: "error",
        message: `Footprint component type doesn't match footprint pads (expected '${likely === "smd" ? "SMD" : "Through hole"}'; actual '${set === "smd" ? "SMD" : "Through hole"}')`,
        at: fp.at,
        items: [{ kind: "pad", net: "", reference: fp.reference, uuid: fp.uuid, description: `Footprint ${fp.reference}` }],
      });
  }
}

/** Whether two closed outlines overlap or touch. */
function outlinesCollide(a: Point[], b: Point[]): boolean {
  const inside = (p: Point, poly: Point[]) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const q = poly[i]!, r = poly[j]!;
      if (q.y > p.y !== r.y > p.y && p.x < ((r.x - q.x) * (p.y - q.y)) / (r.y - q.y) + q.x) c = !c;
    }
    return c;
  };
  if (inside(a[0]!, b) || inside(b[0]!, a)) return true;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (shapeDistance({ kind: "seg", a: a[i]!, b: a[(i + 1) % a.length]!, r: 0 }, { kind: "seg", a: b[j]!, b: b[(j + 1) % b.length]!, r: 0 }).dist <= 1e-6) return true;
  return false;
}

/**
 * Copper zones of one net and one priority whose outlines overlap or touch
 * (KiCad's zones_intersect: "intersecting zones must have distinct
 * priorities"), per copper layer. Rule areas and teardrops are left out.
 */
function checkZoneIntersections(board: Board, out: BoardViolation[]) {
  for (const layer of board.copperLayers) {
    const zones = board.zones.filter((z) => !z.keepout && !z.teardrop && z.outline.length >= 3 && z.layers.some((l) => l === layer || (l.startsWith("*") && l.endsWith(".Cu")) || l === "F&B.Cu"));
    for (let i = 0; i < zones.length; i++)
      for (let j = i + 1; j < zones.length; j++) {
        const a = zones[i]!, b = zones[j]!;
        if (a.net !== b.net || a.priority !== b.priority) continue;
        if (!outlinesCollide(a.outline, b.outline)) continue;
        const item = (z: typeof a): DrcItem => ({ kind: "zone", net: z.net, uuid: z.uuid, description: `Zone [${z.net}] on ${layer}` });
        out.push({ type: "zones_intersect", severity: "error", message: "Copper zones intersect (intersecting zones must have distinct priorities)", at: a.outline[0]!, items: [item(a), item(b)] });
      }
  }
}

// ---------------------------------------------------------------------------
// Starved thermal reliefs
// ---------------------------------------------------------------------------

/** Points where two closed outlines cross (deduplicated). */
function crossings(a: Point[], b: Point[]): Point[] {
  const out: Point[] = [];
  const bb = boxOf([b]);
  const bx0 = bb.x0 - 1e-6;
  const bx1 = bb.x1 + 1e-6;
  const by0 = bb.y0 - 1e-6;
  const by1 = bb.y1 + 1e-6;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = a[(i + 1) % a.length]!;
    if (Math.max(p.x, q.x) < bx0 || Math.min(p.x, q.x) > bx1 || Math.max(p.y, q.y) < by0 || Math.min(p.y, q.y) > by1) continue;
    for (let j = 0; j < b.length; j++) {
      const r = b[j]!;
      const s = b[(j + 1) % b.length]!;
      const d = (q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x);
      if (Math.abs(d) < 1e-15) continue;
      const t = ((r.x - p.x) * (s.y - r.y) - (r.y - p.y) * (s.x - r.x)) / d;
      const u = ((r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x)) / d;
      if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
      const x = { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) };
      if (!out.some((o) => Math.abs(o.x - x.x) < 1e-6 && Math.abs(o.y - x.y) < 1e-6)) out.push(x);
    }
  }
  return out;
}

/**
 * Thermal reliefs with fewer working spokes than the minimum (KiCad's
 * starved_thermal): spokes are where the pad outline, grown by half the
 * relief gap, crosses the zone's fill; spokes into an island that connects
 * only this pad don't count, and tracks from the pad into the fill do.
 */
function checkThermals(board: Board, rules: DesignRules, out: BoardViolation[]) {
  const minCount = rules.minResolvedSpokes ?? 2;
  if (minCount <= 0) return;
  const flashed = flashChecker(board);
  for (const zone of board.zones) {
    if (zone.keepout || !zone.net) continue;
    const layers = [...new Set(zone.fills.map((f) => f.layer))];
    for (const layer of layers) {
      const fills = zone.fills.filter((f) => f.layer === layer).map((f) => f.points);
      if (!fills.length) continue;
      const zbox = boxOf(fills);
      // Which fill outlines connect to how many items (pads, vias, track ends of the zone's net).
      // Pads join a fill polygon through their spokes (or solidly, centre inside);
      // vias and track ends by lying in it.
      const padRings = new Map<Pad, Point[]>();
      const members: Array<{ key: string; joins: (poly: Point[]) => boolean }> = [];
      for (const fp of board.footprints)
        for (const pad of fp.pads) {
          if (pad.net !== zone.net || !onPadLayer(pad, layer) || !flashed(pad, layer)) continue;
          const ring = padPolygons(pad, (pad.thermalGap ?? zone.thermalGap) / 2)[0] ?? [];
          padRings.set(pad, ring);
          members.push({ key: pad.uuid ?? `${fp.uuid}:${pad.number}:${pad.at.x},${pad.at.y}`, joins: (poly) => pointInPoly(pad.at, poly) || crossings(poly, ring).length >= 2 });
        }
      for (const v of board.vias) if (v.net === zone.net) members.push({ key: v.uuid, joins: (poly) => pointInPoly(v.at, poly) });
      for (const t of board.tracks) if (t.net === zone.net && t.layer === layer) members.push({ key: t.uuid, joins: (poly) => pointInPoly(t.start, poly) || pointInPoly(t.end, poly) });
      const items = fills.map((poly) => new Set(members.filter((m) => m.joins(poly)).map((m) => m.key)));

      for (const fp of board.footprints) {
        for (const pad of fp.pads) {
          if (pad.net !== zone.net || !pad.net || !onPadLayer(pad, layer) || !flashed(pad, layer)) continue;
          if (connectionOf(pad, fp, zone) !== "thermal") continue;
          const gap = pad.thermalGap ?? zone.thermalGap;
          const outline = padRings.get(pad) ?? padPolygons(pad, gap / 2)[0];
          if (!outline) continue;
          const ob = boxOf([outline]);
          if (ob.x0 > zbox.x1 || ob.x1 < zbox.x0 || ob.y0 > zbox.y1 || ob.y1 < zbox.y0) continue;
          let spokes = 0;
          let ignored = 0;
          let ignoredAt: Point | undefined;
          fills.forEach((poly, j) => {
            const x = crossings(poly, outline);
            if (x.length < 2) return;
            const n = Math.floor(x.length / 2);
            // An island reached only by this pad is part of the pad, not a connection.
            if (items[j]!.size <= 1) {
              ignored += n;
              ignoredAt = { x: (x[0]!.x + x[1]!.x) / 2, y: (x[0]!.y + x[1]!.y) / 2 };
            } else spokes += n;
          });
          if (spokes === 0 && ignored === 0) continue;
          if (pad.shape === "custom") continue; // custom spoke templates aren't modelled
          if (spokes >= minCount) continue;
          // Tracks from inside the relief out into the fill act as extra spokes.
          for (const t of board.tracks) {
            if (t.layer !== layer || t.net !== zone.net) continue;
            const inS = pointInPoly(t.start, outline);
            const inE = pointInPoly(t.end, outline);
            if ((inS && fills.some((f) => pointInPoly(t.end, f))) || (!inS && inE && fills.some((f) => pointInPoly(t.start, f)))) spokes++;
          }
          // Connected only to islands of its own: count those spokes (connectivity is
          // checked elsewhere), as current KiCad does.
          if (spokes === 0) {
            spokes = ignored;
            ignored = 0;
          }
          if (spokes < minCount) {
            const item = padItem(fp, pad);
            out.push({
              type: "starved_thermal",
              severity: "error",
              message: ignored
                ? `Thermal relief connection to zone incomplete (layer ${layer}; ${ignored} spokes connected to isolated island)`
                : `Thermal relief connection to zone incomplete (layer ${layer}; min spoke count ${minCount}; actual ${spokes})`,
              at: ignored && ignoredAt ? ignoredAt : pad.at,
              items: [{ kind: "zone", net: zone.net, uuid: zone.uuid, description: `Zone [${zone.net}] on ${layer}` }, item],
              actual: spokes,
              required: minCount,
            });
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Track width and via diameter
// ---------------------------------------------------------------------------

/** Tracks narrower than the board minimum (or a custom track_width rule), vias smaller than min_via_diameter. */
function checkWidths(board: Board, rules: DesignRules, items: CopperItem[], out: BoardViolation[]) {
  const custom = rules.custom ?? [];
  const minTrack = rules.minTrackWidth ?? 0;
  const minVia = rules.minViaDiameter ?? 0.5;
  const trackItems = items.filter((i) => i.item.kind === "track");
  const onCopper = board.tracks.filter((t) => board.copperLayers.includes(t.layer));
  const nets = new Set(board.nets);
  onCopper.forEach((t, i) => {
    const item = trackItems[i]!;
    const ruled = custom.length
      ? customConstraint(custom, "track_width", { hasNet: (n) => nets.has(n), type: "Track", netName: t.net, netClass: netClassOf(rules, t.net).name, layer: t.layer, layers: new Set([t.layer]), intersectsArea: (name) => board.zones.some((z) => z.name === name && z.outline.length >= 3 && (pointInPoly(t.start, z.outline) || pointInPoly(t.end, z.outline))) }, t.layer)
      : undefined;
    const min = ruled?.min ?? minTrack;
    const max = ruled?.max;
    if (min > 0 && t.width < min - 1e-9)
      out.push({ type: "track_width", severity: "error", message: `Track width (min ${fmt(min)} mm; actual ${fmt(t.width)} mm)`, at: t.kind === "arc" && t.mid ? t.mid : { x: (t.start.x + t.end.x) / 2, y: (t.start.y + t.end.y) / 2 }, items: [item.item], actual: t.width, required: min });
    else if (max !== undefined && t.width > max + 1e-9)
      out.push({ type: "track_width", severity: "error", message: `Track width (max ${fmt(max)} mm; actual ${fmt(t.width)} mm)`, at: { x: (t.start.x + t.end.x) / 2, y: (t.start.y + t.end.y) / 2 }, items: [item.item], actual: t.width, required: max });
  });
  for (const v of board.vias) {
    const ruled = custom.length ? customConstraint(custom, "via_diameter", holeRuleItem(board, rules, "Via", v.net, v.at, board.copperLayers)) : undefined;
    const min = ruled?.min ?? minVia;
    if (min > 0 && v.size < min - 1e-9)
      out.push({ type: "via_diameter", severity: "error", message: `Via diameter (min ${fmt(min)} mm; actual ${fmt(v.size)} mm)`, at: v.at, items: [viaItem(v)], actual: v.size, required: min });
  }
}

// ---------------------------------------------------------------------------
// Silkscreen text size
// ---------------------------------------------------------------------------

/** Visible silkscreen text smaller or thinner than the board minimums (KiCad applies these to silk only). */
function checkTextSizes(board: Board, rules: DesignRules, out: BoardViolation[]) {
  const minH = rules.minTextHeight ?? 0.8;
  const minT = rules.minTextThickness ?? 0.08;
  const check = (t: Board["texts"][number], owner?: Footprint) => {
    if (t.layer !== "F.SilkS" && t.layer !== "B.SilkS") return;
    const item: DrcItem = { kind: "graphic", net: "", reference: owner?.reference, uuid: t.uuid ?? owner?.uuid, description: owner ? `Text '${t.text}' of ${owner.reference}` : `Text '${t.text}' on ${t.layer}` };
    if (t.size.y < minH - 1e-9)
      out.push({ type: "text_height", severity: "warning", message: `Text height (min ${fmt(minH)} mm; actual ${fmt(t.size.y)} mm)`, at: t.at, items: [item], actual: t.size.y, required: minH });
    // The pen KiCad draws with (bold heavier, never over a quarter of the text size).
    const pen = textPen(t);
    if (pen < minT - 1e-9)
      out.push({ type: "text_thickness", severity: "warning", message: `Text thickness (min ${fmt(minT)} mm; actual ${fmt(pen)} mm)`, at: t.at, items: [item], actual: pen, required: minT });
  };
  for (const fp of board.footprints) for (const t of fp.texts) check(t, fp);
  for (const t of board.texts) check(t);
}

/** Text that would read backwards: mirrored on a front layer, or not mirrored on a back one. */
function checkTextMirroring(board: Board, out: BoardViolation[]) {
  const front = new Set(["F.Cu", "F.SilkS", "F.Mask", "F.Fab"]);
  const back = new Set(["B.Cu", "B.SilkS", "B.Mask", "B.Fab"]);
  const check = (t: Board["texts"][number], owner?: Footprint) => {
    const mirrored = t.justify.includes("mirror");
    const type = mirrored && front.has(t.layer) ? "mirrored_text_on_front_layer" : !mirrored && back.has(t.layer) ? "nonmirrored_text_on_back_layer" : undefined;
    if (!type) return;
    const item: DrcItem = { kind: "graphic", net: "", reference: owner?.reference, uuid: t.uuid ?? owner?.uuid, description: owner ? `Text '${t.text}' of ${owner.reference}` : `Text '${t.text}' on ${t.layer}` };
    out.push({ type, severity: "warning", message: mirrored ? `Mirrored text on ${t.layer} (reads backwards from the front)` : `Text on ${t.layer} isn't mirrored (reads backwards from the back)`, at: t.at, items: [item] });
  };
  for (const fp of board.footprints) for (const t of fp.texts) check(t, fp);
  for (const t of board.texts) check(t);
}

/** Every visible silkscreen item as shapes: graphics with their stroke, text as its glyph strokes. */
export function silkItems(board: Board): Array<{ item: DrcItem; layer: string; shapes: Shape[]; ringAt?: Shape; line?: boolean }> {
  const out: Array<{ item: DrcItem; layer: string; shapes: Shape[]; ringAt?: Shape; line?: boolean }> = [];
  // An unfilled circle's stored point (on the circle), as a dot of its stroke.
  const ringAt = (g: Graphic): Shape | undefined => (g.kind === "circle" && !g.fill && g.points[1] ? { kind: "seg", a: g.points[1], b: g.points[1], r: g.width / 2 } : undefined);
  const isSilk = (l: string) => l === "F.SilkS" || l === "B.SilkS";
  const layerName = (l: string) => (l === "F.SilkS" ? "F.Silkscreen" : "B.Silkscreen");
  const textShapes = (t: Board["texts"][number]): Shape[] => {
    // TrueType text: KiCad's glyph outlines.
    const glyphs = !t.knockout && textOutline(t);
    if (glyphs) return glyphs.map((poly) => buildArea(poly));
    // Knockout text is its filled box (the letters are holes in it).
    if (t.knockout) {
      const k = knockoutText(t);
      return k ? [buildArea(k.box)] : [];
    }
    const r = textPen(t) / 2;
    return textStrokes(t).flatMap((st) => (st.length === 1 ? [{ kind: "seg" as const, a: st[0]!, b: st[0]!, r }] : st.slice(1).map((b, i) => ({ kind: "seg" as const, a: st[i]!, b, r }))));
  };
  for (const fp of board.footprints) {
    for (const g of fp.graphics) if (isSilk(g.layer)) out.push({ layer: g.layer, shapes: graphicShapes(g), ringAt: ringAt(g), line: g.kind === "line", item: { kind: "graphic", net: "", reference: fp.reference, uuid: g.uuid, description: `${g.kind} of ${fp.reference} on ${layerName(g.layer)}` } });
    for (const t of fp.texts) if (isSilk(t.layer)) out.push({ layer: t.layer, shapes: textShapes(t), item: { kind: "graphic", net: "", reference: fp.reference, uuid: t.uuid, description: `Text '${t.text}' of ${fp.reference}` } });
  }
  for (const g of board.drawings) if (isSilk(g.layer)) out.push({ layer: g.layer, shapes: graphicShapes(g), ringAt: ringAt(g), line: g.kind === "line", item: { kind: "graphic", net: "", uuid: g.uuid, description: `${g.kind} on ${layerName(g.layer)}` } });
  for (const t of board.texts) if (isSilk(t.layer)) out.push({ layer: t.layer, shapes: textShapes(t), item: { kind: "graphic", net: "", uuid: t.uuid, description: `Text '${t.text}' on ${layerName(t.layer)}` } });
  return out;
}

/** Silkscreen on or too near the board edge (fabs clip it there); one finding per item. */
function checkSilkEdge(board: Board, rules: DesignRules, silk: ReturnType<typeof silkItems>, out: BoardViolation[]) {
  const clear = rules.minSilkClearance ?? 0;
  const edges: Shape[] = edgeChains(board).flatMap((c) => c.slice(1).map((b, i): Shape => ({ kind: "seg", a: c[i]!, b, r: 0 })));
  if (!edges.length) return;
  const edgeItem: DrcItem = { kind: "edge", net: "", description: "Board edge (Edge.Cuts)" };
  for (const s of silk) {
    let hit: { dist: number; at: Point } | undefined;
    for (const sh of s.shapes) {
      for (const e of edges) {
        const d = shapeDistance(sh, e, clear + 1);
        // KiCad: closer than the clearance (less its DRC epsilon); with none, actually overlapping.
        if (d.dist < Math.max(0, clear - 0.0005) - 1e-5) {
          hit = d;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) out.push({ type: "silk_edge_clearance", severity: "warning", message: clear > 0 ? `Silkscreen too close to the board edge (min ${fmt(clear)} mm)` : "Silkscreen clipped by the board edge", at: hit.at, items: [edgeItem, s.item] });
  }
}

const boxOfShapes = (shapes: Shape[]): Box => {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const s of shapes) {
    const sb = shapeBox(s);
    b.x0 = Math.min(b.x0, sb.x0); b.y0 = Math.min(b.y0, sb.y0); b.x1 = Math.max(b.x1, sb.x1); b.y1 = Math.max(b.y1, sb.y1);
  }
  return b;
};
const overlaps = (a: Box, b: Box, m = 0) => a.x0 <= b.x1 + m && b.x0 <= a.x1 + m && a.y0 <= b.y1 + m && b.y0 <= a.y1 + m;

/** The solder-mask openings on one side: pads with their margin, untented vias, mask graphics and zones. */
function maskOpenings(board: Board, layer: "F.Mask" | "B.Mask"): Array<{ item: DrcItem; shapes: Shape[] }> {
  const out: Array<{ item: DrcItem; shapes: Shape[] }> = [];
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      if (!onLayer(pad.layers, layer)) continue;
      // KiCad tests silk against the pad's own shape here, without its mask margin.
      // Its exact shape, too: silk that only touches a round pad doesn't overlap it.
      const shapes = padShapes(pad);
      if (shapes.length) out.push({ shapes, item: { kind: "pad", net: pad.net, reference: fp.reference, pad: pad.number, uuid: pad.uuid, description: `Pad ${pad.number} [${pad.net || "<no net>"}] of ${fp.reference} on ${layer}` } });
    }
    for (const g of fp.graphics) if (g.layer === layer) out.push({ shapes: graphicShapes(g), item: { kind: "graphic", net: "", reference: fp.reference, uuid: g.uuid, description: `${g.kind} of ${fp.reference} on ${layer}` } });
  }
  for (const g of board.drawings) if (g.layer === layer) out.push({ shapes: graphicShapes(g), item: { kind: "graphic", net: "", uuid: g.uuid, description: `${g.kind} on ${layer}` } });
  for (const z of board.zones) {
    if (!z.layers.includes(layer)) continue;
    const fills = z.fills.filter((f) => f.layer === layer).map((f) => f.points);
    const polys = fills.length ? fills : z.outline.length >= 3 ? [z.outline] : [];
    if (polys.length) out.push({ shapes: polys.map((p) => buildArea(p)), item: { kind: "zone", net: z.net, uuid: z.uuid, description: `Zone on ${layer}` } });
  }
  // Tented vias are covered (KiCad doesn't put them on the mask layer); untented ones open with the board's margin.
  const tented = layer === "F.Mask" ? board.setup.tentFront : board.setup.tentBack;
  if (!tented)
    for (const v of board.vias) out.push({ shapes: [{ kind: "seg", a: v.at, b: v.at, r: v.size / 2 + board.setup.maskMargin }], item: { kind: "via", net: v.net, at: v.at, uuid: v.uuid, description: `Via [${v.net}]` } });
  return out;
}

/**
 * Silkscreen over a solder-mask opening (the fab clips it, or it prints on
 * exposed copper): one finding per silk item and opening. Openings off the
 * board don't count.
 */
function checkSilkOverMask(board: Board, rules: DesignRules, silk: ReturnType<typeof silkItems>, out: BoardViolation[]) {
  const clear = Math.max(0, rules.minSilkClearance ?? 0);
  const outline = (boardArea(board) ?? []).map((p) => p.map((q) => ({ x: q.X / 1e5, y: q.Y / 1e5 })));
  // On the board: some point of the opening inside the outline (even-odd over its loops).
  const inside = (p: Point) => outline.filter((loop) => pointInPoly(p, loop)).length % 2 === 1;
  const points = (sh: Shape): Point[] => (sh.kind === "seg" ? [sh.a, sh.b] : sh.pts);
  for (const side of ["F", "B"] as const) {
    const openings = maskOpenings(board, `${side}.Mask`)
      .map((o) => ({ ...o, box: boxOfShapes(o.shapes) }))
      .filter((o) => !outline.length || o.shapes.some((sh) => points(sh).some(inside)));
    for (const s of silk) {
      if (s.layer !== `${side}.SilkS` || !s.shapes.length) continue;
      const sbox = boxOfShapes(s.shapes);
      for (const o of openings) {
        if (!overlaps(sbox, o.box, clear)) continue;
        let hit: Point | undefined;
        for (const a of s.shapes) {
          for (const b of o.shapes) {
            const d = shapeDistance(a, b, clear + 1);
            if (d.dist < Math.max(0, clear - 0.0005) - 1e-5) {
              hit = d.at;
              break;
            }
          }
          if (hit) break;
        }
        if (hit) out.push({ type: "silk_over_copper", severity: "warning", message: "Silkscreen clipped by a solder-mask opening", at: hit, items: [s.item, o.item] });
      }
    }
  }
}

/**
 * Silkscreen on silkscreen (KiCad's silk_overlap): items on the same silk
 * layer closer than the silk clearance (overlapping, at KiCad's default of 0),
 * one finding per pair. Two shapes of one footprint, or two board shapes,
 * don't count (outlines are drawn in pieces); items must be on the board.
 */
function checkSilkOverlap(board: Board, rules: DesignRules, silk: ReturnType<typeof silkItems>, out: BoardViolation[]) {
  const clear = Math.max(0, rules.minSilkClearance ?? 0);
  const outline = (boardArea(board) ?? []).map((p) => p.map((q) => ({ x: q.X / 1e5, y: q.Y / 1e5 })));
  const inside = (p: Point) => outline.filter((loop) => pointInPoly(p, loop)).length % 2 === 1;
  const onBoard = (shapes: Shape[]) => !outline.length || shapes.some((sh) => (sh.kind === "seg" ? [sh.a, sh.b] : sh.pts).some(inside));
  for (const layer of ["F.SilkS", "B.SilkS"]) {
    const items = silk
      .filter((s) => s.layer === layer && s.shapes.length && onBoard(s.shapes))
      .map((s) => ({ ...s, box: boxOfShapes(s.shapes), text: s.item.description.startsWith("Text") }))
      .sort((a, b) => a.box.x0 - b.box.x0);
    const open: typeof items = [];
    for (const it of items) {
      for (let i = open.length - 1; i >= 0; i--) if (open[i]!.box.x1 + clear < it.box.x0) open.splice(i, 1);
      for (const o of open) {
        if (!overlaps(o.box, it.box, clear)) continue;
        // Shapes of one footprint (or both on the board) make up one drawing.
        if (!o.text && !it.text && (o.item.reference ?? "") === (it.item.reference ?? "")) continue;
        let hit: Point | undefined;
        // KiCad tests a straight segment against an unfilled circle only at the circle's
        // stored point (its full-circle outline acts as a zero-length arc there).
        const sa = o.ringAt && it.line ? [o.ringAt] : o.shapes;
        const sb = it.ringAt && o.line ? [it.ringAt] : it.shapes;
        for (const a of sa) {
          for (const b of sb) {
            const d = shapeDistance(a, b, clear + 0.01);
            if (d.dist < Math.max(0, clear - 0.0005) - 1e-5) {
              hit = d.at;
              break;
            }
          }
          if (hit) break;
        }
        if (hit) out.push({ type: "silk_overlap", severity: "warning", message: clear > 0 ? `Silkscreen too close to other silkscreen (min ${fmt(clear)} mm)` : "Silkscreen overlaps silkscreen", at: hit, items: [o.item, it.item] });
      }
      open.push(it);
    }
  }
}

interface MaskThing {
  item: DrcItem;
  shapes: Shape[];
  box: { x0: number; y0: number; x1: number; y1: number };
  footprint?: Footprint;
  logicalPad?: string;
}

/**
 * Solder-mask bridges (KiCad's solder_mask_bridge): a mask opening that
 * exposes copper of another net, where solder could join them. Openings are
 * pads (grown by their mask margin) and untented vias. They bridge with each
 * other, with tracks, copper graphics and tented vias under them, and with
 * zone copper. Mask-only graphics bridge when they expose two nets. Exempt:
 * one logical pad, footprints that allow bridges, net ties.
 */
function checkMaskBridges(board: Board, items: CopperItem[], out: BoardViolation[]) {
  const allowAll = !!board.setup.allowMaskBridgesInFootprints;
  const sameNet = (a: string, b: string) => !!a && a === b;
  // Copper of one footprint may share an opening when the footprint (or board) allows it, or it's a net tie.
  const exempt = (a: MaskThing, b: MaskThing) => {
    if (a.logicalPad && a.logicalPad === b.logicalPad) return true;
    const fa = a.footprint, fb = b.footprint;
    return !!fa && fa === fb && (allowAll || !!fa.attributes.allowMaskBridges || !!fa.netTie);
  };
  const touch = (a: MaskThing, b: MaskThing): Point | undefined => {
    if (!overlaps(a.box, b.box)) return undefined;
    for (const sa of a.shapes)
      for (const sb of b.shapes) {
        if (sa.kind === "area" && sb.kind === "area") {
          // Two polygons: an edge of the smaller one on or inside the larger.
          const [small, big] = sa.pts.length <= sb.pts.length ? [sa, sb] : [sb, sa];
          for (let i = 0; i < small.pts.length; i++) {
            const d = shapeDistance({ kind: "seg", a: small.pts[i]!, b: small.pts[(i + 1) % small.pts.length]!, r: 0 }, big, 0.01);
            if (d.dist <= 1e-6) return d.at;
          }
          continue;
        }
        const d = shapeDistance(sa, sb, 0.01);
        if (d.dist <= 1e-6) return d.at;
      }
    return undefined;
  };
  // Pairs whose boxes overlap, by sweeping along x.
  const pairs = (xs: MaskThing[], ys: MaskThing[], same: boolean, visit: (a: MaskThing, b: MaskThing) => void) => {
    const ev = [...xs.map((t) => ({ t, s: 0 })), ...(same ? [] : ys.map((t) => ({ t, s: 1 })))].sort((p, q) => p.t.box.x0 - q.t.box.x0);
    const open: Array<{ t: MaskThing; s: number }> = [];
    for (const e of ev) {
      for (let i = open.length - 1; i >= 0; i--) if (open[i]!.t.box.x1 < e.t.box.x0) open.splice(i, 1);
      for (const o of open) if (same || o.s !== e.s) visit(o.s === 0 ? o.t : e.t, o.s === 0 ? e.t : o.t);
      open.push(e);
    }
  };
  const reported = new Set<string>();
  const report = (at: Point, things: MaskThing[]) => {
    const key = things.map((t) => t.item.uuid ?? t.item.description).sort().join("|");
    if (reported.has(key)) return;
    reported.add(key);
    out.push({ type: "solder_mask_bridge", severity: "error", message: "Solder mask aperture bridges items with different nets", at, items: things.map((t) => t.item) });
  };

  for (const side of ["F", "B"] as const) {
    const mask = `${side}.Mask`, cu = `${side}.Cu`;
    const tented = side === "F" ? board.setup.tentFront : board.setup.tentBack;
    const openings: MaskThing[] = [];
    const apertures: MaskThing[] = [];
    const copper: MaskThing[] = [];
    const thing = (item: DrcItem, shapes: Shape[], extra: Partial<MaskThing> = {}): MaskThing => ({ item, shapes, box: boxOfShapes(shapes), ...extra });
    for (const fp of board.footprints)
      for (const pad of fp.pads) {
        const onMask = onLayer(pad.layers, mask);
        const onCu = onLayer(pad.layers, cu);
        if (!onMask && !onCu) continue;
        // A non-plated hole with no copper (no copper layer, or no bigger than its hole) is neither.
        if (pad.type === "np_thru_hole" && (!hasCopper(pad) || Math.max(pad.size.x, pad.size.y) <= (pad.drill ?? 0) + 1e-9)) continue;
        const item: DrcItem = { kind: "pad", net: pad.net, reference: fp.reference, pad: pad.number, uuid: pad.uuid, description: `Pad ${pad.number} [${pad.net || "<no net>"}] of ${fp.reference}` };
        const logicalPad = pad.number ? `${fp.uuid}\0${pad.number}` : undefined;
        if (onMask) {
          const margin = hasCopper(pad) ? (pad.maskMargin ?? fp.maskMargin ?? board.setup.maskMargin) : 0;
          const t = thing(item, padPolygons(pad, margin).map((poly) => buildArea(poly)), { footprint: fp, logicalPad });
          (onCu ? openings : apertures).push(t);
        } else copper.push(thing(item, padPolygons(pad, 0).map((poly) => buildArea(poly)), { footprint: fp, logicalPad }));
      }
    for (const v of board.vias) {
      const item: DrcItem = { kind: "via", net: v.net, at: v.at, uuid: v.uuid, description: `Via [${v.net}]` };
      if (!tented) openings.push(thing(item, [{ kind: "seg", a: v.at, b: v.at, r: v.size / 2 + board.setup.maskMargin }]));
    }
    // Copper under openings: tracks, copper graphics, tented vias and zone fills on this side.
    for (const it of items) {
      if (!it.layers.has(cu)) continue;
      if (it.item.kind === "track" || it.item.kind === "graphic" || it.item.kind === "zone" || (it.item.kind === "via" && tented)) {
        const fp = it.item.kind === "graphic" && it.item.reference ? board.footprints.find((f) => f.reference === it.item.reference) : undefined;
        copper.push({ item: it.item, shapes: it.shapes, box: it.box, footprint: fp });
      }
    }
    for (const fp of board.footprints) for (const g of fp.graphics) if (g.layer === mask) apertures.push(thing({ kind: "graphic", net: "", reference: fp.reference, uuid: g.uuid, description: `${g.kind} of ${fp.reference} on ${mask}` }, graphicShapes(g), { footprint: fp }));
    for (const g of board.drawings) if (g.layer === mask) apertures.push(thing({ kind: "graphic", net: "", uuid: g.uuid, description: `${g.kind} on ${mask}` }, graphicShapes(g)));

    // Opening against opening, and opening over other copper.
    pairs(openings, openings, true, (a, b) => {
      if (sameNet(a.item.net, b.item.net) || exempt(a, b)) return;
      const at = touch(a, b);
      if (at) report(at, [a, b]);
    });
    pairs(openings, copper, false, (a, b) => {
      if (sameNet(a.item.net, b.item.net) || exempt(a, b)) return;
      const at = touch(a, b);
      if (at) report(at, [a, b]);
    });
    // A mask-only opening bridges when it exposes two different nets.
    const exposed = new Map<MaskThing, Array<{ t: MaskThing; at: Point }>>();
    pairs(apertures, [...openings, ...copper], false, (a, b) => {
      if (!b.item.net || (a.footprint && (allowAll || a.footprint.attributes.allowMaskBridges))) return;
      const at = touch(a, b);
      if (!at) return;
      const list = exposed.get(a) ?? [];
      if (!list.some((x) => x.t.item.net === b.item.net)) list.push({ t: b, at });
      exposed.set(a, list);
    });
    for (const [a, list] of exposed) if (list.length >= 2) report(list[1]!.at, [a, list[0]!.t, list[1]!.t]);
  }
}

// ---------------------------------------------------------------------------
// Rule areas (keep-outs)
// ---------------------------------------------------------------------------

/** Tracks and vias in a rule area that keeps them out (KiCad's items_not_allowed). */
function checkRuleAreas(board: Board, out: BoardViolation[]) {
  const inside = (poly: Point[], p: Point) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };
  const toSegment = (p: Point, a: Point, b: Point) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  const cross = (a: Point, b: Point, c: Point, d: Point) => {
    const o = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
  };
  const outer = (l: string) => l === board.copperLayers[0] || l === board.copperLayers[board.copperLayers.length - 1];
  for (const z of board.zones) {
    if (!z.keepout || z.outline.length < 3 || !(z.noTracks || z.noVias)) continue;
    const poly = z.outline;
    const edges = poly.map((a, k) => [a, poly[(k + 1) % poly.length]!] as const);
    const area: DrcItem = { kind: "zone", net: "", uuid: z.uuid, description: `Rule area${z.name ? ` '${z.name}'` : ""}` };
    const covers = (l: string) => z.layers.includes(l) || z.layers.includes("*.Cu") || (outer(l) && z.layers.includes("F&B.Cu"));
    if (z.noTracks)
      for (const t of board.tracks) {
        if (!covers(t.layer)) continue;
        const at = inside(poly, t.start) ? t.start : inside(poly, t.end) ? t.end : edges.some(([a, b]) => cross(t.start, t.end, a, b)) ? { x: (t.start.x + t.end.x) / 2, y: (t.start.y + t.end.y) / 2 } : undefined;
        if (at) out.push({ type: "items_not_allowed", severity: "error", message: "Track in a rule area that keeps tracks out", at, items: [area, { kind: "track", net: t.net, uuid: t.uuid, description: `Track [${t.net || "<no net>"}] on ${t.layer}` }] });
      }
    if (z.noVias)
      for (const v of board.vias) {
        if (inside(poly, v.at) || edges.some(([a, b]) => toSegment(v.at, a, b) < v.size / 2)) out.push({ type: "items_not_allowed", severity: "error", message: "Via in a rule area that keeps vias out", at: v.at, items: [area, viaItem(v)] });
      }
  }
}

const onPadLayer = (pad: Pad, layer: string) => pad.layers.some((l) => l === layer || l === "*.Cu" || (l === "F&B.Cu" && (layer === "F.Cu" || layer === "B.Cu")));

/**
 * Every check in this module, in one pass, with the project's severities
 * applied (ignored checks dropped) and the designer's exclusions left out.
 */
export function checkBoard(board: Board, rules: DesignRules, items: CopperItem[] = copperItems(board)): BoardViolation[] {
  const all: BoardViolation[] = [];
  const sev = rules.severities ?? {};
  // KiCad ignores some checks unless the project turns them on.
  const DEFAULT_IGNORE: BoardCheck[] = ["footprint_type_mismatch"];
  const on = (t: BoardCheck) => (sev[t] === undefined ? !DEFAULT_IGNORE.includes(t) : sev[t] !== "ignore");
  if (on("drill_out_of_range") || on("annular_width") || on("holes_co_located") || on("hole_to_hole")) checkHoles(board, rules, all);
  if (on("track_dangling") || on("via_dangling")) checkDangling(board, items, all);
  if (on("courtyards_overlap")) checkCourtyards(board, all);
  if (on("pth_inside_courtyard") || on("npth_inside_courtyard")) checkCourtyardHoles(board, all);
  if (on("footprint_type_mismatch")) checkFootprintTypes(board, all);
  if (on("zones_intersect")) checkZoneIntersections(board, all);
  if ((on("length_out_of_range") || on("skew_out_of_range")) && rules.custom?.length)
    for (const v of checkLengthRules(board, rules, rules.custom)) all.push({ type: v.type, severity: "error", message: v.message, at: v.at, items: v.items, actual: v.actual, required: v.max ?? v.min });
  if (on("starved_thermal")) checkThermals(board, rules, all);
  if (on("text_height") || on("text_thickness")) checkTextSizes(board, rules, all);
  if (on("track_width") || on("via_diameter")) checkWidths(board, rules, items, all);
  if (on("mirrored_text_on_front_layer") || on("nonmirrored_text_on_back_layer")) checkTextMirroring(board, all);
  const silk = on("silk_edge_clearance") || on("silk_over_copper") || on("silk_overlap") ? silkItems(board) : [];
  if (on("silk_edge_clearance")) checkSilkEdge(board, rules, silk, all);
  if (on("silk_over_copper")) checkSilkOverMask(board, rules, silk, all);
  if (on("solder_mask_bridge")) checkMaskBridges(board, items, all);
  if (on("silk_overlap")) checkSilkOverlap(board, rules, silk, all);
  if (on("items_not_allowed")) checkRuleAreas(board, all);
  const excluded = excludedKeys(rules);
  return all
    .filter((v) => on(v.type))
    .filter((v) => !excluded.has(exclusionKey(v.type, v.items)))
    .map((v) => (sev[v.type] === "error" || sev[v.type] === "warning" ? { ...v, severity: sev[v.type] as "error" | "warning" } : v));
}

/**
 * DRC exclusions as KiCad keeps them in the project file: "type|x|y|uuid|uuid" (position in nm).
 * We match on the check and the items' UUIDs only, since the position moves with any edit.
 */
export function exclusionKey(type: string, items: Array<{ uuid?: string }>): string {
  // Only the nil UUID stands for "no item"; 00000000-…-xxxxxxxx ones are real (converted legacy timestamps).
  return `${type}|${items.map((i) => i.uuid ?? "").filter((u) => u && u !== "00000000-0000-0000-0000-000000000000").sort().join("|")}`;
}

/** The keys of the project's exclusions (see exclusionKey). */
export function excludedKeys(rules: DesignRules): Set<string> {
  return new Set(
    (rules.exclusions ?? []).map((e) => {
      const [type, , , ...uuids] = e.split("|");
      return exclusionKey(type ?? "", uuids.map((uuid) => ({ uuid })));
    }),
  );
}

/** A new exclusion entry, written as KiCad writes it. */
export function exclusionEntry(type: string, at: Point, items: Array<{ uuid?: string }>): string {
  const nil = "00000000-0000-0000-0000-000000000000";
  const [a, b] = [items[0]?.uuid ?? nil, items[1]?.uuid ?? nil];
  return `${type}|${Math.round(at.x * 1e6)}|${Math.round(at.y * 1e6)}|${a}|${b}`;
}

/** KiCad's name for a clearance-checker finding. */
export const clearanceCheckType = (t: "clearance" | "short" | "edge" | "hole"): string =>
  ({ clearance: "clearance", short: "shorting_items", edge: "copper_edge_clearance", hole: "hole_clearance" })[t];

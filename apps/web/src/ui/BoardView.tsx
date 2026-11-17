import { useEffect, useMemo, useRef, useState } from "react";
import { alignMoves, boardItemBox, boardItemPosition, copperItems, groupItems, topGroup, distributeMoves, coupledRoute, dimensionGeometry, displayName, diffPairSizes, diffPartnerOnBoard, InteractiveRouter, netClassOf, pairEscape, pairObstacles, partnerPads, roundedRectShapes, trackConflicts, type AlignMode, type Board, type ClearanceViolation, type DesignRules, type DistributeMode, type DrawingSheetPrim } from "@crossprobe/kicad-model";
import type { ProjectView } from "../render/types";
import { buildScene, drawKnockouts, drawPadLabels, drawTrackLabels, drawViaLabels, drawFrame, layerColor, padPath, type BoardScene } from "../render/board";
import { attachedTrackEnds, boardItemOf, connectedTrace, footprintBox, graphicPath, itemsInBox, padAt, pickAll, pickItem, route45, snap, textCorners, type BoardItem } from "../render/board-edit";
import type { EditOp } from "../edit/ops";
import type { Selection } from "./selection";
import { Icon } from "./icons";
import { BoardProps } from "./BoardProps";
import { CreateArray } from "./CreateArray";
import { PositionRelative, type RelativeReference } from "./PositionRelative";
import { addCorner, dragHandle, editShape, handleAt, handles, removeCorner, type Handle } from "../render/point-edit";
import type { PlacingFootprint } from "./FootprintPicker";
import { fromOverlay, useViewport } from "./viewport";

const BG = "#0b1220";
const SEL = "#ffd166";

export type BoardTool = "select" | "route" | "via" | "footprint" | "outline" | "zone" | "text" | "textbox" | "dimension" | "measure";

type Point = { x: number; y: number };

function drawScene(ctx: CanvasRenderingContext2D, scene: BoardScene, visible: Set<string>, scale: number, alpha: number, highlight: boolean, flipped: boolean, afterLayer?: (layer: string) => void) {
  const minW = 1 / scale; // keep hairlines visible when zoomed out
  // Seen from the bottom, the back layers are on top (the outline stays last).
  const order = flipped ? [...scene.order.filter((l) => l !== "Edge.Cuts").reverse(), "Edge.Cuts"] : scene.order;
  for (const name of order) {
    const l = scene.layers.get(name);
    if (!l || !visible.has(name)) continue;
    const isCopper = name.endsWith(".Cu");
    ctx.globalAlpha = alpha * (isCopper && name !== (flipped ? "B.Cu" : "F.Cu") && !highlight ? 0.75 : 1);
    ctx.fillStyle = highlight ? lighten(l.color) : l.color;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.fill(l.fills, "evenodd");
    for (const [w, path] of l.strokes) {
      ctx.lineWidth = Math.max(w, minW);
      ctx.stroke(path);
    }
    ctx.fill(l.pads);
    if (l.knockouts.length) {
      const fill = ctx.fillStyle;
      drawKnockouts(ctx, l, fill, BG);
      ctx.fillStyle = ctx.strokeStyle = fill;
    }
    // Per-layer extras (net names on its tracks), so layers above cover them.
    if (afterLayer) {
      ctx.globalAlpha = 1;
      afterLayer(name);
    }
  }
  ctx.globalAlpha = alpha;
  if (visible.has("Vias")) {
    ctx.fillStyle = highlight ? "#ffffff" : "#b9b9b9";
    ctx.fill(scene.vias);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = BG;
  ctx.fill(scene.holes);
}

/** A net's last path part, as KiCad shows it ("/sheet/D+" → "D+"). */
const shortName = (net: string) => displayName(net.split("/").filter(Boolean).at(-1) ?? net);

/** KiCad's grid steps (mm), for N / Shift+N. */
const GRIDS = [0.05, 0.1, 0.25, 0.5, 0.635, 1, 1.27, 2.54];

/** Track widths W / Shift+W step through: common ones and those on the board. */
function trackWidths(board: Board): number[] {
  return [...new Set([0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.8, 1, ...board.tracks.map((t) => t.width)])].sort((a, b) => a - b);
}

/** The pickable item with this UUID (for selecting new copies). */
function itemFor(board: Board, uuid: string): BoardItem | undefined {
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
  const tx = board.texts.find((x) => x.uuid === uuid) ?? board.textBoxes.find((x) => x.uuid === uuid);
  if (tx) return { kind: "text", uuid, layer: tx.layer };
  return undefined;
}

function lighten(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.45);
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

/** Outline of the selected items (optionally shifted while dragging). */
function drawSelection(ctx: CanvasRenderingContext2D, board: Board, uuids: Set<string>, scale: number, d: Point = { x: 0, y: 0 }) {
  if (!uuids.size) return;
  ctx.save();
  ctx.translate(d.x, d.y);
  ctx.strokeStyle = SEL;
  ctx.fillStyle = SEL;
  ctx.lineWidth = 1.5 / scale;
  for (const fp of board.footprints) {
    if (!uuids.has(fp.uuid)) continue;
    const b = footprintBox(fp);
    ctx.setLineDash([4 / scale, 3 / scale]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
    const pads = new Path2D();
    for (const p of fp.pads) padPath(pads, p);
    ctx.globalAlpha = 0.55;
    ctx.fill(pads);
    ctx.globalAlpha = 1;
  }
  for (const t of board.tracks) {
    if (!uuids.has(t.uuid)) continue;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = t.width;
    ctx.beginPath();
    ctx.moveTo(t.start.x, t.start.y);
    ctx.lineTo(t.end.x, t.end.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (const v of board.vias) {
    if (!uuids.has(v.uuid)) continue;
    ctx.beginPath();
    ctx.arc(v.at.x, v.at.y, v.size / 2, 0, Math.PI * 2);
    ctx.globalAlpha = 0.7;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  const outlines = [
    ...[...board.texts, ...board.footprints.flatMap((f) => f.texts)].filter((t) => t.uuid && uuids.has(t.uuid)).map((t) => { const c = textCorners(t); return [...c, c[0]!]; }),
    ...board.zones.filter((z) => uuids.has(z.uuid)).map((z) => [...z.outline, z.outline[0]!]),
    ...board.drawings.filter((g) => g.uuid && uuids.has(g.uuid)).map(graphicPath),
    ...board.textBoxes.filter((t) => uuids.has(t.uuid)).map((t) => [...t.corners, t.corners[0]!]),
  ];
  ctx.lineWidth = 3 / scale;
  for (const pts of outlines) {
    ctx.beginPath();
    pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
  ctx.restore();
}

/** A route in progress: fixed runs per layer, vias, and the live segment to the cursor. */
interface Route {
  net: string;
  width: number;
  runs: Array<{ layer: string; points: Point[] }>;
  vias: Point[];
  diagonalFirst: boolean;
  /**
   * A differential pair: `runs` is the centreline (routed at the pair's full
   * width), drawn and committed as two coupled tracks of `net` and `pair.net`.
   */
  pair?: {
    net: string;
    width: number;
    gap: number;
    startP: Point;
    startN: Point;
    /** The start pads (by uuid): obstacles for the centreline and the pair's vias. */
    ends: string[];
    /** The clicked start pad, and other partner pads as near to it as the one taken (a USB-C D+ pad
     *  has a D- pad on each side): the end click may switch to one of them to keep P and N uncrossed. */
    start: { pad: import("@crossprobe/kicad-model").Pad; fp: import("@crossprobe/kicad-model").Footprint; alts: import("@crossprobe/kicad-model").Pad[] };
    via: { size: number; drill: number };
    /** Centre-to-centre distance of the pair's two vias. */
    viaPitch: number;
  };
}

export interface BoardEditProps {
  editing: boolean;
  tool: BoardTool;
  onTool: (t: BoardTool) => void;
  /** Project-relative .kicad_pcb path. */
  file: string;
  onEdit: (ops: EditOp[]) => void;
  layer: string;
  onLayer: (l: string) => void;
  /** Track width in mm; 0 = the net's net class. */
  trackWidth: number;
  onTrackWidth?: (w: number) => void;
  /** Via size; undefined = the net's net class. */
  via?: { size: number; drill: number };
  /** Vias the router and via tool place: through (default), or blind/buried or micro between the two layers they join. */
  viaType?: "through" | "blind" | "micro";
  grid: number;
  onGrid?: (g: number) => void;
  /** The footprint the footprint tool places. */
  placingFootprint?: PlacingFootprint;
  /** The net new zones get. */
  zoneNet: string;
  /** Outline tool: a rectangle (corner radius > 0 rounds it) or a polygon. */
  outlineMode: "rect" | "poly";
  cornerRadius: number;
}

export function BoardView({
  board,
  visible,
  selectable,
  selection,
  onSelect,
  focusToken,
  flipped = false,
  ratsnest = [],
  drc = [],
  netClasses = {},
  designRules,
  edit,
  dirty = false,
  frame: pageFrame,
}: {
  board: Board;
  visible: Set<string>;
  /** KiCad's selection filter: the kinds clicks and boxes may pick (footprint, pad, track, via, zone, graphic, text). */
  selectable?: Set<string>;
  selection: Selection;
  onSelect: (s: Selection) => void;
  focusToken?: number;
  flipped?: boolean;
  /** Missing connections to draw as straight lines. */
  ratsnest?: Array<{ net: string; a: { at: { x: number; y: number }; reference?: string }; b: { at: { x: number; y: number }; reference?: string } }>;
  /** Clearance violations to mark. */
  drc?: ClearanceViolation[];
  netClasses?: ProjectView["netClasses"];
  designRules?: ProjectView["designRules"];
  edit?: BoardEditProps;
  /** Zone fills are out of date (board edited since the last refill). */
  dirty?: boolean;
  /** The page frame (drawing sheet), drawn behind the board. */
  frame?: DrawingSheetPrim[];
}) {
  const scene = useMemo(() => buildScene(board), [board]);
  const overlay = useMemo(() => {
    if (selection?.kind === "net") return buildScene(board, { net: selection.name });
    if (selection?.kind === "component") return buildScene(board, { reference: selection.reference });
    return undefined;
  }, [board, selection]);
  // Bottom view mirrors X about the board centre.
  const cx = scene.bbox.x + scene.bbox.w / 2;
  const mirror = (b: { x: number; y: number; w: number; h: number }) => (flipped ? { ...b, x: 2 * cx - b.x - b.w } : b);
  // Frame the board once; again only when an empty board gets its first parts or outline.
  const vp = useViewport(scene.bbox, board.outline.length ? "outline" : board.footprints.length ? "parts" : "empty");
  const canvas = useRef<HTMLCanvasElement>(null);

  const editing = !!edit?.editing;
  const tool = editing ? edit!.tool : "select";
  const [picked, setPicked] = useState<BoardItem[]>([]);
  const tunedNet = useRef<string | undefined>(undefined);
  // A short message for the hint line (e.g. why a locked item didn't move).
  const [note, setNote] = useState<string>();
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(undefined), 4000);
    return () => clearTimeout(t);
  }, [note]);
  // Copied items (Ctrl+C), pasted (Ctrl+V) relative to where they were.
  const clipboard = useRef<{ uuids: string[]; at: Point } | undefined>(undefined);
  // Copies just made: picked once the board has them.
  const pendingPick = useRef<string[] | undefined>(undefined);
  const pickedIds = useMemo(() => new Set(picked.map((p) => p.uuid)), [picked]);
  // Locked footprints, tracks and vias (KiCad's L): not moved, rotated, flipped or deleted.
  const lockedIds = useMemo(() => {
    const ids = new Set([...board.footprints, ...board.tracks, ...board.vias].filter((x) => x.locked).map((x) => x.uuid));
    // Everything in a locked group is locked too (KiCad's IsLocked).
    for (const g of board.groups) if (g.locked) for (const u of groupItems(board, g.uuid)) ids.add(u);
    return ids;
  }, [board]);
  /**
   * A group's members the app can pick (KiCad files can group items it doesn't model:
   * hidden texts, images, tables…): a group counts as picked whole when all of these are.
   */
  const pickableMembers = (g: string, counts: (it: BoardItem) => boolean = () => true) =>
    groupItems(board, g).filter((u) => {
      const it = boardItemOf(board, u);
      return !!it && counts(it);
    });
  const pickedWhole = (g: string, ids: Set<string>, counts?: (it: BoardItem) => boolean) => {
    const m = pickableMembers(g, counts);
    return m.length > 0 && m.every((u) => ids.has(u));
  };
  /** The uuids, with the unmodelled members of the top-level groups the selection covers whole (so those move with them). */
  const withGroupExtras = (uuids: string[]): string[] => {
    const ids = new Set(uuids);
    const out = [...uuids];
    for (const g of board.groups) {
      if (topGroup(board, g.uuid) || !pickedWhole(g.uuid, pickedIds)) continue;
      for (const u of groupItems(board, g.uuid)) if (!ids.has(u) && !boardItemOf(board, u) && !lockedIds.has(u)) (ids.add(u), out.push(u));
    }
    return out;
  };
  const [drag, setDrag] = useState<{ from: Point; d: Point; committed?: Board } | null>(null);
  const [box, setBox] = useState<{ a: Point; b: Point } | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  // A dimension being placed: its points so far.
  const [dim, setDim] = useState<{ start: Point; end?: Point; orthogonal: boolean } | null>(null);
  /** The text box tool's first corner. */
  const [boxCorner, setBoxCorner] = useState<Point | null>(null);
  useEffect(() => setBoxCorner(null), [tool]);
  /** The point editor's shape: one selected zone or board graphic, while selecting. */
  const pointShape = useMemo(() => (editing && tool === "select" && picked.length === 1 && (picked[0]!.kind === "zone" || picked[0]!.kind === "graphic") ? editShape(board, picked[0]!.uuid) : undefined), [editing, tool, picked, board]);
  /** A handle being dragged, and where to. */
  const [ptDrag, setPtDrag] = useState<{ h: Handle; to: Point } | null>(null);
  // The measure tool's ruler: from `a` to the cursor, or to `b` once fixed.
  const [ruler, setRuler] = useState<{ a: Point; b?: Point } | null>(null);
  /** The dimension the cursor makes from the two points: its offset, and for orthogonal ones the direction. */
  const dimFor = (d: { start: Point; end?: Point; orthogonal: boolean }, c: Point) => {
    const { start, end } = d;
    if (!end) return undefined;
    if (d.orthogonal) {
      // Measure across the way the cursor has been pulled out of the two points' span.
      const outY = c.y < Math.min(start.y, end.y) || c.y > Math.max(start.y, end.y);
      const outX = c.x < Math.min(start.x, end.x) || c.x > Math.max(start.x, end.x);
      const vertical = outX && !outY ? true : outY && !outX ? false : Math.abs(end.y - start.y) > Math.abs(end.x - start.x);
      return { start, end, orthogonal: true, vertical, height: vertical ? c.x - start.x : c.y - start.y };
    }
    const dx = end.x - start.x, dy = end.y - start.y;
    const l = Math.hypot(dx, dy) || 1;
    // KiCad's crossbar sits at start + height × (−dy, dx)/|d|.
    return { start, end, height: ((c.x - start.x) * -dy + (c.y - start.y) * dx) / l };
  };
  // Corners of an outline rectangle or zone polygon being drawn.
  const [shape, setShape] = useState<Point[] | null>(null);
  const gesture = useRef<"drag" | "box" | "handle" | null>(null);
  // Where the button went down on an item, and whether the pointer has left that spot. Until
  // it has, the press is a click: it selects and moves nothing (the same 3 px as panning).
  const pressed = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const leftPress = (e: React.PointerEvent) => {
    const d = pressed.current;
    if (d && !d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 3) d.moved = true;
    return !!d?.moved;
  };

  // Forget picks that no longer exist (after undo, delete…), and leave edit mode cleanly.
  useEffect(() => {
    const ids = new Set([
      ...board.footprints.map((f) => f.uuid),
      ...board.tracks.map((t) => t.uuid),
      ...board.vias.map((v) => v.uuid),
      ...board.zones.map((z) => z.uuid),
      ...board.drawings.flatMap((g) => (g.uuid ? [g.uuid] : [])),
      ...board.texts.flatMap((t) => (t.uuid ? [t.uuid] : [])),
      ...board.textBoxes.map((t) => t.uuid),
      ...board.footprints.flatMap((f) => f.texts.flatMap((t) => (t.uuid ? [t.uuid] : []))),
    ]);
    // Copies just pasted or duplicated become the selection.
    const fresh = pendingPick.current;
    if (fresh) {
      const made = fresh.map((u) => itemFor(board, u)).filter((x): x is BoardItem => !!x);
      if (made.length) {
        pendingPick.current = undefined;
        setPicked(made);
        return;
      }
    }
    // After length tuning replaced the picked track, pick the net's tracks (the panel stays up).
    const tuned = tunedNet.current;
    tunedNet.current = undefined;
    setPicked((p) => {
      if (p.every((i) => ids.has(i.uuid))) return p;
      if (tuned) return board.tracks.filter((t) => t.net === tuned).map((t) => ({ kind: "track" as const, uuid: t.uuid, net: t.net }));
      return p.filter((i) => ids.has(i.uuid));
    });
  }, [board]);
  useEffect(() => {
    if (!editing) {
      setPicked([]);
      setRoute(null);
    }
  }, [editing]);
  useEffect(() => {
    if (tool !== "dimension") setDim(null);
    if (tool !== "measure") setRuler(null);
    if (tool !== "route") {
      setRoute(null);
      setPairMode(false);
    }
    setShape(null);
  }, [tool]);

  /** Screen event → board point (undoing the bottom-view mirror). */
  const toBoard = (e: { clientX: number; clientY: number }): Point => {
    const r = vp.ref.current!.getBoundingClientRect();
    const q = vp.toContent(e.clientX - r.left, e.clientY - r.top);
    return flipped ? { x: 2 * cx - q.x, y: q.y } : q;
  };
  const tol = () => 3 / vp.view.scale;
  // For the end-to-end scripts: where a screen point is on the board.
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__crossprobeBoardView = { toBoard: (x: number, y: number) => toBoard({ clientX: x, clientY: y }) };

  // Net class defaults for routing, and the rules for live clearance checks.
  const classOf = (net: string) => netClasses[net] ?? netClasses[""];
  const widthFor = (net: string) => (edit?.trackWidth ? edit.trackWidth : (classOf(net)?.trackWidth ?? 0.25));
  /** The span and kind of a via joining layers a and b, by the via type chosen (through vias span the stack). */
  const viaLayers = (a?: string, b?: string): { layers: [string, string]; type?: "blind" | "buried" | "micro" } => {
    const cu = board.copperLayers;
    const through = { layers: [cu[0]!, cu.at(-1)!] as [string, string] };
    const kind = edit?.viaType ?? "through";
    if (kind === "through" || !a || !b || a === b) return through;
    const [i, j] = [cu.indexOf(a), cu.indexOf(b)].sort((x, y) => x - y) as [number, number];
    if (i < 0 || (i === 0 && j === cu.length - 1)) return through;
    const outer = i === 0 || j === cu.length - 1;
    // A microvia joins an outer layer to the next one only (KiCad's rule); else it's blind/buried.
    const type = kind === "micro" && outer && j - i === 1 ? "micro" : outer ? "blind" : "buried";
    return { layers: [cu[i]!, cu[j]!], type };
  };
  const viaFor = (net: string) => edit?.via ?? { size: classOf(net)?.viaDiameter ?? 0.8, drill: classOf(net)?.viaDrill ?? 0.4 };
  const rules = useMemo<DesignRules | undefined>(
    () =>
      designRules && {
        minClearance: designRules.minClearance,
        copperEdgeClearance: designRules.copperEdgeClearance,
        classes: new Map(designRules.classes.map((c) => [c.name, c])),
        patterns: designRules.patterns,
        assignments: new Map(Object.entries(designRules.assignments)),
      },
    [designRules],
  );
  const copper = useMemo(() => (editing ? copperItems(board) : []), [board, editing]);
  // Zones are refilled around new tracks, so routing doesn't treat them as obstacles.
  const solidCopper = useMemo(() => copper.filter((c) => c.item.kind !== "zone"), [copper]);

  // Routing mode (W cycles): walkaround finds a way around other nets' copper; shove goes
  // around pads and vias but pushes other nets' tracks aside; straight is KiCad's 45° posture.
  const [mode, setMode] = useState<"walkaround" | "shove" | "straight">("walkaround");
  // Differential pairs (6): the route tool routes the pair as one centreline.
  const [pairMode, setPairMode] = useState(false);
  const [pairNote, setPairNote] = useState<string>();
  // What the route may not touch: a pair's centreline ignores its partner's copper but not the pads it starts from.
  const routeCopper = useMemo(() => (route?.pair ? pairObstacles(copper, route.net, route.pair.net, route.pair.ends) : copper), [copper, route?.pair?.net]); // eslint-disable-line react-hooks/exhaustive-deps
  const routeSolid = useMemo(() => routeCopper.filter((c) => c.item.kind !== "zone"), [routeCopper]);
  const router = useMemo(
    () => (route && rules && mode !== "straight" ? new InteractiveRouter(board, rules, routeCopper, route.net, route.width) : undefined),
    // A new router per route (net and width), and when the board changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board, rules, routeCopper, mode, route?.net, route?.width],
  );
  // Pairs don't shove (yet): they walk around.
  const shoving = mode === "shove" && !route?.pair;
  const tails = useRef(new Map<string, Point[]>());
  useEffect(() => tails.current.clear(), [router]);
  /** The path from a fixed corner to `to` on `layer`: around obstacles when walkaround is on, else KiCad's 45° posture. */
  const tail = (from: Point, to: Point, layer: string): Point[] => {
    const straight = route45(from, to, route?.diagonalFirst ?? false);
    if (!router) return straight;
    const key = `${mode}|${route?.pair ? "pair" : ""}|${layer}|${from.x},${from.y}|${to.x},${to.y}`;
    let p = tails.current.get(key);
    if (!p) {
      // The plain 45° posture when it's clear (of what this mode can't push), else a path around.
      const blocking = (pts: Point[]) =>
        pts.some((q, i) => i > 0 && trackConflicts(routeSolid, rules!, { a: pts[i - 1]!, b: q, width: route!.width, layer, net: route!.net }).some((h) => !(shoving && h.with.kind === "track")));
      p = !blocking(straight) ? straight : (router.path(from, to, layer, { throughTracks: shoving }) ?? straight);
      if (tails.current.size > 200) tails.current.clear();
      tails.current.set(key, p);
    }
    return p;
  };

  // Dev-only hook for browser tests: board mm → client pixels.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__boardView = {
      toClient: (p: Point) => {
        const r = vp.ref.current!.getBoundingClientRect();
        const x = flipped ? 2 * cx - p.x : p.x;
        return { x: r.left + x * vp.view.scale + vp.view.tx, y: r.top + p.y * vp.view.scale + vp.view.ty };
      },
      /** What a click at a board point would pick. */
      pick: (p: Point) => pickItem(board, p, tol(), visible),
      /** Frame a board area (mm). */
      frame: (box: { x: number; y: number; w: number; h: number }) => vp.fit(mirror(box)),
    };
  }

  // Frame the selection when it was picked outside the view (inspector, lists).
  useEffect(() => {
    if (!focusToken || !selection) return;
    if (selection.kind === "marker") {
      if (selection.sheet === "board") vp.focus(mirror({ x: selection.at.x - 2, y: selection.at.y - 2, w: 4, h: 4 }));
      return;
    }
    const pts =
      selection.kind === "component"
        ? (board.footprints.find((f) => f.reference === selection.reference)?.pads.map((p) => p.at) ?? [])
        : [
            ...board.footprints.flatMap((f) => f.pads.filter((p) => p.net === selection.name).map((p) => p.at)),
            ...board.tracks.filter((t) => t.net === selection.name).flatMap((t) => [t.start, t.end]),
          ];
    if (!pts.length) return;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const b = { x: Math.min(...xs) - 3, y: Math.min(...ys) - 3, w: Math.max(...xs) - Math.min(...xs) + 6, h: Math.max(...ys) - Math.min(...ys) + 6 };
    if (selection.kind === "component") vp.focus(mirror(b));
    else vp.fit(mirror(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]); // not on edits: they must not re-frame the view

  // ---- Edit operations -----------------------------------------------------

  const selectionCenter = (): Point => {
    const pts = picked.map((i) => {
      if (i.kind === "footprint") return board.footprints.find((f) => f.uuid === i.uuid)!.at;
      if (i.kind === "via") return board.vias.find((v) => v.uuid === i.uuid)!.at;
      if (i.kind === "text") return board.texts.find((t) => t.uuid === i.uuid)?.at ?? board.textBoxes.find((t) => t.uuid === i.uuid)?.corners[0] ?? { x: 0, y: 0 };
      if (i.kind === "fptext") return board.footprints.find((f) => f.uuid === i.footprint)?.texts.find((t) => t.uuid === i.uuid)?.at ?? { x: 0, y: 0 };
      if (i.kind === "zone" || i.kind === "graphic") {
        const pts = i.kind === "zone" ? board.zones.find((z) => z.uuid === i.uuid)!.outline : board.drawings.find((g) => g.uuid === i.uuid)!.points;
        return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
      }
      const t = board.tracks.find((t) => t.uuid === i.uuid)!;
      return { x: (t.start.x + t.end.x) / 2, y: (t.start.y + t.end.y) / 2 };
    });
    const c = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
    return snap(c, edit!.grid);
  };

  const finishRoute = (r: Route | null, end?: Point, pairEnds?: { endP: Point; endN: Point; escape: Point }): "crossed" | void => {
    if (!r || !edit) return setRoute(null);
    const runs = r.runs.map((run) => ({ ...run, points: [...run.points] }));
    const lastRun = runs.at(-1)!;
    // A pair arrives through its escape point, straight into the gap between its pads.
    if (pairEnds) lastRun.points.push(...tail(lastRun.points.at(-1)!, pairEnds.escape, lastRun.layer).slice(1));
    if (end) lastRun.points.push(...(pairEnds ? [end] : tail(lastRun.points.at(-1)!, end, lastRun.layer).slice(1)));
    const ops: EditOp[] = [];
    if (r.pair) {
      // The centreline becomes the pair's two tracks, and each layer change a pair of vias.
      const pair = coupledRoute(runs, r.pair.width, r.pair.gap, r.pair.viaPitch, { startP: r.pair.startP, startN: r.pair.startN, ...(pairEnds && { endP: pairEnds.endP, endN: pairEnds.endN }) });
      if (pair.crossed) return "crossed";
      for (const t of pair.tracks) if (t.points.length > 1) ops.push({ op: "addTrack", file: edit.file, points: t.points, width: r.pair.width, layer: t.layer, net: t.side === "p" ? r.net : r.pair.net });
      const layers: [string, string] = [board.copperLayers[0]!, board.copperLayers.at(-1)!];
      for (const v of pair.vias) for (const [at, net] of [[v.p, r.net], [v.n, r.pair.net]] as const) ops.push({ op: "addVia", file: edit.file, at, size: r.pair.via.size, drill: r.pair.via.drill, layers, net });
      if (ops.length) edit.onEdit(ops);
      setPairNote(undefined);
      return setRoute(null);
    }
    // Shove: the pushed tracks move in the same edit (one undo step).
    const pushed = shoving && router ? router.shove(runs) : undefined;
    if (pushed?.remove.length) {
      ops.push({ op: "boardDelete", file: edit.file, uuids: pushed.remove });
      for (const a of pushed.add) ops.push({ op: "addTrack", file: edit.file, points: a.points, width: a.width, layer: a.layer, net: a.net });
    }
    for (const run of runs) if (run.points.length > 1) ops.push({ op: "addTrack", file: edit.file, points: run.points, width: r.width, layer: run.layer, net: r.net });
    const via = viaFor(r.net);
    r.vias.forEach((v, i) => {
      const span = viaLayers(r.runs[i]?.layer, r.runs[i + 1]?.layer);
      ops.push({ op: "addVia", file: edit.file, at: v, size: via.size, drill: via.drill, layers: span.layers, type: span.type, net: r.net });
    });
    if (ops.length) edit.onEdit(ops);
    setRoute(null);
  };

  /** Finish the polygon being drawn (at least three distinct corners): a zone, or a polygon board outline. */
  const finishZone = (pts: Point[] | null) => {
    setShape(null);
    if (!pts || !edit) return;
    const corners = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) > 1e-9);
    if (corners.length > 1 && Math.hypot(corners[0]!.x - corners.at(-1)!.x, corners[0]!.y - corners.at(-1)!.y) < 1e-9) corners.pop();
    if (corners.length < 3) return;
    if (tool === "outline") return edit.onEdit([{ op: "addBoardShape", file: edit.file, shape: { kind: "poly", points: corners, layer: "Edge.Cuts", width: 0.05 } }]);
    edit.onEdit([
      { op: "addZone", file: edit.file, zone: { net: edit.zoneNet, layers: [edit.layer], outline: corners } },
      { op: "refillZones", file: edit.file },
    ]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      // The symbol or footprint editor open over the board has its own keys.
      if (document.querySelector(".fp-editor")) return;
      if (editing && (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "m") {
        // KiCad's measure tool.
        e.preventDefault();
        edit!.onTool(tool === "measure" ? "select" : "measure");
        return;
      }
      if (editing && (e.metaKey || e.ctrlKey) && tool === "select" && !e.altKey) {
        // KiCad's copy, paste and duplicate (copies keep their nets; footprints get the next reference).
        const k = e.key.toLowerCase();
        const ed = edit!;
        const copy = (uuids: string[], dx: number, dy: number) => {
          const fresh = uuids.map(() => crypto.randomUUID());
          pendingPick.current = fresh;
          ed.onEdit([{ op: "boardDuplicate", file: ed.file, uuids, fresh, dx, dy }]);
        };
        if (k === "c" && picked.length) {
          e.preventDefault();
          clipboard.current = { uuids: picked.map((p) => p.uuid), at: selectionCenter() };
          setNote(`Copied ${picked.length} item${picked.length > 1 ? "s" : ""}`);
        } else if (k === "v" && clipboard.current) {
          e.preventDefault();
          const at = cursor ? snap(cursor, ed.grid) : { x: clipboard.current.at.x + 5 * ed.grid, y: clipboard.current.at.y + 5 * ed.grid };
          copy(clipboard.current.uuids, at.x - clipboard.current.at.x, at.y - clipboard.current.at.y);
        } else if (k === "g" && picked.length) {
          // KiCad's Group (Ctrl+G) and Ungroup (Ctrl+Shift+G).
          e.preventDefault();
          if (e.shiftKey) ungroupSelection();
          else groupSelection();
        } else if (k === "t" && picked.length) {
          // KiCad's Create Array.
          e.preventDefault();
          openArray();
        } else if (k === "d" && picked.length) {
          e.preventDefault();
          const step = Math.max(ed.grid, 1);
          copy(picked.map((p) => p.uuid), flipped ? -step : step, step);
        }
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      if (!editing) {
        if (e.key === "f") vp.fit(mirror(scene.bbox));
        return;
      }
      const ed = edit!;
      // What keys move, rotate, flip or delete: everything picked but locked items.
      const uuids = withGroupExtras(picked.map((p) => p.uuid).filter((u) => !lockedIds.has(u)));
      const key = e.key.toLowerCase();
      if (shape && (e.key === "Enter" || e.key === "Escape")) {
        if ((tool === "zone" || (tool === "outline" && ed.outlineMode === "poly")) && e.key === "Enter") finishZone(shape);
        else setShape(null);
      } else if (shape && e.key === "Backspace") {
        setShape(shape.length > 1 ? shape.slice(0, -1) : null);
      } else if (dim && e.key === "Escape") {
        setDim(null);
      } else if (key === "o" && tool === "dimension") {
        setDim((d) => (d ? { ...d, orthogonal: !d.orthogonal } : d));
      } else if (e.key === "Escape") {
        if (route) finishRoute(route);
        else if (ed.tool !== "select") ed.onTool("select");
        else setPicked([]);
      } else if (e.key === "Home") vp.fit(mirror(scene.bbox));
      else if (key === "p" && e.shiftKey && picked.length) openPosRel();
      else if (key === "x") ed.onTool("route");
      else if (key === "b" && !route) ed.onEdit([{ op: "refillZones", file: ed.file }]);
      else if (key === "a" && !route) {
        // Don't let the key land in the picker's search box that opens.
        e.preventDefault();
        ed.onTool("footprint");
      }
      else if (key === "6") {
        // KiCad's differential-pair router.
        if (tool !== "route") ed.onTool("route");
        if (!route) setPairMode((m) => (tool === "route" ? !m : true));
        setPairNote(undefined);
      } else if (key === "v" && route && cursor) {
        // Drop a via at the cursor and continue on the other side.
        const last = route.runs.at(-1)!;
        const pts = tail(last.points.at(-1)!, cursor, last.layer).slice(1);
        const copper = board.copperLayers;
        const next = last.layer === copper[0] ? copper.at(-1)! : copper[0]!;
        setRoute({ ...route, runs: [...route.runs.slice(0, -1), { ...last, points: [...last.points, ...pts] }, { layer: next, points: [cursor] }], vias: [...route.vias, cursor] });
        ed.onLayer(next);
      } else if (key === "v" && !route) ed.onTool("via");
      else if (key === "/" && route) setRoute({ ...route, diagonalFirst: !route.diagonalFirst });
      else if (key === "m" && tool === "route") setMode((m) => (m === "walkaround" ? "shove" : m === "shove" ? "straight" : "walkaround"));
      else if (key === "w" && tool === "route") {
        // KiCad's W / Shift+W: the next / previous track width (0 = the net class's).
        const widths = trackWidths(board);
        const cur = route && !route.pair ? route.width : ed.trackWidth;
        const i = widths.findIndex((w) => w > cur + 1e-9);
        const next = e.shiftKey ? [...widths].reverse().find((w) => w < cur - 1e-9) ?? widths[0]! : i < 0 ? widths.at(-1)! : widths[i]!;
        ed.onTrackWidth?.(next);
        if (route && !route.pair) setRoute({ ...route, width: next });
        setNote(`Track width ${next} mm`);
      } else if (e.key === "PageUp" || e.key === "PageDown") {
        // KiCad's PgUp / PgDn: front / back copper (while routing, through a via).
        e.preventDefault();
        const copper = board.copperLayers;
        const target = e.key === "PageUp" ? copper[0]! : copper.at(-1)!;
        const last = route?.runs.at(-1);
        if (route && cursor && last && last.layer !== target) {
          const pts = tail(last.points.at(-1)!, cursor, last.layer).slice(1);
          setRoute({ ...route, runs: [...route.runs.slice(0, -1), { ...last, points: [...last.points, ...pts] }, { layer: target, points: [cursor] }], vias: [...route.vias, cursor] });
        }
        ed.onLayer(target);
      } else if (key === "n" && !route) {
        // KiCad's N / Shift+N: the next / previous grid.
        const i = GRIDS.findIndex((g) => Math.abs(g - ed.grid) < 1e-9);
        const next = GRIDS[Math.min(GRIDS.length - 1, Math.max(0, (i < 0 ? 2 : i) + (e.shiftKey ? -1 : 1)))]!;
        ed.onGrid?.(next);
        setNote(`Grid ${next} mm`);
      } else if (key === "t" && !route) {
        // KiCad's T: find a footprint by reference.
        e.preventDefault();
        const ref = window.prompt("Footprint reference (e.g. R12)")?.trim();
        const fp = ref ? board.footprints.find((f) => f.reference.toLowerCase() === ref.toLowerCase()) : undefined;
        if (ref && !fp) setNote(`No footprint ${ref}`);
        if (fp) {
          if (ed.tool !== "select") ed.onTool("select");
          select([{ kind: "footprint", uuid: fp.uuid, reference: fp.reference }], false);
          const b = footprintBox(fp);
          vp.focus(mirror({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 }));
        }
      } else if (key === "l" && picked.length && !route) {
        // KiCad's L: lock / unlock (footprints, tracks, vias).
        // Grouped items lock through their group, as in KiCad.
        const groups = pickedGroups();
        const inGroups = new Set(groups.flatMap((g) => groupItems(board, g)));
        const lockable = [...groups, ...picked.filter((p) => !inGroups.has(p.uuid) && (p.kind === "footprint" || p.kind === "track" || p.kind === "via")).map((p) => p.uuid)];
        const anyUnlocked = lockable.some((u) => (board.groups.some((g) => g.uuid === u) ? !board.groups.find((g) => g.uuid === u)!.locked : !lockedIds.has(u)));
        // Unlocking a group also unlocks the footprints, tracks and vias in it locked on their own.
        const own = anyUnlocked ? [] : [...board.footprints, ...board.tracks, ...board.vias].filter((x) => x.locked && inGroups.has(x.uuid)).map((x) => x.uuid);
        if (lockable.length) ed.onEdit([{ op: "setLocked", file: ed.file, uuids: [...lockable, ...own], locked: anyUnlocked }]);
        setNote(anyUnlocked ? "Locked" : "Unlocked");
      }
      else if (e.key === "Backspace" && route) {
        // Undo the last fixed vertex of the route.
        const last = route.runs.at(-1)!;
        if (last.points.length > 1) setRoute({ ...route, runs: [...route.runs.slice(0, -1), { ...last, points: last.points.slice(0, -1) }] });
        else setRoute(null);
      } else if (key === "u" && picked.some((p) => p.kind === "track" || p.kind === "via")) {
        // Select the whole trace (KiCad's U).
        setPicked(connectedTrace(board, picked));
      } else if (!uuids.length) {
        // Nothing movable picked: locked items stay put (unlock with L).
        if (picked.length && (key === "r" || key === "f" || e.key === "Delete" || e.key === "Backspace" || e.key.startsWith("Arrow"))) setNote("Locked: unlock with L to change it");
        else if (key === "f") vp.fit(mirror(scene.bbox));
      } else if (key === "r") {
        const single = picked.length === 1 && picked[0]!.kind === "footprint";
        ed.onEdit([{ op: "boardRotate", file: ed.file, uuids, deg: e.shiftKey ? -90 : 90, center: single ? undefined : selectionCenter() }]);
      } else if (key === "f") {
        const fps = picked.filter((p) => p.kind === "footprint" && !lockedIds.has(p.uuid)).map((p) => p.uuid);
        if (fps.length) ed.onEdit([{ op: "boardFlip", file: ed.file, uuids: fps, centerX: fps.length > 1 ? selectionCenter().x : undefined }]);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        ed.onEdit([{ op: "boardDelete", file: ed.file, uuids }]);
        setPicked([]);
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const g = ed.grid;
        const [dx, dy] = { ArrowLeft: [-g, 0], ArrowRight: [g, 0], ArrowUp: [0, -g], ArrowDown: [0, g] }[e.key as "ArrowLeft"]!;
        ed.onEdit([{ op: "boardMove", file: ed.file, uuids, dx: flipped ? -dx! : dx!, dy: dy! }]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** The route being drawn, up to the cursor. */
  const pending = useMemo(() => {
    if (!route || !cursor) return undefined;
    const last = route.runs.at(-1)!;
    return [...route.runs.slice(0, -1), { ...last, points: [...last.points, ...tail(last.points.at(-1)!, cursor, last.layer).slice(1)] }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, cursor, router, mode]);
  // Shove preview: which tracks the route pushes, and where to.
  const pushed = useMemo(() => (shoving && router && pending ? router.shove(pending) : undefined), [shoving, router, pending]);
  /** The pair's two tracks up to the cursor. */
  const pendingPair = useMemo(() => (route?.pair && pending ? coupledRoute(pending, route.pair.width, route.pair.gap, route.pair.viaPitch, { startP: route.pair.startP, startN: route.pair.startN }) : undefined), [route, pending]);

  // Live clearance check of the route being drawn (a successful shove has cleared it).
  const conflicts = useMemo(() => {
    if (!route || !cursor || !rules || pushed) return [];
    if (route.pair && pendingPair) {
      const out: ReturnType<typeof trackConflicts> = [];
      const netOf = (side: "p" | "n") => (side === "p" ? route.net : route.pair!.net);
      for (const t of pendingPair.tracks)
        for (let i = 1; i < t.points.length; i++) out.push(...trackConflicts(solidCopper, rules, { a: t.points[i - 1]!, b: t.points[i]!, width: route.pair.width, layer: t.layer, net: netOf(t.side) }));
      for (const v of pendingPair.vias)
        for (const [at, side] of [[v.p, "p"], [v.n, "n"]] as const)
          for (const layer of board.copperLayers) out.push(...trackConflicts(solidCopper, rules, { a: at, b: at, width: route.pair.via.size, layer, net: netOf(side) }));
      return out;
    }
    const last = route.runs.at(-1)!;
    const pts = [...last.points, ...tail(last.points.at(-1)!, cursor, last.layer).slice(1)];
    const out: ReturnType<typeof trackConflicts> = [];
    const solid = solidCopper;
    for (const run of route.runs.slice(0, -1)) {
      for (let i = 1; i < run.points.length; i++) out.push(...trackConflicts(solid, rules, { a: run.points[i - 1]!, b: run.points[i]!, width: route.width, layer: run.layer, net: route.net }));
    }
    for (let i = 1; i < pts.length; i++) out.push(...trackConflicts(solid, rules, { a: pts[i - 1]!, b: pts[i]!, width: route.width, layer: last.layer, net: route.net }));
    return out;
  }, [route, cursor, rules, solidCopper, pushed, pendingPair]);
  const cursorNet = tool === "via" && cursor ? (board.vias.find((v) => Math.hypot(cursor.x - v.at.x, cursor.y - v.at.y) < 1e-6)?.net ?? padAt(board, cursor, 1e-6)?.pad.net) : undefined;

  // ---- Drawing ---------------------------------------------------------------

  useEffect(() => {
    const c = canvas.current;
    const el = vp.ref.current;
    if (!c || !el) return;
    let frame = 0;
    const draw = () => {
      const { width, height } = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) {
        c.width = Math.round(width * dpr);
        c.height = Math.round(height * dpr);
      }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, c.width, c.height);
      const { scale, tx, ty } = vp.view;
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * tx, dpr * ty);
      if (flipped) ctx.transform(-1, 0, 0, 1, 2 * cx, 0);
      // KiCad's grid dots while editing: the snap grid, or a multiple of it when zoomed out.
      if (editing && edit) {
        const step = edit.grid * Math.max(1, Math.ceil(8 / (edit.grid * scale)));
        const xa = -tx / scale, xb = (width - tx) / scale;
        const [x0, x1] = flipped ? [2 * cx - xb, 2 * cx - xa] : [xa, xb];
        const y0 = -ty / scale, y1 = (height - ty) / scale;
        const r = 1 / scale;
        ctx.fillStyle = "rgba(160, 170, 190, 0.35)";
        ctx.beginPath();
        for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step)
          for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) ctx.rect(x - r / 2, y - r / 2, r, r);
        ctx.fill();
      }
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      // The visible area (mm), for net names on tracks and pads once they're big enough to read.
      const xa = -tx / scale, xb = (width - tx) / scale;
      const view = { x0: flipped ? 2 * cx - xb : xa, x1: flipped ? 2 * cx - xa : xb, y0: -ty / scale, y1: (height - ty) / scale };
      const trackLabels = (layer: string) => layer.endsWith(".Cu") && drawTrackLabels(ctx, board, scale, flipped, visible, view, layer);
      if (pageFrame && visible.has("Drawing Sheet")) drawFrame(ctx, pageFrame, scale);
      drawScene(ctx, scene, visible, scale, overlay ? 0.28 : 1, false, flipped, overlay ? undefined : trackLabels);
      if (overlay) drawScene(ctx, overlay, visible, scale, 1, true, flipped, trackLabels);
      if (visible.has("Vias")) drawViaLabels(ctx, board, scale, flipped, view);
      // The selected pad (view mode) or the pad a footprint was picked by (edit mode), outlined.
      {
        const sel: Array<{ ref: string; pad: string }> = [];
        if (!editing && selection?.kind === "component" && selection.pad !== undefined) sel.push({ ref: selection.reference, pad: selection.pad });
        if (editing) for (const it of picked) if (it.kind === "footprint" && it.pad !== undefined) sel.push({ ref: it.reference, pad: it.pad });
        if (sel.length) {
          const outline = new Path2D();
          for (const s of sel) for (const q of board.footprints.find((f) => f.reference === s.ref)?.pads.filter((q) => q.number === s.pad) ?? []) padPath(outline, q);
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2 / scale;
          ctx.stroke(outline);
        }
      }
      drawPadLabels(ctx, board, scale, flipped, visible, view);
      if (visible.has("Ratsnest") && ratsnest.length) {
        // Thin lines between the closest unconnected items, as in KiCad.
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.2 / scale;
        // While dragging, ends on moved footprints follow them.
        const moving = drag && !drag.committed ? new Set(board.footprints.filter((f) => pickedIds.has(f.uuid)).map((f) => f.reference)) : undefined;
        const end = (e: { at: Point; reference?: string }) => (moving && e.reference && moving.has(e.reference) ? { x: e.at.x + drag!.d.x, y: e.at.y + drag!.d.y } : e.at);
        for (const r of ratsnest) {
          const hl = (selection?.kind === "net" && selection.name === r.net) || route?.net === r.net;
          ctx.strokeStyle = hl ? "#ffb347" : "#e8e8e8";
          const a = end(r.a);
          const b = end(r.b);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      // DRC markers: a ring with a cross, constant size on screen.
      if (drc.length) {
        const s = 7 / scale;
        ctx.lineWidth = 1.6 / scale;
        for (const v of drc) {
          const active = selection?.kind === "marker" && selection.sheet === "board" && selection.at.x === v.at.x && selection.at.y === v.at.y;
          ctx.strokeStyle = active ? "#ffffff" : "#ff4d4f";
          ctx.beginPath();
          ctx.arc(v.at.x, v.at.y, s, 0, Math.PI * 2);
          ctx.moveTo(v.at.x - s * 0.6, v.at.y - s * 0.6);
          ctx.lineTo(v.at.x + s * 0.6, v.at.y + s * 0.6);
          ctx.moveTo(v.at.x + s * 0.6, v.at.y - s * 0.6);
          ctx.lineTo(v.at.x - s * 0.6, v.at.y + s * 0.6);
          ctx.stroke();
        }
      }
      if (editing) {
        const liveDrag = drag && (!drag.committed || drag.committed === board) ? drag : null;
        if (!liveDrag?.committed) drawSelection(ctx, board, pickedIds, scale);
        if (liveDrag) {
          ctx.globalAlpha = 0.8;
          drawSelection(ctx, board, pickedIds, scale, liveDrag.d);
          ctx.globalAlpha = 1;
        }
        if (box) {
          ctx.strokeStyle = "#7fb2ff";
          ctx.fillStyle = "rgba(127,178,255,0.12)";
          ctx.lineWidth = 1 / scale;
          const x = Math.min(box.a.x, box.b.x);
          const y = Math.min(box.a.y, box.b.y);
          ctx.fillRect(x, y, Math.abs(box.b.x - box.a.x), Math.abs(box.b.y - box.a.y));
          ctx.strokeRect(x, y, Math.abs(box.b.x - box.a.x), Math.abs(box.b.y - box.a.y));
        }
        if (route?.pair && pendingPair) {
          // The pair's two tracks and vias, with the centreline faintly between them.
          ctx.globalAlpha = 0.85;
          ctx.lineWidth = route.pair.width;
          for (const t of pendingPair.tracks) {
            ctx.strokeStyle = layerColor(t.layer, board.copperLayers);
            ctx.beginPath();
            t.points.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
            ctx.stroke();
          }
          ctx.fillStyle = "#d8d8d8";
          for (const v of pendingPair.vias)
            for (const at of [v.p, v.n]) {
              ctx.beginPath();
              ctx.arc(at.x, at.y, route.pair.via.size / 2, 0, Math.PI * 2);
              ctx.fill();
            }
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1 / scale;
          ctx.setLineDash([4 / scale, 4 / scale]);
          for (const run of pending!) {
            ctx.beginPath();
            run.points.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
            ctx.stroke();
          }
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        } else if (route) {
          const copper = board.copperLayers;
          route.runs.forEach((run, i) => {
            const pts = [...run.points];
            if (i === route.runs.length - 1 && cursor) pts.push(...tail(pts.at(-1)!, cursor, run.layer).slice(1));
            ctx.strokeStyle = layerColor(run.layer, copper);
            ctx.globalAlpha = 0.85;
            ctx.lineWidth = route.width;
            ctx.beginPath();
            pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.stroke();
            ctx.globalAlpha = 1;
          });
          if (pushed?.remove.length) {
            // Where the pushed tracks were (dimmed), and where they go.
            ctx.strokeStyle = "rgba(10, 12, 20, 0.75)";
            for (const t of board.tracks.filter((t) => pushed.remove.includes(t.uuid))) {
              ctx.lineWidth = t.width + 0.02;
              ctx.beginPath();
              ctx.moveTo(t.start.x, t.start.y);
              ctx.lineTo(t.end.x, t.end.y);
              ctx.stroke();
            }
            for (const a of pushed.add) {
              ctx.strokeStyle = layerColor(a.layer, copper);
              ctx.globalAlpha = 0.85;
              ctx.lineWidth = a.width;
              ctx.beginPath();
              a.points.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
              ctx.stroke();
              ctx.globalAlpha = 1;
            }
          }
          ctx.fillStyle = "#d8d8d8";
          for (const v of route.vias) {
            ctx.beginPath();
            ctx.arc(v.x, v.y, viaFor(route.net).size / 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        if (ruler && tool === "measure" && (ruler.b || cursor)) {
          const a = ruler.a, b = ruler.b ?? cursor!;
          const dx = b.x - a.x, dy = b.y - a.y;
          ctx.strokeStyle = ctx.fillStyle = "#ffd75e";
          ctx.lineWidth = 1.5 / scale;
          ctx.setLineDash([6 / scale, 4 / scale]);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.setLineDash([]);
          for (const q of [a, b]) {
            ctx.beginPath();
            ctx.arc(q.x, q.y, 3 / scale, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.save();
          ctx.translate(b.x, b.y);
          if (flipped) ctx.scale(-1, 1);
          ctx.font = `${13 / scale}px "Helvetica Neue", Arial, sans-serif`;
          ctx.textBaseline = "bottom";
          ctx.fillText(`${Math.hypot(dx, dy).toFixed(3)} mm  (dx ${(flipped ? -dx : dx).toFixed(3)}, dy ${dy.toFixed(3)})`, 8 / scale, -6 / scale);
          ctx.restore();
        }
        if (dim && cursor && tool === "dimension") {
          ctx.strokeStyle = ctx.fillStyle = "#c2c2c2";
          ctx.lineWidth = Math.max(0.1, 1 / scale);
          ctx.beginPath();
          const d = dimFor(dim, cursor);
          if (!d) {
            ctx.moveTo(dim.start.x, dim.start.y);
            ctx.lineTo(cursor.x, cursor.y);
          } else {
            const g = dimensionGeometry({ type: d.orthogonal ? "orthogonal" : "aligned", start: d.start, end: d.end, height: d.height, vertical: "vertical" in d ? d.vertical : false });
            for (const [a, b] of g.lines) {
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
            }
            if (g.crossbar) {
              const [cs, ce] = g.crossbar;
              const value = Math.hypot(ce.x - cs.x, ce.y - cs.y);
              ctx.save();
              ctx.translate((cs.x + ce.x) / 2, (cs.y + ce.y) / 2);
              if (flipped) ctx.scale(-1, 1);
              ctx.font = `1px "Helvetica Neue", Arial, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "bottom";
              ctx.fillText(`${value.toFixed(2)} mm`, 0, -0.3);
              ctx.restore();
            }
          }
          ctx.stroke();
        }
        if (shape && cursor) {
          const pts = tool === "outline" && edit!.outlineMode === "rect" ? [shape[0]!, { x: cursor.x, y: shape[0]!.y }, cursor, { x: shape[0]!.x, y: cursor.y }] : [...shape, cursor];
          ctx.strokeStyle = tool === "outline" ? "#e6e600" : layerColor(edit!.layer, board.copperLayers);
          ctx.fillStyle = tool === "outline" ? "rgba(230, 230, 0, 0.06)" : "rgba(120, 160, 255, 0.12)";
          ctx.lineWidth = 1.5 / scale;
          ctx.setLineDash([6 / scale, 4 / scale]);
          ctx.beginPath();
          pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.setLineDash([]);
        }
        {
          // Selected groups: a dashed box around each (KiCad draws their bounding box).
          const ids = new Set(picked.map((p) => p.uuid));
          for (const g of board.groups) {
            const items = groupItems(board, g.uuid);
            if (!items.length || topGroup(board, g.uuid) || !pickedWhole(g.uuid, ids)) continue;
            const boxes = items.map((u) => boardItemBox(board, u)).filter((b): b is NonNullable<typeof b> => !!b);
            if (!boxes.length) continue;
            const d = drag ? drag.d : { x: 0, y: 0 };
            const x0 = Math.min(...boxes.map((b) => b.x0)) + d.x, y0 = Math.min(...boxes.map((b) => b.y0)) + d.y;
            const x1 = Math.max(...boxes.map((b) => b.x1)) + d.x, y1 = Math.max(...boxes.map((b) => b.y1)) + d.y;
            ctx.strokeStyle = g.locked ? "rgba(255, 170, 60, 0.9)" : "rgba(255, 255, 255, 0.75)";
            ctx.lineWidth = 1 / scale;
            ctx.setLineDash([4 / scale, 3 / scale]);
            ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
            ctx.setLineDash([]);
            if (g.name) {
              ctx.fillStyle = ctx.strokeStyle;
              ctx.font = `${11 / scale}px sans-serif`;
              ctx.textBaseline = "bottom";
              ctx.fillText(g.name, x0, y0 - 2 / scale);
            }
          }
        }
        if (tool === "textbox" && boxCorner && cursor) {
          // The text box being drawn.
          ctx.strokeStyle = "#e6e600";
          ctx.lineWidth = 1 / scale;
          ctx.setLineDash([5 / scale, 3 / scale]);
          ctx.strokeRect(Math.min(boxCorner.x, cursor.x), Math.min(boxCorner.y, cursor.y), Math.abs(cursor.x - boxCorner.x), Math.abs(cursor.y - boxCorner.y));
          ctx.setLineDash([]);
        }
        if (pointShape) {
          // The point editor: the shape being edited, and its handles (KiCad's squares).
          const live = ptDrag ? dragHandle(pointShape, ptDrag.h, ptDrag.to) : pointShape.points;
          const shown = { ...pointShape, points: live };
          if (ptDrag) {
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1 / scale;
            ctx.setLineDash([5 / scale, 3 / scale]);
            ctx.beginPath();
            if (shown.kind === "circle") {
              const [c, r] = live as [Point, Point];
              ctx.arc(c.x, c.y, Math.hypot(r.x - c.x, r.y - c.y), 0, Math.PI * 2);
            } else {
              const pts = shown.kind === "rect" ? [live[0]!, { x: live[1]!.x, y: live[0]!.y }, live[1]!, { x: live[0]!.x, y: live[1]!.y }] : live;
              pts.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
              if (shown.kind !== "line" && shown.kind !== "arc") ctx.closePath();
            }
            ctx.stroke();
            ctx.setLineDash([]);
          }
          const hs = 4 / scale;
          for (const h of handles(shown)) {
            ctx.fillStyle = h.type === "edge" ? "rgba(255, 255, 255, 0.55)" : "#ffffff";
            ctx.strokeStyle = "#202020";
            ctx.lineWidth = 1 / scale;
            const k = h.type === "edge" ? hs * 0.75 : hs;
            ctx.fillRect(h.at.x - k, h.at.y - k, 2 * k, 2 * k);
            ctx.strokeRect(h.at.x - k, h.at.y - k, 2 * k, 2 * k);
          }
        }
        if (conflicts.length) {
          ctx.fillStyle = "rgba(255, 77, 79, 0.85)";
          for (const c of conflicts) {
            ctx.beginPath();
            ctx.arc(c.at.x, c.at.y, Math.max(route?.width ?? 0.2, 4 / scale), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        if (cursor && tool !== "select") {
          // Small crosshair at the snapped cursor.
          const s = 6 / scale;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1 / scale;
          ctx.beginPath();
          ctx.moveTo(cursor.x - s, cursor.y);
          ctx.lineTo(cursor.x + s, cursor.y);
          ctx.moveTo(cursor.x, cursor.y - s);
          ctx.lineTo(cursor.x, cursor.y + s);
          ctx.stroke();
          if (tool === "via") {
            ctx.strokeStyle = "#d8d8d8";
            ctx.beginPath();
            ctx.arc(cursor.x, cursor.y, viaFor(cursorNet ?? "").size / 2, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    };
    frame = requestAnimationFrame(draw);
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [scene, overlay, visible, vp.view, vp.ref, flipped, cx, ratsnest, selection, editing, board, pickedIds, drag, box, route, cursor, tool, edit, drc, conflicts, pushed, pendingPair, pending, cursorNet, shape, dim, picked, ruler, pointShape, ptDrag, boxCorner, pageFrame]);

  // ---- Pointer handling ------------------------------------------------------

  /** Where a route or via snaps: a pad centre, a via, a track end, else the grid. */
  const snapTarget = (p: Point): { at: Point; net?: string; layer?: string } => {
    const t = tol();
    const v = board.vias.find((v) => Math.hypot(p.x - v.at.x, p.y - v.at.y) <= v.size / 2 + t);
    if (v) return { at: v.at, net: v.net };
    const pad = padAt(board, p, t);
    if (pad) return { at: pad.pad.at, net: pad.pad.net, layer: pad.pad.type === "smd" ? pad.pad.layers.find((l) => l.endsWith(".Cu")) : undefined };
    for (const tr of board.tracks) {
      if (!visible.has(tr.layer)) continue;
      for (const end of [tr.start, tr.end]) if (Math.hypot(p.x - end.x, p.y - end.y) <= tr.width / 2 + t) return { at: end, net: tr.net, layer: tr.layer };
    }
    const hit = pickItem(board, p, t, visible);
    return { at: snap(p, edit!.grid), net: hit && (hit.kind === "track" || hit.kind === "via") ? hit.net : undefined, layer: hit?.kind === "track" ? board.tracks.find((x) => x.uuid === hit.uuid)?.layer : undefined };
  };

  const select = (picks: BoardItem[], add: boolean) => {
    // Picking any member of a group picks its whole top-level group (KiCad's group selection).
    const items: BoardItem[] = [];
    const seen = new Set<string>();
    for (const it of picks) {
      const g = it.kind === "fptext" ? undefined : topGroup(board, it.uuid);
      const all = g ? groupItems(board, g.uuid).map((u) => (u === it.uuid ? it : boardItemOf(board, u))) : [it];
      for (const x of all) if (x && !seen.has(x.uuid)) (seen.add(x.uuid), items.push(x));
    }
    const next = add ? [...picked.filter((p) => !items.some((i) => i.uuid === p.uuid)), ...items.filter((i) => !pickedIds.has(i.uuid))] : items;
    setPicked(next);
    const first = next[0];
    if (!first) onSelect(null);
    else if (first.kind === "footprint") onSelect({ kind: "component", reference: first.reference, pad: first.pad });
    else if (first.kind === "fptext") onSelect({ kind: "component", reference: first.reference });
    else if ("net" in first && first.net) onSelect({ kind: "net", name: first.net });
    else onSelect(null);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (fromOverlay(e)) return;
    if (posRel?.picking && e.button === 0) {
      // Position Relative's "Select item…" / "Select point…": this click picks its reference, nothing else.
      e.preventDefault();
      const p = toBoard(e);
      if (posRel.picking === "point") return setPosRel({ ...posRel, picking: undefined, reference: { kind: "point", at: snapTarget(p).at, label: "point" } });
      const hit = pickItem(board, p, tol(), visible);
      const uuid = hit && (hit.kind === "fptext" ? hit.footprint : hit.uuid);
      const at = hit && boardItemPosition(board, uuid!, hit.kind === "footprint" ? hit.pad : undefined);
      if (hit && at) setPosRel({ ...posRel, picking: undefined, reference: { kind: "item", at, label: describe(hit.kind === "fptext" ? { kind: "footprint", uuid: hit.footprint, reference: hit.reference } : hit) } });
      return;
    }
    if (e.altKey && e.button === 0 && (!editing || tool === "select")) {
      // Alt+click: choose among everything under the cursor.
      const all = pickAll(board, toBoard(e), tol(), visible).map(allowed).filter((x): x is BoardItem => !!x);
      if (all.length > 1) {
        e.preventDefault();
        const r = vp.ref.current!.getBoundingClientRect();
        setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, choices: all });
        return;
      }
    }
    if (!editing || e.button !== 0 || tool !== "select") return vp.handlers.onPointerDown(e);
    const p = toBoard(e);
    // The point editor's handles come before the items under them.
    const handle = pointShape && !e.shiftKey ? handleAt(pointShape, p, 5 / vp.view.scale) : undefined;
    if (handle) {
      gesture.current = "handle";
      setPtDrag({ h: handle, to: handle.at });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    const hit = pickSel(p, tol());
    if (hit) {
      if (lockedIds.has(hit.uuid) && !e.shiftKey) {
        // A locked item can be picked (and unlocked) but not dragged.
        if (!pickedIds.has(hit.uuid)) select([hit], false);
        setNote("Locked: unlock with L to move it");
        return;
      }
      if (!pickedIds.has(hit.uuid)) select([hit], e.shiftKey);
      else if (e.shiftKey) return select([hit], true);
      else if (hit.kind === "footprint") {
        // Another pad of a picked footprint: the pad shown follows the click.
        const was = picked.find((q) => q.uuid === hit.uuid);
        if (was?.kind === "footprint" && was.pad !== hit.pad) select(picked.map((q) => (q.uuid === hit.uuid ? hit : q)), false);
      }
      gesture.current = "drag";
      pressed.current = { x: e.clientX, y: e.clientY, moved: false };
      setDrag({ from: p, d: { x: 0, y: 0 } });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } else if (e.shiftKey) {
      gesture.current = "box";
      setBox({ a: p, b: p });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } else {
      select([], false);
      vp.handlers.onPointerDown(e);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (editing && tool !== "select") {
      const p = toBoard(e);
      setCursor((tool === "route" && route) || tool === "outline" || tool === "zone" || tool === "text" || tool === "textbox" || tool === "dimension" ? snap(p, edit!.grid) : snapTarget(p).at);
    }
    if (gesture.current === "drag" && drag) {
      if (leftPress(e)) setDrag({ ...drag, d: dragOffset(drag.from, toBoard(e)) });
      return;
    }
    if (gesture.current === "handle" && ptDrag) return setPtDrag({ ...ptDrag, to: snap(toBoard(e), edit!.grid) });
    if (gesture.current === "box" && box) return setBox({ ...box, b: toBoard(e) });
    vp.handlers.onPointerMove(e);
  };

  /** How far a drag from `from` to `p` moves things: snapped so the first footprint's anchor lands on the grid. */
  const dragOffset = (from: Point, p: Point): Point => {
    const anchor = picked[0]?.kind === "footprint" ? board.footprints.find((f) => f.uuid === picked[0]!.uuid)?.at : undefined;
    const g = edit!.grid;
    const raw = { x: p.x - from.x, y: p.y - from.y };
    return anchor ? { x: snap({ x: anchor.x + raw.x, y: 0 }, g).x - anchor.x, y: snap({ x: 0, y: anchor.y + raw.y }, g).y - anchor.y } : snap(raw, g);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (g === "drag" && drag) {
      // From where the button came up: a fast drag may end before the last move has rendered.
      // A click (no pointer travel) moves nothing, even when the footprint sits off the grid
      // and a drag would snap it on.
      const { x: dx, y: dy } = leftPress(e) ? dragOffset(drag.from, toBoard(e)) : { x: 0, y: 0 };
      pressed.current = null;
      const movedAny = Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9;
      // Keep the moved preview until the edited board arrives, so nothing jumps back.
      setDrag(movedAny ? { ...drag, d: { x: dx, y: dy }, committed: board } : null);
      if (movedAny) setTimeout(() => setDrag((x) => (x?.committed ? null : x)), 3000);
      if (movedAny) {
        const ed = edit!;
        // Locked items in the selection stay where they are.
        const ids = new Set(picked.filter((p) => p.kind !== "fptext").map((p) => p.uuid).filter((u) => !lockedIds.has(u)));
        const ops: EditOp[] = ids.size ? [{ op: "boardMove", file: ed.file, uuids: withGroupExtras([...ids]), dx, dy }] : [];
        // A footprint's text moves on its own (unless its footprint moves too).
        for (const t of picked) if (t.kind === "fptext" && !ids.has(t.footprint)) ops.push({ op: "moveFootprintText", file: ed.file, footprint: t.footprint, text: t.uuid, dx, dy });
        // Tracks attached to what moved stretch along (KiCad's drag).
        for (const end of attachedTrackEnds(board, ids)) ops.push({ op: "moveTrackEnd", file: ed.file, uuid: end.uuid, index: end.index, to: { x: end.at.x + dx, y: end.at.y + dy } });
        ed.onEdit(ops);
      }
      return;
    }
    if (g === "handle" && ptDrag && pointShape) {
      const to = snap(toBoard(e), edit!.grid);
      setPtDrag(null);
      if (Math.hypot(to.x - ptDrag.h.at.x, to.y - ptDrag.h.at.y) > 1e-9) commitPoints(dragHandle(pointShape, ptDrag.h, to), ptDrag.h.type === "edge" ? "Move edge" : "Move corner");
      return;
    }
    if (g === "box" && box) {
      const b = { x: Math.min(box.a.x, box.b.x), y: Math.min(box.a.y, box.b.y), w: Math.abs(box.b.x - box.a.x), h: Math.abs(box.b.y - box.a.y) };
      setBox(null);
      // A group is picked only when all of it is in the box.
      const inBox = itemsInBox(board, b).map(allowed).filter((x): x is BoardItem => !!x);
      const ids = new Set(inBox.map((x) => x.uuid));
      // Members the selection filter leaves out don't count.
      select(inBox.filter((x) => { const g = topGroup(board, x.uuid); return !g || pickedWhole(g.uuid, ids, (it) => !!allowed(it)); }), true);
      return;
    }
    vp.handlers.onPointerUp();
    void e;
  };

  const onClick = (e: React.MouseEvent) => {
    if (fromOverlay(e)) return;
    if (vp.wasDrag() || menu?.choices) return;
    const p = toBoard(e);
    if (editing && tool === "measure") {
      // First click: start; second: fix the end; the next starts again. Points snap to
      // pads, vias and track ends first (KiCad's magnetic snapping), else to the grid.
      const at = snapTarget(p).at;
      setRuler((r) => (!r || r.b ? { a: at } : { ...r, b: at }));
      return;
    }
    if (editing && tool === "dimension") {
      // Start, end, then the offset (a third click).
      const at = snap(p, edit!.grid);
      if (!dim) return setDim({ start: at, orthogonal: false });
      if (!dim.end) return Math.hypot(at.x - dim.start.x, at.y - dim.start.y) > 1e-9 ? setDim({ ...dim, end: at }) : undefined;
      const d = dimFor(dim, at);
      setDim(null);
      if (d) edit!.onEdit([{ op: "addDimension", file: edit!.file, layer: "Dwgs.User", ...d }]);
      return;
    }
    if (editing && tool === "textbox") {
      // Two corners, then the text (KiCad's text box tool).
      const at = snap(p, edit!.grid);
      if (!boxCorner) return setBoxCorner(at);
      setBoxCorner(null);
      if (Math.abs(at.x - boxCorner.x) < 1e-9 || Math.abs(at.y - boxCorner.y) < 1e-9) return;
      const text = window.prompt("Text box (silkscreen; it wraps to the box)");
      if (text) edit!.onEdit([{ op: "addTextBox", file: edit!.file, box: { text, a: boxCorner, b: at, layer: flipped ? "B.SilkS" : "F.SilkS" } }]);
      return;
    }
    if (editing && tool === "text") {
      const text = window.prompt("Text (silkscreen)");
      if (text) edit!.onEdit([{ op: "addBoardText", file: edit!.file, text: { text, at: snap(p, edit!.grid), layer: flipped ? "B.SilkS" : "F.SilkS" } }]);
      return;
    }
    if (editing && tool === "outline" && edit!.outlineMode === "rect") {
      const at = snap(p, edit!.grid);
      if (!shape) return setShape([at]);
      const a = shape[0]!;
      setShape(null);
      if (Math.abs(at.x - a.x) > 1e-9 && Math.abs(at.y - a.y) > 1e-9) {
        const shapes = roundedRectShapes(a, at, edit!.cornerRadius, "Edge.Cuts", 0.05);
        edit!.onEdit(shapes.map((shape) => ({ op: "addBoardShape" as const, file: edit!.file, shape })));
      }
      return;
    }
    if (editing && (tool === "zone" || tool === "outline")) {
      const at = snap(p, edit!.grid);
      // Clicking the first corner closes the polygon.
      if (shape && shape.length >= 3 && Math.hypot(at.x - shape[0]!.x, at.y - shape[0]!.y) <= Math.max(edit!.grid / 2, tol())) return finishZone(shape);
      setShape([...(shape ?? []), at]);
      return;
    }
    if (editing && tool === "via") {
      const t = snapTarget(p);
      // A via dropped into a pour (a stitching via) takes the pour's net, as in KiCad.
      const inside = (q: Point, poly: Point[]) => {
        let c = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
          if (poly[i]!.y > q.y !== poly[j]!.y > q.y && q.x < ((poly[j]!.x - poly[i]!.x) * (q.y - poly[i]!.y)) / (poly[j]!.y - poly[i]!.y) + poly[i]!.x) c = !c;
        return c;
      };
      const net = t.net || board.zones.filter((z) => z.net && !z.keepout && inside(t.at, z.outline)).sort((a, b) => b.priority - a.priority)[0]?.net || "";
      const via = viaFor(net);
      edit!.onEdit([
        (() => {
          // A blind or micro via from the active layer to the next one in (outer layers) or out.
          const cu = board.copperLayers;
          const i = Math.max(0, cu.indexOf(edit!.layer));
          const span = viaLayers(cu[i], cu[i === cu.length - 1 ? i - 1 : i + 1]);
          return { op: "addVia" as const, file: edit!.file, at: t.at, size: via.size, drill: via.drill, layers: span.layers, type: span.type, net };
        })(),
        // The pour has to make room for (and connect to) the new via.
        ...(net && board.zones.some((z) => z.net === net) ? [{ op: "refillZones" as const, file: edit!.file }] : []),
      ]);
      return;
    }
    if (editing && tool === "footprint") {
      const fp = edit!.placingFootprint;
      if (!fp) return;
      // Board-only parts get KiCad's usual prefixes; numbered after the existing ones.
      const lib = fp.libId.slice(0, fp.libId.indexOf(":"));
      const prefix = lib === "MountingHole" ? "H" : lib === "Fiducial" ? "FID" : lib === "TestPoint" ? "TP" : lib === "Logo" ? "LOGO" : "REF";
      const used = new Set(board.footprints.map((f) => f.reference));
      let n = 1;
      while (used.has(`${prefix}${n}`)) n++;
      edit!.onEdit([
        {
          op: "placeFootprint",
          file: edit!.file,
          text: fp.text,
          libId: fp.libId,
          at: snap(p, edit!.grid),
          reference: `${prefix}${n}`,
          value: fp.libId.slice(fp.libId.indexOf(":") + 1),
          layer: flipped ? "B.Cu" : "F.Cu",
        },
      ]);
      return;
    }
    if (editing && tool === "route") {
      if (!route) {
        const t = snapTarget(p);
        const hitTrack = pickItem(board, p, tol(), visible);
        // Continue a track at its width; else the chosen width or the net class's.
        const width = hitTrack?.kind === "track" && !edit!.trackWidth ? board.tracks.find((x) => x.uuid === hitTrack.uuid)!.width : widthFor(t.net ?? "");
        const layer = t.layer && board.copperLayers.includes(t.layer) ? t.layer : edit!.layer;
        if (layer !== edit!.layer) edit!.onLayer(layer);
        if (pairMode && rules) {
          // A pair starts between a pad of one net and the partner's pad beside it.
          const pad = padAt(board, p, tol());
          const partner = pad && diffPartnerOnBoard(board, pad.pad.net);
          const others = pad && partner ? partnerPads(board, pad.pad, partner) : [];
          const other = others[0];
          if (!pad || !partner || !other) return setPairNote("Click a pad of a differential pair (nets ending in +/- or P/N)");
          const sz = diffPairSizes(rules, pad.pad.net);
          // Leave straight out from between the pads (Backspace removes that first step).
          const { mid, escape } = pairEscape(pad.pad, other.pad, pad.fp, sz.width, sz.gap, undefined, netClassOf(rules, pad.pad.net).clearance);
          setPairNote(undefined);
          setRoute({
            net: pad.pad.net,
            width: 2 * sz.width + sz.gap,
            runs: [{ layer, points: [mid, escape] }],
            vias: [],
            diagonalFirst: false,
            pair: { net: partner, width: sz.width, gap: sz.gap, startP: pad.pad.at, startN: other.pad.at, ends: [pad.pad.uuid ?? "", other.pad.uuid ?? ""], via: sz.via, viaPitch: sz.via.size + sz.viaGap, start: { pad: pad.pad, fp: pad.fp, alts: others.slice(1).map((o) => o.pad) } },
          });
          return;
        }
        setRoute({ net: t.net ?? "", width, runs: [{ layer, points: [t.at] }], vias: [], diagonalFirst: false });
        return;
      }
      // Clicking a pad (or via) ends the route there; elsewhere fixes a vertex.
      const pad = padAt(board, p, tol());
      if (route.pair) {
        // A pair ends between a pad of either net and its partner's pad beside it.
        if (pad && (pad.pad.net === route.net || pad.pad.net === route.pair.net)) {
          const others = partnerPads(board, pad.pad, pad.pad.net === route.net ? route.pair.net : route.net);
          if (!others.length) return setPairNote("No partner pad next to this one");
          const pr = route.pair;
          const clearance = rules ? netClassOf(rules, route.net).clearance : 0.2;
          // Where a pad has two equally near partner pads (at either end), take the ones that keep P and N uncrossed.
          const first = route.runs[0]!;
          const switchable = first.points.length >= 2;
          const starts = [undefined, ...(switchable ? pr.start.alts : [])];
          for (const alt of starts) {
            let r = route;
            if (alt) {
              const s0 = pairEscape(pr.start.pad, alt, pr.start.fp, pr.width, pr.gap, undefined, clearance);
              r = {
                ...route,
                runs: [{ ...first, points: [s0.mid, s0.escape, ...first.points.slice(2)] }, ...route.runs.slice(1)],
                pair: { ...pr, startN: alt.at, ends: [pr.start.pad.uuid ?? "", alt.uuid ?? ""] },
              };
            }
            for (const other of others) {
              const [endP, endN] = pad.pad.net === route.net ? [pad.pad.at, other.pad.at] : [other.pad.at, pad.pad.at];
              const { mid, escape } = pairEscape(pad.pad, other.pad, pad.fp, pr.width, pr.gap, r.runs.at(-1)!.points.at(-1)!, clearance);
              if (finishRoute(r, mid, { endP, endN, escape }) !== "crossed") return;
            }
          }
          return setPairNote("P and N are swapped at this end: the tracks would cross. Place the parts so they arrive in the same order (KiCad's router doesn't swap them either)");
        }
        if (pad) return;
      }
      const via = board.vias.find((v) => Math.hypot(p.x - v.at.x, p.y - v.at.y) <= v.size / 2 + tol());
      // A route can only end on its own net (or take the net of what it ends on when it has none).
      const sameNet = (net: string) => !route.net || !net || net === route.net;
      if ((pad && !sameNet(pad.pad.net)) || (via && !sameNet(via.net))) return;
      const end = pad?.pad.at ?? via?.at;
      if (end) return finishRoute({ ...route, net: route.net || pad?.pad.net || via?.net || "" }, end);
      const at = snap(p, edit!.grid);
      const last = route.runs.at(-1)!;
      const pts = tail(last.points.at(-1)!, at, last.layer).slice(1);
      setRoute({ ...route, runs: [...route.runs.slice(0, -1), { ...last, points: [...last.points, ...pts] }] });
      return;
    }
    if (editing) return; // selection is handled on pointer down
    // As in KiCad: a pad selects that pad (of its part), a part's body the part, copper its net.
    const hit = pickItem(board, p, 2 / vp.view.scale, visible);
    if (!hit) return onSelect(null);
    if (hit.kind === "footprint") return onSelect({ kind: "component", reference: hit.reference, pad: hit.pad });
    if ((hit.kind === "track" || hit.kind === "via" || hit.kind === "zone") && hit.net) return onSelect({ kind: "net", name: hit.net });
    if (hit.kind === "graphic" && hit.net) return onSelect({ kind: "net", name: hit.net });
    return onSelect(null);
  };

  /** An item the selection filter lets through (a pad pick becomes its footprint when pads are off). */
  const allowed = (it: BoardItem): BoardItem | undefined => {
    if (!selectable) return it;
    if (it.kind === "footprint" && it.pad !== undefined) {
      if (selectable.has("pad")) return it;
      return selectable.has("footprint") ? { kind: "footprint", uuid: it.uuid, reference: it.reference } : undefined;
    }
    return selectable.has(it.kind === "fptext" ? "text" : it.kind) ? it : undefined;
  };
  /** What a click picks, through the selection filter. */
  const pickSel = (p: Point, t: number): BoardItem | undefined => {
    const first = pickItem(board, p, t, visible);
    const ok = first && allowed(first);
    if (ok || !first) return ok;
    for (const it of pickAll(board, p, t, visible)) {
      const a = allowed(it);
      if (a) return a;
    }
    return undefined;
  };

  // ---- Context menu (right click), KiCad's actions for what's under the cursor ----
  /** The top-level groups the selection covers whole. */
  const pickedGroups = (): string[] => {
    const ids = new Set(picked.map((p) => (p.kind === "fptext" ? p.footprint : p.uuid)));
    return [...new Set([...ids].map((u) => topGroup(board, u)?.uuid).filter((g): g is string => !!g))].filter((g) => pickedWhole(g, ids));
  };
  /** Group the selection: its whole groups and loose items become one new group. */
  const groupSelection = () => {
    const groups = pickedGroups();
    const inGroups = new Set(groups.flatMap((g) => groupItems(board, g)));
    const loose = [...new Set(picked.filter((p) => p.kind !== "fptext" && !inGroups.has(p.uuid)).map((p) => p.uuid))];
    const members = [...groups, ...loose];
    if (members.length < 2 && !loose.length) return setNote("Already a group");
    edit!.onEdit([{ op: "boardGroup", file: edit!.file, members }]);
    setNote(`Grouped ${picked.length} item${picked.length > 1 ? "s" : ""}`);
  };
  const ungroupSelection = () => {
    const groups = pickedGroups();
    if (!groups.length) return setNote("No group selected");
    edit!.onEdit([{ op: "boardUngroup", file: edit!.file, groups }]);
    setNote("Ungrouped");
  };
  /** Write the point editor's result: a zone's outline, or a graphic's points. */
  const commitPoints = (points: Point[], label: string) => {
    if (!pointShape) return;
    const ed = edit!;
    if (pointShape.kind === "zone") ed.onEdit([{ op: "setZoneOutline", file: ed.file, uuid: pointShape.uuid, points, label }]);
    else ed.onEdit([{ op: "setGraphicPoints", file: ed.file, uuid: pointShape.uuid, points, label }]);
  };
  /** The Create Array dialog: what it copies, and where the selection is (for the circle's centre). */
  const [arrayFor, setArrayFor] = useState<{ uuids: string[]; origin: Point } | null>(null);
  const openArray = () => {
    // Footprint texts and pads stand for their footprint, once.
    const uuids = [...new Set(picked.map((p) => (p.kind === "fptext" ? p.footprint : p.uuid)))];
    if (uuids.length) setArrayFor({ uuids, origin: selectionCenter() });
  };
  /** Position Relative To: the items it moves, its reference, and what a click on the board picks for it. */
  const [posRel, setPosRel] = useState<{ items: Array<{ uuid: string; locked?: boolean }>; reference?: RelativeReference; picking?: "item" | "point" } | null>(null);
  const openPosRel = () => {
    const uuids = [...new Set(picked.map((p) => (p.kind === "fptext" ? p.footprint : p.uuid)))];
    if (uuids.length) setPosRel({ items: uuids.map((uuid) => ({ uuid, locked: lockedIds.has(uuid) })) });
  };
  const [menu, setMenu] = useState<{ x: number; y: number; at?: Point; hit?: BoardItem; choices?: BoardItem[] } | null>(null);
  /** Menu entries: [label, shortcut, action], a separator, or a submenu. */
  type MenuEntry = [string, string, () => void] | "-" | { label: string; items: Array<[string, string, () => void] | "-"> };
  /**
   * Align or distribute the selection, as KiCad's Align/Distribute tool: by
   * bounding boxes (footprints without their text); locked items stay put.
   * `at`: the cursor, whose item is the alignment target.
   */
  const arrange = (how: { align: AlignMode } | { distribute: DistributeMode }, label: string, at?: Point) => {
    const uuids = [...new Set(picked.filter((p) => p.kind !== "fptext").map((p) => p.uuid))];
    const items = uuids.flatMap((uuid) => {
      const box = boardItemBox(board, uuid);
      return box ? [{ uuid, box, locked: lockedIds.has(uuid) }] : [];
    });
    // A mirrored view shows left and right swapped: KiCad swaps the two commands.
    const swap: Partial<Record<AlignMode, AlignMode>> = { left: "right", right: "left" };
    const moves = "align" in how ? alignMoves(items, (flipped && swap[how.align]) || how.align, at) : distributeMoves(items, how.distribute);
    if (moves.length) edit!.onEdit([{ op: "boardArrange", file: edit!.file, label, moves }]);
  };
  const arrangeMenu = (at?: Point): MenuEntry => {
    const n = new Set(picked.filter((p) => p.kind !== "fptext").map((p) => p.uuid)).size;
    const a = (mode: AlignMode, label: string): [string, string, () => void] => [label, "", () => arrange({ align: mode }, label, at)];
    const d = (mode: DistributeMode, label: string): [string, string, () => void] => [label, "", () => arrange({ distribute: mode }, label)];
    return {
      label: "Align/Distribute",
      items: [
        a("left", "Align to Left"), a("centerX", "Align to Horizontal Center"), a("right", "Align to Right"), "-",
        a("top", "Align to Top"), a("centerY", "Align to Vertical Center"), a("bottom", "Align to Bottom"),
        ...(n > 2 ? (["-", d("centersX", "Distribute Horizontally by Centers"), d("gapsX", "Distribute Horizontally with Even Gaps"), d("centersY", "Distribute Vertically by Centers"), d("gapsY", "Distribute Vertically with Even Gaps")] as const) : []),
      ],
    };
  };
  /** How an item reads in the "which one?" list. */
  const describe = (it: BoardItem): string => {
    if (it.kind === "footprint") {
      const fp = board.footprints.find((f) => f.uuid === it.uuid);
      return it.pad !== undefined ? `Pad ${it.pad || "(unnumbered)"} of ${it.reference}` : `Footprint ${it.reference}${fp?.value ? ` (${fp.value})` : ""}`;
    }
    if (it.kind === "track") {
      const t = board.tracks.find((x) => x.uuid === it.uuid);
      return `Track ${shortName(it.net) || "(no net)"} on ${t?.layer ?? "?"}, ${t?.width ?? "?"} mm`;
    }
    if (it.kind === "via") return `Via ${shortName(it.net) || "(no net)"}`;
    if (it.kind === "zone") return `Zone ${shortName(it.net) || "(no net)"}`;
    if (it.kind === "text") {
      const box = board.textBoxes.find((t) => t.uuid === it.uuid);
      return box ? `Text box '${box.text.split("\n")[0]}' on ${it.layer}` : `Text '${board.texts.find((t) => t.uuid === it.uuid)?.text ?? ""}' on ${it.layer}`;
    }
    if (it.kind === "fptext") return `${it.reference} text '${board.footprints.find((f) => f.uuid === it.footprint)?.texts.find((t) => t.uuid === it.uuid)?.text ?? ""}' on ${it.layer}`;
    return `Graphic on ${it.layer}`;
  };
  /** Pick `it` as a click would (edit: the selection; view: a part, pad or net). */
  const choose = (it: BoardItem) => {
    if (editing) return select([it], false);
    if (it.kind === "footprint") onSelect({ kind: "component", reference: it.reference, pad: it.pad });
    else if ("net" in it && it.net) onSelect({ kind: "net", name: it.net });
  };
  /** Run a menu action through the same keys the shortcuts use. */
  const press = (key: string, o: { shift?: boolean; ctrl?: boolean } = {}) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: o.shift, ctrlKey: o.ctrl, bubbles: true }));
  const onContextMenu = (e: React.MouseEvent) => {
    if (fromOverlay(e)) return;
    e.preventDefault();
    const p = toBoard(e);
    const hit = editing ? pickSel(p, tol()) : pickItem(board, p, tol(), visible);
    // Right-clicking something selects it, as in KiCad (unless it's already in the selection,
    // or it's a handle of the shape being point-edited).
    const onHandle = pointShape && handleAt(pointShape, p, 5 / vp.view.scale);
    if (editing && tool === "select" && hit && !pickedIds.has(hit.uuid) && !onHandle) select([hit], false);
    if (!editing && hit) {
      if (hit.kind === "footprint") onSelect({ kind: "component", reference: hit.reference, pad: hit.pad });
      else if ("net" in hit && hit.net) onSelect({ kind: "net", name: hit.net });
    }
    const r = vp.ref.current!.getBoundingClientRect();
    setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, at: p, hit: hit ?? undefined });
  };
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    // From the next tick: the press that opened the menu (Alt+click) is still on its way up.
    const t = setTimeout(() => {
      window.addEventListener("pointerdown", close);
      window.addEventListener("keydown", close);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);
  const menuItems = (): MenuEntry[] => {
    // Alt+click on overlapping items: KiCad's "clarify selection".
    if (menu?.choices) return menu.choices.map((it) => [describe(it), "", () => choose(it)]);
    const hit = menu?.hit;
    const net = hit && "net" in hit ? hit.net : undefined;
    const pad = hit?.kind === "footprint" && hit.pad !== undefined ? board.footprints.find((f) => f.uuid === hit.uuid)?.pads.find((q) => q.number === hit.pad) : undefined;
    const selectNet = (n: string) => onSelect({ kind: "net", name: n });
    if (!editing)
      return [
        ...(hit?.kind === "footprint" ? [["Select " + hit.reference, "", () => onSelect({ kind: "component", reference: hit.reference })] as [string, string, () => void]] : []),
        ...((pad?.net || net) ? [["Select net " + shortName(pad?.net || net!), "", () => selectNet(pad?.net || net!)] as [string, string, () => void]] : []),
        ["Zoom to fit", "Home", () => vp.fit(mirror(scene.bbox))],
      ];
    const ed = edit!;
    const out: MenuEntry[] = [];
    // KiCad offers Align/Distribute once more than one item is selected.
    if (tool === "select" && new Set(picked.filter((p) => p.kind !== "fptext").map((p) => p.uuid)).size > 1) out.push(arrangeMenu(menu?.at));
    if (tool === "select" && picked.length) {
      out.push(["Create Array…", "Ctrl+T", openArray], ["Position Relative To…", "Shift+P", openPosRel]);
      if (picked.length > 1) out.push(["Group", "Ctrl+G", groupSelection]);
      if (pickedGroups().length) out.push(["Ungroup", "Ctrl+Shift+G", ungroupSelection]);
      out.push("-");
    }
    if (pointShape && (pointShape.kind === "zone" || pointShape.kind === "poly") && menu?.at) {
      // KiCad's point editor: add a corner on the nearest edge, or remove the corner under the cursor.
      const at = menu.at;
      const corner = handleAt(pointShape, at, 5 / vp.view.scale);
      out.push(["Add Corner", "", () => commitPoints(addCorner(pointShape.points, snap(at, edit!.grid)), "Add corner")]);
      if (corner?.type === "corner") {
        const left = removeCorner(pointShape.points, corner.index);
        out.push(["Remove Corner", "", () => (left ? commitPoints(left, "Remove corner") : edit!.onEdit([{ op: "boardDelete", file: edit!.file, uuids: [pointShape.uuid] }]))]);
      }
      out.push("-");
    }
    if (hit?.kind === "footprint") {
      if (pad?.net) out.push([`Select net ${shortName(pad.net)}`, "", () => selectNet(pad.net)], "-");
      out.push(["Rotate", "R", () => press("r")], ["Flip to other side", "F", () => press("f")]);
    }
    if (hit && (hit.kind === "track" || hit.kind === "via")) {
      out.push(["Select whole trace", "U", () => press("u")]);
      if (net) out.push([`Select net ${shortName(net)}`, "", () => selectNet(net)]);
    }
    if (hit && (hit.kind === "footprint" || hit.kind === "track" || hit.kind === "via")) out.push([lockedIds.has(hit.uuid) ? "Unlock" : "Lock", "L", () => press("l")]);
    if (hit) {
      out.push("-", ["Copy", "Ctrl+C", () => press("c", { ctrl: true })], ["Duplicate", "Ctrl+D", () => press("d", { ctrl: true })], ["Delete", "Del", () => press("Delete")]);
    } else {
      if (clipboard.current) out.push(["Paste here", "Ctrl+V", () => press("v", { ctrl: true })]);
      out.push(["Add footprint", "A", () => ed.onTool("footprint")], ["Route tracks", "X", () => ed.onTool("route")], ["Measure", "Ctrl+Shift+M", () => ed.onTool("measure")]);
      if (board.zones.some((z) => !z.keepout)) out.push(["Refill zones", "B", () => ed.onEdit([{ op: "refillZones", file: ed.file }])]);
      out.push("-", ["Zoom to fit", "Home", () => vp.fit(mirror(scene.bbox))]);
    }
    return out;
  };

  const onDoubleClick = () => {
    if (editing && route) finishRoute(route);
    if (editing && (tool === "zone" || tool === "outline") && shape) finishZone(shape);
  };

  // Keep the route's layer in step with the toolbar.
  useEffect(() => {
    if (!route || !edit) return;
    const last = route.runs.at(-1)!;
    if (last.layer !== edit.layer && last.points.length === 1 && route.runs.length === 1) {
      setRoute({ ...route, runs: [{ ...last, layer: edit.layer }] });
    }
  }, [edit?.layer]); // eslint-disable-line react-hooks/exhaustive-deps

  const hint0 = !editing
    ? undefined
    : tool === "route"
      ? route
        ? route.pair
          ? `${pairNote ? `${pairNote} · ` : ""}${conflicts.length ? `⚠ ${conflicts.length} clearance conflict${conflicts.length > 1 ? "s" : ""} · ` : ""}Routing pair ${route.net} / ${route.pair.net} on ${route.runs.at(-1)!.layer}, ${route.pair.width} mm, gap ${route.pair.gap} mm · click to fix a corner, click a pad of the pair to finish · V via pair · Backspace undo corner · Esc done`
          : `${conflicts.length ? `⚠ ${conflicts.length} clearance conflict${conflicts.length > 1 ? "s" : ""} · ` : ""}Routing ${route.net || "(no net)"} on ${route.runs.at(-1)!.layer}, ${route.width} mm · click to fix a corner, click a pad to finish · V via · W/Shift+W width · ${mode === "walkaround" ? "M mode: walkaround" : mode === "shove" ? `M mode: shove${pushed?.remove.length ? ` (pushing ${new Set(pushed.add.map((a) => a.net)).size} net${new Set(pushed.add.map((a) => a.net)).size > 1 ? "s" : ""})` : !pushed && router?.failure ? ` (can't: ${router.failure})` : ""}` : "M mode: straight · / posture"} · Backspace undo corner · Esc done`
        : pairMode
          ? `${pairNote ? `${pairNote} · ` : ""}Differential pair: click a pad of a pair (6 for single tracks)`
          : "Click a pad, via or track to start routing (X) · 6 differential pair"
      : tool === "text"
        ? `Click to place text on ${flipped ? "B.SilkS (mirrored)" : "F.SilkS"}`
      : tool === "textbox"
        ? boxCorner ? "Click the opposite corner, then type the text" : `Text box on ${flipped ? "B.SilkS (mirrored)" : "F.SilkS"}: click a corner`
      : tool === "measure"
        ? !ruler || ruler.b
          ? "Measure: click a start point (Ctrl+Shift+M or Esc to stop)"
          : "Click to fix the end · the line shows distance, dx and dy"
      : tool === "dimension"
        ? !dim
          ? "Dimension: click the first point"
          : !dim.end
            ? "Click the second point · Esc cancel"
            : `Move out to set the offset, click to place (on Dwgs.User) · O ${dim.orthogonal ? "aligned" : "horizontal/vertical"} · Esc cancel`
      : tool === "outline" && edit!.outlineMode === "poly"
        ? shape
          ? "Click to add corners · click the first corner, double-click or Enter to finish · Backspace undo · Esc cancel"
          : "Click the first corner of the board outline (Edge.Cuts)"
      : tool === "outline"
        ? shape
          ? "Click the opposite corner · Esc cancel"
          : board.outline.length
            ? "Click one corner of a rectangle (the board already has an outline: delete it first to replace it)"
            : "Click one corner of the board outline rectangle (Edge.Cuts)"
        : tool === "zone"
        ? shape
          ? `Zone ${edit!.zoneNet || "(no net)"} on ${edit!.layer} · click to add corners · click the first corner, double-click or Enter to finish · Backspace undo · Esc cancel`
          : `Click the first corner of a ${edit!.zoneNet || "no-net"} zone on ${edit!.layer}`
        : tool === "footprint"
        ? edit?.placingFootprint
          ? `Click to place ${edit.placingFootprint.libId} · Esc to stop`
          : "Pick a footprint to place"
        : tool === "via"
        ? "Click to place a via (it takes the net under it, or the pour's: a stitching via)"
        : picked.length
          ? `${picked.length} selected${picked.some((p) => lockedIds.has(p.uuid)) ? " (locked)" : ""} · drag to move · R rotate · F flip · L lock · U whole trace · Del delete · arrows nudge`
          : "Click to select · Alt+click to choose among overlapping items · Shift-drag to box select · X route · V via · T find · Ctrl+C/V/D copy, paste, duplicate · Ctrl+Shift+M measure";
  const hint = note && hint0 ? `${note} · ${hint0}` : hint0;

  return (
    <div
      className={`viewport board${editing && tool !== "select" ? " crosshair" : ""}`}
      ref={vp.ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setCursor(null)}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <canvas ref={canvas} style={{ width: "100%", height: "100%", display: "block" }} />
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          {menuItems().map((m, i) =>
            m === "-" ? (
              <hr key={i} />
            ) : "items" in m ? (
              <div key={i} className="context-sub">
                <button>
                  <span>{m.label}</span>
                  <kbd>▸</kbd>
                </button>
                <div className="context-menu">
                  {m.items.map((s, j) =>
                    s === "-" ? (
                      <hr key={j} />
                    ) : (
                      <button
                        key={j}
                        onClick={() => {
                          setMenu(null);
                          s[2]();
                        }}
                      >
                        <span>{s[0]}</span>
                      </button>
                    ),
                  )}
                </div>
              </div>
            ) : (
              <button
                key={i}
                onClick={() => {
                  setMenu(null);
                  m[2]();
                }}
              >
                <span>{m[0]}</span>
                {m[1] && <kbd>{m[1]}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
      {hint && <div className="edit-hint">{hint}</div>}
      {dirty && board.zones.some((z) => !z.keepout) && (
        <div className="zone-note">Copper zones are out of date. Press B (or Refill) to refill them.</div>
      )}
      {editing && tool === "select" && picked.length > 0 && <BoardProps
          board={board}
          picked={picked}
          file={edit!.file}
          onEdit={(ops) => {
            const tune = ops.find((o) => o.op === "tuneLength");
            if (tune?.op === "tuneLength") tunedNet.current = tune.net;
            edit!.onEdit(ops);
          }}
        />}
      {editing && posRel && (
        <PositionRelative
          board={board}
          file={edit!.file}
          items={posRel.items}
          reference={posRel.reference}
          picking={posRel.picking}
          onPick={(what) => setPosRel({ ...posRel, picking: posRel.picking === what ? undefined : what })}
          onReference={(reference) => setPosRel({ ...posRel, reference, picking: undefined })}
          onEdit={(ops) => edit!.onEdit(ops)}
          onClose={() => setPosRel(null)}
        />
      )}
      {editing && arrayFor && (
        <CreateArray file={edit!.file} uuids={arrayFor.uuids} origin={arrayFor.origin} onEdit={(ops) => edit!.onEdit(ops)} onClose={() => setArrayFor(null)} />
      )}
      <div className="view-tools">
        <button onClick={() => vp.fit(mirror(scene.bbox))} title="Fit board (F, or Home while editing)"><Icon name="fit" /> Fit</button>
      </div>
    </div>
  );
}

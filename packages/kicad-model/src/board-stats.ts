/**
 * Board statistics (KiCad's Board Statistics dialog, `kicad-cli pcb export stats`): footprints by
 * mount type and side, pads by type and property, vias by type, the board's size and area, the
 * thinnest track, the smallest round drill, and the drill table (holes of one size, shape,
 * plating, kind and layer span counted together, most numerous first).
 */
import type { Board } from "./board.js";
import { onLayer, viaSpan } from "./fab.js";
import { boardArea } from "./zone-fill.js";

export interface DrillRow {
  count: number;
  shape: "Round" | "Slot";
  x: number;
  y: number;
  plated: boolean;
  source: "Pad" | "Via";
  start: string;
  stop: string;
}

export interface BoardStatistics {
  board: { hasOutline: boolean; width: number; height: number; area: number; thickness: number; minTrackWidth?: number; minDrill?: number };
  pads: { throughHole: number; smd: number; connector: number; npth: number; castellated: number; pressFit: number };
  vias: { through: number; blind: number; buried: number; micro: number };
  components: Record<"tht" | "smd" | "unspecified", { front: number; back: number }>;
  drills: DrillRow[];
}

/** Signed area of a Clipper path (1e5 units per mm), in mm². */
const signedArea = (path: Array<{ X: number; Y: number }>) => {
  let a = 0;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) a += (path[j]!.X + path[i]!.X) * (path[j]!.Y - path[i]!.Y);
  return a / 2 / 1e10;
};

export function boardStatistics(board: Board, o: { excludeFootprintsWithoutPads?: boolean } = {}): BoardStatistics {
  const copper = board.copperLayers;
  const name = (l: string) => board.layers.find((x) => x.name === l)?.userName ?? l;
  const s: BoardStatistics = {
    board: { hasOutline: false, width: 0, height: 0, area: 0, thickness: board.thickness ?? 1.6 },
    pads: { throughHole: 0, smd: 0, connector: 0, npth: 0, castellated: 0, pressFit: 0 },
    vias: { through: 0, blind: 0, buried: 0, micro: 0 },
    components: { tht: { front: 0, back: 0 }, smd: { front: 0, back: 0 }, unspecified: { front: 0, back: 0 } },
    drills: [],
  };
  const drills: DrillRow[] = [];
  const add = (d: Omit<DrillRow, "count">) => {
    const e = drills.find((x) => x.shape === d.shape && Math.abs(x.x - d.x) < 1e-9 && Math.abs(x.y - d.y) < 1e-9 && x.plated === d.plated && x.source === d.source && x.start === d.start && x.stop === d.stop);
    if (e) e.count++;
    else drills.push({ ...d, count: 1 });
  };
  for (const fp of board.footprints) {
    if (o.excludeFootprintsWithoutPads && !fp.pads.length) continue;
    const kind = fp.attributes.mount === "through_hole" ? "tht" : fp.attributes.mount === "smd" ? "smd" : "unspecified";
    s.components[kind][fp.layer === "B.Cu" ? "back" : "front"]++;
    for (const p of fp.pads) {
      if (p.type === "thru_hole") s.pads.throughHole++;
      else if (p.type === "smd") s.pads.smd++;
      else if (p.type === "connect") s.pads.connector++;
      else if (p.type === "np_thru_hole") s.pads.npth++;
      if (p.property === "castellated") s.pads.castellated++;
      if (p.property === "pressfit") s.pads.pressFit++;
      const dx = p.drillSize?.x ?? p.drill ?? 0, dy = p.drillSize?.y ?? p.drill ?? 0;
      if (dx <= 0 || dy <= 0) continue;
      const on = copper.filter((l) => onLayer(p.layers, l));
      add({ shape: p.drillSize && Math.abs(dx - dy) > 1e-9 ? "Slot" : "Round", x: dx, y: dy, plated: p.type !== "np_thru_hole", source: "Pad", start: on.length ? name(on[0]!) : "N/A", stop: on.length ? name(on[on.length - 1]!) : "N/A" });
    }
  }
  for (const t of board.tracks) if (t.kind !== "arc") s.board.minTrackWidth = Math.min(s.board.minTrackWidth ?? Infinity, t.width);
  for (const v of board.vias) {
    s.vias[v.type === "micro" ? "micro" : v.type === "blind" ? "blind" : v.type === "buried" ? "buried" : "through"]++;
    if (v.drill <= 0) continue;
    const [a, b] = viaSpan(board, v);
    add({ shape: "Round", x: v.drill, y: v.drill, plated: true, source: "Via", start: name(a), stop: name(b) });
  }
  s.drills = drills.sort((a, b) => b.count - a.count);
  const round = drills.filter((d) => d.shape === "Round").map((d) => d.x);
  if (round.length) s.board.minDrill = Math.min(...round);

  const outline = boardArea(board) as Array<Array<{ X: number; Y: number }>> | undefined;
  if (outline?.length) {
    s.board.hasOutline = true;
    // The outer outlines' area (KiCad leaves cut-outs in unless asked): they wind the same way as the largest.
    const areas = outline.map(signedArea);
    const sign = Math.sign(areas.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0));
    s.board.area = areas.filter((a) => Math.sign(a) === sign).reduce((n, a) => n + Math.abs(a), 0);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const path of outline)
      for (const q of path) {
        x0 = Math.min(x0, q.X);
        y0 = Math.min(y0, q.Y);
        x1 = Math.max(x1, q.X);
        y1 = Math.max(y1, q.Y);
      }
    s.board.width = (x1 - x0) / 1e5;
    s.board.height = (y1 - y0) / 1e5;
  }
  return s;
}

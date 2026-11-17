/**
 * Update PCB from Schematic: bring footprints in line with the schematic
 * (references, values, fields and pad nets), list footprints to add or
 * remove, and place new footprints from a library .kicad_mod. Footprints are
 * matched to symbols the way KiCad does: by symbol path, then reference.
 */
import { arg, findChild, findChildren, format, headOf, insertAt, isAtom, isList, list, parse, removeChild, serialize, setArg, str, sym, type List } from "@crossprobe/kicad-sexpr";
import { parseBoard, type Board, type Footprint } from "./board.js";
import { flipFootprint, newBoardUuid, rotateBoardItem, setFootprintAttributes, setFootprintField, setPadNet } from "./board-edit.js";
import type { Point } from "./geometry.js";
import type { Netlist } from "./connectivity.js";
import type { Component, Schematic } from "./project.js";

export interface FootprintUpdate {
  uuid: string;
  reference: string;
  /** Fields to set (only those that differ). */
  fields: Record<string, string>;
  /** Pad number → net ("" clears), only those that differ. */
  pads: Record<string, string>;
  /** The symbol's "do not populate" and "exclude from BOM", where the footprint's differ (KiCad carries both over). */
  attributes?: { dnp?: boolean; excludeFromBom?: boolean };
}

export interface MissingFootprint {
  reference: string;
  value: string;
  /** "Library:Footprint" from the symbol's Footprint field; may be empty. */
  footprint: string;
  /** Symbol path as footprints store it ("/sheet-uuids…/symbol-uuid"). */
  path: string;
  sheetName: string;
  sheetFile: string;
  fields: Record<string, string>;
  /** Pin number → net. */
  pads: Record<string, string>;
  /** The symbol's "do not populate" and "exclude from BOM": the placed footprint takes them, whatever its library file says. */
  attributes: { dnp: boolean; excludeFromBom: boolean };
}

export interface BoardUpdatePlan {
  updates: FootprintUpdate[];
  missing: MissingFootprint[];
  /** Footprints with no symbol (board-only ones excluded): references and UUIDs. */
  extra: Array<{ reference: string; uuid: string }>;
}

const SKIPPED = new Set(["Reference", "Value", "Footprint"]);

/** Footprints store the symbol path without the root sheet's UUID. */
export function footprintPath(sheetPath: string, symbolUuid: string): string {
  const parts = sheetPath.split("/").filter(Boolean).slice(1);
  return "/" + [...parts, symbolUuid].join("/");
}

function schematicFields(comp: Component): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(comp.properties)) {
    if (SKIPPED.has(name) || name.startsWith("ki_")) continue;
    const v = name === "Description" ? raw.trim() : raw;
    out[name] = v === "~" ? "" : v;
  }
  return out;
}

export function planBoardUpdate(schematic: Schematic, netlist: Netlist, board: Board): BoardUpdatePlan {
  const pinNet = new Map<string, string>();
  for (const net of netlist.nets) for (const n of net.nodes) pinNet.set(`${n.reference}\0${n.pin}`, net.name);
  const pinsOf = (ref: string) => {
    const out: Record<string, string> = {};
    for (const [k, net] of pinNet) {
      const [r, pin] = k.split("\0") as [string, string];
      if (r === ref) out[pin] = net;
    }
    return out;
  };

  const components = schematic.components.filter((c) => c.onBoard);
  const byPath = new Map<string, Component>();
  const byRef = new Map<string, Component>();
  for (const c of components) {
    byRef.set(c.reference, c);
    for (const u of c.units) byPath.set(footprintPath(u.sheet.path, u.symbol.uuid), c);
  }

  const plan: BoardUpdatePlan = { updates: [], missing: [], extra: [] };
  const matched = new Set<Component>();
  for (const fp of board.footprints) {
    const comp = (fp.path && byPath.get(fp.path)) || byRef.get(fp.reference);
    if (!comp) {
      if (!fp.attributes.boardOnly && fp.reference) plan.extra.push({ reference: fp.reference, uuid: fp.uuid });
      continue;
    }
    matched.add(comp);
    const u: FootprintUpdate = { uuid: fp.uuid, reference: comp.reference, fields: {}, pads: {} };
    if (fp.reference !== comp.reference) u.fields["Reference"] = comp.reference;
    if (fp.value !== comp.value) u.fields["Value"] = comp.value;
    for (const [name, v] of Object.entries(schematicFields(comp))) {
      if ((fp.properties[name] ?? "") !== v) u.fields[name] = v;
    }
    for (const pad of fp.pads) {
      if (!pad.number) continue;
      const sch = pinNet.get(`${comp.reference}\0${pad.number}`) ?? "";
      if (pad.net === sch) continue;
      if (sch.startsWith("unconnected-") && pad.net.startsWith(sch)) continue;
      u.pads[pad.number] = sch;
    }
    const attributes = { ...(fp.attributes.dnp !== comp.dnp && { dnp: comp.dnp }), ...(fp.attributes.excludeFromBom !== !comp.inBom && { excludeFromBom: !comp.inBom }) };
    if (Object.keys(attributes).length) u.attributes = attributes;
    if (Object.keys(u.fields).length || Object.keys(u.pads).length || u.attributes) plan.updates.push(u);
  }

  for (const comp of components) {
    if (matched.has(comp)) continue;
    const unit = comp.units[0]!;
    plan.missing.push({
      reference: comp.reference,
      value: comp.value,
      footprint: comp.footprint,
      path: footprintPath(unit.sheet.path, unit.symbol.uuid),
      sheetName: unit.sheet.namePath ?? "/",
      sheetFile: unit.sheet.file,
      fields: schematicFields(comp),
      attributes: { dnp: comp.dnp, excludeFromBom: !comp.inBom },
      pads: pinsOf(comp.reference),
    });
  }
  return plan;
}

const fpUuid = (n: List) => String(arg(findChild(n, "uuid") ?? findChild(n, "tstamp"), 0) ?? "");

/** Apply one footprint's update to the board tree. */
export function applyFootprintUpdate(root: List, u: FootprintUpdate): void {
  const fp = root.children.find((c): c is List => isList(c) && headOf(c) === "footprint" && fpUuid(c) === u.uuid);
  if (!fp) return;
  for (const [name, value] of Object.entries(u.fields)) setFootprintField(fp, name, value);
  for (const [pad, net] of Object.entries(u.pads)) setPadNet(root, fp, pad, net);
  if (u.attributes) setFootprintAttributes(fp, u.attributes);
}

export interface PlaceFootprintOptions {
  at: Point;
  layer?: "F.Cu" | "B.Cu";
  reference: string;
  value: string;
  libId: string;
  path?: string;
  sheetName?: string;
  sheetFile?: string;
  fields?: Record<string, string>;
  pads?: Record<string, string>;
  /** The symbol's flags, replacing the library file's (a mounting-hole footprint is "exclude from BOM"; its symbol may not be). */
  attributes?: { dnp?: boolean; excludeFromBom?: boolean };
  /** Not in the schematic (mounting holes, logos, fiducials): KiCad's "board only" attribute keeps parity checks quiet. */
  boardOnly?: boolean;
}

/**
 * Place a footprint from a library .kicad_mod text. Library footprints are
 * written in the board's footprint form: named by lib id, positioned, with
 * fresh UUIDs, the symbol link and pad nets. Returns the new UUID.
 */
export function placeFootprint(root: List, modText: string, o: PlaceFootprintOptions): string {
  const doc = parse(modText, { recover: true });
  const fp = doc.children.find((c): c is List => isList(c) && (headOf(c) === "footprint" || headOf(c) === "module"));
  if (!fp) throw new Error("Not a KiCad footprint");
  // A stray ")" can close the footprint early (KiCad reads on): the forms after it are its own.
  for (const c of doc.children.slice(doc.children.indexOf(fp) + 1)) if (isList(c)) fp.children.push(c), fp.trivia.push("\n\t");
  fp.children[0] = sym("footprint");
  setArg(fp, 0, str(o.libId));
  // Library-only header items.
  for (const h of ["version", "generator", "generator_version", "tedit"]) {
    const n = findChild(fp, h);
    if (n) removeChild(fp, n);
  }
  const layer = findChild(fp, "layer");
  const id = newBoardUuid();
  const after = layer ? fp.children.indexOf(layer) + 1 : 1;
  insertAt(fp, after, list("uuid", str(id)));
  insertAt(fp, after + 1, list("at", o.at.x, o.at.y));
  // Fresh UUIDs for every child item.
  const renew = (n: List) => {
    for (const c of n.children) {
      if (!isList(c)) continue;
      if (headOf(c) === "uuid" && c !== findChild(fp, "uuid")) setArg(c, 0, str(newBoardUuid()));
      else if (headOf(c) === "tstamp") setArg(c, 0, str(newBoardUuid()));
      else renew(c);
    }
  };
  renew(fp);
  setFootprintField(fp, "Reference", o.reference);
  setFootprintField(fp, "Value", o.value);
  for (const [k, v] of Object.entries(o.fields ?? {})) setFootprintField(fp, k, v);
  if (o.attributes) setFootprintAttributes(fp, o.attributes);
  // As KiCad writes them on a board: every field and text has its own UUID (after its layer).
  for (const c of fp.children) {
    if (!isList(c) || (headOf(c) !== "property" && headOf(c) !== "fp_text") || findChild(c, "uuid")) continue;
    const before = findChild(c, "layer") ?? findChild(c, "at");
    insertAt(c, before ? c.children.indexOf(before) + 1 : c.children.length, list("uuid", str(newBoardUuid())));
  }
  if (o.boardOnly) {
    const attr = findChild(fp, "attr");
    if (!attr) insertAt(fp, fp.children.indexOf(findChildren(fp, "property").pop() ?? fp.children[1]!) + 1, list("attr", sym("board_only")));
    else if (!attr.children.some((c) => isAtom(c) && c.raw === "board_only")) insertAt(attr, attr.children.length, sym("board_only"));
  }
  const anchor = findChild(fp, "attr") ?? findChildren(fp, "property").pop();
  let i = anchor ? fp.children.indexOf(anchor) + (headOf(anchor) === "attr" ? 0 : 1) : fp.children.length;
  if (o.path) insertAt(fp, i++, list("path", str(o.path)));
  if (o.sheetName) insertAt(fp, i++, list("sheetname", str(o.sheetName)));
  if (o.sheetFile) insertAt(fp, i++, list("sheetfile", str(o.sheetFile)));
  for (const [pad, net] of Object.entries(o.pads ?? {})) setPadNet(root, fp, pad, net);

  // After the last footprint, else before the first track.
  let index = -1;
  root.children.forEach((c, k) => {
    if (headOf(c) === "footprint") index = k;
  });
  if (index < 0) index = root.children.findIndex((c) => ["segment", "arc", "via", "zone", "embedded_fonts"].includes(headOf(c) ?? "")) - 1;
  if (index < -1) index = root.children.length - 1;
  insertAt(root, index + 1, format(fp, "\t"), "");
  if (o.layer === "B.Cu") flipFootprint(fp);
  return id;
}

/**
 * A library footprint's extent around its anchor (courtyard, else pads and
 * graphics), for laying out new footprints without overlaps.
 */
export function footprintExtent(modText: string): { x: number; y: number; w: number; h: number } {
  const fp = parseBoard(`(kicad_pcb (version 20260206)\n${modText}\n)`).footprints[0];
  const pts: Point[] = [];
  if (fp) {
    const court = fp.graphics.filter((g) => g.layer.endsWith("CrtYd"));
    for (const g of court.length ? court : fp.graphics) {
      if (g.kind === "circle" && g.points.length === 2) {
        const r = Math.hypot(g.points[1]!.x - g.points[0]!.x, g.points[1]!.y - g.points[0]!.y);
        pts.push({ x: g.points[0]!.x - r, y: g.points[0]!.y - r }, { x: g.points[0]!.x + r, y: g.points[0]!.y + r });
      } else pts.push(...g.points);
    }
    if (!court.length)
      for (const p of fp.pads) {
        const r = Math.max(p.size.x, p.size.y) / 2;
        pts.push({ x: p.at.x - r, y: p.at.y - r }, { x: p.at.x + r, y: p.at.y + r });
      }
  }
  if (!pts.length) return { x: -1, y: -1, w: 2, h: 2 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Lay out new footprints in rows (tallest first) starting at `origin`, each
 * cell its footprint's extent plus a gap. Returns each one's anchor position.
 */
export function packFootprints(items: Array<{ reference: string; extent: { x: number; y: number; w: number; h: number } }>, origin: Point, gap = 2): Record<string, Point> {
  const area = items.reduce((s, i) => s + (i.extent.w + gap) * (i.extent.h + gap), 0);
  const rowWidth = Math.max(40, Math.sqrt(area) * 1.4, ...items.map((i) => i.extent.w));
  const sorted = [...items].sort((a, b) => b.extent.h - a.extent.h);
  const out: Record<string, Point> = {};
  let x = 0, y = 0, rowH = 0;
  const g = (v: number) => Math.round(v * 4) / 4; // keep anchors on a 0.25 mm grid
  for (const i of sorted) {
    if (x > 0 && x + i.extent.w > rowWidth) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    out[i.reference] = { x: g(origin.x + x - i.extent.x), y: g(origin.y + y - i.extent.y) };
    x += i.extent.w + gap;
    rowH = Math.max(rowH, i.extent.h);
  }
  return out;
}

/**
 * Lay out new footprints the way their symbols sit in the schematic: target
 * positions scaled down, then each footprint (in reading order) nudged right
 * and down until its extent plus `gap` is clear of those already placed.
 * Parts that end up next to each other on the sheet start next to each other
 * on the board, so the first ratsnest is short and untangled.
 */
export function placeLikeSchematic(
  items: Array<{ reference: string; extent: { x: number; y: number; w: number; h: number }; target: Point }>,
  origin: Point,
  o: { scale?: number; gap?: number } = {},
): Record<string, Point> {
  const scale = o.scale ?? 0.6;
  const gap = o.gap ?? 1.5;
  if (!items.length) return {};
  const minX = Math.min(...items.map((i) => i.target.x));
  const minY = Math.min(...items.map((i) => i.target.y));
  const order = [...items].sort((a, b) => a.target.y - b.target.y || a.target.x - b.target.x);
  const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  const g = (v: number) => Math.round(v * 4) / 4;
  const out: Record<string, Point> = {};
  const clear = (b: { x0: number; y0: number; x1: number; y1: number }) => placed.every((p) => b.x1 + gap <= p.x0 || p.x1 + gap <= b.x0 || b.y1 + gap <= p.y0 || p.y1 + gap <= b.y0);
  for (const it of order) {
    const want = { x: origin.x + (it.target.x - minX) * scale, y: origin.y + (it.target.y - minY) * scale };
    // Search outward in growing rings for the nearest free spot.
    let at = want;
    const box = (p: Point) => ({ x0: p.x + it.extent.x, y0: p.y + it.extent.y, x1: p.x + it.extent.x + it.extent.w, y1: p.y + it.extent.y + it.extent.h });
    if (!clear(box(at))) {
      let found = false;
      for (let r = 1; r < 200 && !found; r++) {
        for (const [dx, dy] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]] as const) {
          const q = { x: want.x + dx, y: want.y + dy };
          if (clear(box(q))) {
            at = q;
            found = true;
            break;
          }
        }
      }
    }
    at = { x: g(at.x), y: g(at.y) };
    placed.push(box(at));
    out[it.reference] = at;
  }
  return out;
}

/**
 * KiCad's "Update Footprint from Library": the placed footprint `uuid` is replaced by the
 * library's current `modText`, keeping its position, rotation, side, reference, value and other
 * fields, its symbol link and its pads' nets (by pad number). Returns the new footprint's UUID.
 */
export function updateFootprintFromLibrary(root: List, uuid: string, modText: string): string | undefined {
  const old = root.children.find((c): c is List => isList(c) && headOf(c) === "footprint" && fpUuid(c) === uuid);
  if (!old) return undefined;
  const board = parseBoard(`(kicad_pcb (version 20260206)\n${serialize(old)}\n)`);
  const was = board.footprints[0];
  if (!was) return undefined;
  const pads: Record<string, string> = {};
  for (const p of was.pads) if (p.number && p.net) pads[p.number] = p.net;
  const fields = Object.fromEntries(Object.entries(was.properties).filter(([k]) => !["Reference", "Value", "Footprint"].includes(k)));
  const id = placeFootprint(root, modText, {
    at: was.at,
    layer: was.layer === "B.Cu" ? "B.Cu" : "F.Cu",
    reference: was.reference,
    value: was.value,
    libId: was.libId,
    path: was.path || undefined,
    sheetName: was.sheetName || undefined,
    sheetFile: was.sheetFile || undefined,
    fields,
    pads,
    boardOnly: was.attributes.boardOnly,
  });
  const fresh = root.children.find((c): c is List => isList(c) && headOf(c) === "footprint" && fpUuid(c) === id)!;
  // Placing (and flipping, for the back) leaves its own angle: turn the rest of the way.
  const now = Number(arg(findChild(fresh, "at"), 2) ?? 0);
  const turn = ((((was.rotation - now) % 360) + 540) % 360) - 180;
  if (Math.abs(turn) > 1e-9) rotateBoardItem(fresh, turn);
  // The placed footprint keeps its UUID (the schematic and DRC exclusions refer to it).
  setArg(findChild(fresh, "uuid")!, 0, str(uuid));
  removeChild(root, old);
  return uuid;
}
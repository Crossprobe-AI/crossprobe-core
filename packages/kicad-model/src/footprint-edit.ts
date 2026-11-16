/**
 * Footprint editing on a library footprint (.kicad_mod), as KiCad's footprint editor writes it:
 * pads, graphics on silkscreen / fab / courtyard, the reference and value fields and the
 * footprint's properties. Every item gets a UUID when the file is opened for editing (as KiCad's
 * editor saves them), and edits name items by UUID.
 */
import { arg, findChild, findChildren, format, headOf, insertAt, isAtom, isList, list, num, parse, removeChild, serialize, setArg, str, sym, type List, type Node } from "@crossprobe/kicad-sexpr";
import type { Point } from "./geometry.js";
import { newBoardUuid } from "./board-edit.js";

const PADS_AND_GRAPHICS = new Set(["pad", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_text", "property", "zone"]);

/** The footprint list of a .kicad_mod document. */
export function footprintNode(doc: { children: Node[] }): List {
  const fp = doc.children.find((c): c is List => isList(c) && (headOf(c) === "footprint" || headOf(c) === "module"));
  if (!fp) throw new Error("Not a KiCad footprint");
  return fp;
}

/** A new, empty footprint file: reference on silkscreen, value on fab, and the attributes for its kind. */
export function newFootprintText(name: string, o: { smd?: boolean; description?: string; tags?: string } = {}): string {
  const field = (key: string, value: string, y: number, layer: string, hide = false) =>
    `\t(property "${key}" "${value.replace(/"/g, "'")}"\n\t\t(at 0 ${y} 0)\n\t\t(layer "${layer}")\n${hide ? "\t\t(hide yes)\n" : ""}\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1 1)\n\t\t\t\t(thickness 0.15)\n\t\t\t)\n\t\t)\n\t)\n`;
  const text =
    `(footprint "${name.replace(/"/g, "'")}"\n\t(version 20260206)\n\t(generator "pcbnew")\n\t(generator_version "10.0")\n\t(layer "F.Cu")\n` +
    (o.description ? `\t(descr "${o.description.replace(/"/g, "'")}")\n` : "") +
    (o.tags ? `\t(tags "${o.tags.replace(/"/g, "'")}")\n` : "") +
    field("Reference", "REF**", -2, "F.SilkS") +
    field("Value", name, 2, "F.Fab") +
    field("Datasheet", "", 0, "F.Fab", true) +
    field("Description", o.description ?? "", 0, "F.Fab", true) +
    `\t(attr ${o.smd === false ? "through_hole" : "smd"})\n\t(embedded_fonts no)\n)\n`;
  return withUuids(text);
}

/** The footprint with a UUID on every pad, graphic and field that lacks one (as KiCad's editor saves it). */
export function withUuids(text: string): string {
  const doc = parse(text, { recover: true });
  const fp = footprintNode(doc);
  let changed = false;
  for (const c of fp.children) {
    if (!isList(c) || !PADS_AND_GRAPHICS.has(headOf(c) ?? "") || findChild(c, "uuid")) continue;
    // KiCad writes the uuid after the layer(s) of graphics, after the layers / properties of pads.
    const after = findChild(c, "layer") ?? findChild(c, "layers") ?? findChild(c, "at");
    insertAt(c, after ? c.children.indexOf(after) + 1 : c.children.length, list("uuid", str(newBoardUuid())));
    changed = true;
  }
  return changed ? serialize(doc) : text;
}

const uuidOf = (n: List) => String(arg(findChild(n, "uuid"), 0) ?? "");
export const fpItem = (fp: List, uuid: string) => fp.children.find((c): c is List => isList(c) && uuidOf(c) === uuid);

/** Where new items go: before the embedded fonts / 3D model trailer. */
function insertIndex(fp: List): number {
  const tail = fp.children.findIndex((c) => isList(c) && ["embedded_fonts", "model", "embedded_files"].includes(headOf(c) ?? ""));
  return tail >= 0 ? tail : fp.children.length;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const xy = (head: string, p: Point) => list(head, num(r6(p.x)), num(r6(p.y)));

export interface NewPad {
  number: string;
  type: "smd" | "thru_hole" | "np_thru_hole";
  shape: "rect" | "roundrect" | "circle" | "oval";
  at: Point;
  size: Point;
  drill?: number;
  rotation?: number;
  /** Default: KiCad's for the type (SMD front copper, mask and paste; through-hole all copper and both masks). */
  layers?: string[];
  roundrectRatio?: number;
  /** Local solder mask expansion, paste expansion (mm) and paste ratio (−0.2 = 20% smaller); undefined = the footprint's / board's. */
  maskMargin?: number | null;
  pasteMargin?: number | null;
  pasteRatio?: number | null;
  /** A heatsink pad (exposed pads): KiCad's pad_prop_heatsink, joined solidly to zones. */
  heatsink?: boolean;
}

/** Add a pad; returns its UUID. */
export function addFpPad(fp: List, p: NewPad): string {
  const id = newBoardUuid();
  const layers = p.layers ?? (p.type === "smd" ? ["F.Cu", "F.Mask", "F.Paste"] : p.type === "np_thru_hole" ? ["*.Cu", "*.Mask"] : ["*.Cu", "*.Mask"]);
  const at = list("at", num(r6(p.at.x)), num(r6(p.at.y)), ...(p.rotation ? [num(r6(p.rotation))] : []));
  const parts: List[] = [at, xy("size", p.size)];
  if (p.type !== "smd") parts.push(list("drill", num(r6(p.drill ?? Math.min(p.size.x, p.size.y) * 0.6))));
  parts.push(list("layers", ...layers.map((l) => str(l))));
  if (p.shape === "roundrect") parts.push(list("roundrect_rratio", num(p.roundrectRatio ?? 0.25)));
  if (p.maskMargin != null) parts.push(list("solder_mask_margin", num(r6(p.maskMargin))));
  if (p.pasteMargin != null) parts.push(list("solder_paste_margin", num(r6(p.pasteMargin))));
  if (p.pasteRatio != null) parts.push(list("solder_paste_margin_ratio", num(r6(p.pasteRatio))));
  if (p.heatsink) parts.push(list("property", sym("pad_prop_heatsink")), list("zone_connect", num(2)));
  parts.push(list("uuid", str(id)));
  const pad = list("pad", str(p.type === "np_thru_hole" ? "" : p.number), sym(p.type), sym(p.shape), ...parts);
  insertAt(fp, insertIndex(fp), format(pad, "\t"));
  return id;
}

/** A row or grid of pads (headers, QFN / QFP sides), numbered on from `first`; returns their UUIDs. */
export function addFpPadArray(fp: List, base: Omit<NewPad, "number" | "at">, o: { first: number; columns: number; rows: number; pitch: Point; origin: Point; step?: number }): string[] {
  const ids: string[] = [];
  let n = o.first;
  for (let r = 0; r < o.rows; r++)
    for (let c = 0; c < o.columns; c++) {
      ids.push(addFpPad(fp, { ...base, number: String(n), at: { x: o.origin.x + c * o.pitch.x, y: o.origin.y + r * o.pitch.y } }));
      n += o.step ?? 1;
    }
  return ids;
}

/** Change a pad's number, type, shape, size, drill, rotation or layers. */
export function setFpPad(fp: List, uuid: string, p: Partial<Omit<NewPad, "at">>): void {
  const pad = fpItem(fp, uuid);
  if (!pad || headOf(pad) !== "pad") return;
  if (p.number !== undefined) setArg(pad, 0, str(p.number));
  if (p.type !== undefined) setArg(pad, 1, sym(p.type));
  if (p.shape !== undefined) setArg(pad, 2, sym(p.shape));
  if (p.size) {
    const s = findChild(pad, "size");
    if (s) {
      setArg(s, 0, num(r6(p.size.x)));
      setArg(s, 1, num(r6(p.size.y)));
    }
  }
  const type = String(arg(pad, 1) ?? "");
  const drill = findChild(pad, "drill");
  if (type === "smd") {
    if (drill) removeChild(pad, drill);
  } else if (p.drill !== undefined || !drill) {
    const d = p.drill ?? (() => {
      const s = findChild(pad, "size");
      return Math.min(Number(arg(s, 0) ?? 1), Number(arg(s, 1) ?? 1)) * 0.6;
    })();
    if (drill) setArg(drill, 0, num(r6(d)));
    else insertAt(pad, pad.children.indexOf(findChild(pad, "size")!) + 1, list("drill", num(r6(d))));
  }
  if (p.type !== undefined && !p.layers) p.layers = p.type === "smd" ? ["F.Cu", "F.Mask", "F.Paste"] : ["*.Cu", "*.Mask"];
  if (p.layers) {
    const l = findChild(pad, "layers");
    const fresh = list("layers", ...p.layers.map((x) => str(x)));
    if (l) pad.children[pad.children.indexOf(l)] = fresh;
  }
  const rr = findChild(pad, "roundrect_rratio");
  const shape = String(arg(pad, 2) ?? "");
  if (shape === "roundrect" && !rr) insertAt(pad, pad.children.indexOf(findChild(pad, "layers")!) + 1, list("roundrect_rratio", num(p.roundrectRatio ?? 0.25)));
  if (shape !== "roundrect" && rr) removeChild(pad, rr);
  // Margins: a number sets the pad's own, null removes it (back to the footprint's or board's).
  for (const [key, head] of [["maskMargin", "solder_mask_margin"], ["pasteMargin", "solder_paste_margin"], ["pasteRatio", "solder_paste_margin_ratio"]] as const) {
    const v = p[key];
    if (v === undefined) continue;
    const n = findChild(pad, head);
    if (v === null) {
      if (n) removeChild(pad, n);
    } else if (n) setArg(n, 0, num(r6(v)));
    else insertAt(pad, pad.children.indexOf(findChild(pad, "layers")!) + 1, list(head, num(r6(v))));
  }
  if (p.heatsink !== undefined) {
    const prop = findChildren(pad, "property").find((q) => q.children.some((c) => isAtom(c) && c.raw === "pad_prop_heatsink"));
    const zc = findChild(pad, "zone_connect");
    if (p.heatsink && !prop) {
      insertAt(pad, pad.children.indexOf(findChild(pad, "layers")!) + 1, list("property", sym("pad_prop_heatsink")));
      if (!zc) insertAt(pad, pad.children.indexOf(findChild(pad, "layers")!) + 1, list("zone_connect", num(2)));
    }
    if (!p.heatsink && prop) {
      removeChild(pad, prop);
      if (zc && Number(arg(zc, 0)) === 2) removeChild(pad, zc);
    }
  }
  if (p.rotation !== undefined) {
    const at = findChild(pad, "at")!;
    if (at.children.length > 3) setArg(at, 2, num(r6(p.rotation)));
    else if (p.rotation) insertAt(at, at.children.length, num(r6(p.rotation)));
  }
}

/** Move items (pads, graphics, fields) by an offset in the footprint frame. */
export function moveFpItems(fp: List, uuids: string[], d: Point): void {
  for (const u of uuids) {
    const n = fpItem(fp, u);
    if (!n) continue;
    const shift = (node: List) => {
      for (const c of node.children) {
        if (!isList(c)) continue;
        const h = headOf(c);
        if (h === "at" || h === "start" || h === "end" || h === "center" || h === "mid" || h === "xy") {
          setArg(c, 0, num(r6(Number(arg(c, 0)) + d.x)));
          setArg(c, 1, num(r6(Number(arg(c, 1)) + d.y)));
        } else if (h === "pts") shift(c);
      }
    };
    shift(n);
  }
}

/** Delete items by UUID (the reference and value fields stay: KiCad keeps them). */
export function deleteFpItems(fp: List, uuids: string[]): void {
  for (const u of uuids) {
    const n = fpItem(fp, u);
    if (!n) continue;
    if (headOf(n) === "property" && ["Reference", "Value"].includes(String(arg(n, 0)))) continue;
    removeChild(fp, n);
  }
}

export interface NewGraphic {
  kind: "line" | "rect" | "circle" | "poly" | "arc";
  layer: string;
  /** line / rect: start, end · circle: centre, a point on it · arc: start, a point on it, end · poly: the corners. */
  points: Point[];
  width?: number;
  fill?: boolean;
}

/** KiCad's default line widths per layer (silkscreen 0.12, fab 0.1, courtyard 0.05). */
export const defaultLineWidth = (layer: string) => (/SilkS/.test(layer) ? 0.12 : /CrtYd/.test(layer) ? 0.05 : /Fab/.test(layer) ? 0.1 : 0.1);

/** Add a line, rectangle, circle or polygon on a layer; returns its UUID. */
export function addFpGraphic(fp: List, g: NewGraphic): string {
  const id = newBoardUuid();
  const stroke = list("stroke", list("width", num(g.width ?? defaultLineWidth(g.layer))), list("type", sym("solid")));
  const fill = list("fill", sym(g.fill ? "yes" : "no"));
  const [a, b] = g.points;
  let node: List;
  if (g.kind === "line") node = list("fp_line", xy("start", a!), xy("end", b!), stroke, list("layer", str(g.layer)), list("uuid", str(id)));
  else if (g.kind === "rect") node = list("fp_rect", xy("start", a!), xy("end", b!), stroke, fill, list("layer", str(g.layer)), list("uuid", str(id)));
  else if (g.kind === "circle") node = list("fp_circle", xy("center", a!), xy("end", b!), stroke, fill, list("layer", str(g.layer)), list("uuid", str(id)));
  else if (g.kind === "arc") node = list("fp_arc", xy("start", a!), xy("mid", b!), xy("end", g.points[2]!), stroke, list("layer", str(g.layer)), list("uuid", str(id)));
  else node = list("fp_poly", list("pts", ...g.points.map((p) => xy("xy", p))), stroke, fill, list("layer", str(g.layer)), list("uuid", str(id)));
  insertAt(fp, insertIndex(fp), format(node, "\t"));
  return id;
}

/** The footprint's name (and its Value field when that still showed the old name), description, tags and kind. */
export function setFpProps(fp: List, p: { name?: string; description?: string; tags?: string; attr?: "smd" | "through_hole" | "unspecified"; excludeFromBom?: boolean; excludeFromPos?: boolean }): void {
  if (p.name !== undefined) {
    const old = String(arg(fp, 0) ?? "");
    setArg(fp, 0, str(p.name));
    const value = findChildren(fp, "property").find((q) => arg(q, 0) === "Value");
    if (value && arg(value, 1) === old) setArg(value, 1, str(p.name));
  }
  const textItem = (head: string, value: string | undefined) => {
    if (value === undefined) return;
    const n = findChild(fp, head);
    if (n) setArg(n, 0, str(value));
    else insertAt(fp, fp.children.indexOf(findChild(fp, "layer") ?? fp.children[1]!) + 1, list(head, str(value)));
  };
  textItem("descr", p.description);
  textItem("tags", p.tags);
  if (p.description !== undefined) {
    const d = findChildren(fp, "property").find((q) => arg(q, 0) === "Description");
    if (d) setArg(d, 1, str(p.description));
  }
  if (p.attr !== undefined || p.excludeFromBom !== undefined || p.excludeFromPos !== undefined) {
    const old = findChild(fp, "attr");
    const words = old ? old.children.slice(1).filter(isAtom).map((a) => a.raw) : [];
    const kind = p.attr ?? words.find((w) => w === "smd" || w === "through_hole") ?? "unspecified";
    const flag = (w: string, on: boolean | undefined) => (on === undefined ? words.includes(w) : on);
    const out = [...(kind === "unspecified" ? [] : [kind]), ...words.filter((w) => !["smd", "through_hole", "exclude_from_bom", "exclude_from_pos_files"].includes(w))];
    if (flag("exclude_from_pos_files", p.excludeFromPos)) out.push("exclude_from_pos_files");
    if (flag("exclude_from_bom", p.excludeFromBom)) out.push("exclude_from_bom");
    const fresh = list("attr", ...out.map((w) => sym(w)));
    if (old) fp.children[fp.children.indexOf(old)] = fresh;
    else insertAt(fp, insertIndex(fp), fresh);
  }
}

/**
 * A courtyard around everything (pads and body on fab), KiCad library style: the bounding box
 * grown by `excess` (IPC-7351 nominal 0.25 mm) on a 0.01 mm grid, replacing any courtyard there was.
 */
export function setFpCourtyard(fp: List, excess = 0.25): string | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (p: Point, r = 0) => {
    x0 = Math.min(x0, p.x - r); y0 = Math.min(y0, p.y - r); x1 = Math.max(x1, p.x + r); y1 = Math.max(y1, p.y + r);
  };
  const pt = (n: List | undefined) => ({ x: Number(arg(n, 0) ?? 0), y: Number(arg(n, 1) ?? 0) });
  for (const c of fp.children) {
    if (!isList(c)) continue;
    const h = headOf(c);
    if (h === "pad") {
      const at = pt(findChild(c, "at"));
      const s = pt(findChild(c, "size"));
      const rot = (Number(arg(findChild(c, "at"), 2) ?? 0) * Math.PI) / 180;
      const hw = (Math.abs(Math.cos(rot)) * s.x + Math.abs(Math.sin(rot)) * s.y) / 2;
      const hh = (Math.abs(Math.sin(rot)) * s.x + Math.abs(Math.cos(rot)) * s.y) / 2;
      take({ x: at.x - hw, y: at.y - hh });
      take({ x: at.x + hw, y: at.y + hh });
    } else if (h && h.startsWith("fp_") && /Fab$/.test(String(arg(findChild(c, "layer"), 0) ?? ""))) {
      if (h === "fp_circle") {
        const c0 = pt(findChild(c, "center"));
        const e = pt(findChild(c, "end"));
        take(c0, Math.hypot(e.x - c0.x, e.y - c0.y));
      } else for (const k of ["start", "end", "mid"]) if (findChild(c, k)) take(pt(findChild(c, k)));
      const pts = findChild(c, "pts");
      if (pts) for (const q of findChildren(pts, "xy")) take(pt(q));
    }
  }
  if (!Number.isFinite(x0)) return undefined;
  for (const c of [...fp.children]) if (isList(c) && String(arg(findChild(c, "layer"), 0) ?? "") === "F.CrtYd") removeChild(fp, c);
  const g = (v: number, up: boolean) => (up ? Math.ceil(v * 100 - 1e-6) : Math.floor(v * 100 + 1e-6)) / 100;
  return addFpGraphic(fp, { kind: "rect", layer: "F.CrtYd", points: [{ x: g(x0 - excess, false), y: g(y0 - excess, false) }, { x: g(x1 + excess, true), y: g(y1 + excess, true) }], width: 0.05 });
}

/** Set a field's text (Reference "REF**", Value, Datasheet …). */
export function setFpField(fp: List, name: string, value: string): void {
  const f = findChildren(fp, "property").find((q) => arg(q, 0) === name);
  if (f) setArg(f, 1, str(value));
}

/**
 * Paste openings on an exposed pad, as KiCad's footprint generator makes them: the pad keeps its
 * copper and mask but no paste, and a grid of unnumbered paste-only pads covers `coverage` of its
 * area, one centred in each cell (a 1.7 mm pad, 2 × 2 at 66 %: 0.69 mm openings 0.85 mm apart).
 */
export function addFpPasteWindows(fp: List, uuid: string, o: { columns: number; rows: number; coverage: number }): string[] {
  const pad = fpItem(fp, uuid);
  if (!pad || headOf(pad) !== "pad") return [];
  const at = findChild(pad, "at")!;
  const c = { x: Number(arg(at, 0)), y: Number(arg(at, 1)) };
  const rot = Number(arg(at, 2) ?? 0);
  const size = findChild(pad, "size")!;
  const W = Number(arg(size, 0));
  const H = Number(arg(size, 1));
  const layers = findChild(pad, "layers")!;
  const kept = layers.children.slice(1).filter((l) => isAtom(l) && !/Paste/.test(l.raw));
  pad.children[pad.children.indexOf(layers)] = list("layers", ...kept);
  const k = Math.sqrt(Math.max(0.05, Math.min(1, o.coverage)));
  const cw = W / o.columns;
  const ch = H / o.rows;
  const r = (rot * Math.PI) / 180;
  const ids: string[] = [];
  for (let j = 0; j < o.rows; j++)
    for (let i = 0; i < o.columns; i++) {
      const lx = -W / 2 + cw * (i + 0.5);
      const ly = -H / 2 + ch * (j + 0.5);
      // Into the footprint frame (pad angles are counter-clockwise).
      const p = { x: c.x + lx * Math.cos(r) + ly * Math.sin(r), y: c.y - lx * Math.sin(r) + ly * Math.cos(r) };
      ids.push(addFpPad(fp, { number: "", type: "smd", shape: "roundrect", at: { x: r6(p.x), y: r6(p.y) }, size: { x: r6(cw * k), y: r6(ch * k) }, rotation: rot || undefined, layers: ["F.Paste"] }));
    }
  return ids;
}

/** Turn items by `deg` (KiCad: counter-clockwise) about `center`: positions, pad angles and end points. */
export function rotateFpItems(fp: List, uuids: string[], center: Point, deg: number): void {
  const r = (deg * Math.PI) / 180;
  const turn = (p: Point) => {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    return { x: r6(center.x + dx * Math.cos(r) + dy * Math.sin(r)), y: r6(center.y - dx * Math.sin(r) + dy * Math.cos(r)) };
  };
  for (const u of uuids) {
    const n = fpItem(fp, u);
    if (!n) continue;
    const visit = (node: List) => {
      for (const c of node.children) {
        if (!isList(c)) continue;
        const h = headOf(c);
        if (h === "at" || h === "start" || h === "end" || h === "center" || h === "mid" || h === "xy") {
          const q = turn({ x: Number(arg(c, 0)), y: Number(arg(c, 1)) });
          setArg(c, 0, num(q.x));
          setArg(c, 1, num(q.y));
          if (h === "at" && headOf(n) === "pad") {
            const a = ((((Number(arg(c, 2) ?? 0) + deg) % 360) + 360) % 360);
            if (c.children.length > 3) setArg(c, 2, num(r6(a)));
            else if (a) insertAt(c, c.children.length, num(r6(a)));
          }
        } else if (h === "pts") visit(c);
      }
    };
    visit(n);
    // A rectangle stays axis-aligned in KiCad: at a quarter turn its corners just swap.
  }
}

/** Put a field (Reference, Value …) at a position in the footprint frame. */
export function placeFpField(fp: List, name: string, at: Point): void {
  const f = findChildren(fp, "property").find((q) => arg(q, 0) === name);
  const a = f && findChild(f, "at");
  if (!a) return;
  setArg(a, 0, num(r6(at.x)));
  setArg(a, 1, num(r6(at.y)));
}

/** The courtyard's extent (F.CrtYd), if the footprint has one. */
export function fpCourtyardBox(fp: List): { x0: number; y0: number; x1: number; y1: number } | undefined {
  let box: { x0: number; y0: number; x1: number; y1: number } | undefined;
  for (const c of fp.children) {
    if (!isList(c) || String(arg(findChild(c, "layer"), 0) ?? "") !== "F.CrtYd") continue;
    const pts = [findChild(c, "start"), findChild(c, "end"), ...findChildren(findChild(c, "pts") ?? list("pts"), "xy")].filter((n): n is List => !!n).map((n) => ({ x: Number(arg(n, 0)), y: Number(arg(n, 1)) }));
    for (const p of pts) box = box ? { x0: Math.min(box.x0, p.x), y0: Math.min(box.y0, p.y), x1: Math.max(box.x1, p.x), y1: Math.max(box.y1, p.y) } : { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }
  return box;
}
/**
 * Mirror items across a line through `at` as KiCad's footprint editor does: "x" flips left and
 * right (a vertical line), "y" top and bottom. Positions and shape points mirror; a pad's angle
 * θ becomes −θ, its offset mirrors, and a custom pad's primitives mirror in its own frame. Text
 * stays readable: its position mirrors, and left/right justification swaps when it runs across
 * the line.
 */
export function mirrorFpItems(fp: List, uuids: string[], at: number, axis: "x" | "y"): void {
  const k = axis === "x" ? 0 : 1;
  const flip = (c: List, about: number) => setArg(c, k, num(r6(2 * about - Number(arg(c, k)))));
  const flipAll = (node: List, about: number) => {
    for (const c of node.children) {
      if (!isList(c)) continue;
      const h = headOf(c);
      if (h === "start" || h === "end" || h === "center" || h === "mid" || h === "xy") flip(c, about);
      else if (h === "pts" || h === "gr_poly" || h === "gr_line" || h === "gr_arc" || h === "gr_circle" || h === "gr_rect") flipAll(c, about);
    }
  };
  for (const u of uuids) {
    const n = fpItem(fp, u);
    if (!n) continue;
    const head = headOf(n);
    const pos = findChild(n, "at");
    if (pos) flip(pos, at);
    flipAll(n, at);
    if (head === "pad") {
      const a = Number(arg(pos, 2) ?? 0);
      const angle = r6(((-a % 360) + 360) % 360);
      if (pos!.children.length > 3) setArg(pos!, 2, num(angle));
      else if (angle) insertAt(pos!, pos!.children.length, num(angle));
      const offset = findChild(findChild(n, "drill") ?? n, "offset");
      if (offset) flip(offset, 0);
      const prims = findChild(n, "primitives");
      if (prims) flipAll(prims, 0);
    }
    if (head === "property" || head === "fp_text") {
      const angle = ((Number(arg(pos, 2) ?? 0) % 360) + 360) % 360;
      if ((axis === "x" && angle % 180 === 0) || (axis === "y" && angle % 180 === 90)) {
        const justify = findChild(findChild(n, "effects") ?? n, "justify");
        if (justify)
          for (const c of justify.children)
            if (isAtom(c) && (c.raw === "left" || c.raw === "right")) c.raw = c.raw === "left" ? "right" : "left";
      }
    }
  }
}

/** Number pads in the given order: first, first + step, … with an optional prefix (KiCad's renumber tool). */
export function renumberFpPads(fp: List, uuids: string[], o: { first?: number; step?: number; prefix?: string } = {}): void {
  let n = o.first ?? 1;
  for (const u of uuids) {
    const pad = fpItem(fp, u);
    if (!pad || headOf(pad) !== "pad" || String(arg(pad, 1)) === "np_thru_hole") continue;
    setArg(pad, 0, str(`${o.prefix ?? ""}${n}`));
    n += o.step ?? 1;
  }
}

/**
 * A pad of any shape (KiCad's custom pad): the polygon, in footprint coordinates, becomes the
 * pad's primitive around an anchor at `at` (a small round anchor, as KiCad's editor makes them).
 */
export function addFpCustomPad(fp: List, p: { number: string; type: "smd" | "thru_hole"; at: Point; polygon: Point[]; drill?: number; layers?: string[]; anchor?: number }): string {
  const id = newBoardUuid();
  const anchor = p.anchor ?? (p.drill ? p.drill + 0.2 : 0.2);
  const layers = p.layers ?? (p.type === "smd" ? ["F.Cu", "F.Mask", "F.Paste"] : ["*.Cu", "*.Mask"]);
  const parts: List[] = [list("at", num(r6(p.at.x)), num(r6(p.at.y))), xy("size", { x: anchor, y: anchor })];
  if (p.type !== "smd") parts.push(list("drill", num(r6(p.drill ?? 0.8))));
  parts.push(list("layers", ...layers.map((l) => str(l))));
  parts.push(list("options", list("clearance", sym("outline")), list("anchor", sym("circle"))));
  const pts = list("pts", ...p.polygon.map((q) => xy("xy", { x: q.x - p.at.x, y: q.y - p.at.y })));
  parts.push(list("primitives", list("gr_poly", pts, list("width", num(0)), list("fill", sym("yes")))));
  parts.push(list("uuid", str(id)));
  const pad = list("pad", str(p.number), sym(p.type), sym("custom"), ...parts);
  insertAt(fp, insertIndex(fp), format(pad, "\t"));
  return id;
}

export interface FpModel {
  path: string;
  offset?: Point & { z?: number };
  scale?: { x: number; y: number; z: number };
  rotate?: { x: number; y: number; z: number };
}

/** The footprint's 3D model (KiCad's (model …)): set, or removed with null. One model is kept. */
export function setFpModel(fp: List, m: FpModel | null): void {
  for (const old of findChildren(fp, "model")) removeChild(fp, old);
  if (!m) return;
  const v3 = (head: string, v: { x: number; y: number; z?: number }) => list(head, list("xyz", num(r6(v.x)), num(r6(v.y)), num(r6(v.z ?? 0))));
  const node = list("model", str(m.path), v3("offset", m.offset ?? { x: 0, y: 0, z: 0 }), v3("scale", m.scale ?? { x: 1, y: 1, z: 1 }), v3("rotate", m.rotate ?? { x: 0, y: 0, z: 0 }));
  insertAt(fp, fp.children.length, format(node, "\t"));
}

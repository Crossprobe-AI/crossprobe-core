/**
 * The PCB half of a design block: `generateBlockBoard` builds the block's
 * .kicad_pcb from its spec and its (generated) schematic.
 *
 * Pad nets come from the schematic's own netlist, so they carry KiCad's names
 * for every net, including `unconnected-(U1-IO3-Pad15)` for pins left open,
 * and each footprint is linked to its schematic symbol, which is what makes
 * "Update PCB from schematic" and KiCad's parity check agree. Footprints are
 * placed from the spec's layout and tracks and vias are routed between pads
 * by name ("C1.1"), so a route stays attached when a footprint moves.
 */
import { arg, findChild, findChildren, format, headOf, insertAt, isList, parse, serialize, setArg, str, type List } from "@crossprobe/kicad-sexpr";
import { addTrack, addVia, boardRoot, findBoardItem, moveBoardItem, newBoardUuid, rotateBoardItem, rotatePoint, setFootprintField, setPadNet } from "./board-edit.js";
import { footprintPath, placeFootprint } from "./board-update.js";
import { buildNetlist } from "./connectivity.js";
import { stableUuids, type BlockSpec, type BoardPoint, type InsertedBlock } from "./design-block.js";
import { newProject } from "./new-project.js";
import { loadSchematic } from "./project.js";

export type FootprintText = (libId: string) => string;

const SIDE = { track: 0.2, via: 0.6, drill: 0.3 };

/** Generate the block's board file text. `footprints` returns a .kicad_mod's text by "Library:Name". */
export function generateBlockBoard(spec: BlockSpec, schematicText: string, footprints: FootprintText): string {
  const layout = spec.layout;
  if (!layout) throw new Error(`${spec.id} has no layout`);
  const file = "block.kicad_sch";
  const schematic = loadSchematic(file, (f) => (f === file ? schematicText : ""));
  const netlist = buildNetlist(schematic);

  // "REF.pin" → the net's name in the schematic, and symbol links.
  const padNet = new Map<string, string>();
  for (const net of netlist.nets) for (const n of net.nodes) padNet.set(`${n.reference}.${n.pin}`, net.name);
  const symbols = new Map(schematic.placements.map((p) => [p.reference, p]));

  // The spec's net names → the schematic's (a label "EN" is "/EN" on the root sheet): via any pin on the net.
  const boardNet = new Map<string, string>();
  for (const part of spec.parts) {
    for (const [key, net] of Object.entries(part.pins)) {
      if (boardNet.has(net)) continue;
      const pin = [...padNet.keys()].find((k) => k.startsWith(`${part.ref}.`) && k.slice(part.ref.length + 1) === key);
      if (pin) boardNet.set(net, padNet.get(pin)!);
    }
  }

  // Start from KiCad's empty board, titled for the block.
  // No date: the file is generated, and must come out the same whichever day it is built.
  const base = newProject(spec.title, { title: spec.title, date: "" });
  const doc = parse(base.files[base.project.replace(/\.kicad_pro$/, ".kicad_pcb")]!, { recover: true });
  const root = boardRoot(doc);

  const placed = new Map<string, { node: List; at: { x: number; y: number }; angle: number }>();
  for (const part of spec.parts) {
    const place = layout.parts[part.ref];
    if (!place) continue;
    if (!part.footprint) throw new Error(`${part.ref} is placed but has no footprint`);
    const symbol = symbols.get(part.ref);
    if (!symbol) throw new Error(`${part.ref} is not in the schematic`);
    const pads: Record<string, string> = {};
    for (const [k, v] of padNet) if (k.startsWith(`${part.ref}.`)) pads[k.slice(part.ref.length + 1)] = v;
    const id = placeFootprint(root, footprints(part.footprint), {
      at: { x: place.at[0], y: place.at[1] },
      reference: part.ref,
      value: part.value,
      libId: part.footprint,
      path: footprintPath(symbol.sheet.path, symbol.symbol.uuid),
      // KiCad's parity check compares these two with the symbol's.
      fields: Object.fromEntries(Object.entries(symbol.symbol.properties).filter(([k, v]) => !["Reference", "Value", "Footprint"].includes(k) && !k.startsWith("ki_") && v !== "~" && v !== "")),
      pads,
    });
    const node = findBoardItem(root, id)!;
    if (place.rotate) rotateBoardItem(node, place.rotate);
    if (spec.layout?.fabReferences) {
      // Dense placements: reference designators go on the fab layer so they do not collide on the silkscreen.
      const ref = findChildren(node, "property").find((q) => arg(q, 0) === "Reference");
      const layer = ref && findChild(ref, "layer");
      if (layer) setArg(layer, 0, str("F.Fab"));
    }
    if (part.dnp) {
      const attr = findChild(node, "attr");
      if (attr && !attr.children.some((c) => (c as { raw?: string }).raw === "dnp")) attr.children.push({ type: "atom", kind: "symbol", raw: "dnp" } as never), attr.trivia.push(" ");
    }
    placed.set(part.ref, { node, at: { x: place.at[0], y: place.at[1] }, angle: place.rotate ?? 0 });
  }

  /** A pad's centre on the board, or a literal point. */
  const where = (p: BoardPoint): { x: number; y: number } => {
    if (typeof p !== "string") return { x: p[0], y: p[1] };
    const [ref, padNo] = p.split(".") as [string, string];
    const fp = placed.get(ref);
    if (!fp) throw new Error(`layout: ${p} is not a placed part`);
    const pad = findChildren(fp.node, "pad").find((q) => String(arg(q, 0)) === padNo);
    const at = pad && findChild(pad, "at");
    if (!at) throw new Error(`layout: ${p} has no such pad`);
    // Pad positions are stored in the footprint's own frame; rotate them with the footprint.
    return rotatePoint({ x: fp.at.x + Number(arg(at, 0)), y: fp.at.y + Number(arg(at, 1)) }, fp.at, fp.angle);
  };
  const netName = (n: string): string => {
    const name = boardNet.get(n);
    if (!name) throw new Error(`layout: net "${n}" is not in the schematic`);
    return name;
  };

  for (const t of layout.tracks ?? []) {
    const pts = t.path.map(where);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (a.x === b.x && a.y === b.y) continue;
      addTrack(root, { start: a, end: b, width: t.width || SIDE.track, layer: t.layer ?? "F.Cu", net: netName(t.net) });
    }
  }
  for (const v of layout.vias ?? []) addVia(root, { at: where(v.at), size: v.size ?? SIDE.via, drill: v.drill ?? SIDE.drill, layers: ["F.Cu", "B.Cu"], net: netName(v.net) });

  // Stable ids for everything except the symbol links, which must stay equal to the schematic's.
  const links: string[] = [];
  const masked = serialize(doc).replace(/\(path "([^"]*)"\)/g, (_m, p: string) => `(path "@@${links.push(p) - 1}@@")`);
  return stableUuids(masked, `${spec.id}:pcb`).replace(/@@(\d+)@@/g, (_m, i: string) => links[Number(i)]!);
}

/** Top-left corner of a block board's copper and footprints, for placing it. */
function blockCorner(root: List): { x: number; y: number } {
  let x = Infinity;
  let y = Infinity;
  for (const item of root.children) {
    if (!isList(item)) continue;
    const head = headOf(item);
    const pts: Array<[number, number]> = [];
    if (head === "footprint" || head === "via") {
      const at = findChild(item, "at");
      if (at) pts.push([Number(arg(at, 0)), Number(arg(at, 1))]);
    } else if (head === "segment") {
      for (const k of ["start", "end"]) {
        const n = findChild(item, k);
        if (n) pts.push([Number(arg(n, 0)), Number(arg(n, 1))]);
      }
    }
    for (const [px, py] of pts) {
      x = Math.min(x, px);
      y = Math.min(y, py);
    }
  }
  return { x, y };
}

/** Every (x, y) a board item carries in its own start/end/center/at/xy children (footprint pads are not looked at). */
function points(node: List, out: Array<[number, number]> = []): Array<[number, number]> {
  const head = headOf(node);
  if (["start", "end", "center", "xy"].includes(head ?? "") || (head === "at" && node.children.length >= 3)) {
    out.push([Number(arg(node, 0)), Number(arg(node, 1))]);
    return out;
  }
  if (head === "pad" || head === "property" || head === "fp_text" || head === "model") return out;
  for (const c of node.children) if (isList(c)) points(c, out);
  return out;
}

/** A free spot on a board: right of everything on it, top-aligned with it; (20, 20) when it is empty. */
export function findFreeBoardSpot(root: List, gap = 15): { x: number; y: number } {
  let maxX = -Infinity;
  let minY = Infinity;
  for (const item of root.children) {
    if (!isList(item) || !["footprint", "segment", "arc", "via", "zone", "gr_line", "gr_rect", "gr_poly", "gr_circle", "gr_arc"].includes(headOf(item) ?? "")) continue;
    const pts = headOf(item) === "footprint" ? [[Number(arg(findChild(item, "at"), 0)), Number(arg(findChild(item, "at"), 1))] as [number, number]] : points(item);
    for (const [x, y] of pts) {
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
    }
  }
  return maxX === -Infinity ? { x: 20, y: 20 } : { x: Math.round(maxX + gap), y: Math.round(minY) };
}

export interface InsertBoardOptions {
  /** Where the block's top-left corner goes; default: free space to the right of the board's content. */
  at?: { x: number; y: number };
  /** From insertBlock: which block symbol became which new symbol, so each footprint links to its new symbol. */
  symbols: InsertedBlock["symbols"];
  /** The sheet instance path the block's symbols went into. */
  sheetPath: string;
  /** The reference a block footprint gets (after annotation). Default: its own. */
  reference?: (blockReference: string) => string;
  /** The net a pad is on in the target schematic, by (new) reference and pad. Default: keep the block's net names. */
  netOf?: (reference: string, pad: string) => string | undefined;
}

/**
 * Copy a block's board into `target`: footprints linked to the symbols just
 * inserted, tracks and vias on the nets the target schematic now has. Returns
 * the new footprints' UUIDs.
 */
export function insertBlockBoard(target: List, blockPcb: string, o: InsertBoardOptions): string[] {
  const src = boardRoot(parse(blockPcb, { recover: true }));
  const corner = blockCorner(src);
  const at = o.at ?? findFreeBoardSpot(target);
  const dx = at.x - corner.x;
  const dy = at.y - corner.y;
  const newSymbol = new Map(o.symbols.map((s) => [s.blockUuid, s.uuid]));

  // The block's net names → the target's, learned from the pads.
  const rename = new Map<string, string>();
  const ref = (fp: List) => String(arg(findChildren(fp, "property").find((p) => arg(p, 0) === "Reference"), 1) ?? "");
  for (const fp of findChildren(src, "footprint")) {
    const newRef = o.reference?.(ref(fp)) ?? ref(fp);
    for (const pad of findChildren(fp, "pad")) {
      const old = findChild(pad, "net");
      const to = old && o.netOf?.(newRef, String(arg(pad, 0)));
      if (old && to !== undefined && to !== "") rename.set(String(arg(old, 0)), to);
    }
  }
  const net = (name: string) => rename.get(name) ?? name;

  const ids: string[] = [];
  for (const fp of findChildren(src, "footprint")) {
    const copy = parse(serialize(fp), { recover: true }).children.find((c): c is List => isList(c) && headOf(c) === "footprint")!;
    for (const c of copy.children) if (isList(c)) renewIds(c);
    const uuidNode = findChild(copy, "uuid");
    const id = newBoardUuid();
    if (uuidNode) setArg(uuidNode, 0, str(id));
    moveBoardItem(copy, dx, dy);
    const newRef = o.reference?.(ref(fp)) ?? ref(fp);
    if (newRef !== ref(fp)) setFootprintField(copy, "Reference", newRef);
    // Link to the new symbol: the old path ends with the block symbol's UUID.
    const path = findChild(copy, "path");
    const oldSymbol = path ? String(arg(path, 0)).split("/").pop()! : "";
    const fresh = newSymbol.get(oldSymbol);
    if (path && fresh) setArg(path, 0, str(footprintPath(o.sheetPath, fresh)));
    insertAt(target, target.children.length, format(copy, "\t"), "");
    const node = findBoardItem(target, id)!;
    for (const pad of findChildren(fp, "pad")) {
      const old = findChild(pad, "net");
      if (old) setPadNet(target, node, String(arg(pad, 0)), net(String(arg(old, 0))));
    }
    ids.push(id);
  }
  for (const seg of findChildren(src, "segment")) {
    const pt = (k: string) => ({ x: Number(arg(findChild(seg, k), 0)) + dx, y: Number(arg(findChild(seg, k), 1)) + dy });
    addTrack(target, { start: pt("start"), end: pt("end"), width: Number(arg(findChild(seg, "width"), 0)), layer: String(arg(findChild(seg, "layer"), 0)), net: net(String(arg(findChild(seg, "net"), 0) ?? "")) });
  }
  for (const via of findChildren(src, "via")) {
    const l = findChild(via, "layers");
    addVia(target, {
      at: { x: Number(arg(findChild(via, "at"), 0)) + dx, y: Number(arg(findChild(via, "at"), 1)) + dy },
      size: Number(arg(findChild(via, "size"), 0)),
      drill: Number(arg(findChild(via, "drill"), 0)),
      layers: [String(arg(l, 0)), String(arg(l, 1))],
      net: net(String(arg(findChild(via, "net"), 0) ?? "")),
    });
  }
  return ids;
}

function renewIds(n: List): void {
  for (const c of n.children) {
    if (!isList(c)) continue;
    if (headOf(c) === "uuid" || headOf(c) === "tstamp") setArg(c, 0, str(newBoardUuid()));
    else renewIds(c);
  }
}

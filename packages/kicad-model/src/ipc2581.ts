/**
 * IPC-2581 (revision C) export, laid out as KiCad writes it (`kicad-cli pcb export ipc2581`):
 * - Content: function mode, layer refs, and dictionaries of line widths and pad shapes.
 * - Logistic header and history; the BOM, grouped by footprint and value; the vendor list.
 * - Ecad: layers with their functions, the stackup, and the board step, which holds:
 *   padstack definitions, the profile (outline, with cut-outs), packages (pins and outlines),
 *   components and their placements, copper features per layer grouped by net (pads with pin
 *   references, tracks and arcs, zone fills, vias), silkscreen lines, and a drill layer per
 *   via/hole span.
 * Coordinates are millimetres with Y up (the board's Y negated), as KiCad's.
 */
import type { Board, Footprint, Pad } from "./board.js";
import { onLayer, textPen, textStrokes, viaSpan } from "./fab.js";
import { boardArea } from "./zone-fill.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  const s = String(Object.is(r, -0) ? 0 : r);
  return s.includes(".") || s.includes("e") ? s : `${s}.0`;
};
const Y = (y: number) => -y;

const layerFunction = (name: string) =>
  name.endsWith(".Cu") ? "CONDUCTOR" : name.endsWith(".SilkS") ? "SILKSCREEN" : name.endsWith(".Paste") ? "SOLDERPASTE" : name.endsWith(".Mask") ? "SOLDERMASK" : name.endsWith(".Adhes") ? "GLUE" : name === "Edge.Cuts" ? "BOARD_OUTLINE" : name.endsWith(".CrtYd") ? "COURTYARD" : name.endsWith(".Fab") ? "ASSEMBLY" : "DOCUMENT";
const sideOf = (name: string, copper: string[]) => (name === "Edge.Cuts" ? "ALL" : name.startsWith("F.") ? "TOP" : name.startsWith("B.") ? "BOTTOM" : name.endsWith(".Cu") && copper.includes(name) ? "INTERNAL" : "NONE");

export interface Ipc2581Options {
  /** ISO time for the history record; defaults to now. */
  date?: string;
}

export function ipc2581(board: Board, name: string, o: Ipc2581Options = {}): string {
  const date = o.date ?? new Date().toISOString().slice(0, 19);
  const copper = board.copperLayers;
  const lname = (l: string) => board.layers.find((x) => x.name === l)?.userName ?? (l.endsWith(".SilkS") ? l.replace("SilkS", "Silkscreen") : l.endsWith(".CrtYd") ? l.replace("CrtYd", "Courtyard") : l.endsWith(".Adhes") ? l.replace("Adhes", "Adhesive") : l);
  const out: string[] = [];
  const w = (s: string) => out.push(s);

  // Dictionaries: line widths and pad shapes, by key.
  const lines = new Map<string, string>();
  const lineId = (width: number) => {
    const k = n(width);
    if (!lines.has(k)) lines.set(k, `LINE_${lines.size + 1}`);
    return lines.get(k)!;
  };
  const shapes = new Map<string, { id: string; xml: string }>();
  const shapeOf = (p: Pad) => {
    const { x, y } = p.size;
    let key: string, xml: string;
    if (p.shape === "circle") (key = `C${n(x)}`), (xml = `<Circle diameter="${n(x)}"/>`);
    else if (p.shape === "oval") (key = `O${n(x)}x${n(y)}`), (xml = `<Oval width="${n(x)}" height="${n(y)}"/>`);
    else if (p.shape === "roundrect") {
      const r = Math.min(x, y) * (p.roundrectRatio ?? 0.25);
      (key = `RR${n(x)}x${n(y)}r${n(r)}`), (xml = `<RectRound width="${n(x)}" height="${n(y)}" radius="${n(r)}" upperRight="true" upperLeft="true" lowerRight="true" lowerLeft="true"/>`);
    } else (key = `R${n(x)}x${n(y)}`), (xml = `<RectCenter width="${n(x)}" height="${n(y)}"/>`);
    if (!shapes.has(key)) {
      const kind = p.shape === "circle" ? "CIRCLE" : p.shape === "oval" ? "OVAL" : p.shape === "roundrect" ? "ROUNDRECT" : "RECT";
      shapes.set(key, { id: `${kind}_${shapes.size + 1}`, xml });
    }
    return shapes.get(key)!.id;
  };
  const viaShape = (d: number) => shapeOf({ shape: "circle", size: { x: d, y: d } } as Pad);

  // Padstacks: hole and the copper layers' pads.
  const padstacks = new Map<string, { id: string; xml: string }>();
  const padstackOf = (p: Pad | { via: true; size: number; drill: number; layers: string[] }) => {
    const isVia = "via" in p;
    const drill = isVia ? p.drill : p.drillSize ? Math.min(p.drillSize.x, p.drillSize.y) : (p.drill ?? 0);
    const on = isVia ? p.layers : copper.filter((l) => onLayer((p as Pad).layers, l));
    const shape = isVia ? viaShape(p.size) : shapeOf(p as Pad);
    const plating = isVia ? "VIA" : (p as Pad).type === "np_thru_hole" ? "NONPLATED" : "PLATED";
    const key = `${drill}|${plating}|${on.join()}|${shape}`;
    if (!padstacks.has(key)) {
      const id = `PADSTACK_${padstacks.size + 1}`;
      const hole = drill ? `<PadstackHoleDef name="PH${Math.round(drill * 1e6)}" diameter="${n(drill)}" platingStatus="${plating}" plusTol="0.0" minusTol="0.0" x="0.0" y="0.0"/>` : "";
      const pads = on.map((l) => `<PadstackPadDef layerRef="${esc(lname(l))}" padUse="REGULAR"><Location x="0.0" y="0.0"/><StandardPrimitiveRef id="${shape}"/></PadstackPadDef>`).join("");
      padstacks.set(key, { id, xml: `<PadStackDef name="${id}">${hole}${pads}</PadStackDef>` });
    }
    return padstacks.get(key)!.id;
  };
  // Pin names: the pad number, or PADn (KiCad's) for unnumbered pads.
  const pinName = (fp: Footprint, p: Pad) => p.number || `PAD${fp.pads.filter((q) => !q.number).indexOf(p)}`;

  // Packages: one per footprint definition (library id), pins in the footprint's own frame.
  const packages = new Map<string, { id: string; xml: string }>();
  const local = (fp: Footprint, q: { x: number; y: number }) => {
    const a = (fp.rotation * Math.PI) / 180, dx = q.x - fp.at.x, dy = q.y - fp.at.y;
    // Undo the footprint's placement (rotation counter-clockwise in KiCad's y-down frame), then flip for the back.
    const x = dx * Math.cos(a) - dy * Math.sin(a), y = dx * Math.sin(a) + dy * Math.cos(a);
    return { x: fp.layer === "B.Cu" ? -x : x, y };
  };
  const packageOf = (fp: Footprint) => {
    const key = fp.libId || fp.reference;
    if (!packages.has(key)) {
      const id = `${(fp.libId.split(":").pop() || fp.reference).replace(/[^\w.+-]/g, "_")}_${packages.size + 1}`;
      const pts = fp.pads.flatMap((p) => {
        const c = local(fp, p.at);
        return [{ x: c.x - p.size.x / 2, y: c.y - p.size.y / 2 }, { x: c.x + p.size.x / 2, y: c.y + p.size.y / 2 }];
      });
      const crt = fp.graphics.filter((g) => g.layer.endsWith("CrtYd")).flatMap((g) => g.points.map((q) => local(fp, q)));
      const box = (crt.length ? crt : pts).reduce((b, q) => [Math.min(b[0]!, q.x), Math.min(b[1]!, q.y), Math.max(b[2]!, q.x), Math.max(b[3]!, q.y)], [Infinity, Infinity, -Infinity, -Infinity]);
      const outline = Number.isFinite(box[0]) ? `<Outline><Polygon><PolyBegin x="${n(box[2]!)}" y="${n(Y(box[1]!))}"/><PolyStepSegment x="${n(box[2]!)}" y="${n(Y(box[3]!))}"/><PolyStepSegment x="${n(box[0]!)}" y="${n(Y(box[3]!))}"/><PolyStepSegment x="${n(box[0]!)}" y="${n(Y(box[1]!))}"/><PolyStepSegment x="${n(box[2]!)}" y="${n(Y(box[1]!))}"/></Polygon><LineDescRef id="${lineId(0.05)}"/></Outline>` : "";
      const pins = fp.pads
        .map((p) => {
          const c = local(fp, p.at);
          const type = p.type === "smd" || p.type === "connect" ? "SURFACE" : "THRU";
          return `<Pin number="${esc(pinName(fp, p))}" electricalType="${p.type === "np_thru_hole" ? "MECHANICAL" : "ELECTRICAL"}" type="${type}"><Location x="${n(c.x)}" y="${n(Y(c.y))}"/><StandardPrimitiveRef id="${shapeOf(p)}"/></Pin>`;
        })
        .join("");
      const pin1 = fp.pads.some((p) => p.number === "1");
      packages.set(key, { id, xml: `<Package name="${esc(id)}" type="OTHER" pinOne="${pin1 ? "1" : "UNKNOWN"}" pinOneOrientation="${pin1 ? "OTHER" : "OTHER"}">${outline}<PickupPoint x="0.0" y="0.0"/>${pins}</Package>` });
    }
    return packages.get(key)!.id;
  };
  const part = (fp: Footprint) => `${fp.libId.replace(/:/g, "_")}_${fp.value}`;

  // Components.
  // Every footprint is a component; a reference used again gets _1, _2… (as KiCad writes them).
  const parts = board.footprints;
  const refs = new Map<Footprint, string>();
  {
    const seen = new Map<string, number>();
    for (const fp of parts) {
      const base = fp.reference || "REF**";
      const k = seen.get(base) ?? 0;
      seen.set(base, k + 1);
      refs.set(fp, k ? `${base}_${k}` : base);
    }
  }
  const refOf = (fp: Footprint) => refs.get(fp) ?? fp.reference;
  const components = parts.map((fp) => {
    const bottom = fp.layer === "B.Cu";
    const mount = fp.attributes.mount === "smd" ? "SMT" : fp.attributes.mount === "through_hole" ? "THMT" : "OTHER";
    const rot = ((fp.rotation % 360) + 360) % 360;
    return `<Component refDes="${esc(refOf(fp))}" packageRef="${esc(packageOf(fp))}" part="${esc(part(fp))}" layerRef="${esc(lname(bottom ? copper[copper.length - 1]! : copper[0]!))}" mountType="${mount}"><Xform rotation="${n(rot)}"${bottom ? ' mirror="true"' : ""}/><Location x="${n(fp.at.x)}" y="${n(Y(fp.at.y))}"/></Component>`;
  });

  // Copper features per layer, by net.
  const features = new Map<string, Map<string, string[]>>();
  const add = (layer: string, net: string, xml: string) => {
    const byNet = features.get(layer) ?? features.set(layer, new Map()).get(layer)!;
    (byNet.get(net) ?? byNet.set(net, []).get(net)!).push(xml);
  };
  for (const fp of board.footprints)
    for (const p of fp.pads) {
      // NPTH pads aren't copper: they appear only as holes (as KiCad writes them).
      if (p.type === "np_thru_hole") continue;
      const ps = padstackOf(p);
      const rot = ((p.rotation % 360) + 360) % 360;
      const xml = `<Pad padstackDefRef="${ps}">${rot ? `<Xform rotation="${n(rot)}"/>` : ""}<Location x="${n(p.at.x)}" y="${n(Y(p.at.y))}"/><StandardPrimitiveRef id="${shapeOf(p)}"/><PinRef componentRef="${esc(refOf(fp))}" pin="${esc(pinName(fp, p))}"/></Pad>`;
      for (const l of copper) if (onLayer(p.layers, l)) add(l, p.net, xml);
    }
  for (const t of board.tracks) {
    const lw = `<LineDesc lineWidth="${n(t.width)}" lineEnd="ROUND"/>`;
    const xml =
      t.kind === "arc" && t.mid
        ? (() => {
            // Arc by its centre, from start to end, the turn given by the mid point.
            const [a, m, b] = [t.start, t.mid, t.end];
            const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
            const sq = (p: { x: number; y: number }) => p.x * p.x + p.y * p.y;
            const cx = (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d;
            const cy = (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d;
            const cw = (m.x - a.x) * (b.y - m.y) - (m.y - a.y) * (b.x - m.x) > 0; // clockwise once Y is flipped
            return `<Arc startX="${n(a.x)}" startY="${n(Y(a.y))}" endX="${n(b.x)}" endY="${n(Y(b.y))}" centerX="${n(cx)}" centerY="${n(Y(cy))}" clockwise="${cw}">${lw}</Arc>`;
          })()
        : `<Line startX="${n(t.start.x)}" startY="${n(Y(t.start.y))}" endX="${n(t.end.x)}" endY="${n(Y(t.end.y))}">${lw}</Line>`;
    add(t.layer, t.net, `<Features><UserSpecial>${xml}</UserSpecial></Features>`);
  }
  for (const z of board.zones)
    for (const f of z.fills) {
      if (!copper.includes(f.layer) || f.points.length < 3) continue;
      const pts = f.points;
      const poly = `<Polygon><PolyBegin x="${n(pts[0]!.x)}" y="${n(Y(pts[0]!.y))}"/>${pts.slice(1).map((q) => `<PolyStepSegment x="${n(q.x)}" y="${n(Y(q.y))}"/>`).join("")}<PolyStepSegment x="${n(pts[0]!.x)}" y="${n(Y(pts[0]!.y))}"/></Polygon>`;
      add(f.layer, z.net, `<Features><UserSpecial><Contour>${poly}</Contour></UserSpecial></Features>`);
    }
  // Text on copper: its strokes, as KiCad writes them (a TEXT set with no net).
  for (const t of [...board.texts, ...board.footprints.flatMap((f) => f.texts)]) {
    if (!copper.includes(t.layer)) continue;
    const strokes = textStrokes(t).filter((st) => st.length >= 2);
    if (!strokes.length) continue;
    const lw = `<LineDesc lineWidth="${n(textPen(t))}" lineEnd="ROUND"/>`;
    const body = strokes.map((st) => (st.length === 2 ? `<Line startX="${n(st[0]!.x)}" startY="${n(Y(st[0]!.y))}" endX="${n(st[1]!.x)}" endY="${n(Y(st[1]!.y))}">${lw}</Line>` : `<Polyline><PolyBegin x="${n(st[0]!.x)}" y="${n(Y(st[0]!.y))}"/>${st.slice(1).map((q) => `<PolyStepSegment x="${n(q.x)}" y="${n(Y(q.y))}"/>`).join("")}${lw}</Polyline>`)).join("");
    add(t.layer, "\u0000TEXT", `<NonstandardAttribute name="TEXT" value="${esc(t.text)}" type="STRING"/><Features><Location x="0.0" y="0.0"/><UserSpecial>${body}</UserSpecial></Features>`);
  }
  const viaSets = new Map<string, string[]>();
  for (const v of board.vias) {
    const [a, b] = viaSpan(board, v);
    const on = copper.slice(copper.indexOf(a), copper.indexOf(b) + 1);
    const ps = padstackOf({ via: true, size: v.size, drill: v.drill, layers: on });
    for (const l of on) add(l, `${v.net}\u0000VIA`, `<Pad padstackDefRef="${ps}"><Location x="${n(v.at.x)}" y="${n(Y(v.at.y))}"/><StandardPrimitiveRef id="${viaShape(v.size)}"/></Pad>`);
    void viaSets;
  }

  // Drill layers: one per span.
  const drills = new Map<string, string[]>();
  let holeN = 0;
  let slotN = 0;
  const hole = (span: [string, string], xml: (id: string) => string) => {
    const k = `${lname(span[0])}_${lname(span[1])}`;
    (drills.get(k) ?? drills.set(k, []).get(k)!).push(xml(`H${++holeN}`));
  };
  for (const v of board.vias) {
    const sp = viaSpan(board, v);
    const ps = padstackOf({ via: true, size: v.size, drill: v.drill, layers: copper.slice(copper.indexOf(sp[0]), copper.indexOf(sp[1]) + 1) });
    hole(sp, (id) => `<Set geometry="${ps}" net="${esc(v.net)}"><Hole name="${id}" diameter="${n(v.drill)}" platingStatus="VIA" plusTol="0.0" minusTol="0.0" x="${n(v.at.x)}" y="${n(Y(v.at.y))}"/></Set>`);
  }
  for (const fp of board.footprints)
    for (const p of fp.pads) {
      const d = p.drillSize ? Math.min(p.drillSize.x, p.drillSize.y) : (p.drill ?? 0);
      if (!d) continue;
      const ps = padstackOf(p);
      const plating = p.type === "np_thru_hole" ? "NONPLATED" : "PLATED";
      const span: [string, string] = [copper[0]!, copper[copper.length - 1]!];
      if (p.drillSize && Math.abs(p.drillSize.x - p.drillSize.y) > 1e-9) {
        // A slot: on the span's second drill layer, as an oval, long side first (KiCad's).
        const { x: sw, y: sh } = p.drillSize;
        const rot = (((p.rotation + (sh > sw ? 90 : 0)) % 360) + 360) % 360;
        const k = `${lname(span[0])}_${lname(span[1])}_1`;
        (drills.get(k) ?? drills.set(k, []).get(k)!).push(`<Set${p.net ? ` net="${esc(p.net)}"` : ""}><SlotCavity name="SLOT${++slotN}" platingStatus="${plating}" plusTol="0.0" minusTol="0.0"><Location x="${n(p.at.x)}" y="${n(Y(p.at.y))}"/><Xform rotation="${n(rot)}"/><Oval width="${n(Math.max(sw, sh))}" height="${n(Math.min(sw, sh))}"/></SlotCavity></Set>`);
        continue;
      }
      hole(span, (id) => `<Set geometry="${ps}"${p.net ? ` net="${esc(p.net)}"` : ""}><Hole name="${id}" diameter="${n(d)}" platingStatus="${plating}" plusTol="0.0" minusTol="0.0" x="${n(p.at.x)}" y="${n(Y(p.at.y))}"/></Set>`);
    }

  // Silkscreen: footprint and board graphics on the silk layers, as lines.
  const silk = new Map<string, string[]>();
  const graphicXml = (g: Board["footprints"][number]["graphics"][number]) => {
    const lw = `<LineDesc lineWidth="${n(g.width)}" lineEnd="ROUND"/>`;
    const pts = g.kind === "rect" ? [g.points[0]!, { x: g.points[1]!.x, y: g.points[0]!.y }, g.points[1]!, { x: g.points[0]!.x, y: g.points[1]!.y }, g.points[0]!] : g.kind === "poly" ? [...g.points, g.points[0]!] : g.points;
    if (g.kind === "circle") {
      const r = Math.hypot(g.points[1]!.x - g.points[0]!.x, g.points[1]!.y - g.points[0]!.y);
      return `<Circle diameter="${n(2 * r)}">${lw}</Circle>`;
    }
    if (pts.length < 2) return "";
    return pts.length === 2 ? `<Line startX="${n(pts[0]!.x)}" startY="${n(Y(pts[0]!.y))}" endX="${n(pts[1]!.x)}" endY="${n(Y(pts[1]!.y))}">${lw}</Line>` : `<Polyline><PolyBegin x="${n(pts[0]!.x)}" y="${n(Y(pts[0]!.y))}"/>${pts.slice(1).map((q) => `<PolyStepSegment x="${n(q.x)}" y="${n(Y(q.y))}"/>`).join("")}${lw}</Polyline>`;
  };
  for (const g of [...board.footprints.flatMap((f) => f.graphics), ...board.drawings])
    if (g.layer.endsWith(".SilkS")) {
      const xml = graphicXml(g);
      if (!xml) continue;
      const at = g.kind === "circle" ? g.points[0]! : { x: 0, y: 0 };
      (silk.get(g.layer) ?? silk.set(g.layer, []).get(g.layer)!).push(`<Set><Features><Location x="${n(g.kind === "circle" ? at.x : 0)}" y="${n(g.kind === "circle" ? Y(at.y) : 0)}"/><UserSpecial>${xml}</UserSpecial></Features></Set>`);
    }

  // Profile: the board outline, cut-outs as Cutout.
  const outline = boardArea(board) as Array<Array<{ X: number; Y: number }>> | undefined;
  const ring = (path: Array<{ X: number; Y: number }>) => {
    const pts = path.map((q) => ({ x: q.X / 1e5, y: q.Y / 1e5 }));
    return `<PolyBegin x="${n(pts[0]!.x)}" y="${n(Y(pts[0]!.y))}"/>${pts.slice(1).map((q) => `<PolyStepSegment x="${n(q.x)}" y="${n(Y(q.y))}"/>`).join("")}<PolyStepSegment x="${n(pts[0]!.x)}" y="${n(Y(pts[0]!.y))}"/>`;
  };
  const signed = (path: Array<{ X: number; Y: number }>) => path.reduce((s, q, i) => s + (path[(i + path.length - 1) % path.length]!.X * q.Y - q.X * path[(i + path.length - 1) % path.length]!.Y), 0);
  let profile = "";
  if (outline?.length) {
    const big = outline.reduce((a, b) => (Math.abs(signed(b)) > Math.abs(signed(a)) ? b : a));
    const sign = Math.sign(signed(big));
    const outers = outline.filter((p) => Math.sign(signed(p)) === sign);
    const holes = outline.filter((p) => Math.sign(signed(p)) !== sign);
    profile = `<Profile>${outers.map((p) => `<Polygon>${ring(p)}</Polygon>`).join("")}${holes.map((p) => `<Cutout>${ring(p)}</Cutout>`).join("")}</Profile>`;
  }

  // BOM: grouped by part (footprint and value).
  const bom = new Map<string, Footprint[]>();
  for (const fp of parts) (bom.get(part(fp)) ?? bom.set(part(fp), []).get(part(fp))!).push(fp);

  // Layers, in KiCad's order (technical, copper and dielectrics, back).
  const allLayers = board.layers.map((l) => l.name);
  const stackLayers = board.stackup?.length ? board.stackup : copper.map((c) => ({ name: c, type: "copper", thickness: board.copperThickness?.[c] ?? 0.035 }));
  let diel = 0;
  const layerXml: string[] = [];
  const stackXml: string[] = [];
  let seq = 0;
  for (const s of stackLayers) {
    const isCu = s.type === "copper";
    const nm = isCu ? lname(s.name) : `DIELECTRIC_${++diel}`;
    if (!isCu) layerXml.push(`<Layer name="${nm}" layerFunction="${s.type === "prepreg" ? "DIELPREG" : "DIELCORE"}" polarity="POSITIVE" side="INTERNAL"/>`);
    stackXml.push(`<StackupLayer layerOrGroupRef="${esc(nm)}" thickness="${n(s.thickness)}" tolPlus="0.0" tolMinus="0.0" sequence="${++seq}"/>`);
  }
  for (const l of allLayers) layerXml.push(`<Layer name="${esc(lname(l))}" layerFunction="${layerFunction(l)}" polarity="POSITIVE" side="${sideOf(l, copper)}"/>`);
  for (const k of drills.keys()) layerXml.push(`<Layer name="${esc(k)}" layerFunction="DRILL" polarity="POSITIVE" side="ALL"/>`);

  // Features per layer (computed above).
  const layerFeatures: string[] = [];
  for (const l of copper) {
    const byNet = features.get(l);
    if (!byNet) continue;
    const sets = [...byNet].map(([net, xs]) => {
      if (net === "\u0000TEXT") return xs.map((x) => `<Set geometryUsage="TEXT">${x}</Set>`).join("");
      const via = net.endsWith("\u0000VIA");
      const nm = via ? net.slice(0, -4) : net;
      return `<Set${nm ? ` net="${esc(nm)}"` : ""}${via ? ' padUsage="VIA"' : ""}>${xs.join("")}</Set>`;
    });
    layerFeatures.push(`<LayerFeature layerRef="${esc(lname(l))}">${sets.join("")}</LayerFeature>`);
  }
  for (const [l, sets] of silk) layerFeatures.push(`<LayerFeature layerRef="${esc(lname(l))}">${sets.join("")}</LayerFeature>`);
  for (const [k, sets] of drills) layerFeatures.push(`<LayerFeature layerRef="${esc(k)}">${sets.join("")}</LayerFeature>`);

  const t = board.thickness ?? 1.6;
  w(`<?xml version="1.0" encoding="UTF-8"?>`);
  w(`<IPC-2581 revision="C" xmlns="http://webstds.ipc.org/2581" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://webstds.ipc.org/2581 http://webstds.ipc.org/2581/IPC-2581C.xsd">`);
  w(`<Content roleRef="Owner"><FunctionMode mode="ASSEMBLY"/><StepRef name="${esc(name)}"/>`);
  for (const l of [...allLayers.map(lname), ...drills.keys()]) w(`<LayerRef name="${esc(l)}"/>`);
  w(`<BomRef name="${esc(name)}_1"/><AvlRef name="Primary_Vendor_List"/>`);
  w(`<DictionaryLineDesc units="MILLIMETER">${[...lines].map(([wd, id]) => `<EntryLineDesc id="${id}"><LineDesc lineWidth="${wd}" lineEnd="ROUND"/></EntryLineDesc>`).join("")}</DictionaryLineDesc>`);
  w(`<DictionaryStandard units="MILLIMETER">${[...shapes.values()].map((s) => `<EntryStandard id="${s.id}">${s.xml}</EntryStandard>`).join("")}</DictionaryStandard>`);
  w(`</Content>`);
  w(`<LogisticHeader><Role id="Owner" roleFunction="SENDER"/><Enterprise id="UNKNOWN" code="NONE"/><Person name="UNKNOWN" enterpriseRef="UNKNOWN" roleRef="Owner"/></LogisticHeader>`);
  w(`<HistoryRecord number="1" origination="${date}" software="Crossprobe" lastChange="${date}"><FileRevision fileRevisionId="1" comment="NO COMMENT" label="NO LABEL"><SoftwarePackage name="Crossprobe" revision="1" vendor="Crossprobe"><Certification certificationStatus="SELFTEST"/></SoftwarePackage></FileRevision></HistoryRecord>`);
  w(`<Bom name="${esc(name)}_1"><BomHeader revision="1.0" assembly="${esc(name)}_2"><StepRef name="${esc(name)}"/></BomHeader>`);
  for (const [p, fps] of bom) {
    const fp = fps[0]!;
    w(`<BomItem OEMDesignNumberRef="${esc(p)}" quantity="${fps.length}" pinCount="${fp.pads.length}" category="ELECTRICAL">${fps.map((f) => `<RefDes name="${esc(refOf(f))}" packageRef="${esc(packageOf(f))}" populate="${!f.attributes.dnp}" layerRef="${esc(lname(f.layer === "B.Cu" ? copper[copper.length - 1]! : copper[0]!))}"/>`).join("")}<Characteristics category="ELECTRICAL"><Textual definitionSource="KICAD" textualCharacteristicName="Value" textualCharacteristicValue="${esc(fp.value)}"/></Characteristics></BomItem>`);
  }
  w(`</Bom>`);
  w(`<Ecad name="Design"><CadHeader units="MILLIMETER"/><CadData>`);
  w(layerXml.join(""));
  w(`<Stackup name="Primary_Stackup" overallThickness="${n(t)}" tolPlus="0.0" tolMinus="0.0" whereMeasured="MASK" stackupStatus="PROPOSED"><StackupGroup name="Primary_Stackup_Group" thickness="${n(t)}" tolPlus="0.0" tolMinus="0.0">${stackXml.join("")}</StackupGroup></Stackup>`);
  w(`<Step name="${esc(name)}" type="BOARD"><NonstandardAttribute name="FOOTPRINT_COUNT" type="INTEGER" value="${board.footprints.length}"/>`);
  w([...padstacks.values()].map((p) => p.xml).join(""));
  w(`<Datum x="0.0" y="0.0"/>${profile}`);
  w([...packages.values()].map((p) => p.xml).join(""));
  w(components.join(""));
  w(layerFeatures.join(""));
  w(`</Step></CadData></Ecad>`);
  w(`<Avl name="Primary_Vendor_List"><AvlHeader title="BOM" source="Crossprobe" author="OWNER" datetime="${date}" version="1"/>${[...bom.keys()].map((p) => `<AvlItem OEMDesignNumber="${esc(p)}"/>`).join("")}</Avl>`);
  w(`</IPC-2581>`);
  return out.join("\n") + "\n";
}

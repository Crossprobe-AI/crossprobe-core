/**
 * ODB++ (version 8.1) export, laid out as KiCad writes it (`kicad-cli pcb export odb`): a
 * directory tree (returned as path → text) with
 * - misc/info, matrix/matrix (the layer list), fonts/standard;
 * - steps/pcb/stephdr and profile;
 * - steps/pcb/layers/<layer>/features (and attrlist): copper (pads, tracks, arcs, zone fills,
 *   vias, copper text), mask, paste, silkscreen and drawing layers, and drill layers (holes,
 *   with a tools file);
 * - the component layers comp_+_top / comp_+_bot (placements, properties, pins with their nets);
 * - steps/pcb/eda/data (packages with pins; nets with their pads, tracks, vias and planes as
 *   feature references) and netlists/cadnet/netlist.
 * Coordinates in mm with Y up (the board's negated), symbol sizes in microns, rotations
 * clockwise (ODB++'s; KiCad's are counter-clockwise).
 */
import type { Board, Footprint, Graphic, Pad } from "./board.js";
import { onLayer, textStrokes, viaSpan } from "./fab.js";
import { boardArea, padPolygons } from "./zone-fill.js";

const f = (v: number) => {
  const r = Math.round(v * 1e4) / 1e4;
  return (Object.is(r, -0) ? 0 : r).toFixed(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ".0");
};
/** Microns as KiCad writes symbol sizes: two decimals, ".00" shortened to ".0". */
const um = (mm: number) => (Math.round(mm * 1e5) / 100).toFixed(2).replace(/\.00$/, ".0");
const Y = (y: number) => -y;
const cw = (deg: number) => ((((360 - deg) % 360) + 360) % 360);

/** A layer's feature file being built: symbols, attribute names and texts, features. */
class Features {
  symbols = new Map<string, number>();
  attrs = new Map<string, number>();
  texts = new Map<string, number>();
  lines: string[] = [];
  sym(name: string) {
    if (!this.symbols.has(name)) this.symbols.set(name, this.symbols.size);
    return this.symbols.get(name)!;
  }
  attr(name: string) {
    if (!this.attrs.has(name)) this.attrs.set(name, this.attrs.size);
    return this.attrs.get(name)!;
  }
  text(s: string) {
    if (!this.texts.has(s)) this.texts.set(s, this.texts.size);
    return this.texts.get(s)!;
  }
  /** Adds a feature record; returns its index (for eda/data references). */
  add(rec: string) {
    this.lines.push(rec);
    return this.featureCount++;
  }
  featureCount = 0;
  toString() {
    const out = ["UNITS=MM", "#", "#Num Features", "#", `F ${this.featureCount}`, "", "#", "#Feature symbol names", "#"];
    for (const [s, i] of this.symbols) out.push(`$${i} ${s}`);
    out.push("", "#", "#Feature attribute names", "#");
    for (const [s, i] of this.attrs) out.push(`@${i} ${s}`);
    out.push("", "#", "#Feature attribute text strings", "#");
    for (const [s, i] of this.texts) out.push(`&${i} ${s}`);
    out.push("#", "#Layer features", "#", ...this.lines, "");
    return out.join("\n");
  }
}

const padSymbol = (p: Pad, grow = 0) => {
  const w = p.size.x + 2 * grow, h = p.size.y + 2 * grow;
  if (p.shape === "circle") return `r${um(w)}`;
  if (p.shape === "oval") return Math.abs(w - h) < 1e-9 ? `r${um(w)}` : `oval${um(w)}x${um(h)}`;
  if (p.shape === "roundrect") return `rect${um(w)}x${um(h)}xr${um(Math.min(p.size.x, p.size.y) * (p.roundrectRatio ?? 0.25) + grow)}`;
  return `rect${um(w)}x${um(h)}`;
};

export function odbFiles(board: Board, o: { date?: string } = {}): Record<string, string> {
  const date = (o.date ?? new Date().toISOString()).replace(/[-:]/g, "").replace("T", ".").slice(0, 15);
  const copper = board.copperLayers;
  const uname = (l: string) => board.layers.find((x) => x.name === l)?.userName ?? (l.endsWith(".SilkS") ? l.replace("SilkS", "Silkscreen") : l.endsWith(".CrtYd") ? l.replace("CrtYd", "Courtyard") : l.endsWith(".Adhes") ? l.replace("Adhes", "Adhesive") : l);
  const dir = (l: string) => uname(l).toLowerCase().replace(/[^a-z0-9._+-]/g, "_");
  const files: Record<string, string> = {};
  const layers = new Map<string, Features>();
  const L = (name: string) => layers.get(name) ?? layers.set(name, new Features()).get(name)!;

  // References for eda/data: a pad's / track's / via's features, by layer directory name.
  type FID = { kind: "C" | "H"; layer: string; index: number };
  const padFids = new Map<Pad, FID[]>();
  const trackFids: Array<{ net: string; fids: FID[] }> = [];
  const viaFids: Array<{ net: string; fids: FID[] }> = [];
  const planeFids: Array<{ net: string; fids: FID[] }> = [];

  // Copper, mask and paste pads.
  const drillOf = (p: Pad) => (p.drillSize ? Math.min(p.drillSize.x, p.drillSize.y) : (p.drill ?? 0));
  for (const fp of board.footprints)
    for (const p of fp.pads) {
      const fids: FID[] = [];
      const rot = cw(p.rotation);
      const pad = (layer: string, grow: number) => {
        const fl = L(dir(layer));
        // Custom and chamfered pads have no standard symbol: their outline, as a surface (as KiCad writes them).
        if (p.shape === "custom" || p.chamfer) {
          const polys = padPolygons(p, grow).filter((q) => q.length >= 3);
          const body = ["S P 0", ...polys.flatMap((q, k) => [`OB ${f(q[0]!.x)} ${f(Y(q[0]!.y))} ${k === 0 ? "I" : "H"}`, ...q.slice(1).map((v) => `OS ${f(v.x)} ${f(Y(v.y))}`), `OS ${f(q[0]!.x)} ${f(Y(q[0]!.y))}`, "OE"]), "SE"].join("\n");
          fids.push({ kind: "C", layer: dir(layer), index: fl.add(body) });
          return;
        }
        const i = fl.add(`P ${f(p.at.x)} ${f(Y(p.at.y))} ${fl.sym(padSymbol(p, grow))} P 0 8 ${f(rot)} ;${fl.attr(".pad_usage")}=0`);
        fids.push({ kind: "C", layer: dir(layer), index: i });
      };
      if (p.type !== "np_thru_hole") for (const l of copper) if (onLayer(p.layers, l)) pad(l, 0);
      for (const l of ["F.Mask", "B.Mask"]) if (onLayer(p.layers, l)) pad(l, p.maskMargin ?? fp.maskMargin ?? board.setup.maskMargin);
      for (const l of ["F.Paste", "B.Paste"]) if (onLayer(p.layers, l) && (p.type === "smd" || p.type === "connect")) pad(l, p.pasteMargin ?? fp.pasteMargin ?? board.setup.pasteMargin);
      padFids.set(p, fids);
    }
  // Tracks and arcs.
  for (const t of board.tracks) {
    if (!copper.includes(t.layer)) continue;
    const fl = L(dir(t.layer));
    const s = fl.sym(`r${um(t.width)}`);
    let i: number;
    if (t.kind === "arc" && t.mid) {
      const [a, m, b] = [t.start, t.mid, t.end];
      const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
      const sq = (q: { x: number; y: number }) => q.x * q.x + q.y * q.y;
      const cx = (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d;
      const cy = (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d;
      // Clockwise in ODB++'s Y-up frame: the turn a→m→b is counter-clockwise in the board's Y-down frame.
      const turn = (m.x - a.x) * (b.y - m.y) - (m.y - a.y) * (b.x - m.x);
      i = fl.add(`A ${f(a.x)} ${f(Y(a.y))} ${f(b.x)} ${f(Y(b.y))} ${f(cx)} ${f(Y(cy))} ${s} P 0 ${turn > 0 ? "Y" : "N"}`);
    } else i = fl.add(`L ${f(t.start.x)} ${f(Y(t.start.y))} ${f(t.end.x)} ${f(Y(t.end.y))} ${s} P 0`);
    trackFids.push({ net: t.net, fids: [{ kind: "C", layer: dir(t.layer), index: i }] });
  }
  // Zone fills (surfaces), each fill outline one surface.
  for (const z of board.zones) {
    if (z.keepout) continue;
    for (const fill of z.fills) {
      if (!copper.includes(fill.layer) || fill.points.length < 3) continue;
      const fl = L(dir(fill.layer));
      const pts = fill.points;
      const body = [`S P 0`, `OB ${f(pts[0]!.x)} ${f(Y(pts[0]!.y))} I`, ...pts.slice(1).map((q) => `OS ${f(q.x)} ${f(Y(q.y))}`), `OS ${f(pts[0]!.x)} ${f(Y(pts[0]!.y))}`, "OE", "SE"].join("\n");
      const i = fl.add(body);
      planeFids.push({ net: z.net, fids: [{ kind: "C", layer: dir(fill.layer), index: i }] });
    }
  }
  // Vias on their copper layers and the mask (unless tented).
  for (const v of board.vias) {
    const [a, b] = viaSpan(board, v);
    const fids: FID[] = [];
    for (const l of copper.slice(copper.indexOf(a), copper.indexOf(b) + 1)) {
      const fl = L(dir(l));
      fids.push({ kind: "C", layer: dir(l), index: fl.add(`P ${f(v.at.x)} ${f(Y(v.at.y))} ${fl.sym(`r${um(v.size)}`)} P 0 8 0.0 ;${fl.attr(".pad_usage")}=2`) });
    }
    for (const [l, tented] of [["F.Mask", board.setup.tentFront], ["B.Mask", board.setup.tentBack]] as const) if (!tented) {
      const fl = L(dir(l));
      fl.add(`P ${f(v.at.x)} ${f(Y(v.at.y))} ${fl.sym(`r${um(v.size + 2 * board.setup.maskMargin)}`)} P 0 8 0.0`);
    }
    viaFids.push({ net: v.net, fids });
  }
  // Drawings: graphics on silk, fab, courtyard, edge and user layers; text strokes on any layer.
  const draw = (g: Graphic) => {
    if (!board.layers.some((l) => l.name === g.layer) && !copper.includes(g.layer)) return;
    const fl = L(dir(g.layer));
    // A filled shape on copper is a surface (KiCad's); outlines stay lines.
    if (g.fill && (g.kind === "poly" || g.kind === "rect") && copper.includes(g.layer)) {
      const p = g.kind === "rect" ? [g.points[0]!, { x: g.points[1]!.x, y: g.points[0]!.y }, g.points[1]!, { x: g.points[0]!.x, y: g.points[1]!.y }] : g.points;
      fl.add(["S P 0", `OB ${f(p[0]!.x)} ${f(Y(p[0]!.y))} I`, ...p.slice(1).map((q) => `OS ${f(q.x)} ${f(Y(q.y))}`), `OS ${f(p[0]!.x)} ${f(Y(p[0]!.y))}`, "OE", "SE"].join("\n"));
      return;
    }
    const s = fl.sym(`r${um(Math.max(g.width, 0))}`);
    const p = g.points;
    if (g.kind === "line") fl.add(`L ${f(p[0]!.x)} ${f(Y(p[0]!.y))} ${f(p[1]!.x)} ${f(Y(p[1]!.y))} ${s} P 0`);
    else if (g.kind === "arc") {
      const [a, m, b] = p as [typeof p[0], typeof p[0], typeof p[0]];
      const d = 2 * (a!.x * (m!.y - b!.y) + m!.x * (b!.y - a!.y) + b!.x * (a!.y - m!.y));
      if (Math.abs(d) < 1e-12) return;
      const sq = (q: { x: number; y: number }) => q.x * q.x + q.y * q.y;
      const cx = (sq(a!) * (m!.y - b!.y) + sq(m!) * (b!.y - a!.y) + sq(b!) * (a!.y - m!.y)) / d;
      const cy = (sq(a!) * (b!.x - m!.x) + sq(m!) * (a!.x - b!.x) + sq(b!) * (m!.x - a!.x)) / d;
      const turn = (m!.x - a!.x) * (b!.y - m!.y) - (m!.y - a!.y) * (b!.x - m!.x);
      fl.add(`A ${f(a!.x)} ${f(Y(a!.y))} ${f(b!.x)} ${f(Y(b!.y))} ${f(cx)} ${f(Y(cy))} ${s} P 0 ${turn > 0 ? "Y" : "N"}`);
    } else if (g.kind === "circle") {
      const r = Math.hypot(p[1]!.x - p[0]!.x, p[1]!.y - p[0]!.y);
      const st = { x: p[0]!.x + r, y: p[0]!.y };
      fl.add(`A ${f(st.x)} ${f(Y(st.y))} ${f(st.x)} ${f(Y(st.y))} ${f(p[0]!.x)} ${f(Y(p[0]!.y))} ${s} P 0 Y`);
    } else {
      const pts = g.kind === "rect" ? [p[0]!, { x: p[1]!.x, y: p[0]!.y }, p[1]!, { x: p[0]!.x, y: p[1]!.y }, p[0]!] : g.kind === "poly" ? [...p, p[0]!] : p;
      for (let i = 1; i < pts.length; i++) fl.add(`L ${f(pts[i - 1]!.x)} ${f(Y(pts[i - 1]!.y))} ${f(pts[i]!.x)} ${f(Y(pts[i]!.y))} ${s} P 0`);
    }
  };
  for (const g of [...board.footprints.flatMap((fp) => fp.graphics), ...board.drawings]) draw(g);
  for (const t of [...board.texts, ...board.footprints.flatMap((fp) => fp.texts)]) {
    const fl = L(dir(t.layer));
    const s = fl.sym(`r${um(Math.max(t.thickness || t.size.y / 8, 0.01))}`);
    const ti = fl.text(t.text.replace(/[^\w]/g, "_").toUpperCase());
    for (const st of textStrokes(t)) for (let i = 1; i < st.length; i++) fl.add(`L ${f(st[i - 1]!.x)} ${f(Y(st[i - 1]!.y))} ${f(st[i]!.x)} ${f(Y(st[i]!.y))} ${s} P 0 ;${fl.attr(".string")}=${ti}`);
  }

  // Drill layers: plated and non-plated holes through the stack, one layer per via span.
  const drillName = (plated: "plated" | "non-plated", a: string, b: string) => `drill_${plated}_${dir(a)}-${dir(b)}`;
  const tools = new Map<string, Map<string, { num: number; type: string; size: number }>>();
  const drillSpans = new Map<string, [string, string]>();
  const hole = (layer: string, span: [string, string], at: { x: number; y: number }, d: number, type: "VIA" | "PLATED" | "NON_PLATED", slot?: { w: number; h: number; rot: number }) => {
    drillSpans.set(layer, span);
    const fl = L(layer);
    const tl = tools.get(layer) ?? tools.set(layer, new Map()).get(layer)!;
    const key = `${type}|${d}`;
    if (!tl.has(key)) tl.set(key, { num: tl.size + 1, type, size: d });
    const sym = slot ? fl.sym(`oval${um(slot.w)}x${um(slot.h)}`) : fl.sym(`r${um(d)}`);
    const opt = type === "PLATED" ? 0 : type === "NON_PLATED" ? 1 : 2;
    return fl.add(`P ${f(at.x)} ${f(Y(at.y))} ${sym} P 0 8 ${f(slot?.rot ?? 0)} ;${fl.attr(".drill")}=${opt}`);
  };
  const through: [string, string] = [copper[0]!, copper[copper.length - 1]!];
  const viaHoleFid = new Map<number, FID>();
  board.vias.forEach((v, vi) => {
    const sp = viaSpan(board, v);
    const name = drillName("plated", sp[0], sp[1]);
    viaHoleFid.set(vi, { kind: "H", layer: name, index: hole(name, sp, v.at, v.drill, "VIA") });
  });
  for (const fp of board.footprints)
    for (const p of fp.pads) {
      const d = drillOf(p);
      if (!d) continue;
      const plated = p.type !== "np_thru_hole";
      const name = drillName(plated ? "plated" : "non-plated", through[0], through[1]);
      const slot = p.drillSize && Math.abs(p.drillSize.x - p.drillSize.y) > 1e-3 ? { w: Math.max(p.drillSize.x, p.drillSize.y), h: d, rot: cw(p.rotation + (p.drillSize.y > p.drillSize.x ? 90 : 0)) } : undefined;
      const i = hole(name, through, p.at, d, plated ? "PLATED" : "NON_PLATED", slot);
      padFids.get(p)!.push({ kind: "H", layer: name, index: i });
    }
  viaFids.forEach((v, i) => viaHoleFid.has(i) && v.fids.push(viaHoleFid.get(i)!));

  // Nets: KiCad's order (the board's net list), $NONE$ first for no net.
  const netNames = ["", ...board.nets.filter(Boolean)];
  for (const fp of board.footprints) for (const p of fp.pads) if (p.net && !netNames.includes(p.net)) netNames.push(p.net);
  const netIndex = new Map(netNames.map((n, i) => [n, i]));

  // Components per side, and the packages they use.
  const packages = new Map<string, { index: number; fp: Footprint }>();
  const pkgOf = (fp: Footprint) => {
    const k = fp.libId || fp.reference;
    if (!packages.has(k)) packages.set(k, { index: packages.size, fp });
    return packages.get(k)!.index;
  };
  // Components: footprints with pads (logos and the like aren't parts), references made unique (_1, _2…).
  const sides = { top: [] as Footprint[], bot: [] as Footprint[] };
  const refs = new Map<Footprint, string>();
  {
    const seen = new Map<string, number>();
    for (const fp of board.footprints) {
      if (!fp.pads.length) continue;
      const base = fp.reference || "REF**";
      const k = seen.get(base) ?? 0;
      seen.set(base, k + 1);
      refs.set(fp, k ? `${base}_${k}` : base);
      (fp.layer === "B.Cu" ? sides.bot : sides.top).push(fp);
    }
  }
  // Unnumbered pads: NPTHn for holes, PADn otherwise (KiCad's names).
  const pinName = (fp: Footprint, p: Pad) => p.number || (p.type === "np_thru_hole" ? `NPTH${fp.pads.filter((q) => !q.number && q.type === "np_thru_hole").indexOf(p)}` : `PAD${fp.pads.filter((q) => !q.number && q.type !== "np_thru_hole").indexOf(p)}`);
  // Subnets: per net, in order of the pads that join it (the components' TOP records point at them).
  const subnets = new Map<string, string[]>();
  const sub = (net: string, rec: string) => {
    const l = subnets.get(net) ?? subnets.set(net, []).get(net)!;
    l.push(rec);
    return l.length - 1;
  };
  for (const [side, list] of Object.entries(sides) as Array<["top" | "bot", Footprint[]]>) {
    const out = ["UNITS=MM", "", "#", "#Feature attribute names", "#", "@0 .comp_mount_type", "", "#", "#Feature attribute text strings", "#"];
    list.forEach((fp, ci) => {
      const mirror = side === "bot" ? "M" : "N";
      const mount = fp.attributes.mount === "smd" ? 1 : fp.attributes.mount === "through_hole" ? 2 : 0;
      out.push(`# CMP ${ci}`, `CMP ${pkgOf(fp)} ${f(fp.at.x)} ${f(Y(fp.at.y))} ${f(cw(fp.rotation))} ${mirror} ${refs.get(fp)} ${(fp.libId || "").replace(/:/g, "_")} ;0=${mount}`);
      for (const [k, v] of Object.entries({ Datasheet: fp.properties["Datasheet"] ?? "", Description: fp.properties["Description"] ?? "", Value: fp.value })) out.push(`PRP ${k} '${String(v).replace(/'/g, "")}'`);
      fp.pads.forEach((p, pi) => {
        const net = p.net;
        const fids = padFids.get(p) ?? [];
        const si = sub(net, [`SNT TOP ${side === "bot" ? "B" : "T"} ${ci} ${pi}`, ...fids.map((x) => `FID ${x.kind} ${x.layer} ${x.index}`)].join("\n"));
        out.push(`TOP ${pi} ${f(p.at.x)} ${f(Y(p.at.y))} ${f(cw(p.rotation))} ${mirror} ${netIndex.get(net) ?? 0} ${si} ${pinName(fp, p)}`);
      });
      out.push("#");
    });
    files[`steps/pcb/layers/comp_+_${side}/components`] = out.join("\n") + "\n";
  }
  for (const t of trackFids) sub(t.net, [`SNT TRC`, ...t.fids.map((x) => `FID ${x.kind} ${x.layer} ${x.index}`)].join("\n"));
  for (const v of viaFids) sub(v.net, [`SNT VIA`, ...v.fids.map((x) => `FID ${x.kind} ${x.layer} ${x.index}`)].join("\n"));
  for (const p of planeFids) sub(p.net, [`SNT PLN S 0 0`, ...p.fids.map((x) => `FID ${x.kind} ${x.layer} ${x.index}`)].join("\n"));

  // eda/data: LYR (the layers FIDs refer to, by number), nets, packages.
  const lyr = [...new Set([...subnets.values()].flatMap((l) => l.flatMap((r) => [...r.matchAll(/^FID [CH] (\S+) /gm)].map((m) => m[1]!))))].sort();
  const lyrIndex = new Map(lyr.map((l, i) => [l, i]));
  const eda = [`# ${o.date ?? new Date().toISOString().slice(0, 19)}`, "HDR Crossprobe", "UNITS=MM", `LYR ${lyr.join(" ")}`, "", "#", "#Feature attribute names", "#", "", "#", "#Feature attribute text strings", "#"];
  netNames.forEach((net, i) => {
    eda.push(`#NET ${i}`, `NET ${net || "$NONE$"} `);
    for (const r of subnets.get(net) ?? []) eda.push(r.replace(/^FID ([CH]) (\S+) (\d+)$/gm, (_, k, l, n) => `FID ${k} ${lyrIndex.get(l)} ${n}`));
  });
  for (const [, { fp }] of packages) {
    const loc = (q: { x: number; y: number }) => {
      const a = (fp.rotation * Math.PI) / 180, dx = q.x - fp.at.x, dy = q.y - fp.at.y;
      const x = dx * Math.cos(a) - dy * Math.sin(a), y = dx * Math.sin(a) + dy * Math.cos(a);
      return { x: fp.layer === "B.Cu" ? -x : x, y: -y };
    };
    const pins = fp.pads.map((p) => ({ p, c: loc(p.at) }));
    const xs = pins.flatMap(({ p, c }) => [c.x - p.size.x / 2, c.x + p.size.x / 2]), ys = pins.flatMap(({ p, c }) => [c.y - p.size.y / 2, c.y + p.size.y / 2]);
    const [x0, x1, y0, y1] = xs.length ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] : [0, 0, 0, 0];
    const pitch = pins.length > 1 ? Math.min(...pins.slice(1).map(({ c }, i) => Math.hypot(c.x - pins[i]!.c.x, c.y - pins[i]!.c.y))) : 0;
    eda.push(`PKG ${(fp.libId.split(":").pop() || fp.reference).replace(/\s/g, "_")} ${f(pitch)} ${f(x0)} ${f(y0)} ${f(x1)} ${f(y1)};`, "RC " + `${f(x0)} ${f(y0)} ${f(x1 - x0)} ${f(y1 - y0)}`);
    for (const { p, c } of pins) eda.push(`PIN ${pinName(fp, p)} ${p.type === "smd" || p.type === "connect" ? "S" : "T"} ${f(c.x)} ${f(c.y)} 0 ${p.type === "np_thru_hole" ? "M" : "E"} ${p.type === "smd" || p.type === "connect" ? "S" : "T"}`, `CR ${f(c.x)} ${f(c.y)} ${f(Math.min(p.size.x, p.size.y) / 2)}`);
  }
  files["steps/pcb/eda/data"] = eda.join("\n") + "\n";
  files["steps/pcb/netlists/cadnet/netlist"] = ["H optimize n staggered n", ...netNames.map((n, i) => `$${i} ${n || "$NONE$"}`), "#", "#Netlist points", "#", ...board.footprints.flatMap((fp) => fp.pads.filter((p) => p.type !== "np_thru_hole").map((p) => `${netIndex.get(p.net) ?? 0} ${f(Math.max(p.size.x, p.size.y))} ${f(p.at.x)} ${f(Y(p.at.y))} ${p.type === "smd" || p.type === "connect" ? (fp.layer === "B.Cu" ? "B" : "T") : "B"} e e staggered 0 0 0`))].join("\n") + "\n";

  // Profile.
  const outline = boardArea(board) as Array<Array<{ X: number; Y: number }>> | undefined;
  const prof = ["UNITS=MM", "#", "#Num Features", "#", "F 1", "#", "#Layer features", "#", "S P 0 "];
  if (outline?.length) {
    const signed = (path: Array<{ X: number; Y: number }>) => path.reduce((s, q, i) => s + (path[(i + path.length - 1) % path.length]!.X * q.Y - q.X * path[(i + path.length - 1) % path.length]!.Y), 0);
    const big = outline.reduce((a, b) => (Math.abs(signed(b)) > Math.abs(signed(a)) ? b : a));
    const sign = Math.sign(signed(big));
    for (const path of outline) {
      const pts = path.map((q) => ({ x: q.X / 1e5, y: q.Y / 1e5 }));
      prof.push(`OB ${f(pts[0]!.x)} ${f(Y(pts[0]!.y))} ${Math.sign(signed(path)) === sign ? "I" : "H"}`, ...pts.slice(1).map((q) => `OS ${f(q.x)} ${f(Y(q.y))}`), `OS ${f(pts[0]!.x)} ${f(Y(pts[0]!.y))}`, "OE");
    }
  }
  prof.push("SE", "");
  files["steps/pcb/profile"] = prof.join("\n");
  files["steps/pcb/stephdr"] = ["AFFECTING_BOM_CHANGED=0", "RIGHT_ACTIVE=0", "BOTTOM_ACTIVE=0", "AFFECTING_BOM=", "TOP_ACTIVE=0", "LEFT_ACTIVE=0", "X_ORIGIN=0", "Y_ORIGIN=0", "Y_DATUM=0", "X_DATUM=0", "UNITS=MM", ""].join("\n");

  // Matrix: component layers, then the stack front to back, drills, then the rest.
  type Row = { name: string; type: string; context: string; start?: string; end?: string };
  const rows: Row[] = [{ name: "comp_+_top", type: "COMPONENT", context: "BOARD" }];
  const typeOf = (l: string) => (l.endsWith(".SilkS") ? "SILK_SCREEN" : l.endsWith(".Paste") ? "SOLDER_PASTE" : l.endsWith(".Mask") ? "SOLDER_MASK" : l.endsWith(".Cu") ? "SIGNAL" : "DOCUMENT");
  for (const l of ["F.SilkS", "F.Paste", "F.Mask"]) rows.push({ name: dir(l), type: typeOf(l), context: "BOARD" });
  let diel = 0;
  for (const [i, l] of copper.entries()) {
    rows.push({ name: dir(l), type: "SIGNAL", context: "BOARD" });
    if (i < copper.length - 1) rows.push({ name: `dielectric_${++diel}`, type: "DIELECTRIC", context: "BOARD" });
  }
  for (const l of ["B.Mask", "B.Paste", "B.SilkS"]) rows.push({ name: dir(l), type: typeOf(l), context: "BOARD" });
  rows.push({ name: "comp_+_bot", type: "COMPONENT", context: "BOARD" });
  for (const [name, sp] of drillSpans) rows.push({ name, type: "DRILL", context: "BOARD", start: dir(sp[0]), end: dir(sp[1]) });
  for (const l of board.layers.map((x) => x.name)) if (!rows.some((r) => r.name === dir(l)) && !copper.includes(l)) rows.push({ name: dir(l), type: typeOf(l), context: "MISC" });
  files["matrix/matrix"] = [
    "STEP {",
    "    COL=1",
    "    NAME=PCB",
    "}",
    "",
    ...rows.flatMap((r, i) => ["LAYER {", `    ROW=${i + 1}`, `    CONTEXT=${r.context}`, `    TYPE=${r.type}`, `    NAME=${r.name.toUpperCase()}`, "    OLD_NAME=", "    POLARITY=POSITIVE", ...(r.start ? [`    START_NAME=${r.start.toUpperCase()}`, `    END_NAME=${r.end!.toUpperCase()}`] : []), "    COLOR=0", "}", ""]),
  ].join("\n");

  // Feature files (every matrix layer has one, empty if nothing is on it).
  for (const r of rows) {
    if (r.type === "COMPONENT") continue;
    const fl = layers.get(r.name) ?? new Features();
    files[`steps/pcb/layers/${r.name}/features`] = fl.toString();
    files[`steps/pcb/layers/${r.name}/attrlist`] = r.type === "SIGNAL" ? `.layer_dielectric=0.03\n.copper_weight=1.0\n` : "";
    const tl = tools.get(r.name);
    if (tl) files[`steps/pcb/layers/${r.name}/tools`] = ["UNITS=MM", "THICKNESS=0", "USER_PARAMS=", ...[...tl.values()].flatMap((t) => ["TOOLS {", `    NUM=${t.num}`, `    TYPE=${t.type}`, "    TYPE2=STANDARD", "    MIN_TOL=0", "    MAX_TOL=0", "    BIT=", `    FINISH_SIZE=${um(t.size)}`, `    DRILL_SIZE=${um(t.size)}`, "}", ""])].join("\n");
  }
  files["misc/info"] = ["JOB_NAME=job", "UNITS=MM", "ODB_VERSION_MAJOR=8", "ODB_VERSION_MINOR=1", "ODB_SOURCE=Crossprobe", `CREATION_DATE=${date}`, `SAVE_DATE=${date}`, "SAVE_APP=Crossprobe", ""].join("\n");
  // Text is drawn as lines here, so the standard font is only the header ODB++ readers expect.
  files["fonts/standard"] = "XSIZE  0.302000\nYSIZE  0.302000\nOFFSET 0.000000\n";
  return files;
}

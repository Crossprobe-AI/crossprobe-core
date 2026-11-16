/**
 * The Gerber job file (.gbrjob): a JSON summary of a Gerber set. It covers
 * the board's size, layer count, thickness and finish, a few design rules,
 * each Gerber's function and polarity, and the material stackup. Fab houses
 * read it to set up an order without guessing what each file is.
 *
 * Written the way KiCad 10's Gerber exporter writes it: the same keys, order,
 * names and values, so `kicad-cli pcb export gerbers` is the oracle.
 */
import type { Board, StackupItem } from "./board.js";
import { netClassOf, type DesignRules } from "./drc.js";
import { customConstraint, type RuleItem } from "./drc-rules.js";

/**
 * KiCad's project GUID for Gerber headers and the job file. It isn't random:
 * KiCad builds it from the board's file name, padded to 16 characters with
 * "X", as a version-4, variant-1 UUID.
 */
export function gerberProjectGuid(fileName: string): string {
  const b = [...fileName.padEnd(16, "X")].map((c) => c.charCodeAt(0));
  const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
  let i = 0;
  let g = "";
  for (let k = 0; k < 4; k++) g += hex(b[i++]! & 0xff, 2);
  g += "-";
  for (let k = 0; k < 2; k++) g += hex(b[i++]! & 0xff, 2);
  g += "-4" + hex(((b[i++]! << 4) & 0xff0) + ((b[i]! >> 4) & 0x0f), 3);
  g += "-9" + hex(((b[i++]! & 0x0f) << 8) + (b[i++]! & 0xff), 3);
  g += "-";
  for (let k = 0; k < 6; k++) g += hex(b[i++]! & 0xff, 2);
  return g;
}

/** A number that prints as a JSON float, the way KiCad's JSON library writes it ("0.0", "1.6"). */
class Float {
  constructor(readonly v: number) {}
}
/** KiCad's mapValue: millimetres to 4 decimals (0.1 µm). */
const mm = (v: number) => new Float(Number(v.toFixed(4)) + 0);

type Json = string | number | boolean | Float | Json[] | { [k: string]: Json };
function dump(v: Json, indent = ""): string {
  const inner = indent + "  ";
  if (v instanceof Float) return Number.isInteger(v.v) ? v.v.toFixed(1) : String(v.v);
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + dump(x, inner)).join(",\n")}\n${indent}]` : "[]";
  if (typeof v === "object") {
    const e = Object.entries(v);
    return e.length ? `{\n${e.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${dump(x, inner)}`).join(",\n")}\n${indent}}` : "{}";
  }
  return JSON.stringify(v);
}

/** The job file's name for a layer's function, or undefined for layers it leaves out (courtyards, margin). */
function jobFunction(board: Board, layer: string): string | undefined {
  if (layer.endsWith(".Cu")) {
    const n = board.copperLayers.length;
    if (layer === "F.Cu") return "Copper,L1,Top";
    if (layer === "B.Cu") return `Copper,L${n},Bot`;
    return `Copper,L${board.copperLayers.indexOf(layer) + 1},Inr`;
  }
  const side = layer.startsWith("F.") ? "Top" : "Bot";
  if (/^[FB]\.Adhes$/.test(layer)) return `Glue,${side}`;
  if (/^[FB]\.Paste$/.test(layer)) return `SolderPaste,${side}`;
  if (/^[FB]\.SilkS$/.test(layer)) return `Legend,${side}`;
  if (/^[FB]\.Mask$/.test(layer)) return `SolderMask,${side}`;
  if (/^[FB]\.Fab$/.test(layer)) return `AssemblyDrawing,${side}`;
  if (layer === "Edge.Cuts") return "Profile";
  if (/^(Dwgs|Cmts|Eco1|Eco2)\.User$|^User\.[1-9]$/.test(layer)) return "Other,User";
  return undefined;
}

/** The bounding box of Edge.Cuts, line widths included (KiCad's board-edges box), in mm. */
function edgeBox(board: Board): { w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number, r: number) => {
    x0 = Math.min(x0, x - r);
    y0 = Math.min(y0, y - r);
    x1 = Math.max(x1, x + r);
    y1 = Math.max(y1, y + r);
  };
  for (const s of board.outline) {
    const r = (s.width ?? 0) / 2;
    const p = s.points;
    if (s.kind === "circle" && p.length >= 2) {
      const R = Math.hypot(p[1]!.x - p[0]!.x, p[1]!.y - p[0]!.y);
      add(p[0]!.x, p[0]!.y, R + r);
    } else if (s.kind === "arc" && p.length >= 3) {
      for (const q of arcSample(p[0]!, p[1]!, p[2]!)) add(q.x, q.y, r);
    } else for (const q of p) add(q.x, q.y, r);
  }
  return x1 >= x0 ? { w: x1 - x0, h: y1 - y0 } : { w: 0, h: 0 };
}

/** An arc's ends plus every axis extreme it passes. */
function arcSample(a: { x: number; y: number }, m: { x: number; y: number }, b: { x: number; y: number }) {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-12) return [a, m, b];
  const sq = (p: { x: number; y: number }) => p.x * p.x + p.y * p.y;
  const c = { x: (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d, y: (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d };
  const R = Math.hypot(a.x - c.x, a.y - c.y);
  const ang = (p: { x: number; y: number }) => Math.atan2(p.y - c.y, p.x - c.x);
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const t0 = ang(a);
  const sweepM = norm(ang(m) - t0), sweepB = norm(ang(b) - t0);
  // Counter-clockwise from a reaches m before b, or the arc runs the other way.
  const ccw = sweepM < sweepB;
  const span = ccw ? sweepB : 2 * Math.PI - sweepB;
  const out = [a, b];
  for (let k = 0; k < 4; k++) {
    const t = (k * Math.PI) / 2;
    const off = ccw ? norm(t - t0) : norm(t0 - t);
    if (off <= span) out.push({ x: c.x + R * Math.cos(t), y: c.y + R * Math.sin(t) });
  }
  return out;
}

const ALL_CU = ["F.Cu", ...Array.from({ length: 30 }, (_, i) => `In${i + 1}.Cu`), "B.Cu"];
/** A pad's layers as KiCad's layer set holds them: wildcards expanded ("*.Cu" is all 32 copper layers). */
function expandLayers(layers: string[]): string[] {
  return layers.flatMap((l) => (l === "*.Cu" ? ALL_CU : l === "F&B.Cu" ? ["F.Cu", "B.Cu"] : l.startsWith("*.") ? [`F.${l.slice(2)}`, `B.${l.slice(2)}`] : [l]));
}

function designRules(board: Board, rules: DesignRules): Json[] {
  const custom = rules.custom ?? [];
  const item = (type: RuleItem["type"], net: string, layers: string[], layer?: string, reference?: string, plated?: boolean): RuleItem => ({
    type,
    netName: net,
    netClass: netClassOf(rules, net).name,
    layer,
    reference,
    plated,
    layers: new Set(layers),
    intersectsArea: () => false,
    hasNet: (n) => board.nets.includes(n),
  });
  // Net classes: KiCad has one clearance for tracks and pads.
  const trackToTrack = Math.min(netClassOf(rules, "").clearance, ...[...rules.classes.values()].map((c) => (c.clearanceUnset ? 0 : c.clearance)));

  // An item's own clearance on a layer, as KiCad's DRC engine resolves it with no second item:
  // a local override, else a custom rule, else the net class. NPTH pads take the hole clearance.
  const def = netClassOf(rules, "").clearance;
  let padOuter = def, padInner = def;
  for (const fp of board.footprints)
    for (const pad of fp.pads) {
      const layers = expandLayers(pad.layers);
      const npth = pad.type === "np_thru_hole";
      const copper = layers.some((l) => l.endsWith(".Cu"));
      const own = (layer: string) => {
        const it = item("Pad", pad.net, layers, undefined, fp.reference, !npth);
        if (npth) return customConstraint(custom, "hole_clearance", it, layer)?.min ?? rules.holeClearance ?? 0;
        const local = pad.clearance ?? fp.clearance;
        if (local !== undefined) return local;
        // No copper (a paste-only aperture, say): no other clearance rule applies.
        if (!copper) return 0;
        return customConstraint(custom, "clearance", it, layer)?.min ?? netClassOf(rules, pad.net).clearance;
      };
      // Without custom rules the layer doesn't change the answer: one look per side will do.
      const outer = layers.filter((l) => l === "F.Cu" || l === "B.Cu");
      const inner = layers.filter((l) => l !== "F.Cu" && l !== "B.Cu");
      for (const l of custom.length ? outer : outer.slice(0, 1)) padOuter = Math.min(padOuter, own(l));
      for (const l of custom.length ? inner : inner.slice(0, 1)) padInner = Math.min(padInner, own(l));
    }

  let widthOuter = Infinity, widthInner = Infinity;
  for (const t of board.tracks) {
    if (t.layer === "F.Cu" || t.layer === "B.Cu") widthOuter = Math.min(widthOuter, t.width);
    else widthInner = Math.min(widthInner, t.width);
  }

  let zoneOuter = Infinity, zoneInner = Infinity;
  for (const z of board.zones) {
    if (z.keepout) continue;
    const layers = expandLayers(z.layers).filter((l) => l.endsWith(".Cu"));
    for (const l of layers) {
      // A custom rule, else the largest of the zone's own clearance, its net class's and the board minimum.
      const c = customConstraint(custom, "clearance", item("Zone", z.net, layers, l), l)?.min ?? Math.max(z.clearance, netClassOf(rules, z.net).clearance, rules.minClearance);
      if (l === "F.Cu" || l === "B.Cu") zoneOuter = Math.min(zoneOuter, c);
      else zoneInner = Math.min(zoneInner, c);
    }
  }

  const group = (name: string, pad: number, width: number, zone: number) => {
    const g: Record<string, Json> = { Layers: name, PadToPad: mm(pad), PadToTrack: mm(pad), TrackToTrack: mm(trackToTrack) };
    if (width !== Infinity) g.MinLineWidth = mm(width);
    if (zone !== Infinity) {
      g.TrackToRegion = mm(zone);
      g.RegionToRegion = mm(zone);
    }
    return g;
  };
  const out: Json[] = [group("Outer", padOuter, widthOuter, zoneOuter)];
  if (board.copperLayers.length > 2) out.push(group("Inner", padInner, widthInner, zoneInner));
  return out;
}

/** The stackup the board file gives, or the one KiCad builds when it has none. */
function stackupItems(board: Board): StackupItem[] {
  if (board.stackupFull) return board.stackupFull.items;
  const has = (l: string) => board.layers.some((x) => x.name === l);
  const n = board.copperLayers.length;
  const masks = ["F.Mask", "B.Mask"].filter(has).length;
  // KiCad works in nanometres, with integer division.
  const diel = Math.trunc((Math.round((board.thickness ?? 1.6) * 1e6) - 35000 * n - 10000 * masks) / Math.max(1, n - 1)) / 1e6;
  const items: StackupItem[] = [];
  const side = (f: boolean) => {
    const s = f ? "Top" : "Bottom", p = f ? "F" : "B";
    const list: StackupItem[] = [];
    if (has(`${p}.SilkS`)) list.push({ layer: `${p}.SilkS`, type: `${s} Silk Screen`, sub: [{}] });
    if (has(`${p}.Paste`)) list.push({ layer: `${p}.Paste`, type: `${s} Solder Paste`, sub: [{}] });
    if (has(`${p}.Mask`)) list.push({ layer: `${p}.Mask`, type: `${s} Solder Mask`, sub: [{}] });
    return list;
  };
  items.push(...side(true));
  board.copperLayers.forEach((l, i) => {
    items.push({ layer: l, type: "copper", sub: [{}] });
    if (i < n - 1) items.push({ layer: `dielectric ${i + 1}`, type: i % 2 === 0 ? "core" : "prepreg", sub: [{ thickness: diel, material: "FR4" }] });
  });
  items.push(...side(false).reverse());
  return items;
}

const GBR_COLORS: Record<string, [number, number, number]> = {
  Green: [60, 150, 80], Red: [128, 0, 0], Blue: [0, 0, 128], Purple: [80, 0, 80], Black: [20, 20, 20], White: [200, 200, 200], Yellow: [128, 128, 0],
};
const DIELECTRIC_COLORS: Record<string, [number, number, number]> = {
  "FR4 natural": [109, 116, 75], "PTFE natural": [252, 252, 250], Polyimide: [205, 130, 0], "Phenolic natural": [92, 17, 6], Aluminum: [213, 213, 213],
};
const NORMALIZED = ["green", "red", "blue", "black", "white", "yellow"];
const specified = (v?: string) => !!v && v !== "Not specified";

/** A stackup colour as the job file names it: a standard name, or R<r>G<g>B<b>. */
function jobColor(name: string, dielectric: boolean): string {
  const rgb = (c: number[]) => `R${c[0]}G${c[1]}B${c[2]}`;
  if (name.startsWith("#")) {
    const h = name.slice(1);
    return rgb([0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)));
  }
  const std = (dielectric ? DIELECTRIC_COLORS : GBR_COLORS)[name];
  if (!std) return name;
  return NORMALIZED.includes(name.toLowerCase()) ? name : rgb(std);
}

function materialStackup(board: Board): Json[] {
  const name = (l: string) => board.layers.find((x) => x.name === l)?.userName ?? l;
  const n = board.copperLayers.length;
  let lastCopper = "F.Cu";
  const out: Json[] = [];
  for (const it of stackupItems(board)) {
    const dielectric = it.type === "core" || it.type === "prepreg";
    const subs = dielectric ? it.sub : it.sub.slice(0, 1);
    subs.forEach((s, k) => {
      const j: Record<string, Json> = {};
      if (it.type === "copper") {
        j.Type = "Copper";
        lastCopper = it.layer;
        j.Thickness = mm(s.thickness ?? 0.035);
        j.Name = name(it.layer);
      } else if (dielectric) {
        j.Type = "Dielectric";
        if (specified(s.color)) j.Color = jobColor(s.color!, true);
        j.Thickness = mm(s.thickness ?? 0);
        const material = s.material ?? "FR4";
        if (specified(material)) {
          j.Material = material;
          if (board.stackupFull?.dielectricConstraints) {
            if ((s.epsilonR ?? 4.5) > 1) j.DielectricConstant = String(s.epsilonR ?? 4.5);
            if ((s.lossTangent ?? 0.02) > 0) j.LossTangent = String(s.lossTangent ?? 0.02);
          }
        }
        const i = board.copperLayers.indexOf(lastCopper);
        const next = i + 1 < n ? board.copperLayers[i + 1]! : "B.Cu";
        const id = Number(/(\d+)\s*$/.exec(it.layer)?.[1] ?? 1);
        const many = it.sub.length > 1;
        j.Name = `${name(lastCopper)}/${name(next)}${many ? ` (${k + 1}/${it.sub.length})` : ""}`;
        j.Notes = `Type: ${many ? `dielectric layer ${id} - ${k + 1}/${it.sub.length}` : `dielectric layer ${id}`} (from ${name(lastCopper)} to ${name(next)})`;
      } else {
        const kind = /Silk Screen/.test(it.type) ? "Legend" : /Solder Mask/.test(it.type) ? "SolderMask" : /Solder Paste/.test(it.type) ? "SolderPaste" : "";
        j.Type = kind;
        if (kind !== "SolderPaste" && specified(s.color)) j.Color = jobColor(s.color!, false);
        if (kind === "SolderMask") j.Thickness = mm(s.thickness ?? 0.01);
        if ((kind === "SolderMask" || kind === "Legend") && specified(s.material)) {
          j.Material = s.material!;
          if (board.stackupFull?.dielectricConstraints) {
            if (s.epsilonR !== undefined && s.epsilonR > 1) j.DielectricConstant = String(s.epsilonR);
            if (s.lossTangent !== undefined && s.lossTangent > 0) j.LossTangent = String(s.lossTangent);
          }
        }
        j.Name = it.type;
      }
      out.push(j);
    });
  }
  return out;
}

export interface GerberJobOptions {
  /** The project's (board file's) base name. */
  name: string;
  /** The Gerbers in the set, in order: file name and the layer it plots. */
  files: Array<{ path: string; layer: string }>;
  /** Design rules (net classes, hole clearance, custom rules) from the project. */
  rules: DesignRules;
  /** ISO timestamp; defaults to now. */
  date?: string;
}

/** The Gerber job file for a set of Gerbers. */
export function gerberJob(board: Board, o: GerberJobOptions): string {
  const size = edgeBox(board);
  const specs: Record<string, Json> = {
    ProjectId: { Name: o.name, GUID: gerberProjectGuid(`${o.name}.kicad_pcb`), Revision: board.revision ?? "rev?" },
    Size: { X: mm(size.w), Y: mm(size.h) },
    LayerNumber: board.copperLayers.length,
    BoardThickness: mm(board.thickness ?? 1.6),
  };
  const st = board.stackupFull;
  // KiCad's default finish is "None"; "Not specified" leaves the key out.
  const finish = st?.finish ?? "None";
  if (specified(finish)) specs.Finish = finish;
  if (st?.dielectricConstraints) specs.ImpedanceControlled = true;
  const pads = board.footprints.flatMap((f) => f.pads);
  if (pads.some((p) => p.property === "castellated")) specs.Castellated = true;
  if (pads.some((p) => p.property === "pressfit")) specs["Press-fit"] = true;
  if (st?.edgePlating) specs.EdgePlating = true;
  if (st?.edgeConnector) {
    specs.EdgeConnector = true;
    specs.EdgeConnectorBevelled = st.edgeConnector === "bevelled";
  }
  const files: Json[] = [];
  for (const f of o.files) {
    const fn = jobFunction(board, f.layer);
    if (fn) files.push({ Path: f.path, FileFunction: fn, FilePolarity: f.layer.endsWith(".Mask") ? "Negative" : "Positive" });
  }
  const job: Json = {
    Header: { GenerationSoftware: { Vendor: "Crossprobe", Application: "Crossprobe", Version: "1" }, CreationDate: o.date ?? new Date().toISOString() },
    GeneralSpecs: specs,
    DesignRules: designRules(board, o.rules),
    FilesAttributes: files,
    MaterialStackup: materialStackup(board),
  };
  return dump(job) + "\n";
}

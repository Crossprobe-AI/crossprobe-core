/**
 * STEP export (ISO 10303-21, AP214), as KiCad's File → Export → STEP lays it out:
 * - The board body: the outline extruded through the dielectric (KiCad's body thickness: the
 *   board less its copper and mask, or the stackup's dielectrics), with the drill holes cut
 *   (vias only when asked), X as in the board and Y flipped, in mm.
 * - Components: any other solids the caller adds (the app adds the footprints' 3D models,
 *   as meshes, from the 3D view).
 * Everything is written as faceted B-reps (planar faces bounded by polygon loops), which
 * OpenCascade and the CAD programs built on it read as solids; arcs and holes are polygons
 * within 1 µm.
 */
import ClipperLib from "clipper-lib";
import type { Board } from "./board.js";
import { boardArea } from "./zone-fill.js";
import { scaleStep } from "./step-scale.js";

export type Vec3 = [number, number, number];

export interface StepSolid {
  name: string;
  /** RGB, 0–1. */
  color: [number, number, number];
  /** Planar faces: each a list of loops (the first the outer one), counter-clockwise seen from outside. */
  faces: Vec3[][][];
}

const S = 1e5; // Clipper units per mm (as zone-fill)
const ARC_ERROR = 0.001;

/**
 * KiCad's board body thickness: from the bottom of F.Cu down to the top of B.Cu, so the
 * dielectrics and the inner copper (without a stackup in the file, KiCad's default one: the
 * board less its outer copper and mask).
 */
export function boardBodyThickness(board: Board): number {
  const st = board.stackup;
  if (st?.some((l) => l.type !== "copper")) return st.filter((l) => l.type !== "copper" || (l.name !== "F.Cu" && l.name !== "B.Cu")).reduce((n, l) => n + l.thickness, 0);
  return (board.thickness ?? 1.6) - 0.035 * 2 - 0.01 * 2;
}

const circle = (cx: number, cy: number, r: number) => {
  const n = Math.max(12, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - ARC_ERROR / Math.max(r, ARC_ERROR)))));
  return Array.from({ length: n }, (_, i) => ({ X: Math.round((cx + r * Math.cos((2 * Math.PI * i) / n)) * S), Y: Math.round((cy + r * Math.sin((2 * Math.PI * i) / n)) * S) }));
};
/** A slot (oblong hole) from a to b, width d. */
const slot = (a: { x: number; y: number }, b: { x: number; y: number }, d: number) => {
  const r = d / 2, ang = Math.atan2(b.y - a.y, b.x - a.x);
  const n = Math.max(6, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - ARC_ERROR / r)) / 2));
  const pts: Array<{ X: number; Y: number }> = [];
  for (let i = 0; i <= n; i++) {
    const t = ang - Math.PI / 2 - (Math.PI * i) / n;
    pts.push({ X: Math.round((a.x + r * Math.cos(t)) * S), Y: Math.round((a.y + r * Math.sin(t)) * S) });
  }
  for (let i = 0; i <= n; i++) {
    const t = ang + Math.PI / 2 - (Math.PI * i) / n;
    pts.push({ X: Math.round((b.x + r * Math.cos(t)) * S), Y: Math.round((b.y + r * Math.sin(t)) * S) });
  }
  return pts;
};

/** The board body as a solid: outline minus holes, extruded from z = 0 to the body thickness. */
export function boardBodySolid(board: Board, o: { cutVias?: boolean; color?: [number, number, number] } = {}): StepSolid | undefined {
  const outline = boardArea(board);
  if (!outline?.length) return undefined;
  const holes: ClipperLib.Paths = [];
  for (const fp of board.footprints)
    for (const p of fp.pads) {
      const d = p.drillSize ? Math.min(p.drillSize.x, p.drillSize.y) : (p.drill ?? 0);
      if (!d) continue;
      if (p.drillSize && Math.abs(p.drillSize.x - p.drillSize.y) > 1e-9) {
        const { x: w, y: h } = p.drillSize;
        const half = (Math.max(w, h) - d) / 2, r = (p.rotation * Math.PI) / 180;
        const axis = w > h ? { x: Math.cos(r), y: -Math.sin(r) } : { x: Math.sin(r), y: Math.cos(r) };
        holes.push(slot({ x: p.at.x - axis.x * half, y: p.at.y - axis.y * half }, { x: p.at.x + axis.x * half, y: p.at.y + axis.y * half }, d));
      } else holes.push(circle(p.at.x, p.at.y, d / 2));
    }
  if (o.cutVias) for (const v of board.vias) holes.push(circle(v.at.x, v.at.y, v.drill / 2));
  const c = new ClipperLib.Clipper();
  c.AddPaths(outline, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(holes, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctDifference, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const t = boardBodyThickness(board);
  const faces: Vec3[][][] = [];
  // Board (x, y) → STEP (x, −y): the board's y points down.
  const at = (p: { X: number; Y: number }, z: number): Vec3 => [p.X / S, -p.Y / S, z];
  const area = (ring: Vec3[]) => ring.reduce((n, p, i) => n + (ring[(i + ring.length - 1) % ring.length]![0] * p[1] - p[0] * ring[(i + ring.length - 1) % ring.length]![1]), 0) / 2;
  const orient = (ring: Vec3[], ccw: boolean) => (area(ring) > 0 === ccw ? ring : [...ring].reverse());
  const visit = (node: ClipperLib.PolyNode) => {
    for (const outer of node.Childs()) {
      if (outer.IsHole()) continue;
      const rings = [outer.Contour(), ...outer.Childs().map((h) => h.Contour())];
      const top = rings.map((r, i) => orient(r.map((p) => at(p, t)), i === 0));
      const bottom = rings.map((r, i) => orient(r.map((p) => at(p, 0)), i !== 0));
      faces.push(top, bottom);
      // Sides: one quad per edge; with the outer ring counter-clockwise (holes clockwise) seen from above, a→b along a ring has the material on its left.
      for (const ring of top) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
          faces.push([[[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], t], [a[0], a[1], t]]]);
        }
      }
      for (const hole of outer.Childs()) visit(hole);
    }
  };
  visit(tree);
  return { name: "PCB", color: o.color ?? [0.277847, 0.436627, 0.370214], faces };
}

/** A STEP file of the given solids (one product, as KiCad names it: <board>_PCB for the body). */
export function stepFile(name: string, solids: StepSolid[], o: { date?: string } = {}): string {
  const lines: string[] = [];
  let n = 0;
  const e = (s: string) => {
    lines.push(`#${++n}=${s};`);
    return `#${n}`;
  };
  const f = (v: number) => {
    const s = (Math.round(v * 1e6) / 1e6).toString();
    return s.includes(".") || s.includes("e") ? s.replace(/e/, "E") : `${s}.`;
  };
  const q = (s: string) => `'${s.replace(/'/g, "''").replace(/[^\x20-\x7e]/g, "_")}'`;
  const ctx = e("APPLICATION_CONTEXT('automotive design')");
  e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${ctx})`);
  const pctx = e(`PRODUCT_CONTEXT('',${ctx},'mechanical')`);
  const prod = e(`PRODUCT(${q(name)},${q(name)},'',(${pctx}))`);
  const pdf = e(`PRODUCT_DEFINITION_FORMATION('','',${prod})`);
  const pdc = e(`PRODUCT_DEFINITION_CONTEXT('part definition',${ctx},'design')`);
  const pd = e(`PRODUCT_DEFINITION('design','',${pdf},${pdc})`);
  const pds = e(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
  const len = e("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))");
  const ang = e("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))");
  const sol = e("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())");
  const unc = e(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${len},'distance_accuracy_value','confusion accuracy')`);
  const gctx = e(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${len},${ang},${sol}))REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`);
  const origin = e("CARTESIAN_POINT('',(0.,0.,0.))");
  const zdir = e("DIRECTION('',(0.,0.,1.))");
  const xdir = e("DIRECTION('',(1.,0.,0.))");
  const axis = e(`AXIS2_PLACEMENT_3D('',${origin},${zdir},${xdir})`);
  const breps: string[] = [];
  const styled: string[] = [];
  const colours = new Map<string, string>();
  for (const s of solids) {
    const points = new Map<string, string>();
    const point = (p: Vec3) => {
      const k = `${f(p[0])},${f(p[1])},${f(p[2])}`;
      let id = points.get(k);
      if (!id) points.set(k, (id = e(`CARTESIAN_POINT('',(${k}))`)));
      return id;
    };
    const faceIds = s.faces.map((loops) => {
      const bounds = loops.map((loop, i) => {
        const pl = e(`POLY_LOOP('',(${loop.map(point).join(",")}))`);
        return e(`${i === 0 ? "FACE_OUTER_BOUND" : "FACE_BOUND"}('',${pl},.T.)`);
      });
      // The face's plane: Newell's normal of the outer loop, the first edge as its x axis.
      const L = loops[0]!;
      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < L.length; i++) {
        const a = L[i]!, b = L[(i + 1) % L.length]!;
        nx += (a[1] - b[1]) * (a[2] + b[2]);
        ny += (a[2] - b[2]) * (a[0] + b[0]);
        nz += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const nl = Math.hypot(nx, ny, nz) || 1;
      [nx, ny, nz] = [nx / nl, ny / nl, nz / nl];
      let [ux, uy, uz] = [L[1]![0] - L[0]![0], L[1]![1] - L[0]![1], L[1]![2] - L[0]![2]];
      const d = ux * nx + uy * ny + uz * nz;
      [ux, uy, uz] = [ux - d * nx, uy - d * ny, uz - d * nz];
      const ul = Math.hypot(ux, uy, uz) || 1;
      const plane = e(`PLANE('',${e(`AXIS2_PLACEMENT_3D('',${point(L[0]!)},${e(`DIRECTION('',(${f(nx)},${f(ny)},${f(nz)}))`)},${e(`DIRECTION('',(${f(ux / ul)},${f(uy / ul)},${f(uz / ul)}))`)})`)})`);
      return e(`FACE_SURFACE('',(${bounds.join(",")}),${plane},.T.)`);
    });
    const shell = e(`CLOSED_SHELL('',(${faceIds.join(",")}))`);
    const brep = e(`FACETED_BREP(${q(s.name)},${shell})`);
    breps.push(brep);
    const ck = s.color.map((v) => f(v)).join(",");
    let psa = colours.get(ck);
    if (!psa) {
      const rgb = e(`COLOUR_RGB('',${ck})`);
      const fac = e(`FILL_AREA_STYLE_COLOUR('',${rgb})`);
      const fas = e(`FILL_AREA_STYLE('',(${fac}))`);
      const ssfa = e(`SURFACE_STYLE_FILL_AREA(${fas})`);
      const sss = e(`SURFACE_SIDE_STYLE('',(${ssfa}))`);
      const ssu = e(`SURFACE_STYLE_USAGE(.BOTH.,${sss})`);
      colours.set(ck, (psa = e(`PRESENTATION_STYLE_ASSIGNMENT((${ssu}))`)));
    }
    styled.push(e(`STYLED_ITEM('color',(${psa}),${brep})`));
  }
  const rep = e(`FACETED_BREP_SHAPE_REPRESENTATION(${q(name)},(${[axis, ...breps].join(",")}),${gctx})`);
  e(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`);
  e(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.join(",")}),${gctx})`);
  const date = o.date ?? new Date().toISOString().slice(0, 19);
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('Crossprobe board export'),'2;1');",
    `FILE_NAME(${q(`${name}.step`)},${q(date)},(''),(''),'Crossprobe','Crossprobe','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;",
    "DATA;",
    ...lines,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Assemblies: the board and its parts' own STEP models, placed
// ---------------------------------------------------------------------------

/** Split a STEP DATA section into entity instances ("#12=…"), keeping strings whole. */
function stepEntities(text: string): Array<{ id: number; body: string }> {
  const start = text.indexOf("DATA;");
  const end = text.lastIndexOf("ENDSEC;");
  const data = text.slice(start + 5, end);
  const out: Array<{ id: number; body: string }> = [];
  let cur = "";
  let inStr = false;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!;
    if (ch === "'") {
      // '' inside a string is an escaped quote.
      if (inStr && data[i + 1] === "'") {
        cur += "''";
        i++;
        continue;
      }
      inStr = !inStr;
    }
    if (!inStr && (ch === "\n" || ch === "\r")) {
      cur += " ";
      continue;
    }
    if (!inStr && ch === ";") {
      const m = /^\s*#(\d+)\s*=\s*([\s\S]*)$/.exec(cur);
      if (m) out.push({ id: Number(m[1]), body: m[2]!.trim() });
      cur = "";
      continue;
    }
    cur += ch;
  }
  return out;
}

/** Renumber #refs outside strings. */
const renumber = (body: string, map: (n: number) => number) => body.replace(/'(?:[^']|'')*'|#(\d+)/g, (m, n) => (n ? `#${map(Number(n))}` : m));

type Mat = number[]; // 4×4, row-major
const mul = (a: Mat, b: Mat): Mat => {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k]! * b[k * 4 + c]!;
  return o;
};
const tr = (x: number, y: number, z: number): Mat => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const rz = (d: number): Mat => {
  const a = (d * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
};
const ry = (d: number): Mat => {
  const a = (d * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
};
const rx = (d: number): Mat => {
  const a = (d * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
};

/**
 * KiCad's placement of a footprint's 3D model, in the STEP frame (x, −y, z; the board's top
 * at `top`, the bottom's at `under`): the footprint's position and rotation, a flip for bottom-side parts, then the
 * model's offset and rotation (Z, Y, X, negated). The scale isn't part of it: a scaled model's
 * geometry is scaled first (scaleStep).
 */
export function modelPlacement(fp: Board["footprints"][number], model: Board["footprints"][number]["models"][number], top: number, under = 0): Mat {
  const bottom = fp.layer === "B.Cu";
  let m = mul(tr(fp.at.x, -fp.at.y, bottom ? under : top), rz(fp.rotation));
  if (bottom) m = mul(mul(m, ry(180)), rz(180));
  m = mul(m, tr(model.offset[0], model.offset[1], model.offset[2]));
  m = mul(mul(mul(m, rz(-model.rotate[2])), ry(-model.rotate[1])), rx(-model.rotate[0]));
  return m;
}

export interface StepAssemblyResult {
  text: string;
  /** Parts placed from their STEP models. */
  placed: string[];
  /** Model paths not placed (no STEP text given, or a scale its geometry can't take exactly). */
  skipped: Array<{ reference: string; path: string }>;
}

/**
 * The board and its parts as a STEP assembly, as KiCad builds it: a <board>_PCB part for the
 * body and every part's own STEP model, each model file included once and placed per footprint.
 * `stepModels` maps a model path (as the footprint names it) to that model's STEP text.
 * `extra` solids (meshes of models that have no STEP) go in the board part.
 */
export function stepAssembly(name: string, boardRef: Board, stepModels: Map<string, string>, o: { extra?: StepSolid[]; cutVias?: boolean; date?: string; body?: boolean } = {}): StepAssemblyResult {
  const body = o.body === false ? undefined : boardBodySolid(boardRef, { cutVias: o.cutVias });
  const part = stepFile(`${name}_PCB`, [...(body ? [{ ...body, name: `${name}_PCB` }] : []), ...(o.extra ?? [])], { date: o.date });
  const lines: string[] = [];
  let next = 0;
  const emit = (body: string) => {
    lines.push(`#${++next}=${body};`);
    return next;
  };
  /** Include a whole STEP file's entities; returns its top product definition and its shape representation. */
  const include = (text: string) => {
    const ents = stepEntities(text);
    const base = next;
    const map = new Map<number, number>();
    for (const [i, e] of ents.entries()) map.set(e.id, base + i + 1);
    for (const e of ents) emit(renumber(e.body, (n) => map.get(n) ?? n));
    const at = (id: number) => ents.find((x) => x.id === id)!;
    const ref = (body: string, k: number) => [...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1]))[k];
    // The top product definition: one not a child of any assembly usage.
    const children = new Set(ents.filter((e) => /^NEXT_ASSEMBLY_USAGE_OCCURRENCE/.test(e.body)).map((e) => ref(e.body, 1)));
    const pds = ents.filter((e) => /^PRODUCT_DEFINITION\s*\(/.test(e.body)).map((e) => e.id).filter((id) => !children.has(id));
    const pd = pds[0];
    if (pd === undefined) return undefined;
    // Its shape: SHAPE_DEFINITION_REPRESENTATION(PRODUCT_DEFINITION_SHAPE(…, pd), rep).
    const pdsShape = ents.find((e) => /^PRODUCT_DEFINITION_SHAPE/.test(e.body) && ref(e.body, 0) === pd);
    const sdr = pdsShape && ents.find((e) => /^SHAPE_DEFINITION_REPRESENTATION/.test(e.body) && ref(e.body, 0) === pdsShape.id);
    const rep = sdr && ref(sdr.body, 1);
    if (rep === undefined) return undefined;
    void at;
    return { pd: map.get(pd)!, rep: map.get(rep)! };
  };

  const board = include(part)!;
  // The assembly: its own product, context and representation.
  const ctx = emit("APPLICATION_CONTEXT('automotive design')");
  emit(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${ctx})`);
  const pctx = emit(`PRODUCT_CONTEXT('',#${ctx},'mechanical')`);
  const q = (s: string) => `'${s.replace(/'/g, "''").replace(/[^\x20-\x7e]/g, "_")}'`;
  const prod = emit(`PRODUCT(${q(name)},${q(name)},'',(#${pctx}))`);
  const pdf = emit(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
  const pdc = emit(`PRODUCT_DEFINITION_CONTEXT('part definition',#${ctx},'design')`);
  const apd = emit(`PRODUCT_DEFINITION('design','',#${pdf},#${pdc})`);
  const apds = emit(`PRODUCT_DEFINITION_SHAPE('','',#${apd})`);
  const len = emit("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))");
  const ang = emit("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))");
  const sol = emit("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())");
  const unc = emit(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${len},'distance_accuracy_value','confusion accuracy')`);
  const gctx = emit(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${len},#${ang},#${sol}))REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`);
  const f = (v: number) => {
    const s = (Math.round(v * 1e9) / 1e9).toString();
    return s.includes(".") || s.includes("e") ? s.replace(/e/, "E") : `${s}.`;
  };
  const axis = (m: Mat) => {
    const p = emit(`CARTESIAN_POINT('',(${f(m[3]!)},${f(m[7]!)},${f(m[11]!)}))`);
    const z = emit(`DIRECTION('',(${f(m[2]!)},${f(m[6]!)},${f(m[10]!)}))`);
    const x = emit(`DIRECTION('',(${f(m[0]!)},${f(m[4]!)},${f(m[8]!)}))`);
    return emit(`AXIS2_PLACEMENT_3D('',#${p},#${z},#${x})`);
  };
  const identity = tr(0, 0, 0);
  const items: number[] = [axis(identity)];
  const links: Array<() => void> = [];
  /** Place a part (product definition + representation) in the assembly at m. */
  const place = (child: { pd: number; rep: number }, label: string, m: Mat) => {
    const to = axis(m);
    items.push(to);
    links.push(() => {
      const from = axis(identity);
      const nauo = emit(`NEXT_ASSEMBLY_USAGE_OCCURRENCE(${q(label)},${q(label)},'',#${apd},#${child.pd},$)`);
      const pds = emit(`PRODUCT_DEFINITION_SHAPE('','',#${nauo})`);
      const idt = emit(`ITEM_DEFINED_TRANSFORMATION('','',#${from},#${to})`);
      const rr = emit(`(REPRESENTATION_RELATIONSHIP('','',#${child.rep},#${arep})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${idt})SHAPE_REPRESENTATION_RELATIONSHIP())`);
      emit(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${rr},#${pds})`);
    });
  };
  place(board, `${name}_PCB`, identity);

  // KiCad seats models on the outer copper, 0.05 mm proud of it (its BOARD_OFFSET).
  const cu = (l: string) => boardRef.copperThickness?.[l] ?? 0.035;
  const top = boardBodyThickness(boardRef) + cu("F.Cu") + 0.05;
  const under = -(cu("B.Cu") + 0.05);
  const included = new Map<string, { pd: number; rep: number } | undefined>();
  const placed: string[] = [];
  const skipped: Array<{ reference: string; path: string }> = [];
  for (const fp of boardRef.footprints) {
    for (const model of fp.models) {
      if (model.hidden || !model.path) continue;
      const text = stepModels.get(model.path);
      if (!text) {
        skipped.push({ reference: fp.reference, path: model.path });
        continue;
      }
      // A scaled model is its own part, scaled about its origin (undefined where it can't be).
      const scaled = model.scale.some((v) => Math.abs(v - 1) > 1e-9);
      const key = scaled ? `${model.path}\0${model.scale.join(",")}` : model.path;
      if (!included.has(key)) {
        const t = scaled ? scaleStep(text, [model.scale[0]!, model.scale[1]!, model.scale[2]!]) : text;
        included.set(key, t === undefined ? undefined : include(t));
      }
      const child = included.get(key);
      if (!child) {
        skipped.push({ reference: fp.reference, path: model.path });
        continue;
      }
      place(child, fp.reference, modelPlacement(fp, model, top, under));
      placed.push(fp.reference);
    }
  }
  const arep = emit(`SHAPE_REPRESENTATION(${q(name)},(${items.map((i) => `#${i}`).join(",")}),#${gctx})`);
  emit(`SHAPE_DEFINITION_REPRESENTATION(#${apds},#${arep})`);
  for (const l of links) l();
  const date = o.date ?? new Date().toISOString().slice(0, 19);
  const text = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('Crossprobe board export'),'2;1');",
    `FILE_NAME(${q(`${name}.step`)},${q(date)},(''),(''),'Crossprobe','Crossprobe','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;",
    "DATA;",
    ...lines,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
  return { text, placed, skipped };
}

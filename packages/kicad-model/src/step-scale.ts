/**
 * A STEP model scaled about its origin, as KiCad applies a footprint model's (x, y, z) scale in its
 * STEP export. KiCad hands the shape to OpenCascade's general transform, which turns every
 * curve and surface into a B-spline. We keep the geometry exact without that: an axis scale is an
 * affine map, so
 * - points, and so B-spline curves and surfaces (their control points), are scaled;
 * - a line stays a line and a plane a plane (its normal by the inverse scale);
 * - a circle becomes an ellipse (still a circle where the scale is uniform in its plane);
 * - a cylinder becomes a linear extrusion of the ellipse across it (or a smaller or larger cylinder);
 * - with one factor on all three axes, cones, spheres and tori just change size too.
 * Each edge keeps its vertices, and each face its sense (the scale keeps orientation), so the
 * topology is untouched. A surface curve becomes its 3D curve; the reader rebuilds the
 * parameter-space ones. Geometry the map can't express exactly (cones and the like under an
 * uneven scale, mirroring scales, assemblies inside the model) gives undefined: the caller
 * leaves the model out, as before.
 */
type V = [number, number, number];

const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V): V => {
  const l = len(a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const times = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];

/** Split a DATA section into entities, strings kept whole; the text around it is kept as is. */
function entities(text: string) {
  const start = text.indexOf("DATA;");
  const end = text.lastIndexOf("ENDSEC;");
  if (start < 0 || end < start) return undefined;
  const data = text.slice(start + 5, end);
  const out = new Map<number, string>();
  let cur = "";
  let inStr = false;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!;
    if (ch === "'") {
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
      if (m) out.set(Number(m[1]), m[2]!.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  return { head: text.slice(0, start + 5), tail: text.slice(end), ents: out };
}

/** A simple entity's type and its top-level arguments (nested lists and strings kept whole). */
function parts(body: string): { type: string; args: string[] } | undefined {
  const m = /^([A-Z_0-9]+)\s*\(([\s\S]*)\)$/.exec(body);
  if (!m) return undefined;
  const args: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (const ch of m[2]!) {
    if (ch === "'") inStr = !inStr;
    if (!inStr) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        args.push(cur.trim());
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  args.push(cur.trim());
  return { type: m[1]!, args };
}

const num = (s: string) => Number(s.replace(/^\./, "0."));
const fmt = (v: number) => {
  const s = (Math.abs(v) < 1e-15 ? 0 : v).toPrecision(15).replace(/\.?0+(e|$)/, "$1");
  const t = s.includes(".") || s.includes("e") ? s : `${s}.`;
  return t.replace("e", "E");
};
const ref = (s: string) => {
  const m = /^#(\d+)$/.exec(s.trim());
  return m ? Number(m[1]) : undefined;
};

/** Geometry that only a uniform scale can map onto its own kind (radii scale, directions stay). */
const UNIFORM_ONLY: Record<string, number[]> = {
  CONICAL_SURFACE: [2],
  SPHERICAL_SURFACE: [2],
  TOROIDAL_SURFACE: [2, 3],
  DEGENERATE_TOROIDAL_SURFACE: [2, 3],
  SURFACE_OF_REVOLUTION: [],
};
/** Geometry not handled at all. */
const UNSUPPORTED = new Set(["OFFSET_SURFACE", "OFFSET_CURVE_3D", "TRIMMED_CURVE", "RECTANGULAR_TRIMMED_SURFACE", "HYPERBOLA", "PARABOLA", "CURVE_REPLICA", "SURFACE_REPLICA", "MAPPED_ITEM", "CARTESIAN_TRANSFORMATION_OPERATOR_3D", "COMPOSITE_CURVE", "POLYLINE"]);

export function scaleStep(text: string, scale: [number, number, number]): string | undefined {
  const [sx, sy, sz] = scale;
  if (!(sx > 0 && sy > 0 && sz > 0)) return undefined;
  const uniform = Math.abs(sx - sy) < 1e-12 && Math.abs(sy - sz) < 1e-12;
  const parsed = entities(text);
  if (!parsed) return undefined;
  const { ents } = parsed;
  const S = (v: V): V => [v[0] * sx, v[1] * sy, v[2] * sz];
  const Sinv = (v: V): V => [v[0] / sx, v[1] / sy, v[2] / sz];
  let next = 0;
  for (const id of ents.keys()) if (id > next) next = id;
  const added: string[] = [];
  const emit = (body: string) => {
    added.push(`#${++next}=${body};`);
    return `#${next}`;
  };
  const vec = (v: V) => `(${v.map(fmt).join(",")})`;
  const direction = (v: V) => emit(`DIRECTION('',${vec(v)})`);
  const get = (id: number | undefined) => (id === undefined ? undefined : ents.get(id));
  const triple = (id: number | undefined): V | undefined => {
    const p = get(id) && parts(get(id)!);
    const m = p && /^\(([^)]*)\)$/.exec(p.args[1] ?? "");
    const v = m?.[1]!.split(",").map(num);
    return v && v.length === 3 ? (v as V) : undefined;
  };
  /** An AXIS2_PLACEMENT_3D: location (a point id, scaled in place), axis and reference direction. */
  const frame = (s: string) => {
    const p = parts(get(ref(s)) ?? "");
    if (p?.type !== "AXIS2_PLACEMENT_3D") return undefined;
    const z = p.args[2] === "$" ? ([0, 0, 1] as V) : triple(ref(p.args[2]!));
    let x = p.args[3] === "$" ? undefined : triple(ref(p.args[3]!));
    if (!z) return undefined;
    // An unset reference direction is any perpendicular one (STEP's default).
    if (!x) x = Math.abs(z[0]) < 0.9 ? norm(cross(z, [1, 0, 0])) : norm(cross(z, [0, 1, 0]));
    x = norm(sub(x, times(z, dot(x, z))));
    return { loc: p.args[1]!, z: norm(z), x };
  };
  const placement = (loc: string, z: V, x: V) => {
    const zz = norm(z);
    const xx = norm(sub(x, times(zz, dot(x, zz))));
    return emit(`AXIS2_PLACEMENT_3D('',${loc},${direction(zz)},${direction(xx)})`);
  };
  /** The ellipse a×(cos t·c1 + sin t·c2) (c1, c2 the columns given) as semi-axes and their directions. */
  const ellipse = (c1: V, c2: V) => {
    const a = dot(c1, c1), b = dot(c1, c2), d = dot(c2, c2);
    const mean = (a + d) / 2, diff = Math.hypot((a - d) / 2, b);
    const l1 = mean + diff, l2 = Math.max(0, mean - diff);
    // The eigenvector of [[a,b],[b,d]] for l1.
    const w: [number, number] = Math.abs(b) > 1e-15 ? [l1 - d, b] : a >= d ? [1, 0] : [0, 1];
    const wl = Math.hypot(w[0], w[1]);
    const major: V = norm([(c1[0] * w[0] + c2[0] * w[1]) / wl, (c1[1] * w[0] + c2[1] * w[1]) / wl, (c1[2] * w[0] + c2[2] * w[1]) / wl]);
    return { r1: Math.sqrt(l1), r2: Math.sqrt(l2), major, normal: norm(cross(c1, c2)) };
  };
  /** A circle or ellipse in the plane `normal`, as a curve entity body. */
  const conic = (name: string, loc: string, e: ReturnType<typeof ellipse>) =>
    Math.abs(e.r1 - e.r2) <= 1e-9 * e.r1 ? `CIRCLE(${name},${placement(loc, e.normal, e.major)},${fmt(e.r1)})` : `ELLIPSE(${name},${placement(loc, e.normal, e.major)},${fmt(e.r1)},${fmt(e.r2)})`;

  const cache = new Map<number, string | undefined>();
  /** The new body of entity `id` (rewritten once; surface curves become their 3D curve). */
  const rewrite = (id: number): string | undefined => {
    if (!cache.has(id)) cache.set(id, compute(id));
    return cache.get(id);
  };
  const compute = (id: number): string | undefined => {
    const body = ents.get(id)!;
    if (body.startsWith("(")) {
      // Complex instances: units, contexts, rational B-splines (points only). Anything else geometric isn't known.
      if (/\b(CONIC|ELEMENTARY_SURFACE|SWEPT_SURFACE|OFFSET|TRIMMED)\b/.test(body)) return undefined;
      return body;
    }
    const p = parts(body);
    if (!p) return body;
    const { type, args } = p;
    const name = args[0]!;
    if (UNSUPPORTED.has(type)) return undefined;
    if (type in UNIFORM_ONLY) {
      if (!uniform) return undefined;
      const a = [...args];
      for (const i of UNIFORM_ONLY[type]!) a[i] = fmt(num(a[i]!) * sx);
      return `${type}(${a.join(",")})`;
    }
    switch (type) {
      case "NEXT_ASSEMBLY_USAGE_OCCURRENCE":
        // Sub-parts in their own frames: an uneven scale doesn't pass through their rotations.
        return uniform ? body : undefined;
      case "CARTESIAN_POINT": {
        const m = /^\(([^)]*)\)$/.exec(args[1]!);
        const v = m?.[1]!.split(",").map(num);
        if (!v || v.length !== 3) return body; // 2D points belong to parameter-space curves.
        return `CARTESIAN_POINT(${name},${vec(S(v as V))})`;
      }
      case "LINE": {
        const vp = parts(get(ref(args[2]!)) ?? "");
        const d = vp?.type === "VECTOR" ? triple(ref(vp.args[1]!)) : undefined;
        if (!vp || !d) return undefined;
        const sd = S(norm(d));
        return `LINE(${name},${args[1]},${emit(`VECTOR('',${direction(norm(sd))},${fmt(num(vp.args[2]!) * len(sd))})`)})`;
      }
      case "PLANE": {
        const f = frame(args[1]!);
        if (!f) return undefined;
        return `PLANE(${name},${placement(f.loc, Sinv(f.z), S(f.x))})`;
      }
      case "CIRCLE":
      case "ELLIPSE": {
        const f = frame(args[1]!);
        if (!f) return undefined;
        const r1 = num(args[2]!), r2 = type === "CIRCLE" ? r1 : num(args[3]!);
        const y = cross(f.z, f.x);
        return conic(name, f.loc, ellipse(times(S(f.x), r1), times(S(y), r2)));
      }
      case "CYLINDRICAL_SURFACE": {
        const f = frame(args[1]!);
        if (!f) return undefined;
        const r = num(args[2]!);
        const axis = S(f.z);
        const a = norm(axis);
        // The cross-section square to the new axis: the scaled circle, projected along it.
        const flat = (v: V) => sub(v, times(a, dot(v, a)));
        const e = ellipse(flat(times(S(f.x), r)), flat(times(S(cross(f.z, f.x)), r)));
        // Wound about the axis, so the surface's normal still points away from it.
        const sec = { ...e, normal: dot(e.normal, a) < 0 ? times(e.normal, -1) : e.normal };
        if (Math.abs(e.r1 - e.r2) <= 1e-9 * e.r1) return `CYLINDRICAL_SURFACE(${name},${placement(f.loc, a, e.major)},${fmt(e.r1)})`;
        const curve = emit(conic("''", f.loc, sec));
        return `SURFACE_OF_LINEAR_EXTRUSION(${name},${curve},${emit(`VECTOR('',${direction(a)},1.)`)})`;
      }
      case "SURFACE_OF_LINEAR_EXTRUSION": {
        const vp = parts(get(ref(args[2]!)) ?? "");
        const d = vp?.type === "VECTOR" ? triple(ref(vp.args[1]!)) : undefined;
        if (!vp || !d) return undefined;
        const sd = S(norm(d));
        return `SURFACE_OF_LINEAR_EXTRUSION(${name},${args[1]},${emit(`VECTOR('',${direction(norm(sd))},${fmt(num(vp.args[2]!) * len(sd))})`)})`;
      }
      case "SURFACE_CURVE":
      case "SEAM_CURVE": {
        // The 3D curve, under this entity's id.
        const c = ref(args[1]!);
        if (c === undefined || !ents.has(c)) return undefined;
        return rewrite(c);
      }
      case "EDGE_CURVE": {
        const c = parts(get(ref(args[3]!)) ?? "");
        return c?.type === "PCURVE" ? undefined : body;
      }
      default:
        return body;
    }
  };
  const lines: string[] = [];
  for (const id of ents.keys()) {
    const b = rewrite(id);
    if (b === undefined) return undefined;
    lines.push(`#${id}=${b};`);
  }
  return `${parsed.head}\n${lines.join("\n")}\n${added.join("\n")}\n${parsed.tail}`;
}

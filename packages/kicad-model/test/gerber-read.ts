/**
 * A small Gerber reader for tests: turns the subset KiCad and Crossprobe write
 * (standard and macro apertures, strokes, arcs, regions, polarity) into
 * Clipper polygons, so plotted layers can be compared by area.
 */
import ClipperLib from "clipper-lib";

const S = 1e4; // clipper units per mm
type Path = ClipperLib.IntPoint[];
type Paths = Path[];
interface P {
  x: number;
  y: number;
}

/** A filled outline, wound counter-clockwise so overlapping shapes add up under a non-zero union. */
const toPath = (pts: P[]): Path => {
  const path = pts.map((p) => ({ X: Math.round(p.x * S), Y: Math.round(p.y * S) }));
  return ClipperLib.Clipper.Area(path) < 0 ? path.reverse() : path;
};

function clip(type: ClipperLib.ClipType, a: Paths, b: Paths): Paths {
  const c = new ClipperLib.Clipper();
  c.AddPaths(a, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  const out: Paths = [];
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}
export const union = (a: Paths, b: Paths = []) => clip(ClipperLib.ClipType.ctUnion, a, b);
export const xor = (a: Paths, b: Paths) => clip(ClipperLib.ClipType.ctXor, a, b);
export const area = (p: Paths) => p.reduce((s, q) => s + ClipperLib.Clipper.Area(q), 0) / (S * S);

const circle = (c: P, r: number, n = 48): P[] => Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }));
function capsule(a: P, b: P, r: number): P[] {
  const al = Math.atan2(b.y - a.y, b.x - a.x);
  const pts: P[] = [];
  for (let k = 0; k <= 12; k++) pts.push({ x: b.x + r * Math.cos(al - Math.PI / 2 + (Math.PI * k) / 12), y: b.y + r * Math.sin(al - Math.PI / 2 + (Math.PI * k) / 12) });
  for (let k = 0; k <= 12; k++) pts.push({ x: a.x + r * Math.cos(al + Math.PI / 2 + (Math.PI * k) / 12), y: a.y + r * Math.sin(al + Math.PI / 2 + (Math.PI * k) / 12) });
  return pts;
}
const rotP = (p: P, deg: number): P => {
  const r = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) };
};

function evalExpr(e: string, vars: number[]): number {
  const s = e.trim().replace(/\$(\d+)/g, (_, i) => String(vars[Number(i)] ?? 0)).replace(/x/gi, "*");
  // Only digits, operators and parentheses reach here.
  if (!/^[\d.+\-*/() eE]*$/.test(s)) throw new Error(`bad macro expression ${e}`);
  return Function(`return (${s})`)() as number;
}

/** Shapes of a macro aperture (centred at the origin). */
function macroShapes(body: string[], params: number[]): P[][] {
  const vars = [0, ...params];
  const out: P[][] = [];
  for (const line of body) {
    if (line.startsWith("0")) continue;
    const assign = /^\$(\d+)=(.*)$/.exec(line);
    if (assign) {
      vars[Number(assign[1])] = evalExpr(assign[2]!, vars);
      continue;
    }
    const v = line.split(",").map((t) => evalExpr(t, vars));
    const code = v[0];
    if (code === 1) out.push(circle(rotP({ x: v[3]!, y: v[4]! }, v[5] ?? 0), v[2]! / 2));
    else if (code === 4) {
      const n = v[2]!;
      const pts: P[] = [];
      for (let i = 0; i <= n; i++) pts.push({ x: v[3 + 2 * i]!, y: v[4 + 2 * i]! });
      out.push(pts.map((p) => rotP(p, v[5 + 2 * n] ?? 0)));
    } else if (code === 20) {
      const [w, x1, y1, x2, y2, r] = v.slice(2);
      const a = { x: x1!, y: y1! };
      const b = { x: x2!, y: y2! };
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const n = { x: (-(b.y - a.y) / d) * (w! / 2), y: ((b.x - a.x) / d) * (w! / 2) };
      out.push([{ x: a.x + n.x, y: a.y + n.y }, { x: b.x + n.x, y: b.y + n.y }, { x: b.x - n.x, y: b.y - n.y }, { x: a.x - n.x, y: a.y - n.y }].map((p) => rotP(p, r ?? 0)));
    } else if (code === 21) {
      const [w, h, cx, cy, r] = v.slice(2);
      out.push([{ x: cx! - w! / 2, y: cy! - h! / 2 }, { x: cx! + w! / 2, y: cy! - h! / 2 }, { x: cx! + w! / 2, y: cy! + h! / 2 }, { x: cx! - w! / 2, y: cy! + h! / 2 }].map((p) => rotP(p, r ?? 0)));
    }
  }
  return out;
}

type Aperture = { kind: "C"; d: number } | { kind: "R" | "O"; w: number; h: number } | { kind: "M"; shapes: P[][] };

/** Every dark area of a Gerber file (clear polarity subtracted), in mm, Y up. */
export function readGerber(text: string): Paths {
  let scale = 1e-6;
  const macros = new Map<string, string[]>();
  const apertures = new Map<number, Aperture>();
  let ap: Aperture | undefined;
  let pos: P = { x: 0, y: 0 };
  let mode: "G01" | "G02" | "G03" = "G01";
  let region: P[] | null = null;
  let regions: P[][] = [];
  let dark: Paths = [];
  let pending: Paths = [];
  let polarity = "D";
  const flush = () => {
    if (!pending.length) return;
    dark = polarity === "D" ? union(dark, pending) : clip(ClipperLib.ClipType.ctDifference, dark, union(pending));
    pending = [];
  };
  const shapeAt = (a: Aperture, at: P): P[][] => {
    if (a.kind === "C") return [circle(at, a.d / 2)];
    if (a.kind === "R") return [[{ x: at.x - a.w / 2, y: at.y - a.h / 2 }, { x: at.x + a.w / 2, y: at.y - a.h / 2 }, { x: at.x + a.w / 2, y: at.y + a.h / 2 }, { x: at.x - a.w / 2, y: at.y + a.h / 2 }]];
    if (a.kind === "O") {
      const r = Math.min(a.w, a.h) / 2;
      const half = a.w > a.h ? { x: a.w / 2 - r, y: 0 } : { x: 0, y: a.h / 2 - r };
      return [capsule({ x: at.x - half.x, y: at.y - half.y }, { x: at.x + half.x, y: at.y + half.y }, r)];
    }
    return a.shapes.map((s) => s.map((p) => ({ x: p.x + at.x, y: p.y + at.y })));
  };
  const width = (a?: Aperture) => (a?.kind === "C" ? a.d : a && "w" in a ? Math.min(a.w, a.h) : 0);

  // Split into extended commands (%...%) and word commands (...*).
  const tokens: string[] = [];
  const re = /%([^%]*)%|([^%*]*)\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) tokens.push(m[1] !== undefined ? "%" + m[1] : m[2]!.trim());
  for (const tok of tokens) {
    if (tok.startsWith("%")) {
      const body = tok.slice(1).trim();
      if (body.startsWith("FS")) {
        const f = /X(\d)(\d)/.exec(body);
        if (f) scale = 10 ** -Number(f[2]);
      } else if (body.startsWith("AM")) {
        const parts = body.split("*").map((s) => s.trim()).filter(Boolean);
        macros.set(parts[0]!.slice(2), parts.slice(1));
      } else if (body.startsWith("AD")) {
        const a = /^ADD(\d+)([^,*]+),?([^*]*)\*?$/.exec(body);
        if (!a) continue;
        const [, code, kind, rest] = a;
        const nums = rest!.split("X").filter(Boolean).map(Number);
        if (kind === "C") apertures.set(Number(code), { kind: "C", d: nums[0]! });
        else if (kind === "R" || kind === "O") apertures.set(Number(code), { kind, w: nums[0]!, h: nums[1]! });
        else if (macros.has(kind!)) apertures.set(Number(code), { kind: "M", shapes: macroShapes(macros.get(kind!)!, nums) });
      } else if (body.startsWith("LP")) {
        flush();
        polarity = body[2]!;
      }
      continue;
    }
    let t = tok;
    if (!t) continue;
    const g = /^G0?([0-9]+)/.exec(t);
    if (g) {
      const n = Number(g[1]);
      if (n === 1 || n === 2 || n === 3) mode = (`G0${n}`) as typeof mode;
      if (n === 36) {
        region = [];
        regions = [];
      }
      if (n === 37 && region) {
        if (region.length > 2) regions.push(region);
        pending.push(...regions.map(toPath));
        region = null;
      }
      t = t.slice(g[0].length);
      if (!t) continue;
    }
    const dsel = /^D(\d+)$/.exec(t);
    if (dsel && Number(dsel[1]) >= 10) {
      ap = apertures.get(Number(dsel[1]));
      continue;
    }
    const c = /^(?:X(-?\d+))?(?:Y(-?\d+))?(?:I(-?\d+))?(?:J(-?\d+))?D0?([123])$/.exec(t);
    if (!c) continue;
    const next = { x: c[1] !== undefined ? Number(c[1]) * scale : pos.x, y: c[2] !== undefined ? Number(c[2]) * scale : pos.y };
    const op = Number(c[5]);
    if (op === 2) {
      if (region) {
        if (region.length > 2) regions.push(region);
        region = [next];
      }
    } else if (op === 3 && ap) {
      pending.push(...shapeAt(ap, next).map(toPath));
    } else if (op === 1) {
      let pts: P[] = [pos, next];
      if (mode !== "G01") {
        const center = { x: pos.x + Number(c[3] ?? 0) * scale, y: pos.y + Number(c[4] ?? 0) * scale };
        const r = Math.hypot(pos.x - center.x, pos.y - center.y);
        let a0 = Math.atan2(pos.y - center.y, pos.x - center.x);
        let a1 = Math.atan2(next.y - center.y, next.x - center.x);
        if (mode === "G03" && a1 <= a0) a1 += 2 * Math.PI;
        if (mode === "G02" && a1 >= a0) a1 -= 2 * Math.PI;
        if (Math.hypot(next.x - pos.x, next.y - pos.y) < 1e-9) a1 = a0 + (mode === "G03" ? 2 : -2) * Math.PI;
        const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 36)));
        pts = Array.from({ length: n + 1 }, (_, i) => ({ x: center.x + r * Math.cos(a0 + ((a1 - a0) * i) / n), y: center.y + r * Math.sin(a0 + ((a1 - a0) * i) / n) }));
        void a0;
      }
      if (region) region.push(...pts.slice(1));
      else {
        const w = width(ap);
        for (let i = 1; i < pts.length; i++) pending.push(toPath(capsule(pts[i - 1]!, pts[i]!, w / 2)));
      }
    }
    pos = next;
  }
  flush();
  return dark;
}

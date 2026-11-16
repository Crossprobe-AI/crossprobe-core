/**
 * Trace impedance on an outer layer over the plane below it (microstrip): Hammerstad–Jensen for
 * one trace, with Wheeler's correction for copper thickness, and the usual edge-coupled estimate
 * for a pair, Zdiff = 2·Z0·(1 − 0.48·e^(−0.96·s/h)). Good to a few percent: the fab's own solver
 * sets the final numbers for impedance-controlled boards.
 */
import type { Board } from "./board.js";

/** One trace: width w over a dielectric h thick with permittivity er, copper t thick (all mm). */
export function microstripZ0(w: number, h: number, er: number, t = 0.035): number {
  // Wheeler: copper thickness widens the trace's effect.
  const weff = t > 0 ? w + (t / Math.PI) * (1 + Math.log((2 * h) / t)) : w;
  const u = weff / h;
  const f = 6 + (2 * Math.PI - 6) * Math.exp(-Math.pow(30.666 / u, 0.7528));
  const zAir = 60 * Math.log(f / u + Math.sqrt(1 + (2 / u) ** 2));
  const a = 1 + Math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + Math.log(1 + (u / 18.1) ** 3) / 18.7;
  const b = 0.564 * Math.pow((er - 0.9) / (er + 3), 0.053);
  const eEff = (er + 1) / 2 + ((er - 1) / 2) * Math.pow(1 + 10 / u, -a * b);
  return zAir / Math.sqrt(eEff);
}

/** A pair: two traces w wide, s apart (edge to edge). */
export function microstripZdiff(w: number, s: number, h: number, er: number, t = 0.035): number {
  return 2 * microstripZ0(w, h, er, t) * (1 - 0.48 * Math.exp((-0.96 * s) / h));
}

/** The trace width giving `target` Ω for a pair `s` apart (bisection); undefined if out of reach. */
export function pairWidthFor(target: number, s: number, h: number, er: number, t = 0.035): number | undefined {
  let lo = 0.02;
  let hi = 5;
  if (microstripZdiff(lo, s, h, er, t) < target || microstripZdiff(hi, s, h, er, t) > target) return undefined;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (microstripZdiff(mid, s, h, er, t) > target) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 1000) / 1000;
}

/** The dielectric under F.Cu and the copper's thickness, from the board's stackup. */
export function outerMicrostrip(board: Board): { h: number; er: number; t: number } | undefined {
  const st = board.stackup;
  const i = st?.findIndex((l) => l.name === "F.Cu") ?? -1;
  const d = i >= 0 ? st![i + 1] : undefined;
  if (!d || d.type === "copper" || !d.thickness) return undefined;
  return { h: d.thickness, er: d.epsilonR ?? 4.5, t: st![i]!.thickness || 0.035 };
}

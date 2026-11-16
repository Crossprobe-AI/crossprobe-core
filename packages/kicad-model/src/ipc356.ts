/**
 * IPC-D-356 netlist (the bare-board electrical test file fabs ask for), as KiCad writes it
 * (File → Fabrication Outputs → IPC-D-356, `kicad-cli pcb export ipcd356`): one record per via,
 * then per copper pad, in decimils from the drill/place origin with Y up, net names uppercased
 * and cut to 14 characters (kept unique), N/C for no net.
 */
import type { Board } from "./board.js";
import { onLayer, viaSpan } from "./fab.js";

interface Rec {
  net: string;
  refdes: string;
  pin: string;
  midpoint: boolean;
  hole: boolean;
  drill: number;
  smd: boolean;
  mechanical: boolean;
  access: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  mask: number;
}

/** KiCad's internal units: integer nanometres. */
const nm = (mm: number) => Math.round(mm * 1e6);
/** nm → decimils (2540 nm each), rounded half away from zero as KiCad's KiROUND, clamped. */
const dmil = (iu: number, clamp: number) => {
  const v = iu / 2540;
  const r = Math.sign(v) * Math.floor(Math.abs(v) + 0.5);
  return Math.max(-clamp, Math.min(clamp, r));
};
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const signed = (v: number, digits: number) => `${v < 0 ? "-" : "+"}${String(Math.abs(v)).padStart(digits, "0")}`;

/** KiCad's layer IDs (F.Cu 0, B.Cu 2, In1.Cu 4 …), which its access codes for inner layers use. */
const layerId = (l: string) => (l === "F.Cu" ? 0 : l === "B.Cu" ? 2 : 2 + 2 * Number(/^In(\d+)\.Cu$/.exec(l)?.[1] ?? 0));

export function ipcD356(board: Board): string {
  const origin = board.setup.auxOrigin ?? { x: 0, y: 0 };
  const copper = board.copperLayers;
  const recs: Rec[] = [];
  for (const v of board.vias) {
    const [top, bottom] = viaSpan(board, v);
    const access = top === "F.Cu" && bottom === "B.Cu" ? 0 : top === "F.Cu" ? 1 : bottom === "B.Cu" ? copper.length : Math.floor(layerId(top) / 2) + 1;
    recs.push({ net: v.net, refdes: "VIA", pin: "", midpoint: true, hole: true, drill: nm(v.drill), smd: false, mechanical: false, access, x: nm(v.at.x) - nm(origin.x), y: nm(origin.y) - nm(v.at.y), w: nm(v.size), h: 0, rotation: 0, mask: (board.setup.tentFront ? 1 : 0) | (board.setup.tentBack ? 2 : 0) });
  }
  for (const fp of board.footprints)
    for (const p of fp.pads) {
      const on = copper.filter((l) => onLayer(p.layers, l));
      if (!on.length) continue;
      const access = on.includes("F.Cu") && on.includes("B.Cu") ? 0 : on.includes("F.Cu") ? 1 : on.includes("B.Cu") ? copper.length : layerId(on[0]!) + 1;
      const drill = p.drillSize ? Math.min(p.drillSize.x, p.drillSize.y) : (p.drill ?? 0);
      // KiCad keeps the pad's angle in 0–360 and writes its negative, truncated to whole
      // degrees and then brought back into 0–360 (so 251.8° gives 109, and −74.1° gives 75).
      let rot = Math.trunc(-(((p.rotation % 360) + 360) % 360));
      if (rot < 0) rot += 360;
      recs.push({
        net: p.net,
        refdes: fp.reference,
        // A hole without plating has no pin, whatever number the file gives its pad.
        pin: p.type === "np_thru_hole" ? "" : p.number,
        midpoint: false,
        hole: drill !== 0,
        drill: nm(drill),
        smd: p.type === "smd" || p.type === "connect",
        mechanical: p.type === "np_thru_hole",
        access,
        x: nm(p.at.x) - nm(origin.x),
        y: nm(origin.y) - nm(p.at.y),
        w: nm(p.size.x),
        h: p.shape === "circle" ? 0 : nm(p.size.y),
        rotation: rot,
        mask: 3 & ~(p.layers.some((l) => l === "F.Mask" || l === "*.Mask") ? 1 : 0) & ~(p.layers.some((l) => l === "B.Mask" || l === "*.Mask") ? 2 : 0),
      });
    }

  // Net names: printable ASCII, uppercase, the last 14 characters, unique (#n when cut clashes).
  const names = new Map<string, string>();
  const used = new Set<string>();
  const nameOf = (net: string) => {
    if (!net) return "N/C";
    const known = names.get(net);
    if (known) return known;
    let canon = [...net].map((ch) => (ch.charCodeAt(0) > 126 || !/[\x21-\x7e]/.test(ch) ? "?" : ch)).join("").toUpperCase();
    if (canon.length > 14) canon = canon.slice(-14);
    if (used.has(canon)) {
      const base = canon.length > 10 ? canon.slice(-10) : canon;
      let n = 0;
      do canon = `${base}#${++n}`;
      while (used.has(canon));
    }
    names.set(net, canon);
    used.add(canon);
    return canon;
  };

  const lines = ["P  CODE 00", "P  UNITS CUST 0", "P  arrayDim   N"];
  for (const r of recs) {
    const type = r.smd ? 327 : r.mechanical ? 367 : r.access === 0 ? 317 : 307;
    let l = `${type}${pad(nameOf(r.net), 14)}   ${pad(r.refdes, 6)}${r.pin ? "-" : " "}${pad(r.pin, 4)}${r.midpoint ? "M" : " "}`;
    l += r.hole ? `D${String(dmil(r.drill, 9999)).padStart(4, "0")}${r.mechanical ? "U" : "P"}` : "      ";
    l += `A${String(r.access).padStart(2, "0")}X${signed(dmil(r.x, 999999), 6)}Y${signed(dmil(r.y, 999999), 6)}X${String(dmil(r.w, 9999)).padStart(4, "0")}Y${String(dmil(r.h, 9999)).padStart(4, "0")}R${String(r.rotation).padStart(3, "0")}`;
    l += `S${r.mask}`;
    lines.push(l);
  }
  lines.push("999", "");
  return lines.join("\n");
}

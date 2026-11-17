/**
 * Plotting, like KiCad's Plot dialogs: schematic sheets and board layers as SVG files in
 * millimetres, or all of them as one PDF through the browser's print (one page per sheet or
 * layer, at its own paper size, so the PDF stays vector).
 */
import { plotSvg, strokeAdvance, strokeGlyph } from "@crossprobe/kicad-model";
import type { Board } from "@crossprobe/kicad-model";
import type { Prim, Role, SheetView } from "../render/types";

/** KiCad's default schematic colours (as on screen), and black for black-and-white plots. */
const SCH: Record<Role, string> = {
  wire: "#009600",
  bus: "#0000c8",
  junction: "#009600",
  noconnect: "#0000ff",
  dnp: "#dc090d",
  body: "#840000",
  bodyFill: "#ffffc2",
  pin: "#840000",
  pinName: "#006464",
  pinNumber: "#a90000",
  reference: "#006464",
  value: "#006464",
  field: "#840084",
  labelLocal: "#0f0f0f",
  labelGlobal: "#840000",
  labelHier: "#725600",
  labelPower: "#006464",
  sheet: "#840084",
  sheetName: "#006464",
  sheetFile: "#725600",
  sheetPin: "#725600",
  note: "#0000c2",
  frame: "#a00000",
};
/** Default pen widths by role, mm (KiCad's 6 mil default, wider for buses and bodies). */
const WIDTH: Partial<Record<Role, number>> = { bus: 0.3048, body: 0.254 };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number) => (Math.round(v * 1e4) / 1e4).toString();
const BASELINE = { top: "hanging", middle: "central", bottom: "alphabetic" } as const;

/** KiCad text markup (~{overbar}, _{sub}, ^{super}) as tspans. */
function markup(text: string): string {
  let out = "";
  let last = 0;
  const re = /([~_^])\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    const [, kind, inner] = m;
    out += kind === "~" ? `<tspan text-decoration="overline">${esc(inner!)}</tspan>` : `<tspan baseline-shift="${kind === "_" ? "sub" : "super"}" font-size="70%">${esc(inner!)}</tspan>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

/**
 * A text primitive drawn with KiCad's stroke font instead of an SVG <text>: the result needs no
 * font where it is rendered (a server without any). Markup braces are dropped; an overbar is not drawn.
 */
function strokeText(p: Extract<Prim, { t: "text" }>, color: string): string {
  const text = p.text.replace(/[~_^]\{([^}]*)\}/g, "$1");
  const size = p.size;
  const width = strokeAdvance(text) * size;
  let x = p.anchor === "start" ? 0 : p.anchor === "end" ? -width : -width / 2;
  // Glyphs sit on the baseline and rise one text size above it.
  const y = p.baseline === "bottom" ? 0 : p.baseline === "top" ? size : size / 2;
  let d = "";
  for (const ch of text) {
    const g = strokeGlyph(ch.codePointAt(0)!);
    for (const s of g.strokes) d += s.map((q, i) => `${i ? "L" : "M"}${n(p.x + x + q.x * size)} ${n(p.y + y + q.y * size)}`).join("");
    x += g.width * size;
  }
  if (!d) return "";
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${n(size * (p.bold ? 0.2 : 0.12))}"${p.angle ? ` transform="rotate(${-p.angle} ${n(p.x)} ${n(p.y)})"` : ""}/>`;
}

function prim(p: Prim, color: (r: Role) => string, strokes = false): string {
  switch (p.t) {
    case "path": {
      const c = color(p.role);
      if (p.fill) return p.role === "bodyFill" && c === "none" ? "" : `<path d="${p.d}" fill="${c}" stroke="none"/>`;
      return `<path d="${p.d}" fill="none" stroke="${c}" stroke-width="${n(p.w || WIDTH[p.role] || 0.1524)}"${p.dash ? ` stroke-dasharray="1.2 0.8"` : ""}/>`;
    }
    case "circle": {
      const c = color(p.role);
      const filled = p.fill || p.role === "junction";
      return `<circle cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(p.r)}" fill="${filled ? c : "none"}" stroke="${filled && p.role !== "junction" && !p.w ? "none" : c}" stroke-width="${n(p.w || WIDTH[p.role] || 0.1524)}"/>`;
    }
    case "image":
      return `<image x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" href="${esc(p.href)}" preserveAspectRatio="none"/>`;
    case "text": {
      if (strokes) return strokeText(p, color(p.role));
      const y = p.baseline === "bottom" ? p.y - p.size * 0.12 : p.y;
      return `<text x="${n(p.x)}" y="${n(y)}" font-size="${n(p.size * 1.36)}" letter-spacing="${n(p.size * 0.08)}" text-anchor="${p.anchor}" dominant-baseline="${BASELINE[p.baseline]}"${p.angle ? ` transform="rotate(${-p.angle} ${n(p.x)} ${n(p.y)})"` : ""} fill="${color(p.role)}"${p.bold ? ` font-weight="700"` : ""}${p.italic ? ` font-style="italic"` : ""}>${markup(p.text)}</text>`;
    }
  }
}

export interface SchPlotOptions {
  blackAndWhite?: boolean;
  /** Leave out the frame and title block (KiCad's "exclude drawing sheet"). */
  noFrame?: boolean;
  /** Paper background colour; white by default ("none" for none). */
  background?: string;
  /** Draw text with KiCad's stroke font, as paths: for rendering where there are no fonts. */
  strokeText?: boolean;
}

/** One schematic sheet as an SVG file, at its paper size in mm. */
export function sheetSvg(sheet: SheetView, o: SchPlotOptions = {}): string {
  const color = (r: Role) => (o.blackAndWhite ? (r === "bodyFill" ? "none" : "#000") : SCH[r]);
  const body = sheet.items
    .filter((it) => !(o.noFrame && it.kind === "graphic" && it.prims.some((p) => "role" in p && p.role === "frame")))
    .map((it) => it.prims.map((p) => prim(p, color, o.strokeText)).join(""))
    .join("\n");
  const { w, h } = sheet.paper;
  const bg = o.background ?? "#fff";
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}mm" height="${n(h)}mm" viewBox="0 0 ${n(w)} ${n(h)}" font-family="Helvetica Neue, Arial, sans-serif" stroke-linecap="round" stroke-linejoin="round">`,
    `<title>${esc(sheet.namePath || sheet.name)}</title>`,
    bg !== "none" ? `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" fill="${bg}"/>` : "",
    body,
    `</svg>`,
    "",
  ].join("\n");
}

/** Board layer colours for plots on white paper (KiCad's on-screen ones, darkened where they're too light). */
export const PRINT_COLORS: Record<string, string> = {
  "F.Cu": "#c83434",
  "B.Cu": "#3b6fb8",
  "F.SilkS": "#7a7400",
  "B.SilkS": "#a0523c",
  "F.Fab": "#6e6e6e",
  "B.Fab": "#3d4270",
  "F.CrtYd": "#d000b8",
  "B.CrtYd": "#00a5b8",
  "F.Mask": "#9a3cc0",
  "B.Mask": "#00a39a",
  "F.Paste": "#7a7a7a",
  "B.Paste": "#008a8a",
  "Edge.Cuts": "#a0a000",
  "Dwgs.User": "#606060",
  "Cmts.User": "#2c64ac",
};

export interface BoardPlotOptions {
  blackAndWhite?: boolean;
  /** Mirror bottom-side plots, to read them from below. */
  mirrorBottom?: boolean;
  /** Add the board outline to every layer (KiCad's common Edge.Cuts). */
  withEdge?: boolean;
}

/** One SVG per layer (each with the outline if asked), or all the layers stacked in one. */
export function boardSvgs(board: Board, layers: string[], o: BoardPlotOptions & { together?: boolean } = {}): Array<{ name: string; svg: string }> {
  const colors = o.blackAndWhite ? undefined : PRINT_COLORS;
  const plot = (ls: string[]) =>
    plotSvg(board, o.withEdge && !ls.includes("Edge.Cuts") ? [...ls, "Edge.Cuts"] : ls, {
      colors: colors && Object.fromEntries(ls.concat("Edge.Cuts").map((l) => [l, colors[l] ?? "#000"])),
      mirror: o.mirrorBottom && ls.every((l) => l.startsWith("B.")),
      background: "#fff",
      margin: 2,
    });
  if (o.together) return [{ name: "board", svg: plot(layers) }];
  return layers.map((l) => ({ name: l.replace(/\./g, "_"), svg: plot([l]) }));
}

/** Print SVG pages (each at its own size) to the browser's print dialog, to save as PDF. */
export function printPages(title: string, pages: string[]): boolean {
  const w = window.open("", "_blank");
  if (!w) return false;
  const sizes = new Map<string, string>();
  const body = pages
    .map((svg) => {
      const m = /width="([\d.]+)mm" height="([\d.]+)mm"/.exec(svg);
      const size = m ? `${m[1]}mm ${m[2]}mm` : "A4 landscape";
      const name = `p${[...sizes.keys()].length}`;
      let key = [...sizes].find(([, v]) => v === size)?.[0];
      if (!key) sizes.set((key = name), size);
      return `<div class="page" style="page:${key}">${svg.replace(/^<\?xml[^>]*>\s*/, "").replace(/width="([\d.]+)mm" height="([\d.]+)mm"/, 'width="$1mm" height="$2mm" style="display:block"')}</div>`;
    })
    .join("");
  const css = [...sizes].map(([k, v]) => `@page ${k} { size: ${v}; margin: 0 }`).join("\n");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}\nhtml,body{margin:0;background:#fff}.page{break-after:page;overflow:hidden}.page:last-child{break-after:auto}</style></head><body>${body}</body></html>`);
  w.document.close();
  w.focus();
  // Let the pages lay out (and fonts load) before the dialog.
  setTimeout(() => w.print(), 300);
  return true;
}

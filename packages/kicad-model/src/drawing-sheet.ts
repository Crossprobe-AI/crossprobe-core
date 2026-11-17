/**
 * Drawing sheets (.kicad_wks): the frame and title block around a page, as KiCad's page layout
 * editor makes them. Items are placed from a page corner, inside the margins (bottom-right unless
 * said), and may repeat with an offset until they leave the page, as the border's 1, 2, 3 and
 * A, B, C do. Texts use the title block's and the sheet's variables (${TITLE}, ${#}…); older files'
 * %-codes (%T, %C0…) mean the same.
 */
import { atomText, findChild, findChildren, headOf, isAtom, isList, parse, type List } from "@crossprobe/kicad-sexpr";
import { base64Bytes, bitmapInfo, bitmapSizeMm } from "./bitmap.js";
import type { Point } from "./geometry.js";
import { strokeAdvance } from "./stroke-font.js";

type Corner = "rb" | "rt" | "lb" | "lt";
interface Pos {
  x: number;
  y: number;
  corner: Corner;
}

interface ItemBase {
  repeat: number;
  incrx: number;
  incry: number;
  /** "page1only" or "notonpage1". */
  option?: string;
  lineWidth: number;
}
export type DrawingSheetItem =
  | (ItemBase & { kind: "line" | "rect"; start: Pos; end: Pos })
  | (ItemBase & {
      kind: "text";
      text: string;
      pos: Pos;
      size: { x: number; y: number };
      bold: boolean;
      italic: boolean;
      h: "left" | "center" | "right";
      v: "top" | "center" | "bottom";
      rotate: number;
      incrlabel: number;
      maxlen: number;
      maxheight: number;
    })
  | (ItemBase & { kind: "polygon"; pos: Pos; rotate: number; outlines: Point[][] })
  /** A picture (a logo), centred on its position: PNG bytes as base64. */
  | (ItemBase & { kind: "bitmap"; pos: Pos; scale: number; png: string });

export interface DrawingSheet {
  textSize: { x: number; y: number };
  lineWidth: number;
  textLineWidth: number;
  margins: { left: number; right: number; top: number; bottom: number };
  items: DrawingSheetItem[];
}

/** What a sheet's texts can name. */
export interface DrawingSheetInfo {
  /** The title block: title, date, rev, company, comment1 … comment9. */
  titleBlock: Record<string, string>;
  paper: string;
  /** Page number and page count. */
  page: string;
  pages: number;
  sheetName: string;
  sheetPath: string;
  fileName: string;
  /** The board layer a plot is of. */
  layer?: string;
  /** Project text variables. */
  variables?: Record<string, string>;
  /** Shown for ${KICAD_VERSION}. */
  generator?: string;
}

/** A drawn piece of the sheet, in page millimetres. */
export type DrawingSheetPrim =
  | { kind: "line"; a: Point; b: Point; width: number }
  | { kind: "rect"; a: Point; b: Point; width: number }
  | { kind: "polygon"; points: Point[]; width: number }
  | { kind: "text"; at: Point; text: string; size: { x: number; y: number }; width: number; bold: boolean; italic: boolean; h: "left" | "center" | "right"; v: "top" | "center" | "bottom"; angle: number }
  /** A picture: its top-left corner, size in mm, and PNG bytes as base64. */
  | { kind: "bitmap"; at: Point; w: number; h: number; png: string };

const num = (n: List | undefined, i: number, d = 0) => {
  const v = n?.children[i + 1];
  return v && isAtom(v) ? Number(atomText(v)) : d;
};
const sym = (n: List, i: number) => {
  const v = n.children[i + 1];
  return v && isAtom(v) ? atomText(v) : undefined;
};

function pos(n: List | undefined): Pos {
  const c = n ? sym(n, 2) : undefined;
  const corner: Corner = c === "ltcorner" ? "lt" : c === "rtcorner" ? "rt" : c === "lbcorner" ? "lb" : "rb";
  return { x: num(n, 0), y: num(n, 1), corner };
}

/** %-codes of older files, as the variables they stand for. */
function legacyCodes(t: string): string {
  const codes: Record<string, string> = { D: "ISSUE_DATE", R: "REVISION", K: "KICAD_VERSION", Z: "PAPER", S: "#", N: "##", F: "FILENAME", L: "LAYER", P: "SHEETPATH", Y: "COMPANY", T: "TITLE" };
  let out = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "%") {
      out += t[i];
      continue;
    }
    const c = t[++i];
    if (c === undefined) break;
    if (c === "%") out += "%";
    else if (c === "C") {
      const d = t[++i];
      out += d !== undefined && /[0-9]/.test(d) ? `\${COMMENT${Number(d) + 1}}` : "";
    } else if (codes[c]) out += `\${${codes[c]}}`;
    // An unknown code (and a % at the very end) is dropped, as KiCad's reader does.
  }
  return out;
}

export function parseDrawingSheet(text: string): DrawingSheet {
  const root = parse(text, { recover: true }).children.find(isList);
  const setup = root && findChild(root, "setup");
  const ts = setup && findChild(setup, "textsize");
  const ds: DrawingSheet = {
    textSize: { x: num(ts, 0, 1.5), y: num(ts, 1, 1.5) },
    lineWidth: num(setup && findChild(setup, "linewidth"), 0, 0.15),
    textLineWidth: num(setup && findChild(setup, "textlinewidth"), 0, 0.15),
    margins: {
      left: num(setup && findChild(setup, "left_margin"), 0, 10),
      right: num(setup && findChild(setup, "right_margin"), 0, 10),
      top: num(setup && findChild(setup, "top_margin"), 0, 10),
      bottom: num(setup && findChild(setup, "bottom_margin"), 0, 10),
    },
    items: [],
  };
  if (!root) return ds;
  for (const n of root.children) {
    if (!isList(n)) continue;
    const head = headOf(n);
    const base: ItemBase = {
      repeat: Math.max(1, num(findChild(n, "repeat"), 0, 1)),
      incrx: num(findChild(n, "incrx"), 0),
      incry: num(findChild(n, "incry"), 0),
      option: findChild(n, "option") ? sym(findChild(n, "option")!, 0) : undefined,
      lineWidth: num(findChild(n, "linewidth"), 0, 0),
    };
    if (head === "line" || head === "rect") ds.items.push({ ...base, kind: head, start: pos(findChild(n, "start")), end: pos(findChild(n, "end")) });
    else if (head === "tbtext") {
      const font = findChild(n, "font");
      const size = font && findChild(font, "size");
      const flags = (l: List | undefined) => (l ? l.children.slice(1).filter(isAtom).map(atomText) : []);
      const just = flags(findChild(n, "justify"));
      const style = [...flags(font), ...(font ? font.children.filter(isList).flatMap((c) => (headOf(c) === "bold" || headOf(c) === "italic") && sym(c, 0) !== "no" ? [headOf(c)!] : []) : [])];
      ds.items.push({
        ...base,
        kind: "text",
        text: legacyCodes(atomText(n.children[1] as never) ?? ""),
        pos: pos(findChild(n, "pos")),
        size: size ? { x: num(size, 0), y: num(size, 1) } : ds.textSize,
        bold: style.includes("bold"),
        italic: style.includes("italic"),
        h: just.includes("center") ? "center" : just.includes("right") ? "right" : "left",
        v: just.includes("top") ? "top" : just.includes("bottom") ? "bottom" : "center",
        rotate: num(findChild(n, "rotate"), 0),
        incrlabel: num(findChild(n, "incrlabel"), 0, 1),
        maxlen: num(findChild(n, "maxlen"), 0),
        maxheight: num(findChild(n, "maxheight"), 0),
        lineWidth: font ? num(findChild(font, "linewidth"), 0, base.lineWidth) : base.lineWidth,
      });
    } else if (head === "bitmap") {
      // KiCad 7+ writes the PNG as base64 in (data …); older files as hex bytes in (pngdata (data …) …).
      const data = findChild(n, "data");
      const pngdata = findChild(n, "pngdata");
      let png = "";
      if (data) png = data.children.slice(1).filter(isAtom).map(atomText).join("").replace(/\s+/g, "");
      else if (pngdata) {
        const hex = findChildren(pngdata, "data").map((d) => atomText(d.children[1] as never) ?? "").join(" ");
        const bytes = hex.split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16)).filter((v) => !Number.isNaN(v));
        let bin = "";
        for (const b of bytes) bin += String.fromCharCode(b);
        png = btoa(bin);
      }
      if (png) ds.items.push({ ...base, kind: "bitmap", pos: pos(findChild(n, "pos")), scale: num(findChild(n, "scale"), 0, 1), png });
    } else if (head === "polygon") {
      ds.items.push({ ...base, kind: "polygon", pos: pos(findChild(n, "pos")), rotate: num(findChild(n, "rotate"), 0), outlines: findChildren(n, "pts").map((p) => findChildren(p, "xy").map((xy) => ({ x: num(xy, 0), y: num(xy, 1) }))) });
    }
  }
  return ds;
}

/** The variables of a sheet's texts, with the title block's (as KiCad resolves them on a drawing sheet). */
export function drawingSheetText(text: string, info: DrawingSheetInfo, depth = 0): string {
  if (!text.includes("${") || depth > 6) return text;
  const tb = info.titleBlock;
  return text.replace(/\$\{([^{}]+)\}/g, (all, key: string) => {
    const again = (v: string) => drawingSheetText(v, info, depth + 1);
    switch (key) {
      case "KICAD_VERSION":
        return info.generator ?? "";
      case "#":
        return info.page;
      case "##":
        return String(info.pages);
      case "SHEETNAME":
        return info.sheetName;
      case "SHEETPATH":
        return info.sheetPath;
      case "FILENAME":
        return info.fileName.split("/").pop()!;
      case "PAPER":
        return info.paper;
      case "LAYER":
        return info.layer ?? "";
      case "TITLE":
        return again(tb["title"] ?? "");
      case "ISSUE_DATE":
        return again(tb["date"] ?? "");
      case "REVISION":
        return again(tb["rev"] ?? "");
      case "COMPANY":
        return again(tb["company"] ?? "");
    }
    const comment = /^COMMENT([1-9])$/.exec(key);
    if (comment) return again(tb[`comment${comment[1]}`] ?? "");
    if (info.variables && Object.hasOwn(info.variables, key)) return again(info.variables[key]!);
    return all;
  });
}

/** KiCad's label stepping: the last letter or number, carried within its kind ("A"→"B", "9"→"10", "Z"→"AA"). */
function stepLabel(text: string, by: number): string {
  if (!by) return text;
  const m = /^(.*?)([0-9]+|[A-Za-z]+)([^0-9A-Za-z]*)$/.exec(text);
  if (!m) return text;
  const [, head, part, tail] = m;
  if (/^[0-9]+$/.test(part!)) return `${head}${Number(part) + by}${tail}`;
  const upper = part === part!.toUpperCase();
  const base = upper ? 65 : 97;
  let n = 0;
  for (const ch of part!) n = n * 26 + (ch.charCodeAt(0) - base + 1);
  n += by;
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(base + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return `${head}${s}${tail}`;
}

/**
 * The drawn sheet on a page of `width` × `height` mm. `firstPage` decides the items marked
 * page1only / notonpage1.
 */
export function drawingSheetPrims(ds: DrawingSheet, width: number, height: number, info: DrawingSheetInfo, firstPage: boolean): DrawingSheetPrim[] {
  const lt = { x: ds.margins.left, y: ds.margins.top };
  const rb = { x: width - ds.margins.right, y: height - ds.margins.bottom };
  const place = (p: Pos, i: number, incrx: number, incry: number): Point => {
    const x = p.x + incrx * i;
    const y = p.y + incry * i;
    switch (p.corner) {
      case "rb":
        return { x: rb.x - x, y: rb.y - y };
      case "rt":
        return { x: rb.x - x, y: lt.y + y };
      case "lb":
        return { x: lt.x + x, y: rb.y - y };
      default:
        return { x: lt.x + x, y: lt.y + y };
    }
  };
  // A repeat is kept while it stays on the page (the run's first position counts as on it).
  const inside = (pts: Point[], first: Point[]) => {
    const xs = [lt.x, rb.x, ...first.map((p) => p.x)];
    const ys = [lt.y, rb.y, ...first.map((p) => p.y)];
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return pts.every((p) => p.x >= x0 - 1e-9 && p.x <= x1 + 1e-9 && p.y >= y0 - 1e-9 && p.y <= y1 + 1e-9);
  };
  const out: DrawingSheetPrim[] = [];
  for (const item of ds.items) {
    if (item.option === "page1only" && !firstPage) continue;
    if (item.option === "notonpage1" && firstPage) continue;
    if (item.kind === "line" || item.kind === "rect") {
      const pen = item.lineWidth || ds.lineWidth;
      const first = [place(item.start, 0, item.incrx, item.incry), place(item.end, 0, item.incrx, item.incry)];
      for (let i = 0; i < item.repeat; i++) {
        const a = place(item.start, i, item.incrx, item.incry);
        const b = place(item.end, i, item.incrx, item.incry);
        if (i > 0 && !inside([a, b], first)) continue;
        out.push({ kind: item.kind, a, b, width: pen });
      }
    } else if (item.kind === "text") {
      const full = drawingSheetText(item.text, info);
      const multiline = full.includes("\\n");
      const first = [place(item.pos, 0, item.incrx, item.incry)];
      for (let i = 0; i < item.repeat; i++) {
        const at = place(item.pos, i, item.incrx, item.incry);
        if (i > 0 && !inside([at], first)) continue;
        const text = (item.repeat > 1 && !multiline ? stepLabel(full, i * item.incrlabel) : full).replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
        // Too long or too tall for its room: shrunk to fit, as KiCad does.
        let size = { ...item.size };
        if (item.maxlen > 0) {
          // KiCad measures the text in whole millimetres.
          const len = Math.round(Math.max(...text.split("\n").map((l) => strokeAdvance(l))) * size.x);
          if (len > item.maxlen) size = { ...size, x: (size.x * item.maxlen) / len };
        }
        if (item.maxheight > 0) {
          const lines = text.split("\n").length;
          const h = size.y * (1 + (lines - 1) * 1.6);
          if (h > item.maxheight) size = { ...size, y: (size.y * item.maxheight) / h };
        }
        out.push({ kind: "text", at, text, size, width: item.lineWidth || ds.textLineWidth, bold: item.bold, italic: item.italic, h: item.h, v: item.v, angle: item.rotate });
      }
    } else if (item.kind === "bitmap") {
      const info = bitmapInfo(base64Bytes(item.png, 1 << 16));
      if (!info) continue;
      const { w, h } = bitmapSizeMm(info, item.scale);
      const first = place(item.pos, 0, item.incrx, item.incry);
      for (let i = 0; i < item.repeat; i++) {
        const at = place(item.pos, i, item.incrx, item.incry);
        if (i > 0 && !inside([at], [first])) continue;
        out.push({ kind: "bitmap", at: { x: at.x - w / 2, y: at.y - h / 2 }, w, h, png: item.png });
      }
    } else if (item.kind === "polygon") {
      const first = place(item.pos, 0, item.incrx, item.incry);
      const rad = (item.rotate * Math.PI) / 180;
      for (let i = 0; i < item.repeat; i++) {
        const at = place(item.pos, i, item.incrx, item.incry);
        if (i > 0 && !inside([at], [first])) continue;
        for (const outline of item.outlines) {
          // Rotated about the item's position (KiCad's angle, y down: counter-clockwise on paper).
          const points = outline.map((p) => ({ x: at.x + p.x * Math.cos(rad) + p.y * Math.sin(rad), y: at.y - p.x * Math.sin(rad) + p.y * Math.cos(rad) }));
          out.push({ kind: "polygon", points, width: item.lineWidth });
        }
      }
    }
  }
  return out;
}

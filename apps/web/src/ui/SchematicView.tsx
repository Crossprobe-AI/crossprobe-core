import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Prim, SchItem, SheetView } from "../render/types";
import type { EditOp, SymbolSource } from "../edit/ops";
import { arcThrough, type LabelShape } from "@crossprobe/kicad-model";
import type { Selection } from "./selection";
import { Icon } from "./icons";
import { fromOverlay, useViewport } from "./viewport";

/** Render KiCad text markup: ~{overbar}, _{subscript}, ^{superscript}. */
function markup(text: string): ReactNode {
  if (!/[~_^]\{/.test(text)) return text;
  const parts: ReactNode[] = [];
  const re = /([~_^])\{([^}]*)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const [, kind, inner] = m;
    if (kind === "~") parts.push(<tspan key={i++} textDecoration="overline">{inner}</tspan>);
    else parts.push(<tspan key={i++} baselineShift={kind === "_" ? "sub" : "super"} fontSize="70%">{inner}</tspan>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const BASELINE = { top: "hanging", middle: "central", bottom: "alphabetic" } as const;

function PrimEl({ p }: { p: Prim }) {
  switch (p.t) {
    case "path":
      return <path d={p.d} className={`r-${p.role}${p.fill ? " fill" : ""}`} style={p.w ? { ["--w" as string]: `${p.w}px` } : undefined} />;
    case "image":
      return <image x={p.x} y={p.y} width={p.w} height={p.h} href={p.href} preserveAspectRatio="none" />;
    case "circle":
      return <circle cx={p.cx} cy={p.cy} r={p.r} className={`r-${p.role}${p.fill ? " fill" : ""}`} style={p.w ? { ["--w" as string]: `${p.w}px` } : undefined} />;
    case "text": {
      const y = p.baseline === "bottom" ? p.y - p.size * 0.12 : p.y;
      return (
        <text
          x={p.x}
          y={y}
          // KiCad's text size is the cap height of a fairly wide stroke font.
          fontSize={p.size * 1.36}
          letterSpacing={p.size * 0.08}
          textAnchor={p.anchor}
          dominantBaseline={BASELINE[p.baseline]}
          transform={p.angle ? `rotate(${-p.angle} ${p.x} ${p.y})` : undefined}
          className={`t-${p.role}`}
          fontWeight={p.bold ? 700 : undefined}
          fontStyle={p.italic ? "italic" : undefined}
        >
          {markup(p.text)}
        </text>
      );
    }
  }
}

const LABEL_SHAPES: Array<[LabelShape, string]> = [["input", "Input"], ["output", "Output"], ["bidirectional", "Bidirectional"], ["tri_state", "Tri-state"], ["passive", "Passive"]];

/** A picture as base64 PNG, as KiCad stores images: PNGs as they are, other kinds redrawn as PNG. */
async function toPngBase64(file: File): Promise<string | undefined> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1];
  } catch {
    return undefined;
  }
}

const HIT_KINDS = new Set<SchItem["kind"]>(["wire", "bus", "pin", "label", "directive", "ruleArea"]);

export type Tool = "select" | "wire" | "bus" | "busentry" | "text" | "textbox" | "line" | "rect" | "circle" | "arc" | "netclass" | "rulearea" | "image" | "label" | "glabel" | "hlabel" | "junction" | "noconnect" | "place" | "power" | "block" | "sheet" | "sheetpin";

/** What the editor needs to know about the project beyond the current sheet. */
export interface EditContext {
  projectName: string;
  /** Sheet instance paths that use a given file. */
  sheetPathsOf: (file: string) => string[];
  references: string[];
  /** The part chosen for the Place tool. */
  placing?: {
    key: string;
    source: SymbolSource;
    prefix: string;
    name: string;
    /** Placing further units of a placed part: its reference, and the units still to place (first next). */
    reference?: string;
    units?: number[];
  };
  /** A symbol was placed with the place tool. */
  onPlaced?: () => void;
  /** The design block chosen for the Add block tool (its schematic text). */
  placingBlock?: { id: string; title: string; text: string; pcb?: string };
  /** File of a sheet instance (for sheet pins), and the next free page number. */
  sheetFileOf: (sheetPath: string) => string | undefined;
  nextPage: number;
  /** The project's net classes, to offer when placing a directive. */
  netClasses?: string[];
  /** The project's folder ("" or "name/"), for files saved next to it (design blocks). */
  projectDir?: string;
  /** Names of the hierarchical labels inside a sheet instance. */
  hierLabelsOf: (sheetPath: string) => string[];
  /** Is a project-relative file name taken? */
  fileExists: (file: string) => boolean;
}

/** Next free reference numbers for a set of prefixes, e.g. R → R14, R15. */
export function nextReferences(used: string[], prefixes: string[]): string[] {
  const max = new Map<string, number>();
  for (const r of used) {
    const m = /^(.*?)(\d+)$/.exec(r);
    if (m) max.set(m[1]!, Math.max(max.get(m[1]!) ?? 0, Number(m[2])));
  }
  return prefixes.map((p) => {
    const n = (max.get(p) ?? 0) + 1;
    max.set(p, n);
    return `${p}${n}`;
  });
}
const refPrefix = (r: string) => r.replace(/[0-9?]+$/, "") || "U";

/** KiCad's default schematic grid: 50 mil. */
const GRID = 1.27;
const snap = (v: number) => Math.round(Math.round(v / GRID) * GRID * 1e4) / 1e4;
const snapPt = (p: { x: number; y: number }) => ({ x: snap(p.x), y: snap(p.y) });
/** Item kinds that can be selected and moved. */
const MOVABLE = new Set<SchItem["kind"]>(["symbol", "field", "pin", "wire", "bus", "label", "directive", "ruleArea", "junction", "noconnect", "text", "sheet", "graphic"]);

const Item = memo(function Item({
  item,
  highlighted,
  selected,
  offset,
}: {
  item: SchItem;
  highlighted: boolean;
  selected: boolean;
  offset?: { dx: number; dy: number };
}) {
  return (
    <g
      className={`i-${item.kind}${highlighted ? " hl" : ""}${selected ? " esel" : ""}`}
      data-net={item.net}
      data-ref={item.ref}
      data-sheet={item.sheetPath}
      data-uuid={item.uuid}
      transform={offset ? `translate(${offset.dx} ${offset.dy})` : undefined}
    >
      {item.prims.map((p, i) => (
        <PrimEl key={i} p={p} />
      ))}
      {/* Thin lines are hard to click: add an invisible, wider hit area. */}
      {HIT_KINDS.has(item.kind) &&
        item.prims.map((p, i) => (p.t === "path" && !p.fill ? <path key={`h${i}`} d={p.d} className="hit" /> : null))}
    </g>
  );
});

/** Connection points on the sheet: pin tips and wire ends (for snapping and finishing wires). */
function connectionPoints(sheet: SheetView): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const item of sheet.items) {
    if (item.kind !== "pin" && item.kind !== "wire") continue;
    const first = item.prims.find((p) => p.t === "path");
    if (!first || first.t !== "path") continue;
    const nums = first.d.replace(/[ML]/g, " ").trim().split(/\s+/).map(Number);
    if (nums.length >= 2) out.push({ x: nums[0]!, y: nums[1]! });
    if (item.kind === "wire" && nums.length >= 4) out.push({ x: nums[nums.length - 2]!, y: nums[nums.length - 1]! });
  }
  return out;
}

export function SchematicView({
  sheet,
  selection,
  onSelect,
  onOpenSheet,
  box,
  focusToken,
  reveal,
  markers,
  editing = false,
  tool = "select",
  onTool,
  onEdit,
  ctx,
}: {
  sheet: SheetView;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onOpenSheet: (path: string) => void;
  /** Initial area to frame, in sheet mm (defaults to the whole page). */
  box?: { x: number; y: number; w: number; h: number };
  /** Changes when the selection should be brought into view (e.g. picked in the inspector). */
  focusToken?: number;
  /** Frame these parts when `token` changes (e.g. a design block was just inserted below the page). */
  reveal?: { token: number; refs: string[]; /** Items by UUID (a field: "<symbol>#<name>"), selected when editing. */ uuids?: string[] };
  /** Issue markers to draw (all sheets; filtered here). */
  markers?: Array<{ sheet: string; at: { x: number; y: number }; severity: "error" | "warning"; label: string }>;
  editing?: boolean;
  tool?: Tool;
  onTool?: (t: Tool) => void;
  onEdit?: (ops: EditOp[]) => void;
  ctx?: EditContext;
}) {
  const content = useMemo(() => box ?? { x: 0, y: 0, w: sheet.paper.w, h: sheet.paper.h }, [sheet, box]);
  const vp = useViewport(content);
  const { scale, tx, ty } = vp.view;
  // Dev-only hook for browser tests: sheet mm → client pixels.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__schematicView = {
      toClient: (p: { x: number; y: number }) => {
        const r = vp.ref.current!.getBoundingClientRect();
        return { x: r.left + p.x * vp.view.scale + vp.view.tx, y: r.top + p.y * vp.view.scale + vp.view.ty };
      },
    };
  }

  // Editing state: selected item UUIDs, an in-progress move, a wire being drawn, the cursor.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ start: { x: number; y: number }; dx: number; dy: number; committed?: SheetView } | undefined>();
  const [wire, setWire] = useState<Array<{ x: number; y: number }>>([]);
  /** The Image tool: where the next picked file goes, and the file input it opens. */
  const imageAt = useRef<{ x: number; y: number } | undefined>(undefined);
  const imageInput = useRef<HTMLInputElement>(null);
  const placeImage = async (file: File) => {
    const at = imageAt.current;
    if (!at) return;
    const png = await toPngBase64(file);
    if (png) onEdit?.([{ op: "addImage", file: sheet.file, at, png }]);
  };
  /** The one selected image (a graphic drawn as a picture), whose size can be chosen. */
  const pickedImage = picked.size === 1 ? sheet.items.find((i) => i.kind === "graphic" && i.uuid && picked.has(i.uuid) && i.prims[0]?.t === "image") : undefined;
  /** The shape new global and hierarchical labels get (KiCad's defaults). */
  const [labelShape, setLabelShape] = useState<{ glabel: LabelShape; hlabel: LabelShape }>({ glabel: "input", hlabel: "bidirectional" });
  /** The one selected global or hierarchical label, whose shape can be changed. */
  const pickedLabel = picked.size === 1 ? sheet.items.find((i) => i.kind === "label" && i.shape && i.uuid && picked.has(i.uuid)) : undefined;
  const [cursor, setCursor] = useState<{ x: number; y: number }>();
  const dragRef = useRef(drag);
  dragRef.current = drag;
  /** The click that ends a drag shouldn't change the selection. */
  const justDragged = useRef(false);
  const [marquee, setMarquee] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | undefined>();
  const marqueeRef = useRef(marquee);
  marqueeRef.current = marquee;
  /** Copied items: their file and UUIDs, and the point they were copied relative to. */
  const clipboard = useRef<{ file: string; uuids: string[]; origin: { x: number; y: number } } | undefined>(undefined);
  /** A selected field of a symbol ("<symbol uuid>#<field name>"), unless its symbol is selected too (then it goes with it). */
  const fieldsOf = (ids: string[]) =>
    ids.flatMap((id) => {
      const at = id.indexOf("#");
      return at < 0 || ids.includes(id.slice(0, at)) ? [] : [{ uuid: id.slice(0, at), name: id.slice(at + 1) }];
    });
  /** The selected items that are nodes of the file (not fields). */
  const nodesOf = (ids: string[]) => ids.filter((id) => !id.includes("#"));
  /** The one selected sheet symbol, with what it and its sheet disagree on: labels inside without a pin, pins without a label. */
  const pickedSheet = picked.size === 1 ? sheet.items.find((i) => i.kind === "sheet" && i.uuid && picked.has(i.uuid)) : undefined;
  const sheetSync = useMemo(() => {
    if (!pickedSheet?.sheetPath) return undefined;
    const labels = ctx?.hierLabelsOf(pickedSheet.sheetPath) ?? [];
    const pins = pickedSheet.pinNames ?? [];
    return { pins: labels.filter((l) => !pins.includes(l)), labels: pins.filter((p) => !labels.includes(p)) };
  }, [pickedSheet, ctx]);
  const byUuid = useMemo(() => {
    const m = new Map<string, SchItem[]>();
    for (const it of sheet.items) if (it.uuid) m.set(it.uuid, [...(m.get(it.uuid) ?? []), it]);
    return m;
  }, [sheet]);

  /** Paste items as new copies, offset, with fresh references for symbols. */
  const paste = (file: string, uuids: string[], dx: number, dy: number) => {
    const symbols = uuids.filter((u) => byUuid.get(u)?.some((i) => i.kind === "symbol"));
    const refs = nextReferences(
      ctx?.references ?? [],
      symbols.map((u) => refPrefix(byUuid.get(u)?.find((i) => i.kind === "symbol")?.reference ?? "U")),
    );
    const references = Object.fromEntries(symbols.map((u, i) => [u, refs[i]!]));
    onEdit?.([{ op: "duplicate", source: file, file: sheet.file, uuids, dx, dy, references, sheetPaths: ctx?.sheetPathsOf(sheet.file) ?? [sheet.path] }]);
  };
  const points = useMemo(() => connectionPoints(sheet), [sheet]);

  // A new sheet (or leaving edit mode) clears the in-progress edit.
  useEffect(() => {
    setPicked(new Set());
    setWire([]);
    setDrag(undefined);
  }, [sheet.path, editing]);
  // The edited sheet has arrived: drop the committed drag preview.
  useEffect(() => {
    setDrag((d) => (d?.committed ? undefined : d));
  }, [sheet]);
  useEffect(() => {
    if (tool !== "wire" && tool !== "bus") setWire([]);
  }, [tool]);
  /** Drawing tools: the points clicked so far (a text box's or rectangle's first corner, a circle's centre, a line's corners). */
  const [draw, setDraw] = useState<Array<{ x: number; y: number }>>([]);
  useEffect(() => setDraw([]), [tool]);
  /** Ask for a net class by name, listing the project's. */
  const askNetClass = (title: string) => {
    const known = (ctx?.netClasses ?? []).filter((c) => c !== "Default");
    const name = window.prompt(`${title}${known.length ? ` (${known.join(", ")})` : ""}`, known[0] ?? "");
    return name?.trim() || undefined;
  };
  const finishRuleArea = (pts = draw) => {
    setDraw([]);
    if (pts.length < 3) return;
    onEdit?.([{ op: "addRuleArea", file: sheet.file, points: pts, netclass: askNetClass("Net class for everything inside (empty: none)") }]);
  };
  const finishLine = (pts = draw) => {
    if (pts.length >= 2) onEdit?.([{ op: "addSchGraphic", file: sheet.file, graphic: { kind: "polyline", points: pts } }]);
    setDraw([]);
  };
  /** Bus entry tool: which way the entry leans (R turns it), as its size vector. */
  const [entry, setEntry] = useState(0);
  const ENTRIES = [{ x: 2.54, y: 2.54 }, { x: 2.54, y: -2.54 }, { x: -2.54, y: -2.54 }, { x: -2.54, y: 2.54 }];

  // Zoom to the selection when asked to (not on clicks inside the view).
  useEffect(() => {
    if (!focusToken || !selection) return;
    const boxes =
      selection.kind === "marker"
        ? selection.sheet === sheet.path
          ? [{ x: selection.at.x - 1, y: selection.at.y - 1, w: 2, h: 2 }]
          : []
        : sheet.items
            .filter((i) => i.bbox && (selection.kind === "net" ? i.net === selection.name && i.kind !== "symbol" : i.ref === selection.reference && i.kind === "symbol"))
            .map((i) => i.bbox!);
    if (!boxes.length) return;
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    // Frame at least ~80 × 50 mm so the surroundings stay readable.
    const w = Math.max(x1 - x0 + 16, 80);
    const h = Math.max(y1 - y0 + 16, 50);
    vp.fit({ x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h });
    // Only for a new focus request or a different sheet: edits must not re-frame the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken, sheet.path]);

  useEffect(() => {
    if (!reveal?.token) return;
    const wanted = new Set(reveal.refs);
    const ids = new Set(reveal.uuids ?? []);
    const boxes = sheet.items.filter((i) => i.bbox && ((i.kind === "symbol" && i.ref && wanted.has(i.ref)) || (i.uuid && ids.has(i.uuid)))).map((i) => i.bbox!);
    if (!boxes.length) return;
    if (ids.size && editing) setPicked(new Set([...ids].filter((id) => byUuid.has(id))));
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    vp.fit({ x: x0 - 8, y: y0 - 8, w: x1 - x0 + 16, h: y1 - y0 + 16 });
    // Only for a new request: later edits must not re-frame the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.token]);

  const toSheet = (e: { clientX: number; clientY: number }) => {
    const r = vp.ref.current!.getBoundingClientRect();
    return vp.toContent(e.clientX - r.left, e.clientY - r.top);
  };

  /** The wire's next corner: horizontal first, then vertical, as KiCad draws. */
  const elbow = (from: { x: number; y: number }, to: { x: number; y: number }) =>
    from.x === to.x || from.y === to.y ? [to] : [{ x: to.x, y: from.y }, to];

  const finishWire = (pts = wire) => {
    if (pts.length >= 2) onEdit?.([{ op: "addWire", file: sheet.file, points: pts, bus: tool === "bus" }]);
    setWire([]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // The symbol or footprint editor open over the sheet has its own keys.
      if (document.querySelector(".fp-editor")) return;
      const uuids = nodesOf([...picked]);
      const fields = fieldsOf([...picked]);
      const k = e.key.toLowerCase();
      if (e.metaKey || e.ctrlKey) {
        if (!editing) return;
        if (k === "c" && uuids.length) {
          const pts = uuids.flatMap((u) => (byUuid.get(u) ?? []).flatMap((i) => i.points ?? (i.bbox ? [{ x: i.bbox.x, y: i.bbox.y }] : [])));
          const origin = pts.length ? snapPt({ x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)) }) : { x: 0, y: 0 };
          clipboard.current = { file: sheet.file, uuids, origin };
        } else if (k === "v" && clipboard.current) {
          const c = clipboard.current;
          const at = cursor ?? { x: c.origin.x + 5.08, y: c.origin.y + 5.08 };
          paste(c.file, c.uuids, snap(at.x - c.origin.x), snap(at.y - c.origin.y));
        } else if (k === "d" && uuids.length) {
          paste(sheet.file, uuids, 5.08, 5.08);
        } else if (k === "a") {
          setPicked(new Set(nodesOf([...byUuid.keys()])));
        } else return;
        e.preventDefault();
        return;
      }
      if (e.key === "f") vp.fit();
      if (!editing) return;
      if (k === "escape") {
        if (draw.length) setDraw([]);
        else if (wire.length) setWire([]);
        else if (tool !== "select") onTool?.("select");
        else setPicked(new Set());
      } else if (k === "enter" && wire.length) finishWire();
      else if (k === "enter" && draw.length && tool === "line") finishLine();
      else if (k === "enter" && draw.length && tool === "rulearea") finishRuleArea();
      else if (k === "t" && !e.shiftKey) onTool?.("text");
      else if (k === "w") onTool?.("wire");
      else if (k === "b" && !e.shiftKey) onTool?.("bus");
      else if (k === "z") onTool?.("busentry");
      else if (k === "r" && tool === "busentry") setEntry((n) => (n + 1) % 4);
      else if (k === "l" && (e.ctrlKey || e.metaKey)) {
        // KiCad's Ctrl+L, where the browser hands it over.
        e.preventDefault();
        onTool?.("glabel");
      } else if (k === "l") onTool?.("label");
      else if (k === "h") onTool?.("hlabel");
      else if (k === "s" && e.shiftKey) onTool?.("sheet");
      else if (k === "j") onTool?.("junction");
      else if (k === "q") onTool?.("noconnect");
      else if (k === "a" && !e.shiftKey) {
        // Don't let the key land in the part picker's search box that opens.
        e.preventDefault();
        onTool?.("place");
      } else if (k === "p" && !e.shiftKey) {
        e.preventDefault();
        onTool?.("power");
      }
      else if (!uuids.length && !fields.length) return;
      else if (k === "r") onEdit?.([...(uuids.length ? [{ op: "rotate" as const, file: sheet.file, uuids }] : []), ...fields.map((f) => ({ op: "rotateField" as const, file: sheet.file, ...f }))]);
      else if (!uuids.length) return;
      else if (k === "x" || k === "y") onEdit?.([{ op: "mirror", file: sheet.file, uuids, axis: k }]);
      else if (k === "delete" || k === "backspace") {
        onEdit?.([{ op: "delete", file: sheet.file, uuids }]);
        setPicked(new Set());
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const isHighlighted = (item: SchItem) =>
    (selection?.kind === "net" && !!item.net && item.net === selection.name) ||
    (selection?.kind === "component" && !!item.ref && item.ref === selection.reference && (item.kind === "symbol" || item.kind === "field"));

  // ERC markers on this sheet: KiCad-style arrows pointing at the problem.
  const sheetMarkers = (markers ?? []).filter((m) => m.sheet === sheet.path);

  const itemAt = (target: EventTarget) => (target as Element).closest("g[data-uuid]") as SVGGElement | null;
  /**
   * What is under the pointer: the drawn element hit, else the smallest symbol
   * whose body contains the point (clicking inside an outline selects it, as in KiCad).
   */
  const hitElement = (e: { clientX: number; clientY: number; target: EventTarget }): Element => {
    const under = document.elementFromPoint(e.clientX, e.clientY) ?? (e.target as Element);
    if (under.closest("g[data-uuid]")) return under;
    const q = toSheet(e);
    let best: SchItem | undefined;
    for (const i of sheet.items) {
      const b = i.kind === "symbol" || (editing && i.kind === "field") ? i.bbox : undefined;
      if (!b || !i.uuid || q.x < b.x || q.x > b.x + b.w || q.y < b.y || q.y > b.y + b.h) continue;
      if (!best || b.w * b.h < best.bbox!.w * best.bbox!.h) best = i;
    }
    const el = best && vp.ref.current?.querySelector(`g.i-${best.kind}[data-uuid="${CSS.escape(best.uuid!)}"]`);
    return el ?? under;
  };

  const onClick = (e: React.MouseEvent) => {
    if (fromOverlay(e)) return;
    if (vp.wasDrag()) return;
    if (justDragged.current) {
      justDragged.current = false;
      return;
    }
    if (editing && tool !== "select") {
      const p0 = snapPt(toSheet(e));
      // Snap to a nearby connection point, so wires land exactly on pins.
      const near = points.find((q) => Math.hypot(q.x - p0.x, q.y - p0.y) < GRID * 0.6);
      const p = near ?? p0;
      if (tool === "text") {
        const text = window.prompt("Text");
        if (text) onEdit?.([{ op: "addSchText", file: sheet.file, text, at: p0 }]);
        return;
      }
      if (tool === "image") {
        // The browser asks for the file; the image goes where the sheet was clicked.
        imageAt.current = p0;
        imageInput.current?.click();
        return;
      }
      if (tool === "netclass") {
        const name = askNetClass("Net class for this wire's net");
        if (name) onEdit?.([{ op: "addDirective", file: sheet.file, at: p, netclass: name }]);
        return;
      }
      if (tool === "rulearea") {
        if (e.detail >= 2) return finishRuleArea();
        setDraw([...draw, p0]);
        return;
      }
      if (tool === "line") {
        if (e.detail >= 2) return finishLine();
        setDraw([...draw, p0]);
        return;
      }
      if (tool === "arc") {
        // Start, end, then a point the arc passes through.
        if (draw.length < 2) {
          if (draw.length === 1 && draw[0]!.x === p0.x && draw[0]!.y === p0.y) return;
          return setDraw([...draw, p0]);
        }
        const [a, b] = draw as [{ x: number; y: number }, { x: number; y: number }];
        setDraw([]);
        onEdit?.([{ op: "addSchGraphic", file: sheet.file, graphic: { kind: "arc", points: [a, p0, b] } }]);
        return;
      }
      if (tool === "textbox" || tool === "rect" || tool === "circle") {
        if (!draw.length) return setDraw([p0]);
        const a = draw[0]!;
        setDraw([]);
        if (a.x === p0.x && a.y === p0.y) return;
        if (tool === "textbox") {
          const text = window.prompt("Text box");
          if (text) onEdit?.([{ op: "addSchTextBox", file: sheet.file, text, a, b: p0 }]);
        } else onEdit?.([{ op: "addSchGraphic", file: sheet.file, graphic: { kind: tool === "rect" ? "rectangle" : "circle", points: [a, p0] } }]);
        return;
      }
      if (tool === "busentry") {
        onEdit?.([{ op: "addBusEntry", file: sheet.file, at: p, size: ENTRIES[entry]! }]);
        return;
      }
      if (tool === "wire" || tool === "bus") {
        if (e.detail >= 2) return finishWire();
        const next = wire.length ? [...wire, ...elbow(wire[wire.length - 1]!, p)] : [p];
        // Ending on a pin, a wire end or the middle of a wire completes the wire, as in KiCad (a bus: on a bus).
        const onWire = sheet.items.some((i) => {
          if (i.kind !== (tool === "bus" ? "bus" : "wire") || i.points?.length !== 2) return false;
          const [a, b] = i.points as [{ x: number; y: number }, { x: number; y: number }];
          const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
          return Math.abs(cross) < 1e-6 && p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6 && p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6;
        });
        if (wire.length && (near || onWire)) return finishWire(next);
        setWire(next);
      } else if (tool === "label" || tool === "glabel" || tool === "hlabel") {
        const text = window.prompt(tool === "label" ? "Label name" : tool === "glabel" ? "Global label name (one net across every sheet)" : "Hierarchical label name");
        // On a pin, the label reads away from the part (as one would rotate it in KiCad).
        const pin = sheet.items.find((i) => i.kind === "pin" && i.outward !== undefined && i.points?.[0] && Math.hypot(i.points[0].x - p.x, i.points[0].y - p.y) < 1e-6);
        const angle = pin ? pin.outward! : tool === "hlabel" ? 180 : 0;
        if (text) onEdit?.([{ op: "addLabel", file: sheet.file, kind: tool === "label" ? "label" : tool === "glabel" ? "global_label" : "hierarchical_label", text, at: p, angle, shape: tool === "label" ? undefined : labelShape[tool] }]);
      } else if (tool === "sheetpin") {
        // The sheet whose rectangle (with a little slack for the edge) contains the click.
        const q = toSheet(e);
        const hit = sheet.items.find((i) => {
          if (i.kind !== "sheet") return false;
          const d = i.prims[0]?.t === "path" ? i.prims[0].d : "";
          const n = d.replace(/[MLZ]/g, " ").trim().split(/\s+/).map(Number);
          const xs = n.filter((_, k) => k % 2 === 0);
          const ys = n.filter((_, k) => k % 2 === 1);
          return q.x >= Math.min(...xs) - 1.5 && q.x <= Math.max(...xs) + 1.5 && q.y >= Math.min(...ys) - 1.5 && q.y <= Math.max(...ys) + 1.5;
        });
        const sheetPath = hit?.sheetPath;
        const uuid = hit?.uuid;
        const childFile = sheetPath ? ctx?.sheetFileOf(sheetPath) : undefined;
        if (!uuid || !childFile) return;
        const name = window.prompt("Sheet pin name (a matching hierarchical label is added inside the sheet)");
        if (name) onEdit?.([{ op: "addSheetPin", file: sheet.file, sheetUuid: uuid, childFile, name, shape: "bidirectional", at: toSheet(e) }]);
      } else if (tool === "place" || tool === "power") {
        const part = ctx?.placing;
        if (!part) return;
        const reference = part.reference ?? nextReferences(ctx?.references ?? [], [part.prefix])[0]!;
        onEdit?.([
          {
            op: "placeSymbol",
            file: sheet.file,
            source: part.source,
            at: p,
            reference,
            unit: part.units?.[0],
            sheetPaths: ctx?.sheetPathsOf(sheet.file) ?? [sheet.path],
            projectName: ctx?.projectName ?? "",
          },
        ]);
        ctx?.onPlaced?.();
      } else if (tool === "block") {
        const block = ctx?.placingBlock;
        if (!block) return;
        onEdit?.([{ op: "insertBlock", file: sheet.file, blockText: block.text, blockPcb: block.pcb, at: p, sheetPaths: ctx?.sheetPathsOf(sheet.file) ?? [sheet.path], projectName: ctx?.projectName ?? "" }]);
      } else if (tool === "junction") onEdit?.([{ op: "addJunction", file: sheet.file, at: p }]);
      else if (tool === "noconnect") onEdit?.([{ op: "addNoConnect", file: sheet.file, at: p }]);
      return;
    }
    // Pointer capture (for dragging) retargets the click to the viewport: use what is under the pointer.
    const under = hitElement(e);
    const g = under.closest("g[data-net], g[data-ref], g[data-sheet]") as SVGGElement | null;
    if (editing) {
      const it = itemAt(under);
      const id = it?.dataset.uuid;
      // Double-click a label or text to change what it says.
      // Double-click a net class directive to change its class.
      if (e.detail >= 2 && id && it?.classList.contains("i-directive")) {
        const now = sheet.items.find((i) => i.uuid === id)?.text ?? "";
        const name = window.prompt("Net class", now);
        if (name !== null && name !== now) onEdit?.([{ op: "setField", file: sheet.file, uuid: id, name: "Netclass", value: name.trim() }]);
        return;
      }
      // Double-click a field to change its value.
      if (e.detail >= 2 && id && it?.classList.contains("i-field")) {
        const f = sheet.items.find((i) => i.uuid === id);
        const text = f?.field ? window.prompt(f.field, f.text ?? "") : null;
        if (f?.owner && text !== null && text !== f.text) {
          onEdit?.([{ op: "setField", file: sheet.file, uuid: f.owner, name: f.field!, value: text!, sheetPath: sheet.path }]);
          if (f.field === "Reference" && f.ref) onSelect({ kind: "component", reference: text! });
        }
        return;
      }
      if (e.detail >= 2 && id && it && (it.classList.contains("i-label") || it.classList.contains("i-text"))) {
        // The text as written: what is drawn has its ${VARIABLES} replaced.
        const now = sheet.items.find((i) => i.uuid === id)?.text ?? it.textContent ?? "";
        const text = window.prompt("Text", now);
        if (text && text !== now) onEdit?.([{ op: "setText", file: sheet.file, uuid: id, text }]);
        return;
      }
      setPicked((prev) => {
        if (!id) return new Set();
        if (e.shiftKey) {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }
        return new Set([id]);
      });
    }
    if (!g) return onSelect(null);
    if (g.dataset.sheet && e.detail >= 2 && !editing) return onOpenSheet(g.dataset.sheet);
    // While editing, a pin belongs to its symbol (it is what gets moved); when viewing, it shows its net.
    const pinSelectsNet = g.classList.contains("i-pin") && !(editing && g.dataset.ref);
    if (g.dataset.net && (g.classList.contains("i-wire") || g.classList.contains("i-label") || pinSelectsNet || !g.dataset.ref)) {
      return onSelect({ kind: "net", name: g.dataset.net });
    }
    if (g.dataset.ref) return onSelect({ kind: "component", reference: g.dataset.ref });
    if (g.dataset.sheet) return onSelect(null);
  };

  // Moving: press on an item in select mode and drag; the move snaps to the grid.
  const onPointerDown = (e: React.PointerEvent) => {
    if (fromOverlay(e)) return;
    // A drag that ended without a click mustn't swallow the next real click.
    justDragged.current = false;
    if (editing && tool === "sheet" && e.button === 0) {
      const p = snapPt(toSheet(e));
      setMarquee({ a: p, b: p });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (editing && tool === "select" && e.button === 0) {
      const it = itemAt(hitElement(e));
      const id = it?.dataset.uuid;
      const kind = it?.getAttribute("class")?.match(/i-(\w+)/)?.[1] as SchItem["kind"] | undefined;
      if (id && kind && MOVABLE.has(kind)) {
        if (!picked.has(id)) setPicked(e.shiftKey ? new Set([...picked, id]) : new Set([id]));
        setDrag({ start: toSheet(e), dx: 0, dy: 0 });
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }
      if (e.shiftKey) {
        // Shift-drag on empty space: box selection.
        const p = toSheet(e);
        setMarquee({ a: p, b: p });
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }
    }
    vp.handlers.onPointerDown(e);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (editing) setCursor(snapPt(toSheet(e)));
    const d = dragRef.current;
    if (d && !d.committed) {
      const p = toSheet(e);
      setDrag({ ...d, dx: snap(p.x - d.start.x), dy: snap(p.y - d.start.y) });
      return;
    }
    if (marqueeRef.current) {
      setMarquee({ ...marqueeRef.current, b: toSheet(e) });
      return;
    }
    vp.handlers.onPointerMove(e);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const bx = marqueeRef.current;
    if (bx && tool === "sheet") {
      setMarquee(undefined);
      justDragged.current = true;
      const a = snapPt({ x: Math.min(bx.a.x, bx.b.x), y: Math.min(bx.a.y, bx.b.y) });
      const size = { x: snap(Math.abs(bx.b.x - bx.a.x)), y: snap(Math.abs(bx.b.y - bx.a.y)) };
      if (size.x < 5 || size.y < 5) return;
      const name = window.prompt("Sheet name");
      if (!name) return;
      let base = name.replace(/[^A-Za-z0-9_-]+/g, "_").toLowerCase() || "sheet";
      let newFile = `${base}.kicad_sch`;
      for (let i = 2; ctx?.fileExists(newFile); i++) newFile = `${base}_${i}.kicad_sch`;
      onEdit?.([
        {
          op: "addSheet",
          file: sheet.file,
          newFile,
          name,
          at: a,
          size,
          parentPaths: ctx?.sheetPathsOf(sheet.file) ?? [sheet.path],
          projectName: ctx?.projectName ?? "",
          page: ctx?.nextPage ?? 2,
        },
      ]);
      return;
    }
    if (bx) {
      setMarquee(undefined);
      justDragged.current = true;
      const x0 = Math.min(bx.a.x, bx.b.x), x1 = Math.max(bx.a.x, bx.b.x), y0 = Math.min(bx.a.y, bx.b.y), y1 = Math.max(bx.a.y, bx.b.y);
      const inside = sheet.items.filter((i) => i.uuid && i.kind !== "field" && i.bbox && i.bbox.x >= x0 && i.bbox.y >= y0 && i.bbox.x + i.bbox.w <= x1 && i.bbox.y + i.bbox.h <= y1);
      setPicked(new Set([...picked, ...inside.map((i) => i.uuid!)]));
      return;
    }
    const last = dragRef.current;
    if (last && !last.committed) {
      // Where the pointer is now: the last move may not have been drawn yet.
      const p = toSheet(e);
      const d = { ...last, dx: snap(p.x - last.start.x), dy: snap(p.y - last.start.y) };
      justDragged.current = !!(d.dx || d.dy);
      // Keep showing the moved state until the edited sheet arrives, so nothing jumps back.
      setDrag(d.dx || d.dy ? { ...d, committed: sheet } : undefined);
      // If the edit fails no new sheet arrives: don't leave the preview stuck.
      setTimeout(() => setDrag((x) => (x?.committed ? undefined : x)), 3000);
      if (d.dx || d.dy) {
        onEdit?.([...dragOps(nodesOf([...picked]), d.dx, d.dy), ...fieldsOf([...picked]).map((f) => ({ op: "moveField" as const, file: sheet.file, ...f, dx: d.dx, dy: d.dy }))]);
        e.preventDefault();
      }
      return;
    }
    vp.handlers.onPointerUp();
  };

  /**
   * Dragging keeps connections, like KiCad's drag: wires attached to what
   * moves follow it and stay orthogonal. A horizontal wire attached to a
   * moved pin slides its far corner vertically (stretching the next wire)
   * when that corner is free; otherwise a short bend segment is added.
   */
  const planDrag = (uuids: string[], dx: number, dy: number) => {
    const moving = new Set(uuids);
    const key = (p: { x: number; y: number }) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;
    const moved = new Set<string>();
    for (const u of uuids) for (const it of byUuid.get(u) ?? []) for (const p of it.points ?? []) moved.add(key(p));
    // What sits at each point that does not move: wire ends, and anything else (pins, labels, junctions…).
    const wiresAt = new Map<string, Array<{ uuid: string; index: 0 | 1 }>>();
    const fixedAt = new Set<string>();
    const wires = sheet.items.filter((it) => it.kind === "wire" && it.uuid && !moving.has(it.uuid) && it.points && it.points.length >= 2);
    for (const w of wires) w.points!.slice(0, 2).forEach((p, index) => wiresAt.set(key(p), [...(wiresAt.get(key(p)) ?? []), { uuid: w.uuid!, index: index as 0 | 1 }]));
    for (const it of sheet.items) {
      if (it.kind === "wire" || (it.uuid && moving.has(it.uuid))) continue;
      for (const p of it.points ?? []) fixedAt.add(key(p));
    }
    const ends = new Map<string, [{ x: number; y: number }, { x: number; y: number }]>();
    const geom = (w: SchItem) => ends.get(w.uuid!) ?? [w.points![0]!, w.points![1]!];
    const setEnd = (uuid: string, index: 0 | 1, to: { x: number; y: number }) => {
      const w = wires.find((x) => x.uuid === uuid)!;
      const g = [...geom(w)] as [{ x: number; y: number }, { x: number; y: number }];
      g[index] = to;
      ends.set(uuid, g);
    };
    const bends: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];
    for (const w of wires) {
      const [p0, p1] = [w.points![0]!, w.points![1]!];
      const m0 = moved.has(key(p0));
      const m1 = moved.has(key(p1));
      if (!m0 && !m1) continue;
      if (m0 && m1) {
        ends.set(w.uuid!, [{ x: p0.x + dx, y: p0.y + dy }, { x: p1.x + dx, y: p1.y + dy }]);
        continue;
      }
      const index: 0 | 1 = m0 ? 0 : 1;
      const e = m0 ? p0 : p1;
      const o = m0 ? p1 : p0;
      const ne = { x: e.x + dx, y: e.y + dy };
      const horizontal = Math.abs(e.y - o.y) < 1e-6;
      const vertical = Math.abs(e.x - o.x) < 1e-6;
      // The wire's own axis needs no help: moving along it just stretches it.
      const across = horizontal ? dy : vertical ? dx : 0;
      if (!across || (!horizontal && !vertical)) {
        setEnd(w.uuid!, index, ne);
        continue;
      }
      // Slide the far corner across too, if it is a plain corner with one perpendicular wire.
      const others = (wiresAt.get(key(o)) ?? []).filter((x) => x.uuid !== w.uuid);
      const corner = others.length === 1 && !fixedAt.has(key(o)) && !moved.has(key(o)) ? others[0]! : undefined;
      const cw = corner && wires.find((x) => x.uuid === corner.uuid)!;
      const perpendicular =
        cw && (horizontal ? Math.abs(cw.points![0]!.x - cw.points![1]!.x) < 1e-6 : Math.abs(cw.points![0]!.y - cw.points![1]!.y) < 1e-6);
      if (corner && perpendicular) {
        const no = horizontal ? { x: o.x, y: o.y + dy } : { x: o.x + dx, y: o.y };
        setEnd(w.uuid!, index, ne);
        setEnd(w.uuid!, (1 - index) as 0 | 1, no);
        setEnd(corner.uuid, corner.index, no);
      } else {
        // Keep this wire on its axis and add a bend segment to the moved end.
        const slid = horizontal ? { x: e.x + dx, y: e.y } : { x: e.x, y: e.y + dy };
        setEnd(w.uuid!, index, slid);
        bends.push([slid, ne]);
      }
    }
    return { ends, bends };
  };

  const dragOps = (uuids: string[], dx: number, dy: number): EditOp[] => {
    if (!uuids.length) return [];
    const { ends, bends } = planDrag(uuids, dx, dy);
    const ops: EditOp[] = [{ op: "move", file: sheet.file, uuids, dx, dy }];
    const byId = new Map(sheet.items.filter((i) => i.kind === "wire" && i.uuid).map((i) => [i.uuid!, i]));
    for (const [uuid, [a, b]] of ends) {
      const w = byId.get(uuid)!;
      if (a.x !== w.points![0]!.x || a.y !== w.points![0]!.y) ops.push({ op: "moveWirePoint", file: sheet.file, uuid, index: 0, to: a });
      if (b.x !== w.points![1]!.x || b.y !== w.points![1]!.y) ops.push({ op: "moveWirePoint", file: sheet.file, uuid, index: 1, to: b });
    }
    for (const [a, b] of bends) if (a.x !== b.x || a.y !== b.y) ops.push({ op: "addWire", file: sheet.file, points: [a, b] });
    return ops;
  };

  // Live preview of the wires that follow a drag.
  // A committed drag only applies to the sheet it was made on (until the edited one arrives).
  const liveDrag = drag && (!drag.committed || drag.committed === sheet) ? drag : undefined;
  const dragPlan = useMemo(
    () => (liveDrag && (liveDrag.dx || liveDrag.dy) ? planDrag([...picked], liveDrag.dx, liveDrag.dy) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveDrag?.dx, liveDrag?.dy, picked, sheet],
  );

  const offset = liveDrag && (liveDrag.dx || liveDrag.dy) ? { dx: liveDrag.dx, dy: liveDrag.dy } : undefined;
  const shapePreview: Array<{ x: number; y: number }> =
    draw.length && cursor
      ? tool === "line"
        ? [...draw, cursor]
        : tool === "rulearea"
          ? [...draw, cursor, draw[0]!]
        : tool === "rect" || tool === "textbox"
          ? [draw[0]!, { x: cursor.x, y: draw[0]!.y }, cursor, { x: draw[0]!.x, y: cursor.y }, draw[0]!]
          : tool === "circle"
            ? Array.from({ length: 49 }, (_, i) => {
                const r = Math.hypot(cursor.x - draw[0]!.x, cursor.y - draw[0]!.y);
                return { x: draw[0]!.x + r * Math.cos((i * Math.PI) / 24), y: draw[0]!.y + r * Math.sin((i * Math.PI) / 24) };
              })
            : tool === "arc"
              ? draw.length === 1
                ? [draw[0]!, cursor]
                : (() => {
                    const arc = arcThrough(draw[0]!, cursor, draw[1]!);
                    if (!arc) return [draw[0]!, draw[1]!];
                    const start = Math.atan2(draw[0]!.y - arc.center.y, draw[0]!.x - arc.center.x);
                    return Array.from({ length: 41 }, (_, i) => ({ x: arc.center.x + arc.radius * Math.cos(start + (arc.sweep * i) / 40), y: arc.center.y + arc.radius * Math.sin(start + (arc.sweep * i) / 40) }));
                  })()
              : []
      : [];
  const preview = wire.length && cursor && (tool === "wire" || tool === "bus") ? [...wire, ...elbow(wire[wire.length - 1]!, cursor)] : [];

  return (
    <div
      className={`viewport schematic${editing ? ` editing tool-${tool}` : ""}`}
      ref={vp.ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onClick}
      onDoubleClick={onClick}
    >
      <svg width="100%" height="100%">
        <g
          transform={`translate(${tx} ${ty}) scale(${scale})`}
          className={selection && selection.kind !== "marker" && !editing ? "has-selection" : undefined}
          style={{ ["--px" as string]: `${1 / scale}px` }}
        >
          <rect x={0} y={0} width={sheet.paper.w} height={sheet.paper.h} className="paper" />
          {sheet.items.map((item, i) => {
            const sel = (!!item.uuid && picked.has(item.uuid)) || (!!item.owner && picked.has(item.owner));
            if (dragPlan && item.kind === "wire" && item.uuid && dragPlan.ends.has(item.uuid)) return null;
            return <Item key={i} item={item} highlighted={isHighlighted(item)} selected={sel} offset={sel ? offset : undefined} />;
          })}
          {dragPlan &&
            [...dragPlan.ends.values(), ...dragPlan.bends].map(([a, b], i) => (
              <line key={`dw${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="wire-drag" />
            ))}
          {marquee && (
            <rect
              className="box-select"
              x={Math.min(marquee.a.x, marquee.b.x)}
              y={Math.min(marquee.a.y, marquee.b.y)}
              width={Math.abs(marquee.b.x - marquee.a.x)}
              height={Math.abs(marquee.b.y - marquee.a.y)}
            />
          )}
          {shapePreview.length > 1 && <polyline points={shapePreview.map((p) => `${p.x},${p.y}`).join(" ")} className="wire-preview graphic-preview" />}
          {preview.length > 1 && <polyline points={preview.map((p) => `${p.x},${p.y}`).join(" ")} className={tool === "bus" ? "wire-preview bus-preview" : "wire-preview"} />}
          {editing && cursor && tool !== "select" && (
            <g className="cursor-cross" transform={`translate(${cursor.x} ${cursor.y})`}>
              <path d={`M${-2.5 / scale * 8} 0 L${2.5 / scale * 8} 0 M0 ${-2.5 / scale * 8} L0 ${2.5 / scale * 8}`} />
            </g>
          )}
          {sheetMarkers.map((m, i) => {
            const active = selection?.kind === "marker" && selection.sheet === m.sheet && selection.at.x === m.at.x && selection.at.y === m.at.y;
            // A small arrow whose tip touches the problem point, sized in screen pixels.
            const s = Math.max(1.2, 14 / scale);
            return (
              <g key={`m${i}`} className={`marker ${m.severity}${active ? " active" : ""}`} transform={`translate(${m.at.x} ${m.at.y}) scale(${s})`}>
                <title>{m.label}</title>
                <path d="M0 0 L0.35 -0.9 L0.15 -0.85 L0.6 -1.4 L0.95 -1.1 L0.45 -0.65 L0.65 -0.5 Z" />
              </g>
            );
          })}
        </g>
      </svg>
      {editing && (
        <div className="edit-hint">
          {tool === "select" &&
            (picked.size
              ? [...picked].every((id) => id.includes("#"))
                ? "Field selected · drag to move · R turns it · double-click to edit"
                : `${picked.size} selected · drag to move · R rotate · X/Y mirror · Del delete · ⌘C/⌘V copy · ⌘D duplicate · `
              : "Click to select · shift-click or shift-drag to add · drag to move")}
          {tool === "wire" && (wire.length ? "Click to add corners · end on a pin or double-click · Esc cancels" : "Click to start a wire")}
          {tool === "bus" && (wire.length ? "Click to add corners · end on a bus or double-click · Esc cancels" : "Click to start a bus (name it with a label like D[0..7])")}
          {tool === "text" && "Click to place text"}
          {tool === "textbox" && (draw.length ? "Click the opposite corner of the text box" : "Click a corner of the text box")}
          {tool === "line" && (draw.length ? "Click the next corner · double-click or Enter to finish · Esc cancels" : "Click to start lines")}
          {tool === "netclass" && "Click a wire to give its net a net class"}
          {tool === "image" && "Click where the image goes (its centre), then pick a picture"}
          {tool === "select" && pickedImage && (
            <label className="hint-option">
              {" · size "}
              <select defaultValue="" onChange={(e) => e.target.value && onEdit?.([{ op: "setImageScale", file: sheet.file, uuid: pickedImage.uuid!, scale: Number(e.target.value) }])}>
                <option value="">…</option>
                {[0.25, 0.5, 1, 2, 4].map((s) => (
                  <option key={s} value={s}>{s * 100}%</option>
                ))}
              </select>
            </label>
          )}
          {tool === "rulearea" && (draw.length ? "Click the next corner · double-click or Enter to close it · Esc cancels" : "Click the first corner of a rule area (its net class applies to everything inside)")}
          {tool === "rect" && (draw.length ? "Click the opposite corner" : "Click a corner of the rectangle")}
          {tool === "circle" && (draw.length ? "Click a point on the circle" : "Click the circle's centre")}
          {tool === "arc" && (["Click where the arc starts", "Click where it ends", "Click a point it passes through · Esc cancels"][draw.length] ?? "")}
          {tool === "busentry" && `Click on a bus to place an entry, leaning ${["↘", "↗", "↖", "↙"][entry]} · R turns it`}
          {tool === "label" && "Click a wire to place a label"}
          {tool === "junction" && "Click to place a junction"}
          {tool === "noconnect" && "Click a pin to mark it as not connected"}
          {tool === "glabel" && "Click to place a global label (one net across every sheet)"}
          {tool === "hlabel" && "Click to place a hierarchical label (connects to a sheet pin in the parent)"}
          {(tool === "glabel" || tool === "hlabel") && (
            <label className="hint-option">
              {" · shape "}
              <select value={labelShape[tool]} onChange={(e) => setLabelShape((s) => ({ ...s, [tool]: e.target.value as LabelShape }))}>
                {LABEL_SHAPES.map(([v, name]) => <option key={v} value={v}>{name}</option>)}
              </select>
            </label>
          )}
          {tool === "select" && pickedSheet && (
            <span className="hint-option">
              {" · "}
              <button
                className="link"
                title="Rename the sheet"
                onClick={() => {
                  const name = window.prompt("Sheet name", pickedSheet.text ?? "");
                  if (name && name !== pickedSheet.text) onEdit?.([{ op: "setSheetProps", file: sheet.file, uuid: pickedSheet.uuid!, name }]);
                }}
              >
                Rename
              </button>
              {" · "}
              <button
                className="link"
                title="The sheet's page number (annotation by sheet number and the netlist follow it)"
                onClick={() => {
                  const number = window.prompt("Page number", pickedSheet.page ?? "");
                  if (number && number !== pickedSheet.page) onEdit?.([{ op: "setSheetProps", file: sheet.file, uuid: pickedSheet.uuid!, page: { path: sheet.path, number } }]);
                }}
              >
                Page {pickedSheet.page}
              </button>
              {sheetSync && sheetSync.pins.length + sheetSync.labels.length > 0 && (
                <>
                  {" · "}
                  <button
                    className="link"
                    title={[sheetSync.pins.length && `Add pins for the labels inside: ${sheetSync.pins.join(", ")}`, sheetSync.labels.length && `Add labels inside for the pins: ${sheetSync.labels.join(", ")}`].filter(Boolean).join(". ")}
                    onClick={() => {
                      const childFile = ctx?.sheetFileOf(pickedSheet.sheetPath!);
                      if (childFile) onEdit?.([{ op: "syncSheetPins", file: sheet.file, sheetUuid: pickedSheet.uuid!, childFile }]);
                    }}
                  >
                    Sync pins ({sheetSync.pins.length + sheetSync.labels.length})
                  </button>
                </>
              )}
            </span>
          )}
          {tool === "select" && nodesOf([...picked]).length > 0 && ctx && (
            <span className="hint-option">
              <button
                className="link"
                title="Save the selected items as a design block in this project's block library (KiCad's Save Selection as Design Block)"
                onClick={() => {
                  const raw = window.prompt("Design block name");
                  const name = raw?.trim().replace(/[\\/:*?"<>|]+/g, "_");
                  if (!name) return;
                  const description = window.prompt("Description (optional)", "") ?? "";
                  const lib = (ctx.projectName || "project").replace(/[\\/:*?"<>|]+/g, "_");
                  onEdit?.([{ op: "saveBlock", file: sheet.file, uuids: nodesOf([...picked]), dir: ctx.projectDir ?? "", lib, name, description, keywords: [], projectName: ctx.projectName }]);
                }}
              >
                Save as block
              </button>
            </span>
          )}
          {tool === "select" && pickedLabel && (
            <label className="hint-option">
              {" · shape "}
              <select value={pickedLabel.shape} onChange={(e) => onEdit?.([{ op: "setLabelShape", file: sheet.file, uuid: pickedLabel.uuid!, shape: e.target.value as LabelShape }])}>
                {LABEL_SHAPES.map(([v, name]) => <option key={v} value={v}>{name}</option>)}
              </select>
            </label>
          )}
          {tool === "sheet" && "Drag a rectangle to add a sub-sheet"}
          {tool === "sheetpin" && "Click a sheet's edge to add a pin"}
          {(tool === "place" || tool === "power") && (ctx?.placing ? `Click to place ${ctx.placing.reference && ctx.placing.units?.length ? `${ctx.placing.reference}${String.fromCharCode(64 + ctx.placing.units[0]!)} (${ctx.placing.name})` : ctx.placing.name} · Esc to stop` : tool === "power" ? "Pick a power symbol to place" : "Pick a part to place")}
          {tool === "block" && (ctx?.placingBlock ? `Click to place ${ctx.placingBlock.title} (top-left corner) · Esc to stop` : "Pick a design block")}
        </div>
      )}
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void placeImage(f);
        }}
      />
      <div className="view-tools">
        <button onClick={() => vp.fit()} title="Fit sheet (F)"><Icon name="fit" /> Fit</button>
      </div>
    </div>
  );
}

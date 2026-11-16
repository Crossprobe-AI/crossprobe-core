/**
 * The footprint editor (KiCad's footprint editor, for the project's own library): pads one at a
 * time or as rows and grids, lines / rectangles / circles on silkscreen, fab and courtyard, the
 * footprint's properties and fields, an IPC courtyard, and "update on the board" for the parts
 * that use it. Edits are ordinary, undoable edits of the .kicad_mod file.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { padPolygons, parseBoard, textPen, textStrokes, type Footprint, type Graphic, type Pad } from "@crossprobe/kicad-model";
import type { EditOp, FootprintEdit } from "../edit/ops";
import type { FpModel } from "@crossprobe/kicad-model";
import type { ModelSource } from "../load";
import { ModelPreview } from "./ModelPreview";
import { useViewport } from "./viewport";
import { Icon } from "./icons";

type Point = { x: number; y: number };
type Tool = "select" | "pad" | "row" | "line" | "rect" | "circle" | "arc" | "poly" | "custom" | "renumber";
type PadType = "smd" | "thru_hole" | "np_thru_hole";
type PadShape = "rect" | "roundrect" | "circle" | "oval";

const LAYER_COLOR: Record<string, string> = { "F.SilkS": "#f2eda1", "F.Fab": "#afafaf", "F.CrtYd": "#ff26e2", "B.SilkS": "#e8b2a7", "F.Cu": "#c83434", "F.Mask": "#d864ff" };
const GRIDS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 1.27, 2.54];

const snap = (v: number, g: number) => Math.round(v / g) * g;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

function padHit(p: Pad, q: Point, tol: number): boolean {
  const r = (-p.rotation * Math.PI) / 180;
  const dx = q.x - p.at.x;
  const dy = q.y - p.at.y;
  const x = dx * Math.cos(r) + dy * Math.sin(r);
  const y = -dx * Math.sin(r) + dy * Math.cos(r);
  if (p.shape === "circle") return Math.hypot(dx, dy) <= p.size.x / 2 + tol;
  return Math.abs(x) <= p.size.x / 2 + tol && Math.abs(y) <= p.size.y / 2 + tol;
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function graphicHit(g: Graphic, q: Point, tol: number): boolean {
  const w = g.width / 2 + tol;
  const pts = g.points;
  if (g.kind === "circle") return Math.abs(Math.hypot(q.x - pts[0]!.x, q.y - pts[0]!.y) - Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y)) <= w;
  const ring = g.kind === "rect" ? [pts[0]!, { x: pts[1]!.x, y: pts[0]!.y }, pts[1]!, { x: pts[0]!.x, y: pts[1]!.y }, pts[0]!] : g.kind === "poly" ? [...pts, pts[0]!] : pts;
  for (let i = 1; i < ring.length; i++) if (segDist(q, ring[i - 1]!, ring[i]!) <= w) return true;
  return false;
}

function PadShapeSvg({ p, sel }: { p: Pad; sel: boolean }) {
  const color = p.type === "np_thru_hole" ? "#3a3a3a" : p.layers.some((l) => l === "*.Cu" || l === "B.Cu") && p.type !== "smd" ? "#c2a33a" : "#c83434";
  const w = p.size.x;
  const h = p.size.y;
  const rx = p.shape === "oval" ? Math.min(w, h) / 2 : p.shape === "roundrect" ? Math.min(w, h) * (p.roundrectRatio ?? 0.25) : 0;
  const body =
    p.shape === "custom" ? (
      <path d={padPolygons(p, 0).map((poly) => `M${poly.map((q) => `${q.x} ${q.y}`).join("L")}Z`).join("")} fill={color} fillRule="evenodd" />
    ) : p.shape === "circle" ? (
      <circle cx={p.at.x} cy={p.at.y} r={w / 2} fill={color} />
    ) : (
      <rect x={p.at.x - w / 2} y={p.at.y - h / 2} width={w} height={h} rx={rx} fill={color} transform={p.rotation ? `rotate(${-p.rotation} ${p.at.x} ${p.at.y})` : undefined} />
    );
  const drill = p.drillSize ? Math.min(p.drillSize.x, p.drillSize.y) : p.drill;
  const label = Math.min(w, h) * 0.5;
  return (
    <g className={sel ? "fpe-sel" : undefined}>
      {body}
      {drill ? <circle cx={p.at.x} cy={p.at.y} r={drill / 2} fill="#0b0f19" /> : null}
      {p.number && (
        <text x={p.at.x} y={p.at.y} fontSize={Math.max(0.2, Math.min(label, 1))} textAnchor="middle" dominantBaseline="central" fill="#fff">
          {p.number}
        </text>
      )}
    </g>
  );
}

function GraphicSvg({ g, sel }: { g: Graphic; sel: boolean }) {
  const c = LAYER_COLOR[g.layer] ?? "#8aa";
  const common = { stroke: c, strokeWidth: Math.max(g.width, 0.02), fill: g.fill ? c : "none", className: sel ? "fpe-sel" : undefined };
  const [a, b] = g.points;
  if (g.kind === "line") return <line x1={a!.x} y1={a!.y} x2={b!.x} y2={b!.y} {...common} strokeLinecap="round" />;
  if (g.kind === "rect") return <rect x={Math.min(a!.x, b!.x)} y={Math.min(a!.y, b!.y)} width={Math.abs(b!.x - a!.x)} height={Math.abs(b!.y - a!.y)} {...common} />;
  if (g.kind === "circle") return <circle cx={a!.x} cy={a!.y} r={Math.hypot(b!.x - a!.x, b!.y - a!.y)} {...common} />;
  return <polyline points={[...g.points, ...(g.kind === "poly" ? [g.points[0]!] : [])].map((p) => `${p.x},${p.y}`).join(" ")} {...common} strokeLinejoin="round" />;
}

/** Some of KiCad's footprint checks, with the fix where there is an obvious one. */
function Checks({ fp, onFix }: { fp: Footprint; onFix: (e: FootprintEdit) => void }) {
  const out: Array<{ text: string; fix?: [string, FootprintEdit] }> = [];
  const tht = fp.pads.some((p) => p.type === "thru_hole");
  const smd = fp.pads.some((p) => p.type === "smd");
  if (fp.attributes.mount === "smd" && tht) out.push({ text: "Type is SMD but it has through-hole pads", fix: ["Make it through-hole", { kind: "setProps", props: { attr: "through_hole" } }] });
  if (fp.attributes.mount === "through_hole" && smd && !tht) out.push({ text: "Type is through-hole but all pads are SMD", fix: ["Make it SMD", { kind: "setProps", props: { attr: "smd" } }] });
  if (fp.pads.length && !fp.graphics.some((g) => g.layer === "F.CrtYd")) out.push({ text: "No courtyard (DRC needs one to check overlaps)", fix: ["Add one", { kind: "courtyard" }] });
  const seen = new Map<string, number>();
  for (const p of fp.pads) if (p.number) seen.set(p.number, (seen.get(p.number) ?? 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  if (dup.length) out.push({ text: `Pad number${dup.length > 1 ? "s" : ""} ${dup.join(", ")} used twice (one connection, as KiCad treats it)` });
  if (!fp.pads.some((p) => p.number === "1") && fp.pads.some((p) => p.number)) out.push({ text: "No pad 1" });
  if (!out.length) return <p className="muted small">Checks: all clear.</p>;
  return (
    <ul className="fpe-checks">
      {out.map((c) => (
        <li key={c.text} className="small">
          ⚠ {c.text}
          {c.fix && (
            <>
              {" "}
              <button className="link" onClick={() => onFix(c.fix![1])}>
                {c.fix[0]}
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function Num({ label, value, onCommit, unit = "mm" }: { label: string; value: number | undefined; onCommit: (v: number) => void; unit?: string }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  return (
    <label className="prop">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={value === undefined ? "mixed" : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = Number(text.trim().replace(",", "."));
          if (text.trim() !== "" && Number.isFinite(v) && v !== value) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
      {unit && <span className="muted small">{unit}</span>}
    </label>
  );
}

/** A number that may be unset (empty = the footprint's or board's own value). */
function OptNum({ label, value, onCommit, unit = "mm", scale = 1 }: { label: string; value: number | undefined; onCommit: (v: number | null) => void; unit?: string; scale?: number }) {
  const shown = value === undefined ? "" : String(Math.round(value * scale * 1e4) / 1e4);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  return (
    <label className="prop" title="Empty: the footprint's or the board's own value">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        placeholder="default"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const t = text.trim();
          if (t === "") return value !== undefined && onCommit(null);
          const v = Number(t.replace(",", ".")) / scale;
          if (Number.isFinite(v) && v !== value) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
      <span className="muted small">{unit}</span>
    </label>
  );
}

/** Split an exposed pad's paste into a grid of openings, as KiCad's generator does. */
function PasteWindows({ onApply }: { onApply: (o: { columns: number; rows: number; coverage: number }) => void }) {
  const [o, setO] = useState({ columns: 2, rows: 2, coverage: 66 });
  return (
    <div className="fpe-paste">
      <h4>Paste windows</h4>
      <Num label="Columns" unit="" value={o.columns} onCommit={(v) => setO({ ...o, columns: Math.max(1, Math.round(v)) })} />
      <Num label="Rows" unit="" value={o.rows} onCommit={(v) => setO({ ...o, rows: Math.max(1, Math.round(v)) })} />
      <Num label="Coverage" unit="%" value={o.coverage} onCommit={(v) => setO({ ...o, coverage: Math.min(100, Math.max(5, v)) })} />
      <button onClick={() => onApply({ columns: o.columns, rows: o.rows, coverage: o.coverage / 100 })} title="The pad keeps copper and mask; its paste becomes a grid of openings covering this much of it (less solder under a big pad, so the part doesn't float)">
        Split the paste
      </button>
    </div>
  );
}

/** The footprint's 3D model: path, offset and rotation (KiCad's model fields). */
function Model3DFields({ model, onCommit, fp, models }: { model?: { path: string; offset: [number, number, number]; scale: [number, number, number]; rotate: [number, number, number] }; onCommit: (m: FpModel | null) => void; fp?: Footprint; models?: ModelSource }) {
  const m = model ?? { path: "", offset: [0, 0, 0], scale: [1, 1, 1], rotate: [0, 0, 0] };
  const put = (patch: Partial<{ path: string; offset: [number, number, number]; rotate: [number, number, number] }>) => {
    const next = { ...m, ...patch };
    if (!next.path) return onCommit(null);
    onCommit({ path: next.path, offset: { x: next.offset[0], y: next.offset[1], z: next.offset[2] }, scale: { x: next.scale[0], y: next.scale[1], z: next.scale[2] }, rotate: { x: next.rotate[0], y: next.rotate[1], z: next.rotate[2] } });
  };
  return (
    <div className="fpe-model">
      <Text label="3D model" value={m.path} onCommit={(v) => put({ path: v.trim() })} />
      {m.path && (
        <>
          <Num label="Offset X" value={m.offset[0]} onCommit={(v) => put({ offset: [v, m.offset[1], m.offset[2]] })} />
          <Num label="Offset Y" value={m.offset[1]} onCommit={(v) => put({ offset: [m.offset[0], v, m.offset[2]] })} />
          <Num label="Offset Z" value={m.offset[2]} onCommit={(v) => put({ offset: [m.offset[0], m.offset[1], v] })} />
          <Num label="Rotate X" unit="°" value={m.rotate[0]} onCommit={(v) => put({ rotate: [v, m.rotate[1], m.rotate[2]] })} />
          <Num label="Rotate Y" unit="°" value={m.rotate[1]} onCommit={(v) => put({ rotate: [m.rotate[0], v, m.rotate[2]] })} />
          <Num label="Rotate Z" unit="°" value={m.rotate[2]} onCommit={(v) => put({ rotate: [m.rotate[0], m.rotate[1], v] })} />
          {fp && <ModelPreview fp={fp} models={models} />}
        </>
      )}
    </div>
  );
}

function Text({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="prop">
      <span>{label}</span>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onCommit(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
    </label>
  );
}

export function FootprintEditor({
  file,
  text,
  libId,
  placed,
  onEdit,
  onClose,
  onUpdateBoard,
  cited,
  models,
}: {
  /** Where 3D models come from (for the model preview). */
  models?: ModelSource;
  /** The datasheet dimensions a drafted footprint was built from. */
  cited?: import("../extensions").Cited[];
  file: string;
  text: string;
  libId: string;
  /** How many placed footprints on the board use this one. */
  placed: number;
  onEdit: (ops: EditOp[]) => void;
  onClose: () => void;
  onUpdateBoard?: () => void;
}) {
  const fp: Footprint | undefined = useMemo(() => {
    try {
      return parseBoard(`(kicad_pcb (version 20260206)\n${text}\n)`).footprints[0];
    } catch {
      return undefined;
    }
  }, [text]);
  const descr = /\(descr "((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? "";
  const tags = /\(tags "((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? "";
  const name = libId.split(":").pop() ?? "";
  const box = useMemo(() => {
    const pts = [...(fp?.pads ?? []).flatMap((p) => [{ x: p.at.x - p.size.x, y: p.at.y - p.size.y }, { x: p.at.x + p.size.x, y: p.at.y + p.size.y }]), ...(fp?.graphics ?? []).flatMap((g) => g.points)];
    if (!pts.length) return { x: -5, y: -5, w: 10, h: 10 };
    const x0 = Math.min(...pts.map((p) => p.x)) - 1, x1 = Math.max(...pts.map((p) => p.x)) + 1;
    const y0 = Math.min(...pts.map((p) => p.y)) - 1, y1 = Math.max(...pts.map((p) => p.y)) + 1;
    return { x: x0, y: y0, w: Math.max(4, x1 - x0), h: Math.max(4, y1 - y0) };
  }, [fp]);
  const vp = useViewport(box, file);
  const [tool, setTool] = useState<Tool>("select");
  const [grid, setGrid] = useState(0.05);
  const [layer, setLayer] = useState("F.SilkS");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [first, setFirst] = useState<Point | null>(null);
  /** Corners of a polygon being drawn, or an arc's first two points. */
  const [path, setPath] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [drag, setDrag] = useState<{ from: Point; d: Point } | null>(null);
  const [padDefaults, setPadDefaults] = useState<{ type: PadType; shape: PadShape; size: Point; drill: number }>({ type: fp?.attributes.mount === "through_hole" ? "thru_hole" : "smd", shape: fp?.attributes.mount === "through_hole" ? "circle" : "roundrect", size: { x: 1.5, y: 1.5 }, drill: 0.8 });
  /** Renumber tool: the next number a clicked pad gets, the step and a prefix. */
  const [renum, setRenum] = useState({ next: 1, step: 1, prefix: "" });
  const [row, setRow] = useState({ count: 4, rows: 1, pitch: 2.54, rowPitch: 2.54, direction: "right" as "right" | "down" });
  const edit = (e: FootprintEdit) => onEdit([{ op: "footprint", file, edit: e }]);
  const nextNumber = () => {
    const nums = (fp?.pads ?? []).map((p) => Number(p.number)).filter(Number.isFinite);
    return String((nums.length ? Math.max(...nums) : 0) + 1);
  };
  // Selection drops what no longer exists (after undo, delete).
  useEffect(() => {
    const ids = new Set([...(fp?.pads ?? []).map((p) => p.uuid), ...(fp?.graphics ?? []).map((g) => g.uuid), ...(fp?.texts ?? []).map((t) => t.uuid)].filter(Boolean) as string[]);
    setSel((s) => (([...s].every((u) => ids.has(u)) ? s : new Set([...s].filter((u) => ids.has(u))))));
  }, [fp]);

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = vp.ref.current!.getBoundingClientRect();
    return vp.toContent(e.clientX - r.left, e.clientY - r.top);
  };
  const tol = () => 4 / vp.view.scale;
  const hit = (q: Point): string | undefined => {
    for (const p of [...(fp?.pads ?? [])].reverse()) if (p.uuid && padHit(p, q, 0)) return p.uuid;
    for (const t of fp?.texts ?? []) if (t.uuid && Math.abs(q.x - t.at.x) <= (t.text.length * t.size.x * 0.45 + tol()) && Math.abs(q.y - t.at.y) <= t.size.y / 2 + tol()) return t.uuid;
    for (const g of fp?.graphics ?? []) if (g.uuid && graphicHit(g, q, tol())) return g.uuid;
    for (const p of fp?.pads ?? []) if (p.uuid && padHit(p, q, tol())) return p.uuid;
    return undefined;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || tool !== "select") return vp.handlers.onPointerDown(e);
    const q = toLocal(e);
    const h = hit(q);
    if (!h) {
      if (!e.shiftKey) setSel(new Set());
      return vp.handlers.onPointerDown(e);
    }
    const next = e.shiftKey ? new Set(sel) : sel.has(h) ? sel : new Set<string>();
    if (e.shiftKey && sel.has(h)) next.delete(h);
    else next.add(h);
    setSel(next);
    if (!e.shiftKey) {
      setDrag({ from: q, d: { x: 0, y: 0 } });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const q = toLocal(e);
    setCursor({ x: snap(q.x, grid), y: snap(q.y, grid) });
    if (drag) return setDrag({ ...drag, d: { x: snap(q.x - drag.from.x, grid), y: snap(q.y - drag.from.y, grid) } });
    vp.handlers.onPointerMove(e);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag) {
      const q = toLocal(e);
      const d = { x: r4(snap(q.x - drag.from.x, grid)), y: r4(snap(q.y - drag.from.y, grid)) };
      setDrag(null);
      if ((d.x || d.y) && sel.size) edit({ kind: "move", uuids: [...sel], d });
      return;
    }
    vp.handlers.onPointerUp();
  };
  const onClick = (e: React.MouseEvent) => {
    if (vp.wasDrag() || tool === "select") return;
    const q = toLocal(e);
    const at = { x: r4(snap(q.x, grid)), y: r4(snap(q.y, grid)) };
    if (tool === "pad") {
      const np = padDefaults.type === "np_thru_hole";
      edit({ kind: "addPad", pad: { number: np ? "" : nextNumber(), type: padDefaults.type, shape: padDefaults.shape, at, size: padDefaults.size, drill: padDefaults.type === "smd" ? undefined : np ? padDefaults.size.x : padDefaults.drill } });
    } else if (tool === "row") {
      const right = row.direction === "right";
      edit({
        kind: "addPadArray",
        base: { type: padDefaults.type, shape: padDefaults.shape, size: padDefaults.size, drill: padDefaults.type === "smd" ? undefined : padDefaults.drill },
        first: Number(nextNumber()),
        columns: right ? row.count : row.rows,
        rows: right ? row.rows : row.count,
        pitch: right ? { x: row.pitch, y: row.rowPitch } : { x: row.rowPitch, y: row.pitch },
        origin: at,
      });
    } else if (tool === "renumber") {
      const h = hit(toLocal(e));
      const pad = fp?.pads.find((p) => p.uuid === h && p.type !== "np_thru_hole");
      if (!pad) return;
      edit({ kind: "renumber", uuids: [pad.uuid!], first: renum.next, prefix: renum.prefix });
      setRenum({ ...renum, next: renum.next + renum.step });
    } else if (tool === "poly" || tool === "custom") {
      // A double click (or Enter) closes it.
      if (e.detail >= 2 && path.length >= 3) return finishPoly();
      setPath([...path, at]);
    } else if (tool === "arc") {
      if (path.length < 2) setPath([...path, at]);
      else {
        edit({ kind: "addGraphic", graphic: { kind: "arc", layer, points: [path[0]!, path[1]!, at] } });
        setPath([]);
      }
    } else if (!first) setFirst(at);
    else {
      edit({ kind: "addGraphic", graphic: { kind: tool as "line" | "rect" | "circle", layer, points: [first, at] } });
      setFirst(null);
    }
  };
  const finishPoly = () => {
    const pts = path.filter((p, i) => i === 0 || Math.hypot(p.x - path[i - 1]!.x, p.y - path[i - 1]!.y) > 1e-9);
    if (pts.length >= 3 && tool === "custom") {
      // The anchor at the polygon's centre (on the grid), as KiCad's editor puts it inside the shape.
      const c = { x: r4(snap(pts.reduce((n, q) => n + q.x, 0) / pts.length, grid)), y: r4(snap(pts.reduce((n, q) => n + q.y, 0) / pts.length, grid)) };
      const np = padDefaults.type === "np_thru_hole";
      edit({ kind: "addCustomPad", pad: { number: nextNumber(), type: np || padDefaults.type === "smd" ? "smd" : "thru_hole", at: c, polygon: pts, drill: padDefaults.type === "thru_hole" ? padDefaults.drill : undefined } });
    } else if (pts.length >= 3) edit({ kind: "addGraphic", graphic: { kind: "poly", layer, points: pts, fill: /CrtYd/.test(layer) ? false : layer === "F.Cu" || layer === "F.Mask" } });
    setPath([]);
  };
  /** The middle of the selection's extent (pads, graphic points, texts): where R turns it about. */
  const selectionCenter = (onGrid = true): Point => {
    const pts = [
      ...(fp?.pads ?? []).filter((p) => p.uuid && sel.has(p.uuid)).map((p) => p.at),
      ...(fp?.graphics ?? []).filter((g) => g.uuid && sel.has(g.uuid)).flatMap((g) => g.points),
      ...(fp?.texts ?? []).filter((t) => t.uuid && sel.has(t.uuid)).map((t) => t.at),
    ];
    if (!pts.length) return { x: 0, y: 0 };
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const c = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    return onGrid ? { x: r4(snap(c.x, grid)), y: r4(snap(c.y, grid)) } : { x: r4(c.x), y: r4(c.y) };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, select, textarea")) return;
      if (e.key === "Enter" && (tool === "poly" || tool === "custom")) {
        finishPoly();
        return;
      }
      if ((e.key === "r" || e.key === "R") && sel.size && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        edit({ kind: "rotate", uuids: [...sel], center: selectionCenter(), deg: e.shiftKey ? -90 : 90 });
        return;
      }
      if (e.key === "Escape") {
        if (path.length) setPath([]);
        else if (first) setFirst(null);
        else if (tool !== "select") setTool("select");
        else setSel(new Set());
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel.size) {
        e.preventDefault();
        edit({ kind: "delete", uuids: [...sel] });
        setSel(new Set());
      } else if (e.key.startsWith("Arrow") && sel.size) {
        e.preventDefault();
        const d = { ArrowLeft: { x: -grid, y: 0 }, ArrowRight: { x: grid, y: 0 }, ArrowUp: { x: 0, y: -grid }, ArrowDown: { x: 0, y: grid } }[e.key]!;
        edit({ kind: "move", uuids: [...sel], d });
      } else if (!e.ctrlKey && !e.metaKey) {
        const t = ({ s: "select", p: "pad", a: "row", l: "line", b: "rect", c: "circle", g: "poly", e: "arc", n: "renumber" } as Record<string, Tool>)[e.key.toLowerCase()];
        if (t) {
          setTool(t);
          setFirst(null);
          setPath([]);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pads = (fp?.pads ?? []).filter((p) => p.uuid && sel.has(p.uuid));
  const common = <T,>(xs: T[]): T | undefined => (xs.length && xs.every((x) => JSON.stringify(x) === JSON.stringify(xs[0])) ? xs[0] : undefined);
  const setPads = (props: Extract<FootprintEdit, { kind: "setPad" }>["props"]) => onEdit(pads.map((p) => ({ op: "footprint" as const, file, edit: { kind: "setPad" as const, uuid: p.uuid!, props } })));
  const { scale, tx, ty } = vp.view;
  const d = drag?.d;
  const hint =
    tool === "select"
      ? "Click to select · Shift-click to add · drag to move · arrows nudge · R rotate · Del delete · S select, P pad, A pad row, L line, B rectangle, C circle, E arc, G polygon"
      : tool === "pad"
        ? `Click to place pad ${padDefaults.type === "np_thru_hole" ? "(unnumbered hole)" : nextNumber()} · Esc done`
        : tool === "row"
          ? `Click where pad ${nextNumber()} goes: ${row.count} × ${row.rows} pads, ${row.pitch} mm apart, ${row.direction} · Esc done`
          : tool === "renumber"
            ? `Click pads in order: the next one becomes ${renum.prefix}${renum.next} · Esc done`
            : tool === "custom"
              ? `${path.length ? `${path.length} corner${path.length > 1 ? "s" : ""} · click the next, double-click or Enter to make the pad` : "Click the first corner"} of a custom-shaped pad ${nextNumber()} · Esc cancel`
              : tool === "poly"
            ? `${path.length ? `${path.length} corner${path.length > 1 ? "s" : ""} · click the next, double-click or Enter to close` : "Click the first corner"} of a polygon on ${layer} · Esc cancel`
            : tool === "arc"
              ? `Arc on ${layer}: click its ${["start", "middle (a point on it)", "end"][path.length]} · Esc cancel`
              : first
                ? `Click the ${tool === "circle" ? "radius" : "other end"} on ${layer} · Esc cancel`
                : `Click to start a ${tool === "rect" ? "rectangle" : tool} on ${layer}`;

  return (
    <div className="fp-editor" onPointerDown={(e) => e.stopPropagation()}>
      <div className="update-head">
        <strong>
          Footprint editor <span className="mono small">{libId}</span>
        </strong>
        <span className="muted small">{file}</span>
        <button className="icon-btn" onClick={onClose} title="Close (edits stay; save the project to write them)">
          <Icon name="close" />
        </button>
      </div>
      <div className="fpe-body">
        <div className="fpe-canvas-wrap">
          <div className="fpe-tools">
            {(
              [
                ["select", "Select (S)"],
                ["pad", "Pad (P)"],
                ["row", "Pad row (A)"],
                ["line", "Line (L)"],
                ["rect", "Rectangle (B)"],
                ["circle", "Circle (C)"],
                ["arc", "Arc (E)"],
                ["poly", "Polygon (G)"],
                ["custom", "Custom pad"],
                ["renumber", "Renumber (N)"],
              ] as Array<[Tool, string]>
            ).map(([t, label]) => (
              <button key={t} className={tool === t ? "on" : ""} onClick={() => (setTool(t), setFirst(null), setPath([]))} title={label}>
                {label.replace(/ \(.\)$/, "")}
              </button>
            ))}
            <select value={layer} onChange={(e) => setLayer(e.target.value)} title="Layer for lines, rectangles and circles">
              {["F.SilkS", "F.Fab", "F.CrtYd", "F.Cu", "F.Mask", "B.SilkS"].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
            <select value={grid} onChange={(e) => setGrid(Number(e.target.value))} title="Grid">
              {GRIDS.map((g) => (
                <option key={g} value={g}>
                  grid {g}
                </option>
              ))}
            </select>
          </div>
          <div className="viewport fpe-canvas" ref={vp.ref} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onClick={onClick} onPointerLeave={() => setCursor(null)}>
            <svg width="100%" height="100%">
              <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
                <line x1={-1} y1={0} x2={1} y2={0} stroke="#556" strokeWidth={1 / scale} />
                <line x1={0} y1={-1} x2={0} y2={1} stroke="#556" strokeWidth={1 / scale} />
                {(fp?.graphics ?? []).map((g, i) => (
                  <g key={g.uuid ?? i} transform={d && g.uuid && sel.has(g.uuid) ? `translate(${d.x} ${d.y})` : undefined}>
                    <GraphicSvg g={g} sel={!!g.uuid && sel.has(g.uuid)} />
                  </g>
                ))}
                {(fp?.pads ?? []).map((p, i) => (
                  <g key={p.uuid ?? i} transform={d && p.uuid && sel.has(p.uuid) ? `translate(${d.x} ${d.y})` : undefined}>
                    <PadShapeSvg p={p} sel={!!p.uuid && sel.has(p.uuid)} />
                  </g>
                ))}
                {(fp?.texts ?? []).map((t, i) => (
                  // KiCad's stroke font, as the text will be plotted.
                  <path
                    key={t.uuid ?? i}
                    d={textStrokes(t).map((st) => `M${st.map((q) => `${q.x},${q.y}`).join("L")}`).join("")}
                    transform={d && t.uuid && sel.has(t.uuid) ? `translate(${d.x} ${d.y})` : undefined}
                    stroke={LAYER_COLOR[t.layer] ?? "#aaa"}
                    strokeWidth={textPen(t)}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                    className={t.uuid && sel.has(t.uuid) ? "fpe-sel" : undefined}
                  />
                ))}
                {first && cursor && (
                  <GraphicSvg g={{ kind: tool === "circle" ? "circle" : tool === "rect" ? "rect" : "line", layer, points: [first, cursor], width: 0.1, fill: false }} sel={false} />
                )}
                {path.length > 0 && cursor && (
                  <polyline points={[...path, cursor].map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke={LAYER_COLOR[layer] ?? "#8aa"} strokeWidth={0.08} strokeDasharray={tool === "arc" ? "0.2 0.15" : undefined} />
                )}
                {cursor && tool !== "select" && <circle cx={cursor.x} cy={cursor.y} r={3 / scale} fill="none" stroke="#7fb2ff" strokeWidth={1 / scale} />}
              </g>
            </svg>
            <div className="edit-hint">{hint}</div>
            <div className="view-tools">
              <button onClick={() => vp.fit(box)} title="Fit">
                <Icon name="fit" /> Fit
              </button>
            </div>
          </div>
        </div>
        <div className="fpe-side">
          {sel.size > 0 && (
            <section className="fpe-mirror">
              <button onClick={() => edit({ kind: "mirror", uuids: [...sel], at: selectionCenter(false).x, axis: "x" })} title="Mirror the selection left to right, about its middle (pad angles and custom shapes mirror; text stays readable)">
                Mirror ↔
              </button>
              <button onClick={() => edit({ kind: "mirror", uuids: [...sel], at: selectionCenter(false).y, axis: "y" })} title="Mirror the selection top to bottom, about its middle">
                Mirror ↕
              </button>
            </section>
          )}
          {tool === "renumber" && (
            <section>
              <h4>Renumber</h4>
              <Num label="Next number" unit="" value={renum.next} onCommit={(v) => setRenum({ ...renum, next: Math.round(v) })} />
              <Num label="Step" unit="" value={renum.step} onCommit={(v) => setRenum({ ...renum, step: Math.round(v) || 1 })} />
              <Text label="Prefix" value={renum.prefix} onCommit={(v) => setRenum({ ...renum, prefix: v })} />
            </section>
          )}
          {pads.length > 0 ? (
            <section>
              <h4>{pads.length === 1 ? `Pad ${pads[0]!.number || "(hole)"}` : `${pads.length} pads`}</h4>
              {pads.length === 1 && <Text label="Number" value={pads[0]!.number} onCommit={(v) => setPads({ number: v })} />}
              <label className="prop">
                <span>Type</span>
                <select value={common(pads.map((p) => p.type)) ?? ""} onChange={(e) => setPads({ type: e.target.value as PadType })}>
                  <option value="smd">SMD</option>
                  <option value="thru_hole">Through-hole</option>
                  <option value="np_thru_hole">Hole (NPTH)</option>
                </select>
              </label>
              <label className="prop">
                <span>Shape</span>
                <select value={common(pads.map((p) => p.shape)) ?? ""} onChange={(e) => setPads({ shape: e.target.value as PadShape })}>
                  {["rect", "roundrect", "circle", "oval"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <Num label="Width" value={common(pads.map((p) => p.size.x))} onCommit={(v) => onEdit(pads.map((p) => ({ op: "footprint", file, edit: { kind: "setPad", uuid: p.uuid!, props: { size: { x: v, y: p.size.y } } } })))} />
              <Num label="Height" value={common(pads.map((p) => p.size.y))} onCommit={(v) => onEdit(pads.map((p) => ({ op: "footprint", file, edit: { kind: "setPad", uuid: p.uuid!, props: { size: { x: p.size.x, y: v } } } })))} />
              {pads.every((p) => p.type !== "smd") && <Num label="Drill" value={common(pads.map((p) => p.drill))} onCommit={(v) => setPads({ drill: v })} />}
              <Num label="Rotation" unit="°" value={common(pads.map((p) => p.rotation))} onCommit={(v) => setPads({ rotation: v })} />
              {pads.every((p) => p.type !== "np_thru_hole") && (
                <>
                  <OptNum label="Mask margin" value={common(pads.map((p) => p.maskMargin))} onCommit={(v) => setPads({ maskMargin: v })} />
                  <OptNum label="Paste margin" value={common(pads.map((p) => p.pasteMargin))} onCommit={(v) => setPads({ pasteMargin: v })} />
                  <OptNum label="Paste ratio" unit="%" scale={100} value={common(pads.map((p) => p.pasteRatio))} onCommit={(v) => setPads({ pasteRatio: v })} />
                  <label className="prop" title="An exposed / thermal pad: KiCad's heatsink property, joined solidly to zones">
                    <input type="checkbox" checked={pads.every((p) => p.property === "heatsink")} onChange={(e) => setPads({ heatsink: e.target.checked })} /> Heatsink pad
                  </label>
                </>
              )}
              {pads.length === 1 && pads[0]!.type === "smd" && pads[0]!.layers.some((l) => /Paste/.test(l)) && <PasteWindows onApply={(o) => edit({ kind: "pasteWindows", uuid: pads[0]!.uuid!, ...o })} />}
              {pads.length === 1 && (
                <p className="muted small">
                  At {pads[0]!.at.x}, {pads[0]!.at.y} · {pads[0]!.layers.join(" ")}
                </p>
              )}
            </section>
          ) : (
            <section>
              <h4>Footprint</h4>
              <Text label="Name" value={name} onCommit={() => window.alert("Rename: make a new footprint with the name you want (the file name is the footprint's name).")} />
              <Text label="Description" value={descr} onCommit={(v) => edit({ kind: "setProps", props: { description: v } })} />
              <Text label="Keywords" value={tags} onCommit={(v) => edit({ kind: "setProps", props: { tags: v } })} />
              <label className="prop">
                <span>Type</span>
                <select value={fp?.attributes.mount ?? "unspecified"} onChange={(e) => edit({ kind: "setProps", props: { attr: e.target.value as "smd" | "through_hole" | "unspecified" } })}>
                  <option value="smd">SMD</option>
                  <option value="through_hole">Through-hole</option>
                  <option value="unspecified">Other</option>
                </select>
              </label>
              <label className="prop">
                <input type="checkbox" checked={!!fp?.attributes.excludeFromBom} onChange={(e) => edit({ kind: "setProps", props: { excludeFromBom: e.target.checked } })} /> Not in the BOM
              </label>
              <button onClick={() => edit({ kind: "courtyard" })} title="A courtyard rectangle around the pads and the fab body, 0.25 mm out (IPC-7351 nominal), replacing any there is">
                Courtyard from pads and body
              </button>
              <p className="muted small">
                {fp?.pads.length ?? 0} pads · {fp?.graphics.length ?? 0} graphics
              </p>
              <Model3DFields model={fp?.models[0]} fp={fp} models={models} onCommit={(m) => edit({ kind: "model", model: m })} />
              {fp && <Checks fp={fp} onFix={edit} />}
            </section>
          )}
          {(tool === "pad" || tool === "row" || pads.length === 0) && (
            <section>
              <h4>New pads</h4>
              <label className="prop">
                <span>Type</span>
                <select value={padDefaults.type} onChange={(e) => setPadDefaults({ ...padDefaults, type: e.target.value as PadType })}>
                  <option value="smd">SMD</option>
                  <option value="thru_hole">Through-hole</option>
                  <option value="np_thru_hole">Hole (NPTH)</option>
                </select>
              </label>
              <label className="prop">
                <span>Shape</span>
                <select value={padDefaults.shape} onChange={(e) => setPadDefaults({ ...padDefaults, shape: e.target.value as PadShape })}>
                  {["rect", "roundrect", "circle", "oval"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <Num label="Width" value={padDefaults.size.x} onCommit={(v) => setPadDefaults({ ...padDefaults, size: { ...padDefaults.size, x: v } })} />
              <Num label="Height" value={padDefaults.size.y} onCommit={(v) => setPadDefaults({ ...padDefaults, size: { ...padDefaults.size, y: v } })} />
              {padDefaults.type === "thru_hole" && <Num label="Drill" value={padDefaults.drill} onCommit={(v) => setPadDefaults({ ...padDefaults, drill: v })} />}
              <h4>Pad row</h4>
              <Num label="Pads" unit="" value={row.count} onCommit={(v) => setRow({ ...row, count: Math.max(1, Math.round(v)) })} />
              <Num label="Pitch" value={row.pitch} onCommit={(v) => setRow({ ...row, pitch: v })} />
              <Num label="Rows" unit="" value={row.rows} onCommit={(v) => setRow({ ...row, rows: Math.max(1, Math.round(v)) })} />
              <Num label="Row pitch" value={row.rowPitch} onCommit={(v) => setRow({ ...row, rowPitch: v })} />
              <label className="prop">
                <span>Direction</span>
                <select value={row.direction} onChange={(e) => setRow({ ...row, direction: e.target.value as "right" | "down" })}>
                  <option value="right">right</option>
                  <option value="down">down</option>
                </select>
              </label>
            </section>
          )}
          {cited && cited.length > 0 && (
            <section>
              <h4>From the datasheet</h4>
              <ul className="fpe-cited">
                {cited.map((c) => (
                  <li key={c.field} className="small">
                    <span className="mono">{c.field.replace(/_/g, " ")} {c.value}</span> <span className="muted">p. {c.passage.page}: “{c.quote}”</span>
                  </li>
                ))}
              </ul>
              <p className="muted small">Drafted by the AI from these words. Check the pads against the datasheet's drawing before using it.</p>
            </section>
          )}
          {placed > 0 && onUpdateBoard && (
            <section>
              <button className="primary" onClick={onUpdateBoard} title="Replace the placed footprints with this version, keeping their position, side, fields and nets (KiCad's Update Footprint from Library)">
                Update {placed} on the board
              </button>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

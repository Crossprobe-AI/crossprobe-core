/**
 * The symbol editor (KiCad's, for the project's own symbol library): pins with their number, name,
 * electrical type, shape, side and length; the body (rectangles, polylines, circles, arcs, text);
 * units (with names and lock) and a De Morgan body style; power symbols; the symbol's fields; a pin
 * table; a box symbol laid out from a pasted pin list; KiCad's symbol checks; and "update on the
 * schematic" for the symbols placed from it. Edits are undoable edits of the .kicad_sym.
 */
import { useEffect, useMemo, useState } from "react";
import { parse } from "@crossprobe/kicad-sexpr";
import { describeSymbol, findLibSymbol, PIN_SHAPES, PIN_TYPES, symbolLibRoot, symbolProblems, type PinAlternate, type PinShape, type SymbolView } from "@crossprobe/kicad-model";
import type { EditOp, SymbolEdit } from "../edit/ops";
import { useViewport } from "./viewport";
import { Icon } from "./icons";

type Point = { x: number; y: number };
type Tool = "select" | "pin" | "rectangle" | "polyline" | "circle" | "arc" | "text";
/** KiCad's unit letters: A, B, … Z, AA, AB … */
export const unitLetter = (u: number): string => (u > 26 ? unitLetter(Math.floor((u - 1) / 26)) : "") + String.fromCharCode(65 + ((u - 1) % 26));
type PinTypeName = (typeof PIN_TYPES)[number];
const GRID = 1.27;
const snap = (v: number) => Math.round(Math.round(v / GRID) * GRID * 1e4) / 1e4;
const dirOf = (angle: number): Point => ({ 0: { x: 1, y: 0 }, 90: { x: 0, y: 1 }, 180: { x: -1, y: 0 }, 270: { x: 0, y: -1 } })[((angle % 360) + 360) % 360 as 0 | 90 | 180 | 270] ?? { x: 1, y: 0 };
const SIDES: Array<[string, 0 | 90 | 180 | 270]> = [["left", 0], ["right", 180], ["top", 270], ["bottom", 90]];

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function Field({ label, value, onCommit, wide }: { label: string; value: string; onCommit: (v: string) => void; wide?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="prop">
      <span>{label}</span>
      <input
        type="text"
        className={wide ? "mono" : undefined}
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

/** "number name type [side]" per line, as from a datasheet's pin table. */
export function parsePinList(text: string): Array<{ number: string; name: string; type: PinTypeName; side?: "left" | "right" | "top" | "bottom" }> {
  const out: Array<{ number: string; name: string; type: PinTypeName; side?: "left" | "right" | "top" | "bottom" }> = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/[\t,;]+|\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const [number, name, type, side] = parts as [string, string, string?, string?];
    const t = (PIN_TYPES as string[]).includes(type ?? "") ? (type as PinTypeName) : /^(vcc|vdd|v\+|vin|avdd|dvdd|vbat|gnd|vss|agnd|dgnd)/i.test(name) ? "power_in" : "passive";
    out.push({ number, name, type: t, side: ["left", "right", "top", "bottom"].includes(side ?? "") ? (side as "left") : undefined });
  }
  return out;
}

/** An SVG path (y down) for the arc from a through m to b. */
function arcPath(a: Point, m: Point, b: Point): string {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-9) return `M${a.x} ${a.y}L${b.x} ${b.y}`;
  const sq = (p: Point) => p.x * p.x + p.y * p.y;
  const c = { x: (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d, y: (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d };
  const r = Math.hypot(a.x - c.x, a.y - c.y);
  const ang = (p: Point) => Math.atan2(p.y - c.y, p.x - c.x);
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // Going the positive-angle way from a, is m passed before b? Then that's the arc's direction.
  const positive = norm(ang(m) - ang(a)) < norm(ang(b) - ang(a));
  const span = positive ? norm(ang(b) - ang(a)) : norm(ang(a) - ang(b));
  return `M${a.x} ${a.y}A${r} ${r} 0 ${span > Math.PI ? 1 : 0} ${positive ? 1 : 0} ${b.x} ${b.y}`;
}

type PinView = SymbolView["pins"][number];
/** KiCad's pin table: every pin (one row each; both body styles change together), edited in place. */
function PinTable({ pins, units, onEdit }: { pins: PinView[]; units: SymbolView["units"]; onEdit: (edits: SymbolEdit[]) => void }) {
  const [sort, setSort] = useState<"number" | "name" | "unit">("number");
  const rows = [...pins].sort((a, b) => (sort === "unit" ? a.unit - b.unit : 0) || (sort === "name" ? a.name.localeCompare(b.name) : 0) || a.number.localeCompare(b.number, undefined, { numeric: true }));
  const set = (p: PinView, props: Extract<SymbolEdit, { kind: "setPin" }>["props"]) => onEdit([{ kind: "setPin", number: p.number, props, unit: units.count > 1 && p.unit ? p.unit : undefined }]);
  const commitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
    e.stopPropagation();
  };
  return (
    <div className="sym-pin-table">
      <table className="small">
        <thead>
          <tr>
            <th onClick={() => setSort("number")}>Number</th>
            <th onClick={() => setSort("name")}>Name</th>
            <th>Type</th>
            <th>Shape</th>
            {units.count > 1 && <th onClick={() => setSort("unit")}>Unit</th>}
            <th>Length</th>
            <th>Hidden</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const nm = p.name === "~" ? "" : p.name;
            return (
              <tr key={`${p.unit}:${p.number}`}>
                <td>
                  <input className="mono small" aria-label={`Pin ${p.number} number`} defaultValue={p.number} key={`n${p.number}`} onBlur={(e) => e.target.value && e.target.value !== p.number && set(p, { number: e.target.value })} onKeyDown={commitOnEnter} />
                </td>
                <td>
                  <input className="mono small" aria-label={`Pin ${p.number} name`} defaultValue={nm} key={`m${p.number}:${nm}`} onBlur={(e) => e.target.value !== nm && set(p, { name: e.target.value })} onKeyDown={commitOnEnter} />
                </td>
                <td>
                  <select aria-label={`Pin ${p.number} type`} value={p.type} onChange={(e) => set(p, { type: e.target.value as PinTypeName })}>
                    {PIN_TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select aria-label={`Pin ${p.number} shape`} value={p.shape} onChange={(e) => set(p, { shape: e.target.value as PinShape })}>
                    {PIN_SHAPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </td>
                {units.count > 1 && (
                  <td>
                    <select aria-label={`Pin ${p.number} unit`} value={p.unit} onChange={(e) => onEdit([{ kind: "pinUnit", numbers: [p.number], unit: Number(e.target.value) }])}>
                      <option value={0}>all</option>
                      {Array.from({ length: units.count }, (_, i) => i + 1).map((u) => (
                        <option key={u} value={u}>
                          {unitLetter(u)}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
                <td>
                  <input
                    className="mono small num-cell"
                    aria-label={`Pin ${p.number} length`}
                    defaultValue={p.length}
                    key={`l${p.number}:${p.length}`}
                    onBlur={(e) => {
                      const v = Number(e.target.value.replace(",", "."));
                      if (v >= 0 && v !== p.length) set(p, { length: v });
                    }}
                    onKeyDown={commitOnEnter}
                  />
                </td>
                <td>
                  <input type="checkbox" aria-label={`Pin ${p.number} hidden`} checked={p.hidden} onChange={(e) => set(p, { hidden: e.target.checked })} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function SymbolEditor({
  file,
  libText,
  name,
  libId,
  placed,
  onEdit,
  onClose,
  onUpdateSchematic,
}: {
  file: string;
  libText: string;
  name: string;
  libId: string;
  placed: number;
  onEdit: (ops: EditOp[]) => void;
  onClose: () => void;
  onUpdateSchematic?: () => void;
}) {
  const { view, problems } = useMemo((): { view?: SymbolView; problems: string[] } => {
    try {
      const s = findLibSymbol(symbolLibRoot(parse(libText)), name);
      return s ? { view: describeSymbol(s), problems: symbolProblems(s) } : { problems: [] };
    } catch {
      return { problems: [] };
    }
  }, [libText, name]);
  const units = view?.units ?? { count: 1, demorgan: false, styles: 1, styleNames: [] as string[], names: {} as Record<number, string>, locked: false, duplicateJumpers: false, jumperGroups: [] as string[][] };
  const styleName = (st: number) => units.styleNames[st - 1] ?? (units.demorgan ? (st === 1 ? "Normal" : "De Morgan") : `Style ${st}`);
  const multi = units.count > 1;
  const [unitSel, setUnit] = useState(1);
  const [styleSel, setStyle] = useState(1);
  const unit = Math.min(unitSel, units.count);
  const style = Math.min(styleSel, units.styles);
  const inScope = (x: { unit: number; style: number }) => (x.unit === 0 || x.unit === unit) && (x.style === 0 || x.style === style);
  const vPins = useMemo(() => (view?.pins ?? []).filter(inScope), [view, unit, style]);
  const vGraphics = useMemo(() => (view?.graphics ?? []).filter(inScope), [view, unit, style]);
  const scope = multi ? unit : undefined;
  const [table, setTable] = useState(false);
  const box = useMemo(() => {
    const pts = [...(view?.pins ?? []).flatMap((p) => [p.at, { x: p.at.x + dirOf(p.angle).x * p.length, y: p.at.y + dirOf(p.angle).y * p.length }]), ...(view?.graphics ?? []).flatMap((g) => g.points)].map((p) => ({ x: p.x, y: -p.y }));
    if (!pts.length) return { x: -10, y: -10, w: 20, h: 20 };
    const x0 = Math.min(...pts.map((p) => p.x)) - 4, x1 = Math.max(...pts.map((p) => p.x)) + 4;
    const y0 = Math.min(...pts.map((p) => p.y)) - 4, y1 = Math.max(...pts.map((p) => p.y)) + 4;
    return { x: x0, y: y0, w: Math.max(10, x1 - x0), h: Math.max(10, y1 - y0) };
  }, [view]);
  const vp = useViewport(box, `${file}:${name}`);
  const [tool, setTool] = useState<Tool>("select");
  const [selPins, setSelPins] = useState<Set<string>>(new Set());
  const [selGraphics, setSelGraphics] = useState<Set<number>>(new Set());
  const [path, setPath] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [drag, setDrag] = useState<{ from: Point; d: Point } | null>(null);
  const [pinType, setPinType] = useState<PinTypeName>("input");
  const [list, setList] = useState("");
  const edit = (e: SymbolEdit) => onEdit([{ op: "symbol", file, name, edit: e }]);
  const addGraphic = (graphic: Extract<SymbolEdit, { kind: "addGraphic" }>["graphic"]) => edit({ kind: "addGraphic", graphic, scope: { unit: multi ? unit : 0, style } });
  const nextNumber = () => {
    const nums = (view?.pins ?? []).map((p) => Number(p.number)).filter(Number.isFinite);
    return String((nums.length ? Math.max(...nums) : 0) + 1);
  };
  useEffect(() => {
    const nums = new Set((view?.pins ?? []).map((p) => p.number));
    setSelPins((s) => ([...s].every((n) => nums.has(n)) ? s : new Set([...s].filter((n) => nums.has(n)))));
    setSelGraphics(new Set());
  }, [view?.pins.length, view?.graphics.length]);

  /** Library coordinates (y up) of a pointer event. */
  const toLib = (e: { clientX: number; clientY: number }) => {
    const r = vp.ref.current!.getBoundingClientRect();
    const c = vp.toContent(e.clientX - r.left, e.clientY - r.top);
    return { x: c.x, y: -c.y };
  };
  const tol = () => 5 / vp.view.scale;
  const hit = (q: Point): { pin?: string; graphic?: number } | undefined => {
    for (const p of vPins) {
      const end = { x: p.at.x + dirOf(p.angle).x * p.length, y: p.at.y + dirOf(p.angle).y * p.length };
      if (segDist(q, p.at, end) <= tol()) return { pin: p.number };
    }
    for (const g of vGraphics) {
      const pts = g.kind === "rectangle" ? [g.points[0]!, { x: g.points[1]!.x, y: g.points[0]!.y }, g.points[1]!, { x: g.points[0]!.x, y: g.points[1]!.y }, g.points[0]!] : g.points;
      if (g.kind === "circle" ? Math.abs(Math.hypot(q.x - pts[0]!.x, q.y - pts[0]!.y) - (g.radius ?? 0)) <= tol() : g.kind === "text" ? Math.hypot(q.x - pts[0]!.x, q.y - pts[0]!.y) <= 2 : pts.some((p, i) => i > 0 && segDist(q, pts[i - 1]!, p) <= tol())) return { graphic: g.index };
    }
    return undefined;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || tool !== "select") return vp.handlers.onPointerDown(e);
    const q = toLib(e);
    const h = hit(q);
    if (!h) {
      if (!e.shiftKey) (setSelPins(new Set()), setSelGraphics(new Set()));
      return vp.handlers.onPointerDown(e);
    }
    const already = (h.pin && selPins.has(h.pin)) || (h.graphic !== undefined && selGraphics.has(h.graphic));
    const pins = e.shiftKey || already ? new Set(selPins) : new Set<string>();
    const gs = e.shiftKey || already ? new Set(selGraphics) : new Set<number>();
    if (h.pin) e.shiftKey && pins.has(h.pin) ? pins.delete(h.pin) : pins.add(h.pin);
    if (h.graphic !== undefined) e.shiftKey && gs.has(h.graphic) ? gs.delete(h.graphic) : gs.add(h.graphic);
    setSelPins(pins);
    setSelGraphics(gs);
    if (!e.shiftKey) {
      setDrag({ from: q, d: { x: 0, y: 0 } });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const q = toLib(e);
    setCursor({ x: snap(q.x), y: snap(q.y) });
    if (drag) return setDrag({ ...drag, d: { x: snap(q.x - drag.from.x), y: snap(q.y - drag.from.y) } });
    vp.handlers.onPointerMove(e);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag) {
      const q = toLib(e);
      const d = { x: snap(q.x - drag.from.x), y: snap(q.y - drag.from.y) };
      setDrag(null);
      if (d.x || d.y) {
        const ops: EditOp[] = [];
        if (selPins.size) ops.push({ op: "symbol", file, name, edit: { kind: "movePins", numbers: [...selPins], d, unit: scope } });
        if (selGraphics.size) ops.push({ op: "symbol", file, name, edit: { kind: "moveGraphics", indexes: [...selGraphics], d } });
        if (ops.length) onEdit(ops);
      }
      return;
    }
    vp.handlers.onPointerUp();
  };
  const finishPolyline = () => {
    if (path.length >= 2) addGraphic({ kind: "polyline", points: path });
    setPath([]);
  };
  const onClick = (e: React.MouseEvent) => {
    if (vp.wasDrag() || tool === "select") return;
    const q = toLib(e);
    const at = { x: snap(q.x), y: snap(q.y) };
    if (tool === "pin") {
      // The pin points into the body: from the left of the centre it enters rightwards, and so on.
      const c = view?.graphics.find((g) => g.kind === "rectangle");
      const mid = c ? { x: (c.points[0]!.x + c.points[1]!.x) / 2, y: (c.points[0]!.y + c.points[1]!.y) / 2 } : { x: 0, y: 0 };
      const dx = at.x - mid.x, dy = at.y - mid.y;
      const angle = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 0 : 180) : dy > 0 ? 270 : 90;
      edit({ kind: "addPin", pin: { number: nextNumber(), name: "~", type: pinType, at, angle, length: 2.54 }, unit: multi ? unit : 1 });
    } else if (tool === "text") {
      const t = window.prompt("Text");
      if (t) addGraphic({ kind: "text", points: [at], text: t });
    } else if (tool === "polyline") {
      if (e.detail >= 2) return finishPolyline();
      setPath([...path, at]);
    } else if (tool === "arc") {
      // Start, a point on the arc, end.
      if (path.length < 2) return setPath([...path, at]);
      addGraphic({ kind: "arc", points: [path[0]!, path[1]!, at] });
      setPath([]);
    } else if (!path.length) setPath([at]);
    else {
      addGraphic({ kind: tool, points: [path[0]!, at], fill: tool === "rectangle" ? "background" : "none" });
      setPath([]);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, select, textarea")) return;
      if (e.key === "Enter" && tool === "polyline") return finishPolyline();
      if (e.key === "Escape") {
        if (path.length) setPath([]);
        else if (tool !== "select") setTool("select");
        else (setSelPins(new Set()), setSelGraphics(new Set()));
      } else if ((e.key === "Delete" || e.key === "Backspace") && (selPins.size || selGraphics.size)) {
        e.preventDefault();
        const ops: EditOp[] = [];
        if (selPins.size) ops.push({ op: "symbol", file, name, edit: { kind: "deletePins", numbers: [...selPins], unit: scope } });
        if (selGraphics.size) ops.push({ op: "symbol", file, name, edit: { kind: "deleteGraphics", indexes: [...selGraphics] } });
        onEdit(ops);
      } else if ((e.key === "r" || e.key === "R") && selPins.size) {
        // Turn pins about their connection point.
        onEdit([...selPins].map((n) => ({ op: "symbol" as const, file, name, edit: { kind: "setPin" as const, number: n, unit: scope, props: { angle: ((((vPins.find((p) => p.number === n)?.angle ?? 0) + 90) % 360) as 0 | 90 | 180 | 270) } } })));
      } else if (!e.ctrlKey && !e.metaKey) {
        const t = ({ s: "select", p: "pin", b: "rectangle", l: "polyline", c: "circle", a: "arc", t: "text" } as Record<string, Tool>)[e.key.toLowerCase()];
        if (t) (setTool(t), setPath([]));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pins = vPins.filter((p) => selPins.has(p.number));
  const common = <T,>(xs: T[]): T | undefined => (xs.length && xs.every((x) => x === xs[0]) ? xs[0] : undefined);
  const setPins = (props: Extract<SymbolEdit, { kind: "setPin" }>["props"]) => onEdit(pins.map((p) => ({ op: "symbol" as const, file, name, edit: { kind: "setPin" as const, number: p.number, props, unit: scope } })));
  const { scale, tx, ty } = vp.view;
  const d = drag?.d ?? { x: 0, y: 0 };
  const f = view?.fields ?? {};
  const hint =
    tool === "select"
      ? "Click to select · Shift-click to add · drag to move · R turns a pin · Del delete · S select, P pin, B rectangle, L polyline, C circle, A arc, T text"
      : tool === "pin"
        ? `Click where pin ${nextNumber()} connects (it points into the body) · Esc done`
        : tool === "arc"
          ? `${["Click where the arc starts", "Click a point on the arc", "Click where it ends"][path.length]} · Esc cancel`
        : tool === "polyline"
          ? `${path.length ? `${path.length} points · double-click or Enter to finish` : "Click the first point"} · Esc cancel`
          : path.length
            ? "Click the other corner / the radius · Esc cancel"
            : `Click to start a ${tool}`;

  return (
    <div className="fp-editor sym-editor" onPointerDown={(e) => e.stopPropagation()}>
      <div className="update-head">
        <strong>
          Symbol editor <span className="mono small">{libId}</span>
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
                ["pin", "Pin (P)"],
                ["rectangle", "Rectangle (B)"],
                ["polyline", "Polyline (L)"],
                ["circle", "Circle (C)"],
                ["arc", "Arc (A)"],
                ["text", "Text (T)"],
              ] as Array<[Tool, string]>
            ).map(([t, label]) => (
              <button key={t} className={tool === t ? "on" : ""} onClick={() => (setTool(t), setPath([]))} title={label}>
                {label.replace(/ \(.\)$/, "")}
              </button>
            ))}
            <select value={pinType} onChange={(e) => setPinType(e.target.value as PinTypeName)} title="Electrical type of new pins">
              {PIN_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <button className={table ? "on" : ""} onClick={() => setTable((t) => !t)} title="Every pin in a table, to edit many at once">
              Pin table
            </button>
          </div>
          {(multi || units.styles > 1) && (
            <div className="fpe-tools sym-units">
              {multi &&
                Array.from({ length: units.count }, (_, i) => i + 1).map((u) => (
                  <button key={u} className={u === unit ? "on" : ""} onClick={() => (setUnit(u), setSelPins(new Set()), setSelGraphics(new Set()))} title={`Unit ${unitLetter(u)}`}>
                    {unitLetter(u)}
                    {units.names[u] ? ` ${units.names[u]}` : ""}
                  </button>
                ))}
              {units.styles > 1 && (
                <>
                  <span className="tb-sep" />
                  {Array.from({ length: units.styles }, (_, i) => i + 1).map((st) => (
                    <button key={st} className={st === style ? "on" : ""} onClick={() => (setStyle(st), setSelPins(new Set()), setSelGraphics(new Set()))}>
                      {styleName(st)}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
          {table && view && <PinTable pins={view.pins.filter((p) => p.style <= 1)} units={units} onEdit={(ops) => onEdit(ops.map((e) => ({ op: "symbol" as const, file, name, edit: e })))} />}
          <div className="viewport fpe-canvas sym-canvas" ref={vp.ref} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onClick={onClick} onPointerLeave={() => setCursor(null)}>
            <svg width="100%" height="100%">
              <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
                <line x1={-1.27} y1={0} x2={1.27} y2={0} stroke="#99a" strokeWidth={1 / scale} />
                <line x1={0} y1={-1.27} x2={0} y2={1.27} stroke="#99a" strokeWidth={1 / scale} />
                {vGraphics.map((g) => {
                  const sel = selGraphics.has(g.index);
                  const off = sel ? d : { x: 0, y: 0 };
                  const p = g.points.map((q) => ({ x: q.x + off.x, y: -(q.y + off.y) }));
                  const cls = `sym-g${sel ? " sel" : ""}${g.fill === "background" ? " bg" : g.fill === "outline" ? " solid" : ""}`;
                  if (g.kind === "rectangle") return <rect key={g.index} className={cls} x={Math.min(p[0]!.x, p[1]!.x)} y={Math.min(p[0]!.y, p[1]!.y)} width={Math.abs(p[1]!.x - p[0]!.x)} height={Math.abs(p[1]!.y - p[0]!.y)} />;
                  if (g.kind === "circle") return <circle key={g.index} className={cls} cx={p[0]!.x} cy={p[0]!.y} r={g.radius} />;
                  if (g.kind === "arc") return <path key={g.index} className={cls} d={arcPath(p[0]!, p[1]!, p[2]!)} />;
                  if (g.kind === "text")
                    return (
                      <text key={g.index} className={`sym-text${sel ? " sel" : ""}`} x={p[0]!.x} y={p[0]!.y} fontSize={1.27 * 1.36} textAnchor="middle" dominantBaseline="central">
                        {g.text}
                      </text>
                    );
                  return <polyline key={g.index} className={cls} points={p.map((q) => `${q.x},${q.y}`).join(" ")} />;
                })}
                {vPins.map((pin) => {
                  const sel = selPins.has(pin.number);
                  const off = sel ? d : { x: 0, y: 0 };
                  const u = dirOf(pin.angle);
                  const a = { x: pin.at.x + off.x, y: -(pin.at.y + off.y) };
                  const b = { x: a.x + u.x * pin.length, y: a.y - u.y * pin.length };
                  const inside = { x: b.x + u.x * 1.016, y: b.y - u.y * 1.016 };
                  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                  const horizontal = pin.angle % 180 === 0;
                  return (
                    <g key={pin.number} className={`sym-pin${sel ? " sel" : ""}${pin.hidden ? " hidden" : ""}`}>
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                      <circle cx={a.x} cy={a.y} r={0.25} className="tip" />
                      {pin.shape.includes("inverted") && <circle cx={b.x - u.x * 0.5} cy={b.y + u.y * 0.5} r={0.5} className="bubble" />}
                      {pin.name && pin.name !== "~" && (
                        // Vertical names read bottom to top (KiCad): a top pin's ends inside the box, a bottom pin's starts there.
                        <text x={inside.x} y={inside.y} fontSize={1.27 * 1.36} textAnchor={horizontal ? (u.x > 0 ? "start" : "end") : u.y < 0 ? "end" : "start"} dominantBaseline="central" transform={horizontal ? undefined : `rotate(-90 ${inside.x} ${inside.y})`}>
                          {pin.name}
                        </text>
                      )}
                      <text x={horizontal ? mid.x : mid.x - 0.35} y={horizontal ? mid.y - 0.35 : mid.y} fontSize={1.0} textAnchor="middle" dominantBaseline="auto" className="num" transform={horizontal ? undefined : `rotate(-90 ${mid.x - 0.35} ${mid.y})`}>
                        {pin.number}
                      </text>
                    </g>
                  );
                })}
                {path.length > 0 && cursor && <polyline points={[...path, cursor].map((q) => `${q.x},${-q.y}`).join(" ")} fill="none" stroke="#7fb2ff" strokeWidth={0.15} strokeDasharray="0.4 0.3" />}
                {cursor && tool !== "select" && <circle cx={cursor.x} cy={-cursor.y} r={3 / scale} fill="none" stroke="#7fb2ff" strokeWidth={1 / scale} />}
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
          {pins.length > 0 ? (
            <section>
              <h4>{pins.length === 1 ? `Pin ${pins[0]!.number}` : `${pins.length} pins`}</h4>
              {pins.length === 1 && <Field label="Number" value={pins[0]!.number} onCommit={(v) => v && setPins({ number: v })} />}
              {pins.length === 1 && <Field label="Name" value={pins[0]!.name === "~" ? "" : pins[0]!.name} onCommit={(v) => setPins({ name: v })} />}
              <label className="prop">
                <span>Type</span>
                <select value={common(pins.map((p) => p.type)) ?? ""} onChange={(e) => setPins({ type: e.target.value as PinTypeName })}>
                  {common(pins.map((p) => p.type)) === undefined && <option value="">mixed</option>}
                  {PIN_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label className="prop">
                <span>Shape</span>
                <select value={common(pins.map((p) => p.shape)) ?? ""} onChange={(e) => setPins({ shape: e.target.value as PinShape })}>
                  {common(pins.map((p) => p.shape)) === undefined && <option value="">mixed</option>}
                  {PIN_SHAPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label className="prop">
                <span>Side</span>
                <select value={SIDES.find(([, a]) => a === common(pins.map((p) => ((p.angle % 360) + 360) % 360)))?.[0] ?? ""} onChange={(e) => setPins({ angle: SIDES.find(([s]) => s === e.target.value)![1] })}>
                  {SIDES.map(([s]) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              {multi && (
                <label className="prop">
                  <span>Unit</span>
                  <select value={common(pins.map((p) => p.unit)) ?? ""} onChange={(e) => edit({ kind: "pinUnit", numbers: pins.map((p) => p.number), unit: Number(e.target.value) })}>
                    {common(pins.map((p) => p.unit)) === undefined && <option value="">mixed</option>}
                    <option value={0}>all units</option>
                    {Array.from({ length: units.count }, (_, i) => i + 1).map((u) => (
                      <option key={u} value={u}>
                        {unitLetter(u)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <Field label="Length" value={String(common(pins.map((p) => p.length)) ?? "")} onCommit={(v) => Number(v) > 0 && setPins({ length: Number(v.replace(",", ".")) })} />
              <label className="prop">
                <input type="checkbox" checked={pins.every((p) => p.hidden)} onChange={(e) => setPins({ hidden: e.target.checked })} /> Hidden
              </label>
              {pins.length === 1 && (
                <div className="pin-alternates">
                  <span className="muted small" title="Other functions a placed part can switch this pin to, in the inspector (KiCad's alternate pin functions)">
                    Alternate functions
                  </span>
                  {pins[0]!.alternates.map((a, i) => {
                    const list = pins[0]!.alternates;
                    const change = (patch: Partial<PinAlternate> | null) => setPins({ alternates: patch ? list.map((x, j) => (j === i ? { ...x, ...patch } : x)) : list.filter((_, j) => j !== i) });
                    return (
                      <div key={`${a.name}${i}`} className="pin-alternate-row">
                        <Field label="" value={a.name} onCommit={(v) => v && change({ name: v })} />
                        <select value={a.type} onChange={(e) => change({ type: e.target.value as PinTypeName })} title="Electrical type">
                          {PIN_TYPES.map((t) => (
                            <option key={t}>{t}</option>
                          ))}
                        </select>
                        <select value={a.shape} onChange={(e) => change({ shape: e.target.value as PinShape })} title="Shape">
                          {PIN_SHAPES.map((t) => (
                            <option key={t}>{t}</option>
                          ))}
                        </select>
                        <button className="icon-btn" title={`Remove ${a.name}`} onClick={() => change(null)}>
                          <Icon name="close" />
                        </button>
                      </div>
                    );
                  })}
                  <button
                    className="link"
                    onClick={() => {
                      const name = window.prompt("Alternate function name (e.g. SDA)");
                      if (name) setPins({ alternates: [...pins[0]!.alternates, { name, type: pins[0]!.type, shape: pins[0]!.shape }] });
                    }}
                  >
                    + Alternate function
                  </button>
                </div>
              )}
            </section>
          ) : (
            <section>
              <h4>Symbol</h4>
              <Field label="Reference" value={f.Reference ?? ""} onCommit={(v) => edit({ kind: "setFields", fields: { reference: v } })} />
              <Field label="Value" value={f.Value ?? ""} onCommit={(v) => edit({ kind: "setFields", fields: { value: v } })} />
              <Field label="Footprint" wide value={f.Footprint ?? ""} onCommit={(v) => edit({ kind: "setFields", fields: { footprint: v } })} />
              <Field label="Datasheet" value={f.Datasheet ?? ""} onCommit={(v) => edit({ kind: "setFields", fields: { datasheet: v } })} />
              <Field label="Description" value={f.Description ?? ""} onCommit={(v) => edit({ kind: "setFields", fields: { description: v } })} />
              <Field label="Keywords" value={f.ki_keywords ?? ""} onCommit={(v) => edit({ kind: "setFields", fields: { keywords: v } })} />
              <Field label="Footprint filters" wide value={f.ki_fp_filters ?? ""} onCommit={(v) => edit({ kind: "setFields", fields: { fpFilters: v } })} />
              <Field label="Units" value={String(units.count)} onCommit={(v) => Number(v) >= 1 && Number(v) <= 64 && (Number(v) >= units.count || window.confirm(`Remove unit${units.count - Number(v) > 1 ? "s" : ""} ${Array.from({ length: units.count - Number(v) }, (_, i) => unitLetter(Number(v) + i + 1)).join(", ")} with their pins and graphics?`)) && edit({ kind: "units", count: Math.round(Number(v)) })} />
              {multi && <Field label={`Unit ${unitLetter(unit)} name`} value={units.names[unit] ?? ""} onCommit={(v) => edit({ kind: "unitName", unit, name: v })} />}
              {multi && (
                <label className="prop">
                  <input type="checkbox" checked={units.locked} onChange={(e) => edit({ kind: "unitsLocked", locked: e.target.checked })} /> Units not interchangeable
                </label>
              )}
              <label className="prop">
                <span>Body styles</span>
                <select
                  value={units.styleNames.length ? "named" : units.demorgan ? "demorgan" : "one"}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "one" && units.styles > 1 && !window.confirm("Keep only the first body style, dropping the others' drawing?")) return;
                    if (v === "one") return edit({ kind: "bodyStyles", styles: null });
                    if (v === "demorgan") return edit({ kind: "bodyStyles", styles: { demorgan: true } });
                    const names = window.prompt("Body style names, separated by commas", units.styles > 1 ? Array.from({ length: units.styles }, (_, i) => styleName(i + 1)).join(", ") : "Normal, Alternate");
                    const list = (names ?? "").split(",").map((x) => x.trim()).filter(Boolean);
                    if (list.length >= 2) edit({ kind: "bodyStyles", styles: { names: list } });
                  }}
                >
                  <option value="one">One</option>
                  <option value="demorgan">De Morgan</option>
                  <option value="named">Named…</option>
                </select>
              </label>
              {units.styleNames.length > 0 && (
                <Field
                  label="Style names"
                  value={units.styleNames.join(", ")}
                  onCommit={(v) => {
                    const list = v.split(",").map((x) => x.trim()).filter(Boolean);
                    if (list.length >= 2 && (list.length >= units.styles || window.confirm(`Drop body style${units.styles - list.length > 1 ? "s" : ""} ${units.styleNames.slice(list.length).join(", ")} and their drawing?`))) edit({ kind: "bodyStyles", styles: { names: list } });
                  }}
                />
              )}
              <label className="prop">
                <input type="checkbox" checked={units.duplicateJumpers} onChange={(e) => edit({ kind: "jumpers", duplicate: e.target.checked })} /> Pins with the same number are joined
              </label>
              <Field
                label="Jumper groups"
                value={units.jumperGroups.map((g) => g.join(" ")).join("; ")}
                onCommit={(v) => edit({ kind: "jumpers", groups: v.split(";").map((g) => g.trim().split(/[\s,]+/).filter(Boolean)) })}
              />
              <div className="prop">
                <span>Power symbol</span>
                {(["supply", "ground"] as const).map((st) => (
                  <button key={st} onClick={() => window.confirm(`Redraw ${view?.name} as a ${st} power symbol (a global label named after it)? Its pins and body are replaced.`) && edit({ kind: "power", style: st })}>
                    {st === "supply" ? "Supply" : "Ground"}
                  </button>
                ))}
              </div>
              <p className="muted small">
                {view?.power ? "Power symbol · " : ""}
                {view?.pins.filter((p) => p.style <= 1).length ?? 0} pins · {view?.graphics.length ?? 0} graphics
              </p>
              {problems.length ? (
                <ul className="fpe-checks">
                  {problems.map((p) => (
                    <li key={p} className="small">
                      ⚠ {p}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">Checks: all clear.</p>
              )}
            </section>
          )}
          <section>
            <h4>Pins from a list</h4>
            <p className="muted small">One pin per line: number, name, type (input, output, bidirectional, power_in …) and optionally side. Lays the box out again: inputs left, outputs right, supplies top, grounds bottom.</p>
            <textarea className="mono small sym-list" rows={6} value={list} placeholder={"1 VCC power_in\n2 IN input\n3 OUT output\n4 GND power_in"} onChange={(e) => setList(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <button disabled={!parsePinList(list).length} onClick={() => edit({ kind: "layout", pins: parsePinList(list) })}>
              Lay out {parsePinList(list).length || ""} pins
            </button>
          </section>
          {placed > 0 && onUpdateSchematic && (
            <section>
              <button className="primary" onClick={onUpdateSchematic} title="Replace the schematic's copy of this symbol with this version (KiCad's Update Symbols from Library); wires on moved pins may need redrawing">
                Update {placed} on the schematic
              </button>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

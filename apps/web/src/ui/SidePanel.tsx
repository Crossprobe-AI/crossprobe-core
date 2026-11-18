/**
 * The workspace's side panels (the sheets and layers on the left, the inspector on the
 * right): each can be resized from its inner edge and collapsed with a small tab-shaped
 * button at the middle of that edge, mirrored on the right.
 *
 * - Collapse: the panel slides shut (its grid column animates to 0) and the chevron
 *   turns; the button stays on the canvas's edge to bring it back. Its content is inert
 *   while shut, so Tab skips it. With reduced motion it opens and shuts at once.
 * - Resize: drag the edge, or focus it and use the arrow keys (Shift for bigger steps),
 *   Home and End for the narrowest and widest; Enter collapses. A double-click puts the
 *   default width back. Dragging well past the narrowest shuts the panel, and dragging
 *   back out of a shut one opens it.
 * - The widths are clamped so the canvas keeps at least CANVAS_MIN, and both widths and
 *   collapsed states are kept in this browser (localStorage), as a convenience only.
 *
 * usePanelLayout holds the state; SidePanel draws a panel's cell, edge and button. The
 * workspace grid takes the columns from layoutColumns().
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Icon } from "./icons";

export type Side = "left" | "right";
export interface PanelState {
  width: number;
  collapsed: boolean;
}
export type PanelLayout = Record<Side, PanelState>;

export const PANEL_LIMITS: Record<Side, { min: number; max: number; default: number }> = {
  left: { min: 160, max: 480, default: 230 },
  right: { min: 260, max: 900, default: 340 },
};
/** The canvas between the panels is never narrower than this while a panel is resized. */
export const CANVAS_MIN = 320;
/** Dragging this far past a panel's narrowest width shuts it. */
export const SNAP_SHUT = 80;
const STEP = 10;
const BIG_STEP = 50;
const STORAGE_KEY = "crossprobe.panels";

export const clampWidth = (side: Side, w: number, room = Infinity) => Math.round(Math.max(PANEL_LIMITS[side].min, Math.min(PANEL_LIMITS[side].max, room, w)));
const DEFAULT: PanelLayout = { left: { width: PANEL_LIMITS.left.default, collapsed: false }, right: { width: PANEL_LIMITS.right.default, collapsed: false } };

/** The kept layout, or the defaults when there is none or it doesn't read. */
export function readLayout(): PanelLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Record<Side, Partial<PanelState>>> | null;
    const one = (side: Side): PanelState => {
      const p = raw?.[side];
      const width = typeof p?.width === "number" && Number.isFinite(p.width) ? clampWidth(side, p.width) : PANEL_LIMITS[side].default;
      return { width, collapsed: p?.collapsed === true };
    };
    return { left: one("left"), right: one("right") };
  } catch {
    return DEFAULT;
  }
}
function writeLayout(l: PanelLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(l));
  } catch {
    // Storage may be off (private window): the layout just isn't kept.
  }
}

/**
 * How wide each panel is in a workspace `total` pixels wide (0: not measured yet). Each
 * open panel is its width, but when that would leave the canvas less than CANVAS_MIN they
 * give way: first the inspector's widening for a tab (`minRight`, the datasheet), then the
 * inspector down to its narrowest, then the left panel down to its narrowest.
 */
export function panelWidths(l: PanelLayout, total: number, minRight = 0): Record<Side, number> {
  let left = l.left.collapsed ? 0 : l.left.width;
  let right = l.right.collapsed ? 0 : Math.max(l.right.width, minRight);
  if (!total) return { left, right };
  let over = left + right + CANVAS_MIN - total;
  const give = (w: number, floor: number) => {
    const g = Math.max(0, Math.min(over, w - floor));
    over -= g;
    return w - g;
  };
  if (!l.right.collapsed) right = give(right, l.right.width);
  if (!l.right.collapsed) right = give(right, PANEL_LIMITS.right.min);
  if (!l.left.collapsed) left = give(left, PANEL_LIMITS.left.min);
  return { left: Math.round(left), right: Math.round(right) };
}

/** The workspace grid's columns for these widths. */
export const layoutColumns = (w: Record<Side, number>) => `${w.left}px minmax(0, 1fr) ${w.right}px`;

/**
 * The panels' state, kept in this browser, and the workspace's columns. Put `ref` on the
 * workspace (it is measured, so the panels give way in a narrow window) and `className`
 * on it too: it animates the columns only while a panel opens or shuts, not while one is
 * dragged or the window is resized.
 */
export function usePanelLayout(minRight = 0) {
  const [layout, setLayout] = useState<PanelLayout>(readLayout);
  // Kept once it settles, not on every move of a drag.
  useEffect(() => {
    const t = setTimeout(() => writeLayout(layout), 250);
    return () => clearTimeout(t);
  }, [layout]);
  /** A tab's widening (minRight) holds until the inspector is resized; the next tab that asks widens it again. */
  const [widen, setWiden] = useState(true);
  useEffect(() => setWiden(true), [minRight]);
  /**
   * The columns animate while a panel opens or shuts. The class goes on in the same update
   * as the new widths, so the browser never lays out the new widths without the transition.
   */
  const [moving, setMoving] = useState(0);
  const current = useRef(layout);
  current.current = layout;
  const set = useCallback((side: Side, patch: Partial<PanelState>) => {
    if (patch.collapsed !== undefined && patch.collapsed !== current.current[side].collapsed) setMoving((n) => n + 1);
    if (side === "right" && patch.width !== undefined) setWiden(false);
    setLayout((l) => ({ ...l, [side]: { ...l[side], ...patch } }));
  }, []);
  const toggle = useCallback((side: Side) => {
    setMoving((n) => n + 1);
    setLayout((l) => ({ ...l, [side]: { ...l[side], collapsed: !l[side].collapsed } }));
  }, []);
  useEffect(() => {
    if (!moving) return;
    const t = setTimeout(() => setMoving(0), 320);
    return () => clearTimeout(t);
  }, [moving]);

  const [total, setTotal] = useState(0);
  const observer = useRef<ResizeObserver>(undefined);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    if (!el) return;
    setTotal(el.getBoundingClientRect().width);
    observer.current = new ResizeObserver(() => setTotal(el.getBoundingClientRect().width));
    observer.current.observe(el);
  }, []);

  const widths = panelWidths(layout, total, widen ? minRight : 0);
  return { layout, set, toggle, widths, ref, className: moving ? "panels-moving" : "", style: { gridTemplateColumns: layoutColumns(widths) } };
}

export function SidePanel({
  side,
  label,
  state,
  onChange,
  onToggle,
  width,
  otherWidth,
  children,
}: {
  side: Side;
  /** What the panel holds, for the button and the edge ("Sheets and layers", "Inspector"). */
  label: string;
  state: PanelState;
  onChange: (patch: Partial<PanelState>) => void;
  onToggle: () => void;
  /** The width it is shown at now (panelWidths: widened for a tab, or given way in a narrow window). */
  width: number;
  /** The other panel's width now (0 when shut), to keep the canvas CANVAS_MIN wide. */
  otherWidth: number;
  children: ReactNode;
}) {
  const cell = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const { min, max } = PANEL_LIMITS[side];
  /** The widest this panel may be now: its maximum, or what leaves the canvas its minimum. */
  const room = () => {
    const ws = cell.current?.parentElement?.getBoundingClientRect().width;
    return ws ? Math.max(min, ws - otherWidth - CANVAS_MIN) : max;
  };
  /** Drags and keys start from the width as shown, not the stored one (they differ while a tab widens it). */
  const shown = state.collapsed ? 0 : width || state.width;
  /**
   * While the column opens or shuts (and while shut), the content keeps the width it has
   * open, so it slides behind the edge instead of being squeezed; otherwise it fills the
   * column (widened for a tab, or yielding on a narrow window).
   */
  const [slideWidth, setSlideWidth] = useState<number>();
  const was = useRef(state.collapsed);
  useLayoutEffect(() => {
    if (was.current === state.collapsed) return;
    was.current = state.collapsed;
    // Shutting: the width it has now (the transition has not moved yet). Opening: its width.
    const w = state.collapsed ? cell.current?.getBoundingClientRect().width || state.width : state.width;
    setSlideWidth(w);
    if (state.collapsed) return;
    const t = setTimeout(() => setSlideWidth(undefined), 320);
    return () => clearTimeout(t);
  }, [state.collapsed]); // only on opening and shutting; the width is read as it is then
  const bodyWidth = state.collapsed ? (slideWidth ?? state.width) : slideWidth;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer can't be captured; the moves still come to the edge.
    }
    const x0 = e.clientX;
    const w0 = shown;
    const limit = room();
    setDragging(true);
    const move = (m: PointerEvent) => {
      const dx = (m.clientX - x0) * (side === "left" ? 1 : -1);
      const w = w0 + dx;
      if (w < min - SNAP_SHUT) onChange({ collapsed: true });
      else onChange({ collapsed: false, width: clampWidth(side, w, limit) });
    };
    const up = () => {
      setDragging(false);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    const step = e.shiftKey ? BIG_STEP : STEP;
    let w: number | undefined;
    if (e.key === grow) w = state.collapsed ? min : shown + step;
    else if (e.key === shrink) w = shown - step;
    else if (e.key === "Home") w = min;
    else if (e.key === "End") w = max;
    else if (e.key === "Enter") {
      e.preventDefault();
      onToggle();
      return;
    } else return;
    e.preventDefault();
    if (e.key === shrink && state.collapsed) return;
    onChange({ collapsed: false, width: clampWidth(side, w, room()) });
  };

  const what = state.collapsed ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`;
  return (
    <div ref={cell} className={`side-panel ${side}${state.collapsed ? " collapsed" : ""}${dragging ? " dragging" : ""}`} data-side={side}>
      <div className="side-panel-clip">
        <div className="side-panel-body" inert={state.collapsed} id={`side-panel-${side}`} style={{ width: bodyWidth ?? "100%" }}>
          {children}
        </div>
      </div>
      <div
        className="side-panel-edge"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label.toLowerCase()}`}
        aria-controls={`side-panel-${side}`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={state.collapsed ? min : shown}
        aria-valuetext={state.collapsed ? "collapsed" : `${shown} pixels`}
        tabIndex={0}
        title="Drag to resize; double-click for the default width"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => onChange({ collapsed: false, width: clampWidth(side, PANEL_LIMITS[side].default, room()) })}
      />
      <button
        type="button"
        className="side-panel-toggle"
        onClick={onToggle}
        aria-expanded={!state.collapsed}
        aria-controls={`side-panel-${side}`}
        aria-label={what}
        title={what}
      >
        <Icon name="chevronRight" size={14} />
      </button>
    </div>
  );
}

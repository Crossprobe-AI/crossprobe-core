import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface View {
  scale: number; // screen px per mm
  tx: number;
  ty: number;
}

/**
 * Pan/zoom state for a view of millimetre content: wheel zooms around the
 * cursor, drag pans, `fit` frames a box. Shared by the schematic (SVG) and
 * board (canvas) views.
 */
export function useViewport(contentIn: Box | undefined, fitKey?: string) {
  // Compare the content box by value: an edit produces a new (equal) box,
  // and that must not re-frame the view under the user. With `fitKey`, the
  // view re-frames only when that key changes (e.g. an empty board gets parts).
  const key = fitKey ?? (contentIn ? `${contentIn.x},${contentIn.y},${contentIn.w},${contentIn.h}` : "");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const content = useMemo(() => contentIn, [key]);
  // Fitting (the Fit button, a resize of an untouched view) frames the content as it is now;
  // the key only decides when the view re-frames by itself.
  const latest = useRef(contentIn);
  latest.current = contentIn;
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const touched = useRef(false); // the user has panned or zoomed since the last fit
  const size = useRef({ w: 0, h: 0 });

  const fit = useCallback((box: Box | undefined = latest.current) => {
    const el = ref.current;
    if (!el || !box || box.w <= 0 || box.h <= 0) return;
    const { width, height } = el.getBoundingClientRect();
    const scale = Math.min(width / box.w, height / box.h) * 0.92;
    touched.current = false;
    setView({ scale, tx: width / 2 - (box.x + box.w / 2) * scale, ty: height / 2 - (box.y + box.h / 2) * scale });
  }, []);

  useEffect(() => {
    fit(content);
    const el = ref.current;
    if (!el) return;
    const r0 = el.getBoundingClientRect();
    size.current = { w: r0.width, h: r0.height };
    // A resized canvas (a wider inspector, a window drag) re-frames an untouched
    // view, and keeps the centre of one the user has moved.
    const reframe = () => {
      const r = el.getBoundingClientRect();
      const prev = size.current;
      size.current = { w: r.width, h: r.height };
      if (!prev.w || (prev.w === r.width && prev.h === r.height)) return;
      if (!touched.current) fit();
      else setView((v) => ({ ...v, tx: v.tx + (r.width - prev.w) / 2, ty: v.ty + (r.height - prev.h) / 2 }));
    };
    // Not while a button is held (a drag, a route being clicked out): the board would
    // shift under the cursor. Picking a part can resize the inspector right then; the
    // view catches up when the button is released.
    let pressed = false;
    let pending = false;
    const down = () => (pressed = true);
    const up = () => {
      pressed = false;
      if (pending) {
        pending = false;
        reframe();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    const ro = new ResizeObserver(() => {
      if (pressed) pending = true;
      else reframe();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
    };
  }, [content, fit]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      touched.current = true;
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      setView((v) => {
        const scale = Math.min(Math.max(v.scale * k, 0.05), 2000);
        const kk = scale / v.scale;
        return { scale, tx: mx - (mx - v.tx) * kk, ty: my - (my - v.ty) * kk };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      drag.current = { x: e.clientX, y: e.clientY, moved: false };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      // Capture only once dragging starts, so plain clicks keep their real target.
      if (!d.moved) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      d.moved = true;
      touched.current = true;
      d.x = e.clientX;
      d.y = e.clientY;
      setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
    },
    onPointerUp: () => {
      setTimeout(() => (drag.current = null), 0);
    },
  };

  /** True while a drag is in progress — clicks at the end of a drag are ignored. */
  const wasDrag = () => !!drag.current?.moved;

  /** Screen point (relative to the viewport) → content mm. */
  const toContent = (sx: number, sy: number) => {
    const v = viewRef.current;
    return { x: (sx - v.tx) / v.scale, y: (sy - v.ty) / v.scale };
  };

  /** Centre the view on a box, zooming in if it is small. */
  const focus = (box: Box) => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const v = viewRef.current;
    const scale = Math.max(v.scale, Math.min(width / Math.max(box.w, 1), height / Math.max(box.h, 1)) * 0.3);
    setView({ scale, tx: width / 2 - (box.x + box.w / 2) * scale, ty: height / 2 - (box.y + box.h / 2) * scale });
  };

  return { ref, view, fit, focus, handlers, wasDrag, toContent };
}

/**
 * True when a pointer event started on an overlay inside the viewport (Fit, a property panel, the
 * hint line) rather than on the drawing: those clicks must not act on the board or sheet.
 */
export function fromOverlay(e: { target: EventTarget | null; currentTarget: EventTarget | null }): boolean {
  const t = e.target;
  if (t === e.currentTarget || t instanceof SVGElement || t instanceof HTMLCanvasElement) return false;
  return t instanceof Element;
}

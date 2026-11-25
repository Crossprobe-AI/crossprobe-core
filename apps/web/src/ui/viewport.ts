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
 * cursor, drag pans, `fit` frames a box. On a touch screen, two fingers pinch
 * to zoom (and pan), and a double tap fits. Shared by the schematic (SVG) and
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
  const pinching = useRef(false); // two fingers are down: they zoom, and one-finger panning waits
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

  // Touch: two fingers pinch (zoom around their midpoint, and pan with it); a double tap fits.
  // Listened to on the element itself, beside the views' own pointer handlers.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const touches = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
    let last: { x: number; y: number; d: number } | undefined;
    let lastTap = { t: 0, x: 0, y: 0 };
    const pair = () => {
      const [a, b] = [...touches.values()];
      const r = el.getBoundingClientRect();
      return { x: (a!.x + b!.x) / 2 - r.left, y: (a!.y + b!.y) / 2 - r.top, d: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp });
      if (touches.size === 2) {
        pinching.current = true;
        // The lift that ends a pinch is not a tap on whatever is under the finger.
        drag.current = { x: e.clientX, y: e.clientY, moved: true };
        last = pair();
      }
    };
    const move = (e: PointerEvent) => {
      const t = touches.get(e.pointerId);
      if (!t) return;
      t.x = e.clientX;
      t.y = e.clientY;
      if (touches.size !== 2 || !last) return;
      const now = pair();
      const k = last.d > 0 ? now.d / last.d : 1;
      const from = last;
      last = now;
      touched.current = true;
      setView((v) => {
        const scale = Math.min(Math.max(v.scale * k, 0.05), 2000);
        const kk = scale / v.scale;
        return { scale, tx: now.x - (from.x - v.tx) * kk, ty: now.y - (from.y - v.ty) * kk };
      });
    };
    const up = (e: PointerEvent) => {
      const t = touches.get(e.pointerId);
      if (!t) return;
      touches.delete(e.pointerId);
      if (pinching.current) {
        if (touches.size === 1) {
          // One finger stays: it pans on from where it is, and its lift is still not a tap.
          const [rest] = [...touches.values()];
          drag.current = { x: rest!.x, y: rest!.y, moved: true };
          last = undefined;
        }
        if (touches.size === 0) pinching.current = false;
        lastTap.t = 0;
        return;
      }
      if (e.type !== "pointerup" || touches.size) return;
      const still = Math.hypot(e.clientX - t.x0, e.clientY - t.y0) < 10 && e.timeStamp - t.t0 < 300;
      if (!still) return;
      if (e.timeStamp - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap.t = 0;
        fit();
      } else lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, [fit]);

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      drag.current = { x: e.clientX, y: e.clientY, moved: false };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || pinching.current) return;
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
      // A finger lifted mid-pinch: the other still holds the gesture (the touch effect above).
      if (pinching.current) return;
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

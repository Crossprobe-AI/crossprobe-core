/**
 * A tab bar that never squeezes its tabs: as many as fit are shown at their
 * natural width, and the rest go under a "⋯" button that opens a menu. The
 * selected tab is always among the visible ones (it takes the place of the
 * last one that fits). Widths come from a hidden copy of the full row, so the
 * split follows the panel's width, the labels and the counts as they change.
 *
 * The copy is inert spans, not buttons: only the real tabs are buttons with
 * role="tab", which is what tests and scripts should select (`.tabs [role=tab]`).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface TabItem<T extends string> {
  id: T;
  /** The tab's content in the bar. */
  label: ReactNode;
  /** The same tab in the overflow menu (usually with a word where the bar shows an icon). */
  menuLabel: ReactNode;
  title?: string;
  className?: string;
  /** Marks the "⋯" button while this tab is hidden (e.g. issues to look at). */
  attention?: boolean;
}

const MORE_WIDTH = 34;

export function OverflowTabs<T extends string>({ items, active, onSelect }: { items: TabItem<T>[]; active: T; onSelect: (id: T) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(items.length);
  const [open, setOpen] = useState(false);

  // How many tabs fit, from the hidden full-width copy.
  useLayoutEffect(() => {
    const el = bar.current;
    const m = measure.current;
    if (!el || !m) return;
    const update = () => {
      const widths = [...m.children].map((c) => (c as HTMLElement).getBoundingClientRect().width);
      const total = widths.reduce((a, b) => a + b, 0);
      const avail = el.getBoundingClientRect().width;
      if (total <= avail) return setFit(widths.length);
      let used = MORE_WIDTH;
      let n = 0;
      while (n < widths.length && used + widths[n]! <= avail) used += widths[n++]!;
      setFit(Math.max(1, n));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    ro.observe(m);
    return () => ro.disconnect();
  }, [items.length]);

  // Close the menu on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !more.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  // The visible tabs: the first `fit`, with the selected one swapped in if it would be hidden.
  let shown = items.slice(0, fit);
  if (fit < items.length && !shown.some((t) => t.id === active)) {
    const sel = items.find((t) => t.id === active);
    if (sel) shown = [...shown.slice(0, Math.max(0, fit - 1)), sel];
  }
  const hidden = items.filter((t) => !shown.includes(t));

  const tab = (t: TabItem<T>) => (
    <button key={t.id} className={`${t.className ?? ""}${t.id === active ? " on" : ""}`.trim()} onClick={() => onSelect(t.id)} title={t.title} role="tab" aria-selected={t.id === active}>
      {t.label}
    </button>
  );

  return (
    <nav className="tabs" ref={bar} role="tablist">
      <div className="tabs-measure" ref={measure} aria-hidden="true" inert>
        {items.map((t) => (
          <span key={t.id} className={t.className}>
            {t.label}
          </span>
        ))}
      </div>
      {shown.map(tab)}
      {hidden.length > 0 && (
        <div className="tabs-more" ref={more}>
          <button
            className={`more${open ? " on" : ""}${hidden.some((t) => t.attention) ? " attention" : ""}`}
            onClick={() => setOpen(!open)}
            title={`${hidden.length} more`}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            ⋯
          </button>
          {open && (
            <div className="tabs-menu" role="menu">
              {hidden.map((t) => (
                <button
                  key={t.id}
                  role="menuitem"
                  title={t.title}
                  onClick={() => {
                    onSelect(t.id);
                    setOpen(false);
                  }}
                >
                  {t.menuLabel}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}

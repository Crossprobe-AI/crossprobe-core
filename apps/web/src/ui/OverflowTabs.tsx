/**
 * A tab bar that never squeezes its tabs: as many as fit are shown at their
 * natural width, and the rest go under a "⋯" button that opens a menu. The
 * selected tab is always among the visible ones: its room is kept first, and
 * the others fill what is left, in order. Widths come from a hidden copy of the
 * full row, so the split follows the panel's width, the labels and the counts
 * as they change.
 *
 * Keyboard, as for a tab list: the selected tab is the one stop in the Tab
 * order, and the arrow keys (Home, End) move to and select the others shown.
 * The "⋯" menu opens with the focus on its first item, moves with the arrows,
 * and Escape closes it and gives the focus back to "⋯".
 *
 * The copy is inert spans, not buttons: only the real tabs are buttons with
 * role="tab", which is what tests and scripts should select (`.tabs [role=tab]`).
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

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

/**
 * Which tabs to show, by index, for these natural widths in this much room: all
 * when they fit; else the selected one, then the others in order while they fit
 * beside it and "⋯". At least one tab is always shown.
 */
export function splitTabs(widths: number[], avail: number, activeIndex: number): Set<number> {
  const all = new Set(widths.map((_, i) => i));
  if (widths.reduce((a, b) => a + b, 0) <= avail) return all;
  const shown = new Set<number>();
  let left = avail - MORE_WIDTH;
  if (activeIndex >= 0) {
    shown.add(activeIndex);
    left -= widths[activeIndex]!;
  }
  for (let i = 0; i < widths.length; i++) {
    if (i === activeIndex) continue;
    if (widths[i]! > left) break;
    shown.add(i);
    left -= widths[i]!;
  }
  if (shown.size === 0) shown.add(0);
  return shown;
}

export function OverflowTabs<T extends string>({ items, active, onSelect }: { items: TabItem<T>[]; active: T; onSelect: (id: T) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDivElement>(null);
  /** The tabs' natural widths and the bar's inner width; undefined before the first measure (all shown). */
  const [room, setRoom] = useState<{ widths: number[]; avail: number }>();
  const [open, setOpen] = useState(false);

  // Measure the hidden full-width copy and the room inside the bar (without its padding).
  useLayoutEffect(() => {
    const el = bar.current;
    const m = measure.current;
    if (!el || !m) return;
    const update = () => {
      const widths = [...m.children].map((c) => (c as HTMLElement).getBoundingClientRect().width);
      const cs = getComputedStyle(el);
      const avail = el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      setRoom((r) => (r && r.avail === avail && r.widths.length === widths.length && r.widths.every((w, i) => w === widths[i]) ? r : { widths, avail }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    ro.observe(m);
    return () => ro.disconnect();
  }, [items.length]);

  // Close the menu on an outside click or Escape (which gives the focus back to "⋯").
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !more.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const focusInside = more.current?.contains(document.activeElement);
      setOpen(false);
      if (focusInside) more.current?.querySelector<HTMLElement>("button.more")?.focus();
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  // Opened from the keyboard or with a click, the focus goes to the first item.
  useEffect(() => {
    if (open) more.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open]);

  const activeIndex = items.findIndex((t) => t.id === active);
  const keep = room && room.widths.length === items.length ? splitTabs(room.widths, room.avail, activeIndex) : new Set(items.map((_, i) => i));
  const shown = items.filter((_, i) => keep.has(i));
  const hidden = items.filter((_, i) => !keep.has(i));

  // Arrow keys move along the shown tabs and select the one they land on.
  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = shown.length;
    const to = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    onSelect(shown[to]!.id);
    (bar.current?.querySelectorAll<HTMLElement>(":scope > [role=tab]")[to])?.focus();
  };
  // Up and down (Home, End) move within the open menu.
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const i = list.indexOf(document.activeElement as HTMLElement);
    const to = e.key === "ArrowDown" ? (i + 1) % list.length : e.key === "ArrowUp" ? (i - 1 + list.length) % list.length : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    list[to]?.focus();
  };

  return (
    <nav className="tabs" ref={bar} role="tablist">
      <div className="tabs-measure" ref={measure} aria-hidden="true" inert>
        {items.map((t) => (
          <span key={t.id} className={t.className}>
            {t.label}
          </span>
        ))}
      </div>
      {shown.map((t, i) => (
        <button
          key={t.id}
          className={`${t.className ?? ""}${t.id === active ? " on" : ""}`.trim()}
          onClick={() => onSelect(t.id)}
          onKeyDown={(e) => onTabKey(e, i)}
          title={t.title}
          role="tab"
          aria-selected={t.id === active}
          tabIndex={t.id === active || (activeIndex < 0 && i === 0) ? 0 : -1}
        >
          {t.label}
        </button>
      ))}
      {hidden.length > 0 && (
        <div className="tabs-more" ref={more}>
          <button
            className={`more${open ? " on" : ""}${hidden.some((t) => t.attention) ? " attention" : ""}`}
            onClick={() => setOpen(!open)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" || open) return;
              e.preventDefault();
              setOpen(true);
            }}
            title={`${hidden.length} more`}
            aria-label={`${hidden.length} more tabs`}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            ⋯
          </button>
          {open && (
            <div
              className="tabs-menu"
              role="menu"
              onKeyDown={onMenuKey}
            >
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

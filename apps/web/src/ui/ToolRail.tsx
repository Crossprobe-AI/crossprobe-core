/**
 * The editors' drawing tools, in a vertical rail at the canvas's left edge (as in KiCad
 * and most CAD tools), grouped with rules between the groups.
 *
 * - A group of related tools (labels, drawing shapes, …) is one button showing the group's
 *   current tool, the one in use or the last one chosen, with a corner mark. A click uses
 *   that tool; the mark, a right-click or ArrowRight opens the group's flyout beside it.
 * - The rail is there while viewing too, so it is clear the design can't be changed yet:
 *   under a "View only" label the tools are dimmed, their tooltips say a click turns
 *   editing on, and a click does (onEdit), then picks the tool.
 * - Keyboard: a toolbar, Up and Down move along it; in a flyout, Up and Down move, Escape
 *   and ArrowLeft go back to its button.
 *
 * Every tool, flyouts included, is a button in the page with its title and a `.tl` label
 * (hidden in the rail), which is what tests and scripts select (`.tool-rail button`).
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon, type IconName } from "./icons";

export interface RailTool<T extends string> {
  id: T;
  label: string;
  icon: IconName;
  /** Its shortcut, shown in the tooltip. */
  keys?: string;
  /** The tooltip, when the label and the shortcut don't say enough. */
  title?: string;
}
export interface RailGroup<T extends string> {
  group: string;
  tools: RailTool<T>[];
}
/** The rail's items, top to bottom: tools, groups of tools, and "|" for a rule. */
export type RailItem<T extends string> = RailTool<T> | RailGroup<T> | "|";

const isGroup = <T extends string>(i: RailItem<T>): i is RailGroup<T> => typeof i === "object" && "group" in i;
const tip = <T extends string>(t: RailTool<T>, editing: boolean) => `${t.title ?? (t.keys ? `${t.label} (${t.keys})` : t.label)}${editing ? "" : " · turns editing on (E)"}`;

export function ToolRail<T extends string>({
  items,
  active,
  editing,
  onChoose,
  onEdit,
  label = "Tools",
}: {
  items: RailItem<T>[];
  active: T;
  editing: boolean;
  onChoose: (tool: T) => void;
  /** Turn editing on (a tool chosen while viewing). */
  onEdit: () => void;
  label?: string;
}) {
  const rail = useRef<HTMLDivElement>(null);
  /** The tool each group shows when none of its tools is in use: the last one chosen. */
  const [last, setLast] = useState<Record<string, T>>({});
  const [open, setOpen] = useState<string>();
  /** Where the open flyout goes: beside its button (fixed, so the rail's scrolling doesn't clip it). */
  const [at, setAt] = useState<{ left: number; top: number }>();

  /** The rail's one Tab stop (a toolbar's roving tabindex): the item with the tool in use, else the first. */
  const tabStop: string | undefined = (() => {
    for (const i of items) {
      if (i === "|") continue;
      if (isGroup(i) ? i.tools.some((t) => t.id === active) : i.id === active) return isGroup(i) ? i.group : i.id;
    }
    const first = items.find((i): i is RailTool<T> | RailGroup<T> => i !== "|");
    return first && (isGroup(first) ? first.group : first.id);
  })();

  const choose = (t: T, group?: string) => {
    if (group) setLast((l) => ({ ...l, [group]: t }));
    setOpen(undefined);
    if (!editing) onEdit();
    onChoose(t);
  };

  // A flyout closes on a click elsewhere and on Escape (back to its button).
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !(e.target as Element).closest?.(`[data-group="${CSS.escape(open)}"]`) && setOpen(undefined);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(undefined);
      rail.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(open)}"] > .rail-tool`)?.focus();
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  // Opened, it goes beside its button, and the focus to its current tool.
  useLayoutEffect(() => {
    if (!open) return setAt(undefined);
    const place = () => {
      const r = rail.current?.querySelector(`[data-group="${CSS.escape(open)}"] > .rail-tool`)?.getBoundingClientRect();
      if (r) setAt({ left: Math.round(r.right + 8), top: Math.round(r.top - 4) });
    };
    place();
    // It follows its button when the window is resized or the rail scrolls.
    const el = rail.current;
    window.addEventListener("resize", place);
    el?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      el?.removeEventListener("scroll", place);
    };
  }, [open]);
  useEffect(() => {
    if (!open || !at) return;
    const fly = rail.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(open)}"] .rail-flyout`);
    (fly?.querySelector<HTMLElement>("[aria-checked=true]") ?? fly?.querySelector<HTMLElement>("button"))?.focus();
  }, [open, at]);

  /** Up and Down along the rail's buttons (not into flyouts). */
  const onRailKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if ((e.target as Element).closest(".rail-flyout")) return;
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>(":scope > .rail-item > .rail-tool")];
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    // Handled here: the editors' own arrow keys (nudging the selection) must not see it.
    e.preventDefault();
    e.stopPropagation();
    list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
  };
  const onFlyKey = (e: ReactKeyboardEvent<HTMLDivElement>, group: string) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>("button")];
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "ArrowRight") return;
      setOpen(undefined);
      rail.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(group)}"] > .rail-tool`)?.focus();
    }
  };

  const button = (t: RailTool<T>, group?: string, extra?: { more?: boolean }) => (
    <button
      type="button"
      className={`rail-tool${editing && active === t.id ? " on" : ""}`}
      aria-pressed={editing && active === t.id}
      title={tip(t, editing)}
      aria-label={t.label}
      data-tool={t.id}
      onClick={() => choose(t.id, group)}
      onContextMenu={group ? (e) => (e.preventDefault(), setOpen(group)) : undefined}
      onKeyDown={(e) => {
        // Left and right are the rail's too (into a flyout), not the editor's.
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        e.stopPropagation();
        if (group && e.key === "ArrowRight") setOpen(group);
      }}
      tabIndex={tabStop === t.id || (group !== undefined && tabStop === group) ? 0 : -1}
      aria-haspopup={group ? "menu" : undefined}
      aria-expanded={group ? open === group : undefined}
    >
      <Icon name={t.icon} />
      <span className="tl">{t.label}</span>
      {extra?.more && <span className="rail-more" aria-hidden="true" />}
    </button>
  );

  return (
    <div className={`tool-rail${editing ? "" : " viewing"}`} ref={rail} role="toolbar" aria-orientation="vertical" aria-label={label} onKeyDown={onRailKey}>
      {!editing && (
        <button type="button" className="rail-view-only" onClick={onEdit} title="View only: the design can't be changed. Click, or press E, to edit">
          <Icon name="eye" size={14} />
          <span>View only</span>
        </button>
      )}
      {items.map((item, n) => {
        if (item === "|") return <span key={`sep${n}`} className="rail-sep" role="separator" />;
        if (!isGroup(item))
          return (
            <div key={item.id} className="rail-item">
              {button(item)}
            </div>
          );
        const g = item.group;
        const current = item.tools.find((t) => t.id === active) ?? item.tools.find((t) => t.id === last[g]) ?? item.tools[0]!;
        const inUse = editing && item.tools.some((t) => t.id === active);
        return (
          <div key={g} className={`rail-item rail-group${inUse ? " in-use" : ""}`} data-group={g}>
            {button(current, g, { more: true })}
            <button type="button" className="rail-open" tabIndex={-1} aria-hidden="true" title={`${g}: more tools`} onClick={() => setOpen(open === g ? undefined : g)} />
            <div className="rail-flyout" role="menu" aria-label={g} hidden={open !== g} style={open === g && at ? at : undefined} onKeyDown={(e) => onFlyKey(e, g)}>
              <span className="rail-flyout-title">{g}</span>
              {item.tools.map((t) => (
                <button key={t.id} type="button" role="menuitemradio" aria-checked={editing && active === t.id} className={editing && active === t.id ? "on" : ""} title={tip(t, editing)} data-tool={t.id} onClick={() => choose(t.id, g)}>
                  <Icon name={t.icon} />
                  <span className="tl">{t.label}</span>
                  {t.keys && <span className="kbd">{t.keys}</span>}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

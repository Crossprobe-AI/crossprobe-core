/**
 * A dropdown in the top bar: a <details> that closes on a click elsewhere, on
 * Escape (giving the focus back to its button), when the focus moves out of it,
 * and when one of its items is chosen. Menus share a `name`, so opening one, by
 * mouse or keyboard, closes the others.
 */
import { useEffect, useRef, type ReactNode } from "react";

export function Menu({ className = "", summary, title, label, onOpen, children }: { className?: string; summary: ReactNode; title?: string; label: string; onOpen?: () => void; children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  const items = useRef<HTMLDivElement>(null);
  // Choosing an item (a button or a link) closes the menu; a click on text in it doesn't. A DOM
  // listener, not React's onClick: items an extension fills in through a portal (extensions/slots)
  // send React's click events up the extension's tree, never through this menu.
  useEffect(() => {
    const list = items.current;
    if (!list) return;
    const chosen = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.("button, a") && details.current) details.current.open = false;
    };
    list.addEventListener("click", chosen);
    return () => list.removeEventListener("click", chosen);
  }, []);
  useEffect(() => {
    const close = (e: Event) => {
      const el = details.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        const focusInside = el.contains(document.activeElement);
        el.open = false;
        if (focusInside) el.querySelector("summary")?.focus();
      } else if (!el.contains(e.target as Node)) el.open = false;
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, []);
  return (
    <details
      className={`menu ${className}`}
      ref={details}
      name="menu"
      onToggle={(e) => e.currentTarget.open && onOpen?.()}
      // Tab past the last item (or Shift+Tab before the button) closes it. A click on
      // text in the menu moves the focus nowhere (relatedTarget null) and leaves it open.
      onBlur={(e) => e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node) && (e.currentTarget.open = false)}
    >
      <summary title={title} aria-label={label}>
        {summary}
      </summary>
      <div className="menu-items" ref={items}>
        {children}
      </div>
    </details>
  );
}

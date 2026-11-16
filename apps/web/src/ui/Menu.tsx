/** A dropdown in the top bar: a <details> that closes on a click elsewhere, on Escape, and when one of its items is chosen. */
import { useEffect, useRef, type ReactNode } from "react";

export function Menu({ className = "", summary, title, label, onOpen, children }: { className?: string; summary: ReactNode; title?: string; label: string; onOpen?: () => void; children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !details.current?.contains(e.target as Node)) details.current?.removeAttribute("open");
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, []);
  return (
    <details className={`menu ${className}`} ref={details} onToggle={(e) => e.currentTarget.open && onOpen?.()}>
      <summary title={title} aria-label={label}>
        {summary}
      </summary>
      {/* Choosing an item closes the menu; text and links in it don't. */}
      <div className="menu-items" onClick={(e) => (e.target as HTMLElement).closest("button, a") && details.current?.removeAttribute("open")}>
        {children}
      </div>
    </details>
  );
}

/**
 * A value to copy: a label, the value in a read-only field (in the monospace face,
 * selected whole on focus) and a Copy button beside it. Copy says "Copied" for a
 * moment, or "Copy failed" when the browser refuses the clipboard; the field stays
 * selectable either way.
 *
 * On one line by default, the button the same height as the field and centred on it.
 * `multiline` is for a value of several lines (a config file, a long command): a
 * read-only text area as tall as the value (up to `maxRows`, then it scrolls), long
 * lines wrapped, and Copy at its top.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

export function CopyField({
  label,
  value,
  className = "",
  multiline = false,
  maxRows = 16,
}: {
  label: string;
  value: string;
  className?: string;
  /** Show the value on as many lines as it has, wrapped, in a text area. */
  multiline?: boolean;
  /** With `multiline`: the most lines shown before the field scrolls. */
  maxRows?: number;
}) {
  const id = useId();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // A multiline field is as tall as the value once wrapped (its lines may wrap at this
  // width), up to maxRows lines; it is measured again when its width changes.
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const fit = () => {
      const cs = getComputedStyle(el);
      const frame = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const max = parseFloat(cs.lineHeight) * maxRows + padding + frame;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight + frame, max)}px`;
    };
    fit();
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, maxRows, multiline]);
  const copy = () => {
    const done = (s: "copied" | "failed") => {
      setState(s);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 1500);
    };
    (navigator.clipboard?.writeText(value) ?? Promise.reject()).then(
      () => done("copied"),
      () => done("failed"),
    );
  };
  return (
    <div className={`copy-field ${className}`.trim()}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className={`copy-row${multiline ? " multiline" : ""}`}>
        {multiline ? (
          <textarea
            ref={area}
            id={id}
            readOnly
            value={value}
            spellCheck={false}
            rows={Math.min(Math.max(value.split("\n").length, 1), maxRows)}
            onFocus={(e) => e.target.select()}
          />
        ) : (
          <input id={id} readOnly value={value} spellCheck={false} onFocus={(e) => e.target.select()} />
        )}
        <button type="button" onClick={copy} aria-label={`Copy ${label}`}>
          {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
        </button>
      </div>
      <span className="visually-hidden" role="status">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </div>
  );
}

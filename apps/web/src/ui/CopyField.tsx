/**
 * A value to copy, on one line: a label, the value in a read-only field (in the
 * monospace face, selected whole on focus) and a Copy button beside it, the same
 * height and centred on it. Copy says "Copied" for a moment, or "Copy failed"
 * when the browser refuses the clipboard; the field stays selectable either way.
 */
import { useEffect, useId, useRef, useState } from "react";

export function CopyField({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  const id = useId();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
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
      <div className="copy-row">
        <input id={id} readOnly value={value} spellCheck={false} onFocus={(e) => e.target.select()} />
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

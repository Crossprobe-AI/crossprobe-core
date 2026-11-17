/**
 * KiCad's Annotate Schematic dialog: which parts get numbers (the whole schematic or this sheet;
 * every part or only the new ones), in which order, and where the numbers start.
 */
import { useState } from "react";
import type { AnnotationOptions } from "@crossprobe/kicad-model";
import type { EditOp } from "../edit/ops";
import type { SheetView } from "../render/types";
import { Icon } from "./icons";

export function Annotate({ sheet, onEdit, onClose }: { sheet: SheetView; onEdit: (ops: EditOp[]) => void; onClose: () => void }) {
  const [scope, setScope] = useState<"all" | "sheet">("all");
  const [mode, setMode] = useState<"unannotated" | "all">("unannotated");
  const [order, setOrder] = useState<"x" | "y">("x");
  const [numbering, setNumbering] = useState<"after" | "100" | "1000">("after");
  const [startAfter, setStartAfter] = useState(0);
  const options = (m: AnnotationOptions["mode"]): AnnotationOptions => ({
    mode: m,
    order,
    sheetPath: scope === "sheet" ? sheet.path : undefined,
    startAfter: numbering === "after" ? startAfter : undefined,
    sheetMultiplier: numbering === "after" ? undefined : (Number(numbering) as 100 | 1000),
  });
  const run = (m: AnnotationOptions["mode"]) => onEdit([{ op: "annotate", file: sheet.file, ...options(m) }]);
  return (
    <div className="update-pcb annotate-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="update-head">
        <strong>Annotate schematic</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="update-body page-settings">
        <label className="prop">
          <span>Scope</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="all">Entire schematic</option>
            <option value="sheet">This sheet only ({sheet.name})</option>
          </select>
        </label>
        <label className="prop">
          <span>Parts</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="unannotated">Keep existing numbers (R? → R14)</option>
            <option value="all">Renumber all</option>
          </select>
        </label>
        <label className="prop">
          <span>Order</span>
          <select value={order} onChange={(e) => setOrder(e.target.value as typeof order)}>
            <option value="x">Left to right, then down</option>
            <option value="y">Top to bottom, then right</option>
          </select>
        </label>
        <label className="prop">
          <span>Numbering</span>
          <select value={numbering} onChange={(e) => setNumbering(e.target.value as typeof numbering)}>
            <option value="after">First free number after…</option>
            <option value="100">Sheet number × 100 (sheet 2: R201)</option>
            <option value="1000">Sheet number × 1000 (sheet 2: R2001)</option>
          </select>
        </label>
        {numbering === "after" && (
          <label className="prop" title="0: numbers start at 1">
            <span>After</span>
            <input type="number" min={0} value={startAfter} onChange={(e) => setStartAfter(Math.max(0, Math.round(Number(e.target.value))))} onKeyDown={(e) => e.stopPropagation()} />
          </label>
        )}
      </div>
      <div className="update-actions">
        <button onClick={() => run("clear")} title="Take the numbers away: R14 becomes R?">
          Clear annotation
        </button>
        <button className="primary" onClick={() => run(mode)}>
          <Icon name="annotate" /> Annotate
        </button>
      </div>
    </div>
  );
}

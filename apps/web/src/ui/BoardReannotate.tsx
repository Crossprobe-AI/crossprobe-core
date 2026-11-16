/**
 * Geographical reannotation of the board (KiCad's PCB reannotate dialog): renumber references
 * by position, then send them to the schematic with Update Schematic from PCB.
 */
import { useMemo, useState } from "react";
import { REANNOTATE_DIRECTIONS, planBoardReannotate, type ReannotateOptions } from "@crossprobe/kicad-model";
import type { EditOp } from "../edit/ops";
import type { ProjectView } from "../render/types";
import { Icon } from "./icons";

export function BoardReannotate({ project, onEdit, onClose, onDone }: { project: ProjectView; onEdit: (ops: EditOp[]) => void; onClose: () => void; onDone: () => void }) {
  const board = project.board!;
  const [o, setO] = useState<ReannotateOptions & { excludeText: string }>({ direction: 0, grid: 1.27, sides: "all", frontStart: 1, backStart: 0, frontPrefix: "", backPrefix: "", excludeLocked: false, excludeText: "" });
  const plan = useMemo(() => planBoardReannotate(board, { ...o, exclude: o.excludeText.split(/[\s,]+/).filter(Boolean) }), [board, o]);
  const set = (patch: Partial<typeof o>) => setO({ ...o, ...patch });
  const apply = () => {
    const ops: EditOp[] = plan.changes.map((c) => ({ op: "setFootprintField", file: project.boardFile!, uuid: c.uuid, name: "Reference", value: c.to }));
    if (ops.length) onEdit(ops);
    onDone();
  };
  const num = (label: string, value: number | undefined, f: (v: number) => void, title?: string) => (
    <label className="prop" title={title}>
      <span>{label}</span>
      <input type="number" value={value ?? 0} onChange={(e) => f(Number(e.target.value))} />
    </label>
  );
  const text = (label: string, value: string | undefined, f: (v: string) => void, title?: string) => (
    <label className="prop" title={title}>
      <span>{label}</span>
      <input value={value ?? ""} onChange={(e) => f(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
    </label>
  );
  return (
    <div className="update-pcb board-reannotate" onPointerDown={(e) => e.stopPropagation()}>
      <div className="update-head">
        <strong>Renumber the board by position</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="update-body page-settings">
        <label className="prop">
          <span>Order</span>
          <select value={o.direction} onChange={(e) => set({ direction: Number(e.target.value) })}>
            {REANNOTATE_DIRECTIONS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </label>
        {num("Row grid (mm)", o.grid, (v) => set({ grid: v }), "Positions are rounded to this first, so parts slightly out of line still count as one row")}
        <label className="prop">
          <span>Parts</span>
          <select value={o.sides} onChange={(e) => set({ sides: e.target.value as ReannotateOptions["sides"] })}>
            <option value="all">Front and back</option>
            <option value="front">Front only</option>
            <option value="back">Back only</option>
          </select>
        </label>
        {num("Front from", o.frontStart, (v) => set({ frontStart: v }))}
        {num("Back from", o.backStart, (v) => set({ backStart: v }), "0: carry on after the front's numbers")}
        {text("Front prefix", o.frontPrefix, (v) => set({ frontPrefix: v }))}
        {text("Back prefix", o.backPrefix, (v) => set({ backPrefix: v }), "e.g. B to make back-side parts BR1, BC1…")}
        {text("Leave alone", o.excludeText, (v) => set({ excludeText: v }), "Prefixes (TP, MH) or patterns ending in * (U1*), separated by commas")}
        <label className="prop">
          <span />
          <span>
            <input type="checkbox" checked={!!o.excludeLocked} onChange={(e) => set({ excludeLocked: e.target.checked })} /> Leave locked parts alone
          </span>
        </label>
        <p className="muted small">Then: Update schematic sends the new references to the schematic, and Update PCB the net names made from them (Net-(R1-Pad2)…).</p>
        {plan.duplicates.length > 0 && <p className="error small">Would give {plan.duplicates.join(", ")} twice: change the start numbers or exclusions.</p>}
        {plan.invalid.length > 0 && <p className="muted small">Not renumbered (no number in the reference): {plan.invalid.slice(0, 6).join(", ")}</p>}
        <details className="update-list small">
          <summary>
            {plan.changes.length} reference{plan.changes.length === 1 ? "" : "s"} change
          </summary>
          <ul>
            {plan.changes.slice(0, 200).map((c) => (
              <li key={c.uuid} className="mono">
                {c.from} → {c.to}
              </li>
            ))}
          </ul>
        </details>
      </div>
      <div className="update-actions">
        <button onClick={onClose}>Close</button>
        <button className="primary" disabled={!plan.changes.length || plan.duplicates.length > 0} onClick={apply} title="Then Update schematic sends the new references to the schematic">
          <Icon name="annotate" /> Renumber {plan.changes.length || ""}
        </button>
      </div>
    </div>
  );
}

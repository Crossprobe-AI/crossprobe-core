/**
 * Update Schematic from PCB (KiCad's back-annotation): what changed on the board (references,
 * values, footprints, other fields, DNP and BOM) goes back to the symbols, as one undoable edit.
 * The plan (planSchematicUpdate) is checked against KiCad's schematic parity check.
 */
import { useMemo, useState } from "react";
import type { SchematicUpdate } from "@crossprobe/kicad-model";
import type { EditOp } from "../edit/ops";
import type { ProjectView } from "../render/types";
import { Icon } from "./icons";

type Kind = "references" | "values" | "footprints" | "fields" | "attributes";
const KINDS: Array<{ k: Kind; label: string }> = [
  { k: "references", label: "Reference designators" },
  { k: "values", label: "Values" },
  { k: "footprints", label: "Footprint assignments" },
  { k: "fields", label: "Other fields" },
  { k: "attributes", label: "DNP and BOM" },
];
const kindOf = (field: string): Kind => (field === "Reference" ? "references" : field === "Value" ? "values" : field === "Footprint" ? "footprints" : "fields");

export function UpdateSchematic({ project, onEdit, onClose }: { project: ProjectView; onEdit: (ops: EditOp[]) => void; onClose: () => void }) {
  const [on, setOn] = useState<Record<Kind, boolean>>({ references: true, values: true, footprints: true, fields: true, attributes: true });
  const plan = project.schematicUpdate ?? { updates: [], unmatched: [] };
  // The schematic files as the edit ops name them (with the project folder).
  const fileOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of project.components) for (const u of c.units) m.set(u.uuid, u.file);
    return m;
  }, [project.components]);

  const lines = (u: SchematicUpdate) => {
    const c = project.components.find((x) => x.reference === u.reference);
    const out: Array<{ kind: Kind; text: string }> = [];
    for (const [f, v] of Object.entries(u.fields)) {
      const now = f === "Reference" ? u.reference : f === "Value" ? c?.value : f === "Footprint" ? c?.footprint : c?.properties[f];
      out.push({ kind: kindOf(f), text: `${f === "Reference" ? "Reference" : f}: ${now || "(none)"} → ${v || "(empty)"}` });
    }
    if (u.dnp !== undefined) out.push({ kind: "attributes", text: u.dnp ? "Do not populate" : "Populate" });
    if (u.inBom !== undefined) out.push({ kind: "attributes", text: u.inBom ? "Include in BOM" : "Exclude from BOM" });
    return out;
  };
  const shown = plan.updates.map((u) => ({ u, lines: lines(u).filter((l) => on[l.kind]) })).filter((x) => x.lines.length);
  const count = shown.reduce((n, x) => n + x.lines.length, 0);

  const apply = () => {
    const ops: EditOp[] = [];
    for (const { u } of shown)
      for (const unit of u.units) {
        const file = fileOf.get(unit.uuid);
        if (!file) continue;
        for (const [name, value] of Object.entries(u.fields)) if (on[kindOf(name)]) ops.push({ op: "setField", file, uuid: unit.uuid, name, value, sheetPath: unit.sheet });
        if (on.attributes && (u.dnp !== undefined || u.inBom !== undefined)) ops.push({ op: "setSymbolAttributes", file, uuid: unit.uuid, dnp: u.dnp, inBom: u.inBom });
      }
    if (ops.length) onEdit(ops);
    onClose();
  };

  return (
    <div className="update-pcb update-sch" onPointerDown={(e) => e.stopPropagation()}>
      <div className="update-head">
        <strong>Update schematic from PCB</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="update-body">
        <div className="plot-opts">
          {KINDS.map(({ k, label }) => (
            <label key={k}>
              <input type="checkbox" checked={on[k]} onChange={(e) => setOn({ ...on, [k]: e.target.checked })} /> {label}
            </label>
          ))}
        </div>
        {shown.length ? (
          <ul className="update-list small">
            {shown.map(({ u, lines }) => (
              <li key={u.reference}>
                <strong className="mono">{u.reference}</strong>
                <ul>
                  {lines.map((l) => (
                    <li key={l.text}>{l.text}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">The schematic already matches the board.</p>
        )}
        {plan.unmatched.length > 0 && (
          <p className="muted small" title={plan.unmatched.join(", ")}>
            {plan.unmatched.length} footprint{plan.unmatched.length > 1 ? "s have" : " has"} no symbol: {plan.unmatched.slice(0, 8).join(", ")}
            {plan.unmatched.length > 8 ? "…" : ""} (add them in the schematic, or mark them board-only).
          </p>
        )}
      </div>
      <div className="update-actions">
        <button onClick={onClose}>Close</button>
        <button className="primary" disabled={!count} onClick={apply}>
          <Icon name="sync" /> Update {count || ""} in the schematic
        </button>
      </div>
    </div>
  );
}

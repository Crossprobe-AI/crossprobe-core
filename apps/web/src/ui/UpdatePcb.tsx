/**
 * Update PCB from Schematic: shows what the analysis found (field and net
 * changes, footprints to add, footprints without a symbol) and applies it as
 * one undoable edit. New footprints come from KiCad's footprint libraries and
 * are lined up beside the board, ready to be placed.
 */
import { useState } from "react";
import { displayName, footprintExtent, packFootprints, placeLikeSchematic } from "@crossprobe/kicad-model";
import type { EditOp } from "../edit/ops";
import { kicadFootprint } from "../load";
import type { ProjectView } from "../render/types";
import { Icon } from "./icons";

type Point = { x: number; y: number };

export function UpdatePcb({ project, onEdit, onClose, onAssignFootprints }: { project: ProjectView; onEdit: (ops: EditOp[]) => void; onClose: () => void; onAssignFootprints?: () => void }) {
  const plan = project.boardUpdate;
  const [deleteExtra, setDeleteExtra] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!plan || !project.board || !project.boardFile) return null;

  const pads = plan.updates.reduce((n, u) => n + Object.keys(u.pads).length, 0);
  const fields = plan.updates.reduce((n, u) => n + Object.keys(u.fields).length, 0);
  const nothing = !plan.updates.length && !plan.missing.length && !plan.extra.length;

  const apply = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const ids = [...new Set(plan.missing.map((m) => m.footprint).filter(Boolean))];
      const texts = await Promise.all(ids.map((id) => kicadFootprint(id)));
      const footprints: Record<string, string> = {};
      ids.forEach((id, i) => texts[i] && (footprints[id] = texts[i]!));
      // Pack new footprints by their real size, to the right of what is already there.
      const b = project.board!;
      const pts = [...b.outline.flatMap((o) => o.points), ...b.footprints.map((f) => f.at)];
      // An empty board: start near the middle of the page.
      const right = pts.length ? Math.max(...pts.map((p) => p.x)) + 10 : 90;
      const top = pts.length ? Math.min(...pts.map((p) => p.y)) : 80;
      // Where each symbol sits in the schematic (sub-sheets side by side), so the new
      // footprints start out grouped the way the circuit is drawn.
      const targets = new Map<string, { x: number; y: number }>();
      project.sheets.forEach((sheet, i) => {
        for (const it of sheet.items) {
          if (it.kind !== "symbol" || !it.ref || !it.bbox || targets.has(it.ref)) continue;
          targets.set(it.ref, { x: i * 320 + it.bbox.x + it.bbox.w / 2, y: it.bbox.y + it.bbox.h / 2 });
        }
      });
      const fresh = plan.missing.filter((m) => footprints[m.footprint]).map((m) => ({ reference: m.reference, extent: footprintExtent(footprints[m.footprint]!), target: targets.get(m.reference) }));
      const places = fresh.every((f) => f.target)
        ? placeLikeSchematic(fresh as Array<(typeof fresh)[number] & { target: { x: number; y: number } }>, { x: right, y: top })
        : packFootprints(fresh, { x: right, y: top });
      onEdit([{ op: "updateBoard", file: project.boardFile!, plan, footprints, places, deleteExtra }]);
      const skipped = plan.missing.filter((m) => !footprints[m.footprint]).map((m) => m.reference);
      if (skipped.length) setError(`No library footprint for ${skipped.join(", ")}: set their Footprint field in the schematic.`);
      else onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="update-pcb">
      <div className="update-head">
        <strong>Update PCB from schematic</strong>
        <button className="icon-btn" onClick={onClose} title="Close"><Icon name="close" /></button>
      </div>
      {nothing ? (
        <p className="muted">The board matches the schematic.</p>
      ) : (
        <div className="update-body">
          {plan.updates.length > 0 && (
            <section>
              <h4>Update {plan.updates.length} footprint{plan.updates.length > 1 ? "s" : ""} <span className="muted small">({fields} fields, {pads} pad nets)</span></h4>
              <ul>
                {plan.updates.slice(0, 40).map((u) => (
                  <li key={u.uuid}>
                    <b>{u.reference}</b>{" "}
                    <span className="muted small">
                      {[
                        ...Object.entries(u.fields).map(([k, v]) => `${k} → ${v || "∅"}`),
                        ...(u.attributes?.dnp !== undefined ? [u.attributes.dnp ? "do not populate" : "populate"] : []),
                        ...(u.attributes?.excludeFromBom !== undefined ? [u.attributes.excludeFromBom ? "exclude from BOM" : "include in BOM"] : []),
                        ...Object.entries(u.pads).map(([k, v]) => `pad ${k} → ${v ? displayName(v) : "no net"}`),
                      ].join(" · ")}
                    </span>
                  </li>
                ))}
                {plan.updates.length > 40 && <li className="muted">…and {plan.updates.length - 40} more</li>}
              </ul>
            </section>
          )}
          {plan.missing.length > 0 && (
            <section>
              <h4>Add {plan.missing.length} footprint{plan.missing.length > 1 ? "s" : ""}</h4>
              <ul>
                {plan.missing.map((m) => (
                  <li key={m.reference}>
                    <b>{m.reference}</b> <span className="muted small">{m.footprint || "no Footprint field"}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {plan.extra.length > 0 && (
            <section>
              <h4>{plan.extra.length} footprint{plan.extra.length > 1 ? "s" : ""} without a symbol</h4>
              <p className="muted small">{plan.extra.map((e) => e.reference).join(", ")}</p>
              <label className="small">
                <input type="checkbox" checked={deleteExtra} onChange={(e) => setDeleteExtra(e.target.checked)} /> Delete them
              </label>
            </section>
          )}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      {plan.missing.some((m) => !m.footprint) && (
        <p className="small">
          <span className="error">{plan.missing.filter((m) => !m.footprint).length} part(s) have no footprint yet.</span>{" "}
          {onAssignFootprints && (
            <button className="link" onClick={onAssignFootprints}>
              Assign footprints…
            </button>
          )}
        </p>
      )}
      <div className="update-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || nothing} onClick={apply}>{busy ? "Updating…" : "Update PCB"}</button>
      </div>
    </div>
  );
}

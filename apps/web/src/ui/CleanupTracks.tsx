/**
 * Cleanup Tracks & Vias (KiCad's dialog): choose what to clean, see what was found, apply it as
 * one undoable edit. The plan (planCleanup) is checked against KiCad's DRC on the demo boards:
 * it never leaves more unconnected items or violations than before.
 */
import { useMemo, useState } from "react";
import { planCleanup, type CleanupKind, type CleanupOptions } from "@crossprobe/kicad-model";
import type { EditOp } from "../edit/ops";
import type { ProjectView } from "../render/types";
import { Icon } from "./icons";

const OPTIONS: Array<{ k: keyof CleanupOptions; label: string; title: string }> = [
  { k: "vias", label: "Redundant vias", title: "A second via in the same place, or a via in a through-hole pad of its net" },
  { k: "merge", label: "Merge collinear segments", title: "Also zero-length and duplicate segments. A joint with anything else on it, or a change of width, stays" },
  { k: "inPads", label: "Tracks inside pads", title: "Tracks lying wholly inside one pad of their net" },
  { k: "dangling", label: "Dangling tracks", title: "Tracks with an end that touches nothing of its net (again and again, as removing one can leave another dangling)" },
  { k: "danglingVias", label: "Dangling vias", title: "Vias connected on one layer only" },
];

export function CleanupTracks({ project, onEdit, onClose, onShow }: { project: ProjectView; onEdit: (ops: EditOp[]) => void; onClose: () => void; onShow?: (at: { x: number; y: number }) => void }) {
  const [opts, setOpts] = useState<Required<CleanupOptions>>({ vias: true, merge: true, inPads: true, dangling: true, danglingVias: true });
  const plan = useMemo(() => planCleanup(project.board!, opts), [project.board, opts]);
  const byKind = useMemo(() => {
    const m = new Map<CleanupKind, typeof plan.items>();
    for (const i of plan.items) m.set(i.kind, [...(m.get(i.kind) ?? []), i]);
    return [...m];
  }, [plan]);
  const apply = () => {
    if (plan.remove.length || plan.reshape.length) onEdit([{ op: "cleanupTracks", file: project.boardFile!, remove: plan.remove, reshape: plan.reshape }]);
    onClose();
  };
  return (
    <div className="update-pcb cleanup-tracks" onPointerDown={(e) => e.stopPropagation()}>
      <div className="update-head">
        <strong>Cleanup tracks &amp; vias</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="update-body">
        <div className="plot-opts">
          {OPTIONS.map(({ k, label, title }) => (
            <label key={k} title={title}>
              <input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} /> {label}
            </label>
          ))}
        </div>
        {byKind.length ? (
          <ul className="update-list small">
            {byKind.map(([kind, items]) => (
              <li key={kind}>
                <details>
                  <summary>
                    <strong>{items.length}</strong> × {kind}
                  </summary>
                  <ul>
                    {items.slice(0, 50).map((i, n) => (
                      <li key={n}>
                        <button className="link" onClick={() => onShow?.(i.at)}>
                          {i.net || "(no net)"} at {i.at.x.toFixed(2)}, {i.at.y.toFixed(2)}
                        </button>
                      </li>
                    ))}
                    {items.length > 50 && <li className="muted">… and {items.length - 50} more</li>}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Nothing to clean up.</p>
        )}
        <p className="muted small">Locked tracks and vias are left alone.</p>
      </div>
      <div className="update-actions">
        <button onClick={onClose}>Close</button>
        <button className="primary" disabled={!plan.items.length} onClick={apply}>
          <Icon name="sync" /> Clean up {plan.remove.length + plan.reshape.length || ""}
        </button>
      </div>
    </div>
  );
}

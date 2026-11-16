/** Rule-based compatibility findings (supply rail crossings, I2C pull-ups), live from the design. */
import { useMemo } from "react";
import { checkCompatibility } from "../compat/compat";
import type { ProjectView } from "../render/types";
import type { Selection } from "./selection";

export function CompatibilitySection({ project, onSelect }: { project: ProjectView; onSelect: (s: Selection) => void }) {
  const found = useMemo(() => checkCompatibility(project), [project]);
  const refs = new Set(project.components.map((c) => c.reference));
  const nets = new Set(project.nets.map((n) => n.name));
  return (
    <details className="requirements" open={found.length > 0}>
      <summary>
        Compatibility <span className="muted small">· {found.length ? `${found.length} to check` : "nothing found"}</span>
      </summary>
      {found.map((f, i) => (
        <div key={i} className={`finding ${f.severity}`}>
          <div className="finding-head">
            <span className={`rsev ${f.severity}`}>{f.severity}</span>
            <b>{f.title}</b>
          </div>
          <p className="small">{f.detail}</p>
          <div className="finding-links">
            {f.references.map((r) => (
              <button key={r} className="chip" disabled={!refs.has(r)} onClick={() => onSelect({ kind: "component", reference: r })}>{r}</button>
            ))}
            {f.nets.map((n) => (
              <button key={n} className="chip net" disabled={!nets.has(n)} onClick={() => onSelect({ kind: "net", name: n })}>{n}</button>
            ))}
          </div>
        </div>
      ))}
      {!found.length && <p className="empty small">Checked by rules from net names like +3V3 and +5V. Parts on several rails, or on rails the name doesn't give, are skipped.</p>}
    </details>
  );
}

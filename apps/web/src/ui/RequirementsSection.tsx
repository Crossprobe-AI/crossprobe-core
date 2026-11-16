/**
 * The project's structured requirements: live pass / fail / unknown from the
 * rule checks, with a small editor. Stored in the project's requirements
 * sidecar file; the KiCad files are not touched.
 */
import { useMemo, useState } from "react";
import { installed } from "../extensions";
import type { EditOp } from "../edit/ops";
import type { ProjectView } from "../render/types";
import { checkRequirements, FORM, requirementFromForm, type RequirementKind } from "../requirements/requirements";
import { Icon } from "./icons";
import type { Selection } from "./selection";

/** What extensions add to the empty state (who else reads the results). */
const NOTES = installed.flatMap((e) => (e.requirementsNote ? [e.requirementsNote] : []));

export function RequirementsSection({ project, onSelect, onEdit }: { project: ProjectView; onSelect: (s: Selection) => void; onEdit?: (ops: EditOp[]) => void }) {
  const results = useMemo(() => checkRequirements(project), [project]);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<RequirementKind>("board_size");
  const [title, setTitle] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const refs = new Set(project.components.map((c) => c.reference));
  const nets = new Set(project.nets.map((n) => n.name));

  const save = (requirements: typeof project.requirements) => onEdit?.([{ op: "setRequirements", file: project.requirementsFile, requirements }]);
  const draft = requirementFromForm(kind, `r${Date.now().toString(36)}`, title || FORM[kind].label, values);
  const add = () => {
    if (!draft) return;
    save([...project.requirements, draft]);
    setAdding(false);
    setTitle("");
    setValues({});
  };
  const failed = results.filter((r) => r.status === "fail").length;

  return (
    <details className="requirements" open={project.requirements.length > 0 || adding}>
      <summary>
        Requirements {project.requirements.length > 0 && <span className="muted small">· {failed ? `${failed} failing` : "all met"}</span>}
      </summary>
      {!project.requirements.length && !adding && <p className="empty small">No requirements yet. They are checked by rules against the design.{NOTES.map((n) => ` ${n}`)}</p>}
      {results.map((r) => (
        <div key={r.id} className={`finding ${r.status === "fail" ? "error" : r.status === "unknown" ? "warning" : "info"}`}>
          <div className="finding-head">
            <span className={`rsev ${r.status === "fail" ? "error" : r.status === "unknown" ? "warning" : "info"}`}>{r.status}</span>
            <b>{r.title}</b>
            {onEdit && (
              <button className="icon-btn" title="Remove requirement" onClick={() => save(project.requirements.filter((x) => x.id !== r.id))}>
                <Icon name="close" />
              </button>
            )}
          </div>
          <p className="small">{r.detail}</p>
          <div className="finding-links">
            {r.references?.map((x) => (
              <button key={x} className="chip" disabled={!refs.has(x)} onClick={() => onSelect({ kind: "component", reference: x })}>{x}</button>
            ))}
            {r.nets?.map((x) => (
              <button key={x} className="chip net" disabled={!nets.has(x)} onClick={() => onSelect({ kind: "net", name: x })}>{x}</button>
            ))}
          </div>
        </div>
      ))}
      {onEdit &&
        (adding ? (
          <div className="review-form">
            <select value={kind} onChange={(e) => { setKind(e.target.value as RequirementKind); setValues({}); }}>
              {(Object.keys(FORM) as RequirementKind[]).map((k) => <option key={k} value={k}>{FORM[k].label}</option>)}
            </select>
            <input placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
            {FORM[kind].fields.map((f) => (
              <input key={f.key} placeholder={f.label} title={f.label} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            ))}
            <div className="review-actions">
              <button className="primary" disabled={!draft} onClick={add}>Add</button>
              <button onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)}>Add requirement</button>
        ))}
    </details>
  );
}

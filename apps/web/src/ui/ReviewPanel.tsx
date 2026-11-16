/**
 * The Review tab: the project's requirements and the compatibility checks
 * across connected parts (rules, no model), and what an extension adds (an
 * assistant's design review). Findings cross-probe to the views like any
 * other selection.
 */
import { installed } from "../extensions";
import type { EditOp } from "../edit/ops";
import type { ProjectView } from "../render/types";
import { CompatibilitySection } from "./CompatibilitySection";
import { RequirementsSection } from "./RequirementsSection";
import type { Selection } from "./selection";

const sections = installed.flatMap((e) => (e.reviewSection ? [{ id: e.id, Section: e.reviewSection }] : []));

export function ReviewPanel({ project, onSelect, onEdit, hidden }: { project: ProjectView; onSelect: (s: Selection) => void; onEdit?: (ops: EditOp[]) => void; hidden: boolean }) {
  return (
    <div className="review" style={hidden ? { display: "none" } : undefined}>
      <RequirementsSection project={project} onSelect={onSelect} onEdit={onEdit} />
      <CompatibilitySection project={project} onSelect={onSelect} />
      {sections.map(({ id, Section }) => (
        <Section key={id} project={project} onSelect={onSelect} onEdit={onEdit} />
      ))}
    </div>
  );
}

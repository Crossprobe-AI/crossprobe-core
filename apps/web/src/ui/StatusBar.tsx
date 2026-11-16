/**
 * The status bar under the workspace, as in an IDE or EDA tool: what is open
 * and selected on the left, check results in the middle (click to open the
 * Issues tab), and save state and analysis stats on the right.
 */
import { displayName } from "@crossprobe/kicad-model";
import type { ProjectView } from "../render/types";
import type { Selection } from "./selection";

export function StatusBar({
  project,
  mode,
  where,
  selection,
  editing,
  dirty,
  busy,
  onIssues,
}: {
  project: ProjectView;
  mode: "schematic" | "board" | "3d";
  /** The sheet name (schematic) or a short board description. */
  where: string;
  selection: Selection;
  editing: string | undefined;
  dirty: string[];
  busy: boolean;
  onIssues: () => void;
}) {
  const ercErrors = project.erc.filter((v) => v.severity === "error").length;
  // Clearance findings and the other board checks together, as KiCad's DRC counts them.
  const drc = project.clearance.length + project.boardChecks.length;
  const drcErrors = project.clearance.length + project.boardChecks.filter((v) => v.severity === "error").length;
  const checks: Array<[string, number, "err" | "warn" | "ok"]> = [
    ["ERC", project.erc.length, ercErrors ? "err" : project.erc.length ? "warn" : "ok"],
    ...(project.board
      ? ([
          ["DRC", drc, drcErrors ? "err" : drc ? "warn" : "ok"],
          ["Unrouted", project.unconnected.length, project.unconnected.length ? "warn" : "ok"],
          ["Parity", project.parity.length, project.parity.length ? "warn" : "ok"],
        ] as Array<[string, number, "err" | "warn" | "ok"]>)
      : []),
  ];
  const selected =
    selection?.kind === "component"
      ? `${selection.reference} · ${project.components.find((c) => c.reference === selection.reference)?.value ?? ""}`
      : selection?.kind === "net"
        ? `Net ${displayName(selection.name)}`
        : selection?.kind === "marker"
          ? selection.label
          : "Nothing selected";
  return (
    <footer className="statusbar" aria-label="Status">
      <span className="sb-item sb-mode">{mode === "board" ? "PCB" : mode === "3d" ? "3D" : "Schematic"}</span>
      <span className="sb-item">{where}</span>
      <span className="sb-item sb-sel" title={selected}>{selected}</span>
      {editing && <span className="sb-item sb-edit">Edit · {editing}</span>}
      <span className="sb-spacer" />
      <button className="sb-item sb-checks" onClick={onIssues} title="Open the Issues tab">
        {checks.map(([name, n, level]) => (
          <span key={name} className={`sb-check ${level}`}>
            <span className="sb-led" aria-hidden="true" />
            {name} <b>{n}</b>
          </span>
        ))}
      </button>
      <span className={`sb-item${dirty.length ? " sb-dirty" : ""}`}>{busy ? "Updating…" : dirty.length ? `${dirty.length} unsaved` : "Saved"}</span>
      <span className="sb-item muted">
        {project.stats.files} files · {project.stats.parseMs} ms
      </span>
    </footer>
  );
}

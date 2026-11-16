/**
 * Board setup: the design-rule minimums the DRC checks against and the
 * Default net class (what new tracks and vias use), written to the
 * .kicad_pro. Presets fill in a fab's limits in one step.
 */
import { useEffect, useState } from "react";
import { microstripZdiff, outerMicrostrip, pairWidthFor, trackCurrent } from "@crossprobe/kicad-model";
import type { EditOp } from "../edit/ops";
import type { ProjectView } from "../render/types";
import { Icon } from "./icons";

type Rules = Record<string, number>;

/** Board minimums: our name → KiCad's key in board.design_settings.rules. */
const RULE_FIELDS: Array<[string, string, string]> = [
  ["minClearance", "min_clearance", "Minimum clearance"],
  ["minTrackWidth", "min_track_width", "Minimum track width"],
  ["minViaDiameter", "min_via_diameter", "Minimum via diameter"],
  ["minViaAnnular", "min_via_annular_width", "Minimum via annular ring"],
  ["minHoleSize", "min_through_hole_diameter", "Minimum hole"],
  ["minHoleToHole", "min_hole_to_hole", "Hole to hole"],
  ["holeClearance", "min_hole_clearance", "Copper to hole"],
  ["copperEdgeClearance", "min_copper_edge_clearance", "Copper to board edge"],
  ["minTextHeight", "min_text_height", "Minimum silkscreen text"],
];
/** A pair's sizes in a net class (differential pairs take them). */
const PAIR_FIELDS: Array<[string, string]> = [
  ["diff_pair_width", "Pair width"],
  ["diff_pair_gap", "Pair gap"],
];
const CLASS_FIELDS: Array<[keyof Preset["netClass"], string]> = [
  ["clearance", "Clearance"],
  ["track_width", "Track width"],
  ["via_diameter", "Via diameter"],
  ["via_drill", "Via drill"],
];

interface Preset {
  label: string;
  note: string;
  rules: Rules;
  netClass: { clearance: number; track_width: number; via_diameter: number; via_drill: number };
  /** Copper layers the preset is for (the board's count is set too). */
  copperLayers?: number;
  /** The fab's stackup to write (see STACKUPS in the model). */
  stackup?: string;
}

const PRESETS: Preset[] = [
  {
    label: "KiCad defaults",
    note: "What a new KiCad project starts with.",
    rules: { min_clearance: 0, min_track_width: 0.2, min_via_diameter: 0.5, min_via_annular_width: 0.1, min_through_hole_diameter: 0.3, min_hole_to_hole: 0.25, min_hole_clearance: 0.25, min_copper_edge_clearance: 0.5, min_text_height: 0.8 },
    netClass: { clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3 },
  },
  {
    label: "JLCPCB 2-layer (standard)",
    note: "From JLCPCB's published capabilities: 0.127 mm track and spacing, 0.3 mm via hole on 1–2 layer boards, 0.5 mm hole to hole. Check their current limits before ordering.",
    rules: { min_clearance: 0.127, min_track_width: 0.127, min_via_diameter: 0.6, min_via_annular_width: 0.15, min_through_hole_diameter: 0.3, min_hole_to_hole: 0.5, min_copper_edge_clearance: 0.3, min_text_height: 1 },
    netClass: { clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3 },
  },
  {
    label: "JLCPCB 4-layer (standard)",
    note: "Four copper layers, with JLCPCB's published 4–6 layer capabilities: 0.09 mm track and spacing, 0.2 mm via hole on multilayer boards. Writes their default stackup, JLC04161H-7628 (1.6 mm; 0.5 oz inner copper). New tracks and vias keep comfortable sizes. Check their current limits before ordering.",
    rules: { min_clearance: 0.09, min_track_width: 0.09, min_via_diameter: 0.45, min_via_annular_width: 0.125, min_through_hole_diameter: 0.2, min_hole_to_hole: 0.5, min_hole_clearance: 0.2, min_copper_edge_clearance: 0.3, min_text_height: 1 },
    netClass: { clearance: 0.15, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3 },
    copperLayers: 4,
    stackup: "JLC04161H-7628",
  },
];

function Field({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="prop">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = Number(text.trim().replace(",", "."));
          if (text.trim() !== "" && Number.isFinite(v) && v >= 0 && v !== value) onCommit(v);
          else setText(String(value));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
      <span className="muted small">mm</span>
    </label>
  );
}

/** A class's nets as KiCad patterns (comma-separated, * and ? wildcards), with how many board nets they take. */
function PatternsField({ value, nets, onCommit }: { value: string[]; nets: string[]; onCommit: (list: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => setText(value.join(", ")), [value.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = text.split(",").map((t) => t.trim()).filter(Boolean);
  const res = list.map((p) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"));
  const taken = nets.filter((n) => n && res.some((r) => r.test(n) || r.test(n.slice(n.lastIndexOf("/") + 1))));
  return (
    <label className="prop" title={`Net names or patterns, comma-separated (* and ? wildcards), as KiCad's net class assignments${taken.length ? `: ${taken.join(", ")}` : ""}`}>
      <span>Nets</span>
      <input
        type="text"
        value={text}
        placeholder="e.g. VIN, GND, +5V"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => list.join(",") !== value.join(",") && onCommit(list)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
      <span className="muted small">{taken.length} net{taken.length === 1 ? "" : "s"}</span>
    </label>
  );
}

export function BoardSetup({ project, onEdit, onClose }: { project: ProjectView; onEdit: (ops: EditOp[]) => void; onClose: () => void }) {
  const file = project.projectFile;
  const setup = project.boardSetup as unknown as Record<string, number>;
  const setRule = (key: string, v: number) => onEdit([{ op: "setProjectRules", file, rules: { [key]: v } }]);
  const apply = (p: Preset) =>
    onEdit([
      { op: "setProjectRules", file, rules: p.rules, netClass: { name: "Default", fields: p.netClass } },
      ...(p.copperLayers && project.boardFile && project.board?.copperLayers.length !== p.copperLayers ? [{ op: "setCopperLayers" as const, file: project.boardFile, count: p.copperLayers }] : []),
      ...(p.stackup && project.boardFile ? [{ op: "setStackup" as const, file: project.boardFile, name: p.stackup }] : []),
    ]);

  return (
    <div className="update-pcb board-setup" onPointerDown={(e) => e.stopPropagation()}>
      <div className="update-head">
        <strong>Board setup</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="update-body">
        <div className="setup-presets">
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => apply(p)} title={p.note}>
              {p.label}
            </button>
          ))}
        </div>
        <h4>Board</h4>
        <label className="prop" title="Copper layers: inner ones (In1.Cu …) sit between the outer two, as in KiCad's Board Setup. Fewer layers only once nothing is left on the ones that go.">
          <span>Copper layers</span>
          <select
            value={project.board?.copperLayers.length ?? 2}
            onChange={(e) => project.boardFile && onEdit([{ op: "setCopperLayers", file: project.boardFile, count: Number(e.target.value) }])}
          >
            {[2, 4, 6, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <h4>Design rules (the DRC's minimums)</h4>
        {RULE_FIELDS.map(([ours, key, label]) => (
          <Field key={key} label={label} value={setup[ours] ?? 0} onCommit={(v) => setRule(key, v)} />
        ))}
        <h4>Net classes (track and via sizes per net)</h4>
        {[...project.designRules.classes].sort((a, b) => (a.name === "Default" ? -1 : b.name === "Default" ? 1 : 0)).map((c) => {
          const value: Record<string, number | undefined> = { clearance: c.clearance, track_width: c.trackWidth, via_diameter: c.viaDiameter, via_drill: c.viaDrill, diff_pair_width: c.diffPairWidth, diff_pair_gap: c.diffPairGap };
          const patterns = project.designRules.patterns.filter((p) => p.netclass === c.name).map((p) => p.pattern);
          return (
            <div key={c.name} className="net-class">
              <div className="net-class-head">
                <strong>{c.name}</strong>
                {c.name === "Default" ? (
                  <span className="muted small">every net no other class takes</span>
                ) : (
                  <button className="link" title={`Delete the ${c.name} class: its nets go back to Default (or another class that matches)`} onClick={() => onEdit([{ op: "setProjectRules", file, removeClass: c.name }])}>
                    Remove
                  </button>
                )}
              </div>
              {CLASS_FIELDS.map(([key, label]) => (
                <Field key={key} label={label} value={value[key] ?? 0} onCommit={(v) => onEdit([{ op: "setProjectRules", file, netClass: { name: c.name, fields: { [key]: v } } }])} />
              ))}
              {PAIR_FIELDS.map(([key, label]) => (
                <Field key={key} label={label} value={value[key] ?? 0} onCommit={(v) => onEdit([{ op: "setProjectRules", file, netClass: { name: c.name, fields: { [key]: v } } }])} />
              ))}
              {(() => {
                const ms = project.board && outerMicrostrip(project.board);
                const w = c.diffPairWidth ?? 0.2;
                const g = c.diffPairGap ?? 0.25;
                if (!ms) return <p className="muted small">Pair impedance needs a stackup (Board setup's fab presets write one).</p>;
                const z = microstripZdiff(w, g, ms.h, ms.er, ms.t);
                const for90 = pairWidthFor(90, g, ms.h, ms.er, ms.t);
                return (
                  <p className="muted small" title={`Edge-coupled microstrip on F.Cu over ${ms.h} mm of dielectric (εr ${ms.er}): an estimate to within about 10%. For impedance control, order it and let the fab size the pair.`}>
                    Pair on F.Cu ≈ {z.toFixed(0)} Ω differential{" "}
                    {for90 !== undefined && Math.abs(z - 90) > 2 && (
                      <button className="link" title={`A pair width of ${for90} mm at this gap: USB's 90 Ω`} onClick={() => onEdit([{ op: "setProjectRules", file, netClass: { name: c.name, fields: { diff_pair_width: for90 } } }])}>
                        Size for 90 Ω (USB)
                      </button>
                    )}
                  </p>
                );
              })()}
              {(() => {
                const ct = project.board?.copperThickness ?? {};
                const outer = ct["F.Cu"] ?? 0.035;
                const innerCu = Object.entries(ct).find(([l]) => /^In\d/.test(l))?.[1] ?? 0.035;
                const hasInner = (project.board?.copperLayers.length ?? 2) > 2;
                return (
                  <p className="muted small" title="IPC-2221, as KiCad's calculator: the current that warms the track by 10 °C. Wider tracks or thicker copper carry more.">
                    {c.trackWidth} mm carries ≈ {trackCurrent(c.trackWidth, outer).toFixed(1)} A outside ({Math.round(outer * 1000)} µm copper)
                    {hasInner ? `, ${trackCurrent(c.trackWidth, innerCu, 10, true).toFixed(1)} A inside (${Math.round(innerCu * 1000)} µm)` : ""} at a 10 °C rise
                  </p>
                );
              })()}
              {c.name !== "Default" && (
                <PatternsField
                  value={patterns}
                  nets={project.board?.nets ?? []}
                  onCommit={(list) => onEdit([{ op: "setProjectRules", file, classPatterns: { name: c.name, patterns: list } }])}
                />
              )}
            </div>
          );
        })}
        <button
          className="link"
          onClick={() => {
            const name = window.prompt("Name of the new net class (e.g. Power)")?.trim();
            if (name && !project.designRules.classes.some((c) => c.name === name)) onEdit([{ op: "setProjectRules", file, netClass: { name, fields: {} } }]);
          }}
        >
          + Add net class
        </button>
        <p className="muted small">Saved in the project file (.kicad_pro), as KiCad's Board Setup saves them.</p>
      </div>
    </div>
  );
}

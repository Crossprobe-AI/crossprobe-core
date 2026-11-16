/**
 * Fabrication export: Gerbers, drill files, BOM and pick-and-place in one
 * zip, after a short pre-flight of what usually goes wrong on a first order
 * (no closed outline, unrouted nets, DRC/ERC errors, stale zone fills).
 */
import { useMemo, useState } from "react";
import { boardArea, fabricationFiles, ipc2581, odbFiles, projectFileName } from "@crossprobe/kicad-model";
import { downloadZip } from "../load";
import type { ProjectView } from "../render/types";
import { Icon } from "./icons";

type Check = { ok: boolean; warn?: boolean; text: string };

export function FabExport({ project, zonesStale, onRefill, onClose }: { project: ProjectView; zonesStale: boolean; onRefill: () => void; onClose: () => void }) {
  const [error, setError] = useState<string>();
  const [jlcpcb, setJlcpcb] = useState(() => {
    try {
      return localStorage.getItem("crossprobe.fab.jlcpcb") === "1";
    } catch {
      return false;
    }
  });
  const board = project.board!;
  /** Optional formats beside the Gerbers: IPC-2581 (and ODB++). */
  const [extra, setExtra] = useState<{ ipc2581: boolean; odb: boolean }>(() => {
    try {
      return { ipc2581: false, odb: false, ...JSON.parse(localStorage.getItem("crossprobe.fab.extra") ?? "{}") };
    } catch {
      return { ipc2581: false, odb: false };
    }
  });
  const setExtraKey = (k: "ipc2581" | "odb", v: boolean) => {
    const next = { ...extra, [k]: v };
    setExtra(next);
    try {
      localStorage.setItem("crossprobe.fab.extra", JSON.stringify(next));
    } catch {
      // a per-browser preference only
    }
  };
  const name = projectFileName(project.boardFile?.split("/").pop()?.replace(/\.kicad_pcb$/, "") ?? project.name);

  const checks = useMemo<Check[]>(() => {
    const closed = !!boardArea(board)?.length;
    const shorts = project.clearance.filter((v) => v.type === "short").length;
    const clearance = project.clearance.length - shorts;
    const ercErrors = project.erc.filter((v) => v.severity === "error").length;
    const noFootprint = project.components.filter((c) => c.onBoard && !c.footprint).length;
    return [
      { ok: closed, text: closed ? "Board outline is closed" : "No closed board outline on Edge.Cuts: draw one with the Outline tool" },
      { ok: !project.unconnected.length, text: project.unconnected.length ? `${project.unconnected.length} unrouted connection${project.unconnected.length > 1 ? "s" : ""}` : "Everything is routed" },
      (() => {
        const errors = project.boardChecks.filter((v) => v.severity === "error");
        const kinds = [...new Set(errors.map((v) => v.type.replace(/_/g, " ")))];
        return { ok: !errors.length, text: errors.length ? `${errors.length} DRC error${errors.length > 1 ? "s" : ""} (${kinds.join(", ")})` : "No hole, annular ring or courtyard errors" };
      })(),
      { ok: !shorts && !clearance, text: shorts || clearance ? `${shorts ? `${shorts} short${shorts > 1 ? "s" : ""}` : ""}${shorts && clearance ? ", " : ""}${clearance ? `${clearance} clearance violation${clearance > 1 ? "s" : ""}` : ""}` : "No copper clearance problems" },
      { ok: !zonesStale, warn: true, text: zonesStale ? "Zone fills are out of date" : "Zone fills are current" },
      { ok: !ercErrors, warn: true, text: ercErrors ? `${ercErrors} ERC error${ercErrors > 1 ? "s" : ""} in the schematic` : "Schematic passes ERC" },
      { ok: !noFootprint, warn: true, text: noFootprint ? `${noFootprint} part${noFootprint > 1 ? "s" : ""} without a footprint` : "Every part has a footprint" },
    ];
  }, [board, project, zonesStale]);

  const files = useMemo(() => {
    try {
      // The BOM's Datasheet column: the part's link, plus where its pinned evidence is (document, page).
      const datasheets: Record<string, string> = {};
      for (const c of project.components) {
        const pins = project.evidence.filter((e) => e.target.reference === c.reference);
        const link = c.datasheet && c.datasheet !== "~" ? c.datasheet : "";
        if (link || pins.length) datasheets[c.reference] = [link, ...pins.map((e) => `pinned: ${e.evidence.doc.title} p.${e.evidence.label ?? e.evidence.page}`)].filter(Boolean).join(" | ");
      }
      const dr = project.designRules;
      const rules = {
        ...dr,
        classes: new Map(dr.classes.map((c) => [c.name, c])),
        assignments: new Map(Object.entries(dr.assignments)),
      };
      const out: Record<string, string | Uint8Array> = fabricationFiles(board, { name, jlcpcb, datasheets, rules });
      if (extra.ipc2581) out[`${name}-IPC-2581.xml`] = ipc2581(board, name);
      if (extra.odb) for (const [p, t] of Object.entries(odbFiles(board))) out[`${name}-odb/${p}`] = t;
      return out;
    } catch (e) {
      setError((e as Error).message);
      return {};
    }
  }, [board, name, jlcpcb, project, extra]);
  const blocking = checks.some((c) => !c.ok && !c.warn);

  return (
    <div className="update-pcb fab-export" onPointerDown={(e) => e.stopPropagation()}>
      <div className="update-head">
        <strong>Fabrication outputs</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="update-body">
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.text} className={c.ok ? "ok" : c.warn ? "warn" : "bad"}>
              <span aria-hidden>{c.ok ? "✓" : c.warn ? "!" : "✕"}</span> {c.text}
              {!c.ok && c.text.startsWith("Zone fills") && (
                <button className="link" onClick={onRefill}>
                  Refill now
                </button>
              )}
            </li>
          ))}
        </ul>
        <label className="small fab-option">
          <input
            type="checkbox"
            checked={jlcpcb}
            onChange={(e) => {
              setJlcpcb(e.target.checked);
              try {
                localStorage.setItem("crossprobe.fab.jlcpcb", e.target.checked ? "1" : "0");
              } catch {
                // a per-browser preference only
              }
            }}
          />{" "}
          Add JLCPCB assembly files (BOM and CPL in their column format; LCSC part numbers from an "LCSC" field)
        </label>
        <label className="small fab-option">
          <input type="checkbox" checked={extra.ipc2581} onChange={(e) => setExtraKey("ipc2581", e.target.checked)} /> Add IPC-2581 (rev C): the whole board — layers, stackup, padstacks, parts, nets and features — in one file, as KiCad writes it
        </label>
        <label className="small fab-option">
          <input type="checkbox" checked={extra.odb} onChange={(e) => setExtraKey("odb", e.target.checked)} /> Add ODB++ (8.1): the job tree — layers, drills, components, nets — in an odb folder, as KiCad writes it
        </label>
        <details className="fab-list">
          <summary>
            <strong>{Object.keys(files).length} files</strong> in the zip
          </summary>
          <ul className="mono small fab-files">
            {Object.keys(files).map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
        <p className="muted small">Gerber X2 per layer, Excellon drill files (plated, non-plated and one per blind/buried via span), a BOM, a pick-and-place file and the IPC-D-356 test netlist, named as KiCad names them.</p>
      </div>
      {error && <p className="error small">{error}</p>}
      <div className="update-actions">
        <button onClick={onClose}>Close</button>
        <button
          className="primary"
          disabled={!Object.keys(files).length}
          title={blocking ? "Problems remain: the files may not be what you want to order" : undefined}
          onClick={() => downloadZip(`${name}-fab`, files)}
        >
          <Icon name="download" /> {blocking ? "Download anyway" : "Download zip"}
        </button>
      </div>
    </div>
  );
}

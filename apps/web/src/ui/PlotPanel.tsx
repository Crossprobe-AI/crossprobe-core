/**
 * Plot: the schematic's sheets or the board's layers as SVG files or one PDF (KiCad's Plot
 * dialogs). Board layer plots are the same plot as the Gerbers, checked against kicad-cli's SVG.
 */
import { useState } from "react";
import { projectFileName } from "@crossprobe/kicad-model";
import type { ProjectView } from "../render/types";
import { boardSvgs, printPages, sheetSvg } from "../plot/plot";
import { downloadFile, downloadZip } from "../load";
import { Icon } from "./icons";

function remembered<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`crossprobe.plot.${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function remember(key: string, v: unknown) {
  try {
    localStorage.setItem(`crossprobe.plot.${key}`, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

const DEFAULT_LAYERS = ["F.Cu", "B.Cu", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Edge.Cuts"];

export function PlotPanel({ project, initial, onClose }: { project: ProjectView; initial: "schematic" | "board"; onClose: () => void }) {
  const board = project.board;
  const [what, setWhat] = useState<"schematic" | "board">(board ? initial : "schematic");
  const [bw, setBw] = useState(() => remembered("bw", false));
  const [noFrame, setNoFrame] = useState(() => remembered("noFrame", false));
  const [mirror, setMirror] = useState(() => remembered("mirror", true));
  const [withEdge, setWithEdge] = useState(() => remembered("withEdge", true));
  const [together, setTogether] = useState(() => remembered("together", false));
  const allLayers = board ? board.layers.map((l) => l.name).filter((l) => !l.startsWith("User.") || board.layers.find((x) => x.name === l)?.userName) : [];
  const [layers, setLayers] = useState<string[]>(() => remembered("layers", DEFAULT_LAYERS).filter((l) => allLayers.includes(l)));
  const [note, setNote] = useState<string>();
  const name = projectFileName(project.name);

  const set = <T,>(key: string, f: (v: T) => void) => (v: T) => {
    remember(key, v);
    f(v);
  };
  const pages = (): Array<{ name: string; svg: string }> => {
    if (what === "schematic") {
      return project.sheets.map((s, i) => ({ name: `${String(i + 1).padStart(2, "0")}-${(s.namePath || s.name || "root").replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9_.-]+/g, "_") || "root"}`, svg: sheetSvg(s, { blackAndWhite: bw, noFrame }) }));
    }
    const ordered = allLayers.filter((l) => layers.includes(l));
    return boardSvgs(board!, ordered, { blackAndWhite: bw, mirrorBottom: mirror, withEdge, together });
  };
  const svg = () => {
    const ps = pages();
    if (!ps.length) return setNote("Nothing to plot.");
    if (ps.length === 1) downloadFile(`${name}-${ps[0]!.name}.svg`, ps[0]!.svg);
    else downloadZip(`${name}-${what}-svg`, Object.fromEntries(ps.map((p) => [`${name}-${p.name}.svg`, p.svg])));
    setNote(`${ps.length} SVG file${ps.length > 1 ? "s" : ""}.`);
  };
  const pdf = () => {
    const ps = pages();
    if (!ps.length) return setNote("Nothing to plot.");
    setNote(printPages(`${name} ${what}`, ps.map((p) => p.svg)) ? `${ps.length} page${ps.length > 1 ? "s" : ""}: choose "Save as PDF" in the print dialog.` : "The browser blocked the print window: allow pop-ups for this site.");
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
    <div className="modal plot-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="update-head">
        <strong>Plot</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="segmented small">
        <button className={what === "schematic" ? "on" : ""} onClick={() => setWhat("schematic")}>
          Schematic
        </button>
        <button className={what === "board" ? "on" : ""} onClick={() => setWhat("board")} disabled={!board}>
          Board
        </button>
      </div>
      {what === "schematic" ? (
        <div className="plot-opts">
          <p className="muted small">{project.sheets.length} sheet{project.sheets.length > 1 ? "s" : ""}, each at its paper size.</p>
          <label>
            <input type="checkbox" checked={noFrame} onChange={(e) => set("noFrame", setNoFrame)(e.target.checked)} /> Leave out the frame and title block
          </label>
        </div>
      ) : (
        <div className="plot-opts">
          <div className="plot-layers">
            {allLayers.map((l) => (
              <label key={l} data-layer={l} title={board!.layers.find((x) => x.name === l)?.userName}>
                <input type="checkbox" checked={layers.includes(l)} onChange={(e) => set("layers", setLayers)(e.target.checked ? [...layers, l] : layers.filter((x) => x !== l))} /> {l}
              </label>
            ))}
          </div>
          <label>
            <input type="checkbox" checked={withEdge} onChange={(e) => set("withEdge", setWithEdge)(e.target.checked)} /> Board outline on every layer
          </label>
          <label>
            <input type="checkbox" checked={mirror} onChange={(e) => set("mirror", setMirror)(e.target.checked)} /> Mirror bottom layers (seen from below)
          </label>
          <label>
            <input type="checkbox" checked={together} onChange={(e) => set("together", setTogether)(e.target.checked)} /> All layers on one page
          </label>
        </div>
      )}
      <label className="plot-bw">
        <input type="checkbox" checked={bw} onChange={(e) => set("bw", setBw)(e.target.checked)} /> Black and white
      </label>
      <div className="update-actions">
        <button onClick={onClose}>Close</button>
        <button className="primary" onClick={pdf} title="One PDF, a page per sheet or layer (through the print dialog)">
          <Icon name="doc" /> PDF
        </button>
        <button onClick={svg} title="An SVG file per sheet or layer (a zip when there are several)">
          <Icon name="download" /> SVG
        </button>
      </div>
      {note && <p className="muted small">{note}</p>}
    </div>
    </div>
  );
}

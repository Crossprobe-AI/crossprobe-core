import type { Board } from "@crossprobe/kicad-model";
import { layerColor } from "../render/board";
import { Icon } from "./icons";
import type { SheetView } from "../render/types";
import { SHEET_COLOR } from "../render/board";

export function SheetTree({ sheets, current, onOpen }: { sheets: SheetView[]; current: string; onOpen: (path: string) => void }) {
  const byPath = new Map(sheets.map((s) => [s.path, s]));
  const root = sheets[0];
  if (!root) return null;
  const node = (s: SheetView, depth: number): React.ReactNode => (
    <li key={s.path}>
      <button className={`tree-item${s.path === current ? " on" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onOpen(s.path)}>
        <Icon name="sheet" size={14} className="sheet-icon" />
        {s.name}
        {depth > 0 && <span className="muted small"> {s.file}</span>}
      </button>
      {s.children.length > 0 && <ul>{s.children.map((c) => byPath.get(c)).filter(Boolean).map((c) => node(c!, depth + 1))}</ul>}
    </li>
  );
  return (
    <div className="side-section">
      <h4>Sheets</h4>
      <ul className="tree">{node(root, 0)}</ul>
    </div>
  );
}

/** What KiCad's selection filter can switch off. */
export const SELECTABLE: Array<[string, string]> = [
  ["footprint", "Footprints"],
  ["pad", "Pads"],
  ["track", "Tracks"],
  ["via", "Vias"],
  ["zone", "Zones"],
  ["graphic", "Graphics"],
  ["text", "Text"],
];

export function LayerList({
  board,
  visible,
  onToggle,
  flipped,
  onFlip,
  selectable,
  onSelectable,
  onStats,
}: {
  board: Board;
  /** Open the board statistics. */
  onStats?: () => void;
  visible: Set<string>;
  onToggle: (layer: string) => void;
  flipped: boolean;
  onFlip: (v: boolean) => void;
  /** While editing: KiCad's selection filter (what clicks and boxes may pick). */
  selectable?: Set<string>;
  onSelectable?: (kind: string) => void;
}) {
  const copper = board.copperLayers;
  const technical = ["F.SilkS", "B.SilkS", "F.Fab", "B.Fab", "F.CrtYd", "B.CrtYd", "Edge.Cuts", "Dwgs.User", "Cmts.User"];
  const row = (name: string, color: string, label = name) => (
    <label key={name} className="layer">
      <input type="checkbox" checked={visible.has(name)} onChange={() => onToggle(name)} />
      <span className="swatch" style={{ background: color }} />
      {label}
    </label>
  );
  return (
    <div className="side-section">
      <h4>View</h4>
      <label className="layer">
        <input type="checkbox" checked={flipped} onChange={(e) => onFlip(e.target.checked)} />
        <Icon name="flip" size={14} /> View from bottom
      </label>
      <h4><Icon name="layers" size={13} /> Copper</h4>
      {copper.map((l) => row(l, layerColor(l, copper)))}
      {row("Vias", "#b9b9b9")}
      {row("Ratsnest", "#e8e8e8", "Ratsnest (unrouted)")}
      {row("Drawing Sheet", SHEET_COLOR, "Drawing sheet")}
      <h4>Technical</h4>
      {technical.map((l) => row(l, layerColor(l, copper)))}
      {selectable && onSelectable && (
        <>
          <h4>Selection filter</h4>
          <div className="selection-filter">
            {SELECTABLE.map(([kind, label]) => (
              <label key={kind} className="layer">
                <input type="checkbox" checked={selectable.has(kind)} onChange={() => onSelectable(kind)} /> {label}
              </label>
            ))}
          </div>
        </>
      )}
      <div className="side-section stats">
        <h4>Board</h4>
        <p className="muted small">
          {board.footprints.length} footprints · {board.tracks.length} tracks · {board.vias.length} vias · {board.zones.length} zones
          {board.thickness ? ` · ${board.thickness} mm` : ""}
        </p>
        {onStats && (
          <button className="link small" onClick={onStats}>
            Statistics…
          </button>
        )}
      </div>
    </div>
  );
}

/** Shown at first, as in KiCad: copper, silkscreen, fabrication and courtyards, the outline and drawings. */
export const DEFAULT_LAYERS = (board: Board) => new Set([...board.copperLayers, "Vias", "Ratsnest", "F.SilkS", "B.SilkS", "F.Fab", "B.Fab", "F.CrtYd", "B.CrtYd", "Edge.Cuts", "Dwgs.User", "Cmts.User", "Drawing Sheet"]);

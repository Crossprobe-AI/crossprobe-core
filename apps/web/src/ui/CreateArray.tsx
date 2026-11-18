/**
 * Create Array (KiCad's dialog, Ctrl+T): copies of the selection in a grid or
 * around a circle, or the selection itself laid out that way. The layout and
 * the reference numbering follow KiCad's (createBoardArray).
 */
import { useState } from "react";
import { arraySize, type ArrayOptions } from "@crossprobe/kicad-model";
import type { EditOp } from "../edit/ops";
import { Icon } from "./icons";

type Point = { x: number; y: number };

function Num({ label, value, onChange, step = 0.01, min, title }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; title?: string }) {
  return (
    <label title={title}>
      {label}{" "}
      <input type="number" step={step} min={min} value={value} onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))} />
    </label>
  );
}

export function CreateArray({ file, uuids, arrangeable = uuids, origin, onEdit, onClose }: { file: string; uuids: string[]; /** What "Arrange" may move: not locked, not in a group. */ arrangeable?: string[]; origin: Point; onEdit: (ops: EditOp[]) => void; onClose: () => void }) {
  const [kind, setKind] = useState<"grid" | "circular">("grid");
  // KiCad's defaults: a 5 × 5 grid at 2.54 mm; four copies 90° apart, clockwise.
  const [grid, setGrid] = useState({ nx: 5, ny: 5, dx: 2.54, dy: 2.54, offsetX: 0, offsetY: 0, stagger: 1, staggerRows: true, horizontalFirst: true, reverseAlternate: false, centred: false });
  const [circ, setCirc] = useState({ count: 4, cx: Math.round((origin.x + 10) * 100) / 100, cy: Math.round(origin.y * 100) / 100, angle: 90, full: false, offset: 0, clockwise: true, rotateItems: false });
  const [arrange, setArrange] = useState(false);
  const [reannotate, setReannotate] = useState(true);
  const options: ArrayOptions =
    kind === "grid"
      ? { kind: "grid", ...grid }
      : { kind: "circular", count: circ.count, center: { x: circ.cx, y: circ.cy }, angle: circ.full ? 0 : circ.angle, offset: circ.offset, clockwise: circ.clockwise, rotateItems: circ.rotateItems };
  const size = arraySize(options);
  const valid = size >= 1 && Number.isInteger(size) && (kind === "circular" || (grid.nx >= 1 && grid.ny >= 1));
  const apply = () => {
    const items = arrange ? arrangeable : uuids;
    if (valid && items.length) onEdit([{ op: "boardArray", file, uuids: items, options, reannotate, arrange }]);
    onClose();
  };
  return (
    <div className="update-pcb create-array" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => (e.stopPropagation(), e.key === "Escape" && onClose())}>
      <div className="update-head">
        <strong>Create array</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="update-body">
        <div className="segmented">
          <button className={kind === "grid" ? "on" : ""} onClick={() => setKind("grid")}>Grid</button>
          <button className={kind === "circular" ? "on" : ""} onClick={() => setKind("circular")}>Circular</button>
        </div>
        {kind === "grid" ? (
          <div className="plot-opts array-fields">
            <Num label="Columns" step={1} min={1} value={grid.nx} onChange={(nx) => setGrid({ ...grid, nx })} />
            <Num label="Rows" step={1} min={1} value={grid.ny} onChange={(ny) => setGrid({ ...grid, ny })} />
            <Num label="Column spacing (mm)" value={grid.dx} onChange={(dx) => setGrid({ ...grid, dx })} />
            <Num label="Row spacing (mm)" value={grid.dy} onChange={(dy) => setGrid({ ...grid, dy })} />
            <Num label="Row offset (mm)" title="Each row shifts this far along x" value={grid.offsetX} onChange={(offsetX) => setGrid({ ...grid, offsetX })} />
            <Num label="Column offset (mm)" title="Each column shifts this far along y" value={grid.offsetY} onChange={(offsetY) => setGrid({ ...grid, offsetY })} />
            <Num label="Stagger" step={1} title="Shift every n rows (or columns) by a fraction of the spacing; 1 for none" value={grid.stagger} onChange={(stagger) => setGrid({ ...grid, stagger })} />
            <label>
              <input type="checkbox" checked={!grid.staggerRows} onChange={(e) => setGrid({ ...grid, staggerRows: !e.target.checked })} /> Stagger columns instead of rows
            </label>
            <label>
              <input type="checkbox" checked={!grid.horizontalFirst} onChange={(e) => setGrid({ ...grid, horizontalFirst: !e.target.checked })} /> Fill columns first
            </label>
            <label>
              <input type="checkbox" checked={grid.reverseAlternate} onChange={(e) => setGrid({ ...grid, reverseAlternate: e.target.checked })} /> Reverse every other row
            </label>
            <label title="Otherwise the selection is the first cell">
              <input type="checkbox" checked={grid.centred} onChange={(e) => setGrid({ ...grid, centred: e.target.checked })} /> Centre on the selection
            </label>
          </div>
        ) : (
          <div className="plot-opts array-fields">
            <Num label="Count" step={1} min={1} value={circ.count} onChange={(count) => setCirc({ ...circ, count })} />
            <Num label="Centre X (mm)" value={circ.cx} onChange={(cx) => setCirc({ ...circ, cx })} />
            <Num label="Centre Y (mm)" value={circ.cy} onChange={(cy) => setCirc({ ...circ, cy })} />
            <label>
              <input type="checkbox" checked={circ.full} onChange={(e) => setCirc({ ...circ, full: e.target.checked })} /> Spread over the full circle
            </label>
            {!circ.full && <Num label="Angle between (°)" step={1} value={circ.angle} onChange={(angle) => setCirc({ ...circ, angle })} />}
            <Num label="First at (°)" step={1} value={circ.offset} onChange={(offset) => setCirc({ ...circ, offset })} />
            <label>
              <input type="checkbox" checked={circ.clockwise} onChange={(e) => setCirc({ ...circ, clockwise: e.target.checked })} /> Clockwise
            </label>
            <label>
              <input type="checkbox" checked={circ.rotateItems} onChange={(e) => setCirc({ ...circ, rotateItems: e.target.checked })} /> Rotate the items
            </label>
          </div>
        )}
        <div className="plot-opts">
          <label>
            <input type="radio" checked={!arrange} onChange={() => setArrange(false)} /> Duplicate the selection
          </label>
          <label>
            <input type="radio" checked={arrange} disabled={!arrangeable.length} onChange={() => setArrange(true)} /> Arrange the selection itself
          </label>
          {!arrange && (
            <label title="Otherwise the copies keep the references of what they copy">
              <input type="checkbox" checked={reannotate} onChange={(e) => setReannotate(e.target.checked)} /> Give copied footprints new references
            </label>
          )}
        </div>
        <p className="muted small">
          {arrange
            ? `Up to ${size} of the ${arrangeable.length} selected item${arrangeable.length === 1 ? "" : "s"}, one per cell.${arrangeable.length < uuids.length ? " Locked and grouped items stay where they are." : ""}`
            : `${size} cells: ${Math.max(0, size - 1)} copies of the ${uuids.length} selected item${uuids.length > 1 ? "s" : ""}.`}
        </p>
      </div>
      <div className="update-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!valid} onClick={apply}>
          Create
        </button>
      </div>
    </div>
  );
}

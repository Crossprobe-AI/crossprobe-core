/**
 * Position Relative To (KiCad's dialog, Shift+P): the selection moves so its
 * top-left footprint (else top-left item) sits at a reference plus an offset.
 * The reference is an item or a point picked on the board, or the grid origin;
 * the offset is x/y or a radius and an angle. The move is positionRelativeMoves.
 */
import { useState } from "react";
import { positionRelativeMoves, type Board } from "@crossprobe/kicad-model";
import type { EditOp } from "../edit/ops";
import { Icon } from "./icons";

type Point = { x: number; y: number };
export type RelativeReference = { kind: "item" | "point" | "grid"; at: Point; label: string };

export function PositionRelative({
  board,
  file,
  items,
  extras,
  reference,
  picking,
  onPick,
  onReference,
  onEdit,
  onClose,
}: {
  board: Board;
  file: string;
  items: Array<{ uuid: string; locked?: boolean }>;
  /** Members of the selection's groups the app doesn't model: moved by the same amount. */
  extras?: string[];
  reference?: RelativeReference;
  /** What the next click on the board will pick, if anything. */
  picking?: "item" | "point";
  onPick: (what: "item" | "point") => void;
  onReference: (r: RelativeReference) => void;
  onEdit: (ops: EditOp[]) => void;
  onClose: () => void;
}) {
  const [polar, setPolar] = useState(false);
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  const grid = board.setup.gridOrigin ?? { x: 0, y: 0 };
  const apply = () => {
    if (!reference) return;
    const moves = positionRelativeMoves(board, items, reference.at, { x: a, y: b }, polar);
    // A group's members the app doesn't model go with it.
    if (moves.length) for (const u of extras ?? []) moves.push({ uuid: u, dx: moves[0]!.dx, dy: moves[0]!.dy });
    if (moves.length) onEdit([{ op: "boardArrange", file, label: "Position Relative", moves }]);
    onClose();
  };
  const togglePolar = (p: boolean) => {
    // Keep the same offset in the other form, as KiCad's dialog does.
    if (p && !polar) {
      const r = Math.hypot(a, b);
      setA(Math.round(r * 1e4) / 1e4);
      setB(r ? Math.round(((Math.atan2(b, a) * 180) / Math.PI) * 1e3) / 1e3 : 0);
    } else if (!p && polar) {
      setA(Math.round(a * Math.cos((b * Math.PI) / 180) * 1e4) / 1e4);
      setB(Math.round(a * Math.sin((b * Math.PI) / 180) * 1e4) / 1e4);
    }
    setPolar(p);
  };
  const locked = items.filter((i) => i.locked).length;
  return (
    <div className="update-pcb position-relative" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => (e.stopPropagation(), e.key === "Escape" && onClose())}>
      <div className="update-head">
        <strong>Position relative to</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="update-body">
        <p className="small">{picking ? (picking === "item" ? "Click an item on the board…" : "Click a point on the board…") : reference ? `Reference: ${reference.label} (${reference.at.x.toFixed(4)}, ${reference.at.y.toFixed(4)})` : "Choose a reference."}</p>
        <div className="row-buttons">
          <button className={picking === "item" ? "on" : ""} onClick={() => onPick("item")}>Select item…</button>
          <button className={picking === "point" ? "on" : ""} onClick={() => onPick("point")}>Select point…</button>
          <button onClick={() => onReference({ kind: "grid", at: grid, label: "grid origin" })}>Grid origin</button>
        </div>
        <div className="plot-opts array-fields">
          <label>
            <input type="checkbox" checked={polar} onChange={(e) => togglePolar(e.target.checked)} /> Polar coordinates
          </label>
          <label>
            {polar ? "Distance (mm)" : "Offset X (mm)"} <input type="number" step={0.01} value={a} onChange={(e) => e.target.value !== "" && setA(Number(e.target.value))} />
          </label>
          <label>
            {polar ? "Angle (°)" : "Offset Y (mm)"} <input type="number" step={polar ? 1 : 0.01} value={b} onChange={(e) => e.target.value !== "" && setB(Number(e.target.value))} />
          </label>
        </div>
        <p className="muted small">
          The top-left footprint of the selection goes to the reference plus this offset; the rest follows.
          {locked ? ` ${locked} locked item${locked > 1 ? "s" : ""} stay${locked > 1 ? "" : "s"} put.` : ""}
        </p>
      </div>
      <div className="update-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!reference || !!picking} onClick={apply}>
          Move
        </button>
      </div>
    </div>
  );
}

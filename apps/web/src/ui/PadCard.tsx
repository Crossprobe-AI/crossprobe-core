/**
 * A picked pad in the inspector (KiCad's pad properties, read-only): its
 * number, net (a link to the net), pin, shape, size, drill and layers. Also
 * the board-only parts (mounting holes, logos) that aren't in the schematic.
 */
import { useEffect, useState } from "react";
import { displayName, type Footprint } from "@crossprobe/kicad-model";
import type { EditOp } from "../edit/ops";
import type { Selection } from "./selection";

/** A number that commits on Enter or blur. */
function Num({ value, onCommit, title }: { value: number; onCommit: (v: number) => void; title: string }) {
  const [text, setText] = useState(String(Number(value.toFixed(4))));
  useEffect(() => setText(String(Number(value.toFixed(4)))), [value]);
  const commit = () => {
    const v = Number(text);
    if (text.trim() && Number.isFinite(v) && v > 0 && Math.abs(v - value) > 1e-9) onCommit(v);
    else setText(String(Number(value.toFixed(4))));
  };
  return (
    <input
      className="pad-num"
      type="number"
      step={0.01}
      min={0}
      title={title}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        e.stopPropagation();
      }}
    />
  );
}

const SHAPES = ["circle", "rect", "oval", "roundrect", "trapezoid"];

const mm = (v: number) => `${Number(v.toFixed(3))}`;

export function PadCard({
  footprint,
  pad,
  onSelect,
  edit,
}: {
  footprint: Footprint;
  pad: string;
  onSelect?: (s: Selection) => void;
  /** While editing: change the pad (size, shape, drill, net), and the board's nets to choose from. */
  edit?: { file: string; nets: string[]; onEdit: (ops: EditOp[]) => void };
}) {
  const pads = footprint.pads.filter((p) => p.number === pad);
  const p = pads[0];
  if (!p) return null;
  const set = (props: Omit<Extract<EditOp, { op: "setPadProps" }>, "op" | "file" | "footprint" | "pad">) =>
    edit?.onEdit([{ op: "setPadProps", file: edit.file, footprint: footprint.uuid, pad: p.number, ...props }]);
  return (
    <section className="detail pad-card">
      <header>
        <span className="kind">Pad</span>
        <h2>
          {p.number || "(unnumbered)"} <span className="muted small">of</span>{" "}
          {onSelect ? (
            <button className="link" onClick={() => onSelect({ kind: "component", reference: footprint.reference })}>
              {footprint.reference}
            </button>
          ) : (
            footprint.reference
          )}
        </h2>
      </header>
      <dl className="compact">
        <dt>Net</dt>
        <dd>
          {edit ? (
            <select value={p.net} onChange={(e) => set({ net: e.target.value })} title="The pad's net">
              <option value="">(no net)</option>
              {edit.nets.map((n) => (
                <option key={n} value={n}>
                  {displayName(n)}
                </option>
              ))}
            </select>
          ) : !p.net ? (
            <span className="muted">none</span>
          ) : onSelect ? (
            <button className="link mono" onClick={() => onSelect({ kind: "net", name: p.net })}>
              {displayName(p.net)}
            </button>
          ) : (
            <span className="mono">{displayName(p.net)}</span>
          )}
        </dd>
        {(p.pinFunction || p.pinType) && (
          <>
            <dt>Pin</dt>
            <dd>
              {p.pinFunction ?? ""} {p.pinType && <span className="muted small">{p.pinType}</span>}
            </dd>
          </>
        )}
        <dt>Type</dt>
        <dd>
          {p.type.replace(/_/g, " ")},{" "}
          {edit && p.shape !== "custom" ? (
            <select value={p.shape} onChange={(e) => set({ shape: e.target.value })} title="Pad shape">
              {SHAPES.map((sh) => (
                <option key={sh}>{sh}</option>
              ))}
            </select>
          ) : (
            p.shape
          )}
          {pads.length > 1 && <span className="muted small"> · {pads.length} pads share this number</span>}
        </dd>
        <dt>Size</dt>
        <dd className="mono">
          {edit ? (
            <>
              <Num value={p.size.x} title="Width (mm)" onCommit={(x) => set({ size: { x, y: p.size.y } })} /> ×{" "}
              <Num value={p.size.y} title="Height (mm)" onCommit={(y) => set({ size: { x: p.size.x, y } })} /> mm
            </>
          ) : (
            <>
              {mm(p.size.x)} × {mm(p.size.y)} mm
            </>
          )}
          {p.rotation ? ` · ${mm(p.rotation)}°` : ""}
        </dd>
        {p.drill ? (
          <>
            <dt>Drill</dt>
            <dd className="mono">
              {edit && !p.drillSize ? <Num value={p.drill} title="Drill (mm)" onCommit={(d) => set({ drill: d })} /> : p.drillSize ? `${mm(p.drillSize.x)} × ${mm(p.drillSize.y)}` : mm(p.drill)} mm
            </dd>
          </>
        ) : null}
        <dt>Layers</dt>
        <dd className="mono small">{p.layers.join(" ")}</dd>
        <dt>At</dt>
        <dd className="mono">
          {mm(p.at.x)}, {mm(p.at.y)}
        </dd>
      </dl>
    </section>
  );
}

/** A footprint that's only on the board (no schematic part): what it is and where. */
export function BoardFootprintCard({ footprint, onEditFootprint }: { footprint: Footprint; onEditFootprint?: (libId: string) => void }) {
  return (
    <section className="detail">
      <header>
        <span className="kind">Board item</span>
        <h2>{footprint.reference}</h2>
        <span className="muted">{footprint.value}</span>
      </header>
      <dl className="compact">
        <dt>Footprint</dt>
        <dd className="mono one-line" title={footprint.libId}>
          {footprint.libId}
          {onEditFootprint && (
            <>
              {" "}
              <button className="link" onClick={() => onEditFootprint(footprint.libId)}>
                Edit footprint
              </button>
            </>
          )}
        </dd>
        <dt>Side</dt>
        <dd>{footprint.layer === "B.Cu" ? "Back" : "Front"}</dd>
        <dt>At</dt>
        <dd className="mono">
          {mm(footprint.at.x)}, {mm(footprint.at.y)}
          {footprint.rotation ? ` · ${mm(footprint.rotation)}°` : ""}
        </dd>
        <dt>Pads</dt>
        <dd>{footprint.pads.length}</dd>
      </dl>
    </section>
  );
}

/**
 * Properties of the board items selected in edit mode: track width and
 * layer, via size and drill, a footprint's position, rotation and side.
 * Each change is one undoable edit.
 */
import { useEffect, useState } from "react";
import { diffPartnerOnBoard, displayName, netLength, type Board } from "@crossprobe/kicad-model";
import type { EditOp } from "../edit/ops";
import type { BoardItem } from "../render/board-edit";

/** A number field that commits on Enter or blur. */
function NumField({ label, value, onCommit, step = 0.01, unit = "mm" }: { label: string; value: number | undefined; onCommit: (v: number) => void; step?: number; unit?: string }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  const commit = () => {
    const v = Number(text);
    if (text.trim() !== "" && Number.isFinite(v) && v !== value) onCommit(v);
    else setText(value === undefined ? "" : String(value));
  };
  return (
    <label className="prop">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={text}
        placeholder={value === undefined ? "mixed" : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(value === undefined ? "" : String(value));
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
      />
      <span className="muted small">{unit}</span>
    </label>
  );
}

/** A text field that commits on Enter or blur. */
function TextField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(value);
        e.stopPropagation();
      }}
    />
  );
}

/**
 * The net's routed length (as KiCad measures it) and lengthening it with
 * meanders to a target; for a differential pair, the skew to the partner
 * and matching the shorter one to the longer.
 */
/** The last length asked of each net, to say when meanders couldn't reach it. */
const lastTargets = new Map<string, number>();

function LengthTuning({ board, net, prefer, file, onEdit }: { board: Board; net: string; prefer?: string; file: string; onEdit: (ops: EditOp[]) => void }) {
  const length = netLength(board, net);
  const partner = diffPartnerOnBoard(board, net);
  const other = partner ? netLength(board, partner) : undefined;
  const target = lastTargets.get(net);
  // After a tune: did it get there? (Meanders need room beside a straight track.)
  const short = target !== undefined && length < target - 0.01;
  const tune = (n: string, t: number) => {
    lastTargets.set(n, t);
    onEdit([{ op: "tuneLength", file, net: n, target: Math.round(t * 1000) / 1000, prefer: n === net ? prefer : undefined }]);
  };
  return (
    <div className="length-tuning">
      <p className="muted small">Net length {length.toFixed(3)} mm</p>
      <NumField label="Tune to" value={target ?? Math.round(length * 100) / 100} onCommit={(t) => t > length + 1e-3 && tune(net, t)} />
      {short && <p className="warn small">Reached {length.toFixed(2)} of {target!.toFixed(2)} mm: no room beside the net's straight tracks for more meanders.</p>}
      {partner && other !== undefined && (
        <p className="small">
          Pair skew {(length - other).toFixed(3)} mm <span className="muted">({partner} {other.toFixed(3)} mm)</span>{" "}
          {Math.abs(length - other) > 0.005 && (
            <button className="link" title="Lengthen the shorter net of the pair to the longer one's length" onClick={() => (length < other ? tune(net, other) : tune(partner, length))}>
              Match pair
            </button>
          )}
        </p>
      )}
    </div>
  );
}

const common = <T,>(xs: T[]): T | undefined => (xs.length && xs.every((x) => x === xs[0]) ? xs[0] : undefined);

export function BoardProps({ board, picked, file, onEdit }: { board: Board; picked: BoardItem[]; file: string; onEdit: (ops: EditOp[]) => void }) {
  const ids = new Set(picked.map((p) => p.uuid));
  const tracks = board.tracks.filter((t) => ids.has(t.uuid));
  const vias = board.vias.filter((v) => ids.has(v.uuid));
  const fps = board.footprints.filter((f) => ids.has(f.uuid));
  const zones = board.zones.filter((z) => ids.has(z.uuid));
  const shapes = board.drawings.filter((g) => g.uuid && ids.has(g.uuid));
  const texts = board.texts.filter((t) => t.uuid && ids.has(t.uuid));
  if (!tracks.length && !vias.length && !fps.length && !zones.length && !shapes.length && !texts.length) return null;
  const textIds = texts.map((t) => t.uuid!);
  const zoneIds = zones.map((z) => z.uuid);
  const rect = shapes.length === 1 && shapes[0]!.kind === "rect" ? shapes[0]! : undefined;
  const nets = [...board.nets].filter((n) => n).sort((a, b) => a.localeCompare(b));
  const trackIds = tracks.map((t) => t.uuid);
  const viaIds = vias.map((v) => v.uuid);
  const fp = fps.length === 1 ? fps[0]! : undefined;

  return (
    <div className="board-props" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      {tracks.length > 0 && (
        <section>
          <h4>
            {tracks.length === 1 ? "Track" : `${tracks.length} tracks`}
            <span className="muted small"> {displayName(common(tracks.map((t) => t.net)) ?? "mixed nets")}</span>
          </h4>
          <NumField label="Width" value={common(tracks.map((t) => t.width))} onCommit={(width) => width > 0 && onEdit([{ op: "setTrackProps", file, uuids: trackIds, width }])} />
          <label className="prop">
            <span>Layer</span>
            <select value={common(tracks.map((t) => t.layer)) ?? ""} onChange={(e) => onEdit([{ op: "setTrackProps", file, uuids: trackIds, layer: e.target.value }])}>
              {common(tracks.map((t) => t.layer)) === undefined && <option value="">mixed</option>}
              {board.copperLayers.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          <p className="muted small">
            Length {tracks.reduce((n, t) => n + Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y), 0).toFixed(2)} mm
          </p>
          {common(tracks.map((t) => t.net)) && <LengthTuning board={board} net={tracks[0]!.net} prefer={trackIds[0]} file={file} onEdit={onEdit} />}
        </section>
      )}
      {vias.length > 0 && (
        <section>
          <h4>
            {vias.length === 1 ? "Via" : `${vias.length} vias`}
            <span className="muted small"> {displayName(common(vias.map((v) => v.net)) ?? "mixed nets")}</span>
          </h4>
          <NumField label="Diameter" value={common(vias.map((v) => v.size))} onCommit={(size) => size > 0 && onEdit([{ op: "setViaProps", file, uuids: viaIds, size }])} />
          <NumField label="Drill" value={common(vias.map((v) => v.drill))} onCommit={(drill) => drill > 0 && onEdit([{ op: "setViaProps", file, uuids: viaIds, drill }])} />
        </section>
      )}
      {fp && (
        <section>
          <h4>
            {fp.reference} <span className="muted small">{fp.value}</span>
          </h4>
          <p className="muted small mono">{fp.libId}</p>
          <NumField label="X" value={fp.at.x} onCommit={(x) => onEdit([{ op: "boardMove", file, uuids: [fp.uuid], dx: x - fp.at.x, dy: 0 }])} />
          <NumField label="Y" value={fp.at.y} onCommit={(y) => onEdit([{ op: "boardMove", file, uuids: [fp.uuid], dx: 0, dy: y - fp.at.y }])} />
          <NumField
            label="Rotation"
            unit="°"
            step={1}
            value={fp.rotation}
            onCommit={(r) => onEdit([{ op: "boardRotate", file, uuids: [fp.uuid], deg: r - fp.rotation }])}
          />
          <label className="prop">
            <span>Side</span>
            <select value={fp.layer} onChange={(e) => e.target.value !== fp.layer && onEdit([{ op: "boardFlip", file, uuids: [fp.uuid] }])}>
              <option value="F.Cu">Top</option>
              <option value="B.Cu">Bottom</option>
            </select>
          </label>
        </section>
      )}
      {zones.length > 0 && (
        <section>
          <h4>{zones.length === 1 ? "Zone" : `${zones.length} zones`}</h4>
          <label className="prop">
            <span>Net</span>
            <select
              value={common(zones.map((z) => z.net)) ?? "\u0000"}
              onChange={(e) => onEdit([{ op: "setZoneProps", file, uuids: zoneIds, net: e.target.value }, { op: "refillZones", file }])}
            >
              {common(zones.map((z) => z.net)) === undefined && <option value={"\u0000"}>mixed</option>}
              <option value="">(no net)</option>
              {nets.map((n) => (
                <option key={n} value={n}>{displayName(n)}</option>
              ))}
            </select>
          </label>
          <label className="prop">
            <span>Layer</span>
            <select
              value={common(zones.map((z) => z.layers.join(","))) ?? ""}
              onChange={(e) => onEdit([{ op: "setZoneProps", file, uuids: zoneIds, layer: e.target.value }, { op: "refillZones", file }])}
            >
              {common(zones.map((z) => z.layers.join(","))) === undefined && <option value="">mixed</option>}
              {board.copperLayers.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          <label className="prop" title="How pads of the zone's net join it (KiCad's pad connections). Fine-pitch pins often can't take two thermal spokes: solid for SMD pads avoids starved thermals.">
            <span>Pads</span>
            <select
              value={common(zones.map((z) => z.connect)) ?? ""}
              onChange={(e) => onEdit([{ op: "setZoneProps", file, uuids: zoneIds, connect: e.target.value as "thermal" | "solid" | "none" | "tht" }, { op: "refillZones", file }])}
            >
              {common(zones.map((z) => z.connect)) === undefined && <option value="">mixed</option>}
              <option value="thermal">Thermal reliefs</option>
              <option value="tht">Reliefs for through-hole only (SMD solid)</option>
              <option value="solid">Solid</option>
              <option value="none">None</option>
            </select>
          </label>
        </section>
      )}
      {texts.length > 0 && (
        <section>
          <h4>{texts.length === 1 ? "Text" : `${texts.length} texts`}</h4>
          {texts.length === 1 && (
            <label className="prop">
              <span>Text</span>
              <TextField value={texts[0]!.text} onCommit={(text) => text && onEdit([{ op: "setBoardText", file, uuids: textIds, text }])} />
            </label>
          )}
          <NumField label="Size" value={common(texts.map((t) => t.size.y))} onCommit={(size) => size > 0 && onEdit([{ op: "setBoardText", file, uuids: textIds, size }])} />
          <label className="prop">
            <span>Side</span>
            <select value={common(texts.map((t) => t.layer)) ?? ""} onChange={(e) => onEdit([{ op: "setBoardText", file, uuids: textIds, layer: e.target.value }])}>
              {common(texts.map((t) => t.layer)) === undefined && <option value="">mixed</option>}
              {["F.SilkS", "B.SilkS", "F.Cu", "B.Cu", "F.Fab", "B.Fab"].filter((l) => board.layers.some((x) => x.name === l)).map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
        </section>
      )}
      {rect && (
        <section>
          <h4>
            Rectangle <span className="muted small">{rect.layer}</span>
          </h4>
          <NumField
            label="Width"
            value={Math.round(Math.abs(rect.points[1]!.x - rect.points[0]!.x) * 1e4) / 1e4}
            onCommit={(w) => w > 0 && onEdit([{ op: "setGraphicPoints", file, uuid: rect.uuid!, points: [rect.points[0]!, { x: rect.points[0]!.x + Math.sign(rect.points[1]!.x - rect.points[0]!.x || 1) * w, y: rect.points[1]!.y }] }])}
          />
          <NumField
            label="Height"
            value={Math.round(Math.abs(rect.points[1]!.y - rect.points[0]!.y) * 1e4) / 1e4}
            onCommit={(h) => h > 0 && onEdit([{ op: "setGraphicPoints", file, uuid: rect.uuid!, points: [rect.points[0]!, { x: rect.points[1]!.x, y: rect.points[0]!.y + Math.sign(rect.points[1]!.y - rect.points[0]!.y || 1) * h }] }])}
          />
        </section>
      )}
      {fps.length > 1 && (
        <section>
          <h4>{fps.length} footprints</h4>
          <p className="muted small">{fps.map((f) => f.reference).join(", ")}</p>
        </section>
      )}
    </div>
  );
}

/**
 * The editor on a phone: below COMPACT_WIDTH or COMPACT_HEIGHT the app is a viewer (App.tsx, styles.css `.app.compact`).
 * The schematic, board or 3D view fills the screen, tabs at the bottom switch between them, and a
 * tapped part opens a sheet with what it is. Editing, the side panels, the toolbars and the status
 * bar are left out: they need a mouse, a keyboard and room.
 */
import { useEffect, useState } from "react";
import type { ComponentInfo } from "../render/types";
import { Icon, type IconName } from "./icons";

/** Narrower or shorter than these (CSS px), the app is the viewer: a phone, upright or on its side. Tablets and up keep the editor. */
export const COMPACT_WIDTH = 700;
export const COMPACT_HEIGHT = 500;
const QUERY = `(max-width: ${COMPACT_WIDTH - 1}px), (max-height: ${COMPACT_HEIGHT - 1}px)`;

export function useCompact(): boolean {
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const change = () => setCompact(mq.matches);
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, []);
  return compact;
}

export type CompactMode = "schematic" | "board" | "3d";

const TABS: Array<{ mode: CompactMode; label: string; icon: IconName }> = [
  { mode: "schematic", label: "Schematic", icon: "schematic" },
  { mode: "board", label: "Board", icon: "pcb" },
  { mode: "3d", label: "3D", icon: "cube" },
];

/** The views, as tabs at the bottom (within the thumb's reach). Board and 3D only with a board. */
export function CompactTabs({ mode, hasSchematic, hasBoard, onMode }: { mode: CompactMode; hasSchematic: boolean; hasBoard: boolean; onMode: (m: CompactMode) => void }) {
  return (
    <nav className="compact-tabs" aria-label="Views">
      {TABS.map((t) => {
        const enabled = t.mode === "schematic" ? hasSchematic : hasBoard;
        return (
          <button key={t.mode} className={mode === t.mode ? "on" : ""} aria-current={mode === t.mode ? "page" : undefined} disabled={!enabled} onClick={() => onMode(t.mode)}>
            <Icon name={t.icon} size={22} />
            <span>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** The sheet shown, and with more than one, a picker in its place. */
export function CompactSheetPicker({ sheets, current, onOpen }: { sheets: Array<{ path: string; namePath: string }>; current: string; onOpen: (path: string) => void }) {
  const name = (s: { namePath: string }) => (s.namePath === "/" ? "Root sheet" : s.namePath);
  const sheet = sheets.find((s) => s.path === current);
  if (sheets.length < 2) return <div className="breadcrumb compact-sheet">{sheet ? name(sheet) : ""}</div>;
  return (
    <label className="breadcrumb compact-sheet">
      <span className="visually-hidden">Sheet</span>
      <select value={current} onChange={(e) => onOpen(e.target.value)}>
        {sheets.map((s) => (
          <option key={s.path} value={s.path}>
            {name(s)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * A tapped part, in a sheet above the tabs: reference and value, what it is, its footprint and
 * sheets, its datasheet, and a way to see it in the other view.
 */
export function CompactPartSheet({
  part,
  sheetName,
  other,
  onOther,
  onClose,
}: {
  part: ComponentInfo;
  sheetName: (path: string) => string;
  /** The view to show it in next, if the project has it. */
  other?: "schematic" | "board";
  onOther: () => void;
  onClose: () => void;
}) {
  const datasheet = /^https?:\/\//i.test(part.datasheet) ? part.datasheet : undefined;
  const footprint = part.footprint.includes(":") ? part.footprint.slice(part.footprint.indexOf(":") + 1) : part.footprint;
  return (
    <section className="compact-part" role="dialog" aria-label={`${part.reference} ${part.value}`}>
      <header>
        <div>
          <h2>
            {part.reference} · {part.value}
          </h2>
          {part.description && <p className="muted">{part.description}</p>}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" size={20} />
        </button>
      </header>
      <dl>
        {footprint && (
          <>
            <dt>Footprint</dt>
            <dd>{footprint}</dd>
          </>
        )}
        {part.sheets.length > 0 && (
          <>
            <dt>{part.sheets.length > 1 ? "Sheets" : "Sheet"}</dt>
            <dd>{part.sheets.map(sheetName).join(", ")}</dd>
          </>
        )}
        {part.dnp && (
          <>
            <dt>Fitted</dt>
            <dd>No (DNP)</dd>
          </>
        )}
      </dl>
      {(datasheet || other) && (
        <div className="compact-part-actions">
          {datasheet && (
            <a href={datasheet} target="_blank" rel="noopener noreferrer">
              Datasheet ↗
            </a>
          )}
          {other && <button onClick={onOther}>{other === "board" ? "Show on board" : "Show in schematic"}</button>}
        </div>
      )}
    </section>
  );
}

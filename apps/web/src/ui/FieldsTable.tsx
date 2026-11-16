/**
 * KiCad's Symbol Fields Table: every part with its fields in one table, grouped like a BOM (same
 * value, footprint and fields) or one row per part, every custom field as a column, cells edited
 * for all the parts of a row at once, sorting, a filter, and the view as CSV.
 */
import { useMemo, useState } from "react";
import type { EditOp } from "../edit/ops";
import type { ComponentInfo, ProjectView } from "../render/types";
import { Icon } from "./icons";
import { downloadFile } from "../load";

const STANDARD = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
const HIDDEN = (k: string) => k.startsWith("ki_") || STANDARD.includes(k);

const fieldOf = (c: ComponentInfo, k: string) =>
  k === "Reference" ? c.reference : k === "Value" ? c.value : k === "Footprint" ? c.footprint : k === "Datasheet" ? (c.datasheet === "~" ? "" : c.datasheet) : k === "Description" ? c.description : (c.properties[k] ?? "");

/** A row: the parts it stands for (one, or a group) and its shown value per column. */
interface Row {
  parts: ComponentInfo[];
  cells: Record<string, string>;
}

const naturalRefs = (refs: string[]) => [...refs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

export function FieldsTable({ project, onEdit, onClose }: { project: ProjectView; onEdit: (ops: EditOp[]) => void; onClose: () => void }) {
  const parts = useMemo(() => project.components.filter((c) => !c.reference.startsWith("#")), [project.components]);
  const [extra, setExtra] = useState<string[]>([]);
  const columns = useMemo(() => {
    const custom = new Set<string>();
    for (const c of parts) for (const k of Object.keys(c.properties)) if (!HIDDEN(k)) custom.add(k);
    for (const k of extra) custom.add(k);
    return [...STANDARD, ...[...custom].sort()];
  }, [parts, extra]);
  const [grouped, setGrouped] = useState(true);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 }>({ col: "Reference", dir: 1 });
  const rows = useMemo((): Row[] => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = parts.filter((c) => terms.every((t) => columns.some((k) => fieldOf(c, k).toLowerCase().includes(t))));
    let out: Row[];
    if (grouped) {
      // Same as a BOM line: every field but the reference equal.
      const groups = new Map<string, ComponentInfo[]>();
      for (const c of shown) {
        const key = JSON.stringify([c.libId, ...columns.filter((k) => k !== "Reference").map((k) => fieldOf(c, k)), c.dnp]);
        groups.set(key, [...(groups.get(key) ?? []), c]);
      }
      out = [...groups.values()].map((g) => ({ parts: g, cells: Object.fromEntries(columns.map((k) => [k, k === "Reference" ? naturalRefs(g.map((c) => c.reference)).join(", ") : fieldOf(g[0]!, k)])) }));
    } else out = shown.map((c) => ({ parts: [c], cells: Object.fromEntries(columns.map((k) => [k, fieldOf(c, k)])) }));
    const key = (r: Row) => (sort.col === "Qty" ? String(r.parts.length).padStart(6, "0") : sort.col === "Reference" ? naturalRefs(r.parts.map((c) => c.reference))[0]! : r.cells[sort.col] ?? "");
    return out.sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true }) * sort.dir);
  }, [parts, columns, grouped, filter, sort]);

  const set = (row: Row, col: string, value: string) => {
    const ops = row.parts.flatMap((c) => c.units.map((u) => ({ op: "setField" as const, file: u.file, uuid: u.uuid, name: col, value, sheetPath: u.sheet })));
    if (ops.length) onEdit(ops);
  };
  const csv = () => {
    const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const head = [...columns, ...(grouped ? ["Qty"] : [])];
    const lines = [head, ...rows.map((r) => [...columns.map((k) => r.cells[k] ?? ""), ...(grouped ? [String(r.parts.length)] : [])])].map((l) => l.map(q).join(","));
    downloadFile(`${project.name}-fields.csv`, lines.join("\n") + "\n");
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal fields-table" onPointerDown={(e) => e.stopPropagation()}>
        <div className="update-head">
          <strong>
            Symbol fields <span className="muted small">{parts.length} parts · {rows.length} rows</span>
          </strong>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="fp-filters">
          <input placeholder="Filter (any field)…" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <label title="One row per BOM line: parts with the same value, footprint and fields">
            <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Group like the BOM
          </label>
          <button
            onClick={() => {
              const name = window.prompt("New field (e.g. MPN, Manufacturer, LCSC)")?.trim();
              if (name && !columns.includes(name)) setExtra([...extra, name]);
            }}
          >
            + Field
          </button>
          <button onClick={csv} title="This table as CSV, as shown">
            CSV
          </button>
        </div>
        <div className="fields-scroll">
          <table>
            <thead>
              <tr>
                {[...columns, ...(grouped ? ["Qty"] : [])].map((k) => (
                  <th key={k} onClick={() => setSort({ col: k, dir: sort.col === k ? ((-sort.dir) as 1 | -1) : 1 })} className={sort.col === k ? "sorted" : undefined}>
                    {k}
                    {sort.col === k ? (sort.dir > 0 ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.parts.map((c) => c.reference).join(",")} className={r.parts.some((c) => c.dnp) ? "dnp" : undefined}>
                  {columns.map((k) => (
                    <td key={k} className={k === "Reference" || k === "Footprint" ? "mono" : undefined}>
                      {k === "Reference" && (grouped || r.parts.length > 1) ? (
                        <span title={r.cells[k]}>{r.cells[k]}</span>
                      ) : (
                        <Cell value={r.cells[k] ?? ""} onCommit={(v) => set(r, k, v)} />
                      )}
                    </td>
                  ))}
                  {grouped && <td className="qty">{r.parts.length}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">An edit applies to every part in its row. Saved in the schematic, as KiCad's fields table saves it.</p>
      </div>
    </div>
  );
}

function Cell({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [was, setWas] = useState(value);
  if (was !== value) {
    setWas(value);
    setText(value);
  }
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

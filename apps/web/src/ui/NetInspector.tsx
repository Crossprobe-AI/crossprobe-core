/**
 * KiCad's Net Inspector: every board net with its pads, vias, via length, track length per
 * copper layer and in total, and what's still unrouted (as airlines). Numbers come from
 * netStats, which follows KiCad's own length calculation. Sort, filter, group by net class,
 * select a net on the board, and save the table as CSV.
 */
import { useMemo, useState } from "react";
import { displayName, netStats } from "@crossprobe/kicad-model";
import type { ProjectView } from "../render/types";
import { downloadFile } from "../load";
import { Icon } from "./icons";

const mm = (v: number) => (v ? v.toFixed(3) : "");

type Col = "net" | "class" | "pads" | "vias" | "viaLength" | "trackLength" | "total" | "unrouted" | `layer:${string}`;

export function NetInspector({ project, onSelectNet, onClose }: { project: ProjectView; onSelectNet: (net: string) => void; onClose: () => void }) {
  const board = project.board!;
  const [filter, setFilter] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [byClass, setByClass] = useState(false);
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 }>({ col: "net", dir: 1 });
  const stats = useMemo(() => netStats(board), [board]);
  const unrouted = useMemo(() => {
    const out = new Map<string, number>();
    for (const u of project.unconnected) out.set(u.net, (out.get(u.net) ?? 0) + Math.hypot(u.a.at.x - u.b.at.x, u.a.at.y - u.b.at.y));
    return out;
  }, [project.unconnected]);
  const copper = board.copperLayers.filter((l) => stats.some((s) => s.layers[l]));
  const cls = (net: string) => project.netClasses[net]?.name ?? "Default";

  const rows = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const list = stats.filter((s) => (showEmpty || s.trackLength > 0 || s.pads > 1) && terms.every((t) => s.net.toLowerCase().includes(t) || displayName(s.net).toLowerCase().includes(t) || cls(s.net).toLowerCase().includes(t)));
    const value = (s: (typeof stats)[number], c: Col): string | number =>
      c === "net" ? s.net : c === "class" ? cls(s.net) : c === "unrouted" ? (unrouted.get(s.net) ?? 0) : c.startsWith("layer:") ? (s.layers[c.slice(6)] ?? 0) : (s[c as "pads"] as number);
    return list.sort((a, b) => {
      if (byClass) {
        const k = cls(a.net).localeCompare(cls(b.net));
        if (k) return k;
      }
      const va = value(a, sort.col), vb = value(b, sort.col);
      return (typeof va === "number" ? va - (vb as number) : va.localeCompare(vb as string, undefined, { numeric: true })) * sort.dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, filter, showEmpty, byClass, sort, unrouted]);

  const head: Array<{ col: Col; label: string; title?: string }> = [
    { col: "net", label: "Net" },
    { col: "class", label: "Class" },
    { col: "pads", label: "Pads" },
    { col: "vias", label: "Vias" },
    { col: "viaLength", label: "Via length", title: "Through the stackup, between the layers each via's tracks use" },
    { col: "trackLength", label: "Track length" },
    { col: "total", label: "Total", title: "Track and via length" },
    ...copper.map((l) => ({ col: `layer:${l}` as Col, label: board.layers.find((x) => x.name === l)?.userName ?? l })),
    { col: "unrouted", label: "Unrouted", title: "Airline length of what's still unconnected" },
  ];
  const cells = (s: (typeof stats)[number]) => [displayName(s.net), cls(s.net), String(s.pads), String(s.vias || ""), mm(s.viaLength), mm(s.trackLength), mm(s.total), ...copper.map((l) => mm(s.layers[l] ?? 0)), mm(unrouted.get(s.net) ?? 0)];
  const csv = () => {
    const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [head.map((h) => h.label + (h.col === "net" || h.col === "class" || h.col === "pads" || h.col === "vias" ? "" : " (mm)")), ...rows.map(cells)];
    downloadFile(`${project.name}-nets.csv`, lines.map((l) => l.map(q).join(",")).join("\n") + "\n");
  };
  const totals = rows.reduce((t, s) => ({ track: t.track + s.trackLength, vias: t.vias + s.vias }), { track: 0, vias: 0 });

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal fields-table net-inspector" onPointerDown={(e) => e.stopPropagation()}>
        <div className="update-head">
          <strong>
            Net inspector{" "}
            <span className="muted small">
              {rows.length} nets · {totals.track.toFixed(1)} mm of track · {totals.vias} vias
            </span>
          </strong>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="fp-filters">
          <input placeholder="Filter by net or class…" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <label>
            <input type="checkbox" checked={byClass} onChange={(e) => setByClass(e.target.checked)} /> Group by net class
          </label>
          <label title="Nets with a single pad and no tracks">
            <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} /> Single-pad nets
          </label>
          <button onClick={csv} title="This table as CSV, as shown">
            CSV
          </button>
        </div>
        <div className="fields-scroll">
          <table>
            <thead>
              <tr>
                {head.map((h) => (
                  <th key={h.col} title={h.title} className={sort.col === h.col ? "sorted" : undefined} onClick={() => setSort({ col: h.col, dir: sort.col === h.col ? ((-sort.dir) as 1 | -1) : h.col === "net" || h.col === "class" ? 1 : -1 })}>
                    {h.label}
                    {sort.col === h.col ? (sort.dir > 0 ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.net} className="net-row" onClick={() => onSelectNet(s.net)} title="Select this net on the board">
                  {cells(s).map((c, i) => (
                    <td key={i} className={i === 0 ? "mono" : i > 1 ? "num" : undefined}>
                      <span>{c}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">Lengths in mm, as KiCad's Net Inspector measures them: tracks merged and clipped where they end inside pads and vias, vias through the stackup between the layers their tracks use.</p>
      </div>
    </div>
  );
}

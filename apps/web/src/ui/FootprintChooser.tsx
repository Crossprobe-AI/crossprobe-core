/**
 * Footprint assignment, like KiCad's CvPcb: choose a library footprint for a
 * schematic symbol, narrowed by the symbol's own footprint filters
 * (ki_fp_filters) and its pin count, with a preview of the pads so a wrong
 * package is easy to spot. `AssignFootprints` lists every part at once.
 */
import { useEffect, useMemo, useState } from "react";
import { parseBoard, type Footprint } from "@crossprobe/kicad-model";
import type { EditOp } from "../edit/ops";
import { isProjectFootprint, kicadFootprint, kicadFootprintIndex, kicadFootprintPads } from "../load";
import type { ComponentInfo } from "../render/types";
import { Icon } from "./icons";
import { assistant, type AssistantStatus, type SuggestProgress } from "../extensions";

let index: Promise<string[]> | undefined;
let pads: Promise<Record<string, number>> | undefined;
const previews = new Map<string, Promise<Footprint | undefined>>();

function loadPreview(libId: string): Promise<Footprint | undefined> {
  let p = isProjectFootprint(libId) ? undefined : previews.get(libId);
  if (!p) {
    p = kicadFootprint(libId).then((t) => (t ? parseBoard(`(kicad_pcb (version 20260206)\n${t}\n)`).footprints[0] : undefined));
    previews.set(libId, p);
  }
  return p;
}

const patterns = new Map<string, RegExp>();
/** KiCad filter semantics: wildcards, case-insensitive; a pattern with ":" also matches the library. */
function matchesFilter(id: string, filter: string): boolean {
  let re = patterns.get(filter);
  if (!re) patterns.set(filter, (re = new RegExp("^" + filter.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i")));
  return re.test(filter.includes(":") ? id : id.slice(id.indexOf(":") + 1));
}

/** Field edits for every placed unit of a component. */
export function footprintOps(c: ComponentInfo, libId: string): EditOp[] {
  return c.units.map((u) => ({ op: "setField" as const, file: u.file, uuid: u.uuid, name: "Footprint", value: libId, sheetPath: u.sheet }));
}

type P = { x: number; y: number };
/** An SVG arc from start through mid to end (undefined when the points are collinear). */
function arcPath(a: P, m: P, b: P): string | undefined {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-12) return undefined;
  const sq = (p: P) => p.x * p.x + p.y * p.y;
  const cx = (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d;
  const cy = (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  // Going the positive-angle way (SVG sweep 1) from start: do we meet mid before end?
  const ang = (p: P) => Math.atan2(p.y - cy, p.x - cx);
  const turn = (p: P) => (((ang(p) - ang(a)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const sweep = turn(m) < turn(b) ? 1 : 0;
  const span = sweep ? turn(b) : 2 * Math.PI - turn(b);
  const large = span > Math.PI ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} ${sweep} ${b.x} ${b.y}`;
}

/** The pads and outlines of a footprint, drawn to fit a box. */
export function Preview({ fp }: { fp: Footprint }) {
  const layer = (l: string) => (l.endsWith("CrtYd") ? "var(--fp-crtyd)" : l.endsWith("SilkS") ? "var(--fp-silk)" : l.endsWith("Fab") ? "var(--fp-fab)" : undefined);
  const graphics = fp.graphics.filter((g) => layer(g.layer) && (g.layer.startsWith("F.") || g.layer.startsWith("B.")));
  const pts = [...graphics.flatMap((g) => g.points), ...fp.pads.flatMap((p) => [{ x: p.at.x - p.size.x / 2, y: p.at.y - p.size.y / 2 }, { x: p.at.x + p.size.x / 2, y: p.at.y + p.size.y / 2 }])];
  if (!pts.length) return <p className="muted small">Nothing to preview.</p>;
  const x0 = Math.min(...pts.map((p) => p.x)) - 0.5;
  const y0 = Math.min(...pts.map((p) => p.y)) - 0.5;
  const w = Math.max(...pts.map((p) => p.x)) - x0 + 0.5;
  const h = Math.max(...pts.map((p) => p.y)) - y0 + 0.5;
  const stroke = Math.max(w, h) / 250;
  return (
    <svg className="fp-preview" viewBox={`${x0} ${y0} ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
      {graphics.map((g, i) => {
        const c = layer(g.layer);
        const sw = Math.max(g.width, stroke);
        if (g.kind === "circle" && g.points.length === 2) {
          const r = Math.hypot(g.points[1]!.x - g.points[0]!.x, g.points[1]!.y - g.points[0]!.y);
          return <circle key={i} cx={g.points[0]!.x} cy={g.points[0]!.y} r={r} fill="none" stroke={c} strokeWidth={sw} />;
        }
        if (g.kind === "rect" && g.points.length === 2) {
          const [a, b] = g.points as [{ x: number; y: number }, { x: number; y: number }];
          return <rect key={i} x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} fill="none" stroke={c} strokeWidth={sw} />;
        }
        if (g.kind === "arc" && g.points.length === 3) {
          const d = arcPath(g.points[0]!, g.points[1]!, g.points[2]!);
          if (d) return <path key={i} d={d} fill="none" stroke={c} strokeWidth={sw} />;
        }
        const closed = g.kind === "poly";
        return <polyline key={i} points={[...g.points, ...(closed ? [g.points[0]!] : [])].map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={c} strokeWidth={sw} />;
      })}
      {fp.pads.map((p, i) => {
        const { x: sx, y: sy } = p.size;
        const r = p.shape === "circle" || p.shape === "oval" ? Math.min(sx, sy) / 2 : p.shape === "roundrect" ? Math.min(sx, sy) * (p.roundrectRatio ?? 0.25) : 0;
        const fill = p.type === "np_thru_hole" ? "none" : p.type === "smd" ? "var(--fp-smd)" : "var(--fp-tht)";
        return (
          <g key={i} transform={`translate(${p.at.x} ${p.at.y}) rotate(${-p.rotation})`}>
            <rect x={-sx / 2} y={-sy / 2} width={sx} height={sy} rx={r} fill={fill} stroke={p.type === "np_thru_hole" ? "var(--fp-fab)" : "none"} strokeWidth={stroke} />
            {p.drill ? <ellipse rx={(p.drillSize?.x ?? p.drill) / 2} ry={(p.drillSize?.y ?? p.drill) / 2} fill="var(--fp-hole)" /> : null}
            {p.number && (
              <text fontSize={Math.min(sx, sy) * 0.5} textAnchor="middle" dominantBaseline="central" fill="var(--fp-num)">
                {p.number}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Footprints this project already uses for the same symbol, most used first. */
export function usedFootprints(components: ComponentInfo[], c: ComponentInfo): string[] {
  const n = new Map<string, number>();
  for (const o of components) if (o.libId === c.libId && o.footprint) n.set(o.footprint, (n.get(o.footprint) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

/** Other parts of the same symbol still without a footprint. */
export function sameKindWithout(components: ComponentInfo[], c: ComponentInfo): ComponentInfo[] {
  return components.filter((o) => o !== c && o.libId === c.libId && o.onBoard && !o.footprint);
}

export function FootprintChooser({
  component,
  onChoose,
  onClose,
  components = [],
  onEditFootprint,
  onDraftFootprint,
  libraryKey,
  created,
}: {
  /** "Draft from datasheet (AI)": resolves to the footprint to offer (a new one, or KiCad's). */
  onDraftFootprint?: () => void;
  /** Changes when the project's own footprints do: the list is read again. */
  libraryKey?: string;
  /** A footprint just created for this part: selected. */
  created?: string;
  /** Open the footprint editor: on a copy of `libId` (or the project's own), or a new footprint with none. */
  onEditFootprint?: (libId?: string) => void;
  component: ComponentInfo;
  /** `also`: other parts of the same symbol to give the same footprint. */
  onChoose: (libId: string, also: ComponentInfo[]) => void;
  onClose: () => void;
  /** The project's parts, for "used in this project" and "same for the others". */
  components?: ComponentInfo[];
}) {
  const used = useMemo(() => usedFootprints(components, component), [components, component]);
  const siblings = useMemo(() => sameKindWithout(components, component), [components, component]);
  const [applyToSiblings, setApplyToSiblings] = useState(true);
  const [all, setAll] = useState<string[]>();
  const [padCounts, setPadCounts] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [useFilters, setUseFilters] = useState(component.fpFilters.length > 0);
  const [usePins, setUsePins] = useState(component.pinCount > 0);
  const [current, setCurrent] = useState<string | undefined>(component.footprint || used[0] || undefined);
  const [preview, setPreview] = useState<Footprint | null>();

  useEffect(() => {
    index = kicadFootprintIndex();
    pads = kicadFootprintPads();
    let live = true;
    index.then((i) => live && setAll(i));
    pads.then((p) => live && setPadCounts(p));
    return () => {
      live = false;
    };
  }, [libraryKey]);
  // A footprint just made for this part in the editor: offer it straight away.
  useEffect(() => {
    if (created) setCurrent(created);
  }, [created]);

  const havePads = Object.keys(padCounts).length > 0;
  const rows = useMemo(() => {
    if (!all) return [];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter(
      (id) =>
        // The project's own footprints are always offered (the symbol's filters name KiCad's libraries).
        (!useFilters || !component.fpFilters.length || isProjectFootprint(id) || component.fpFilters.some((f) => matchesFilter(id, f))) &&
        (!usePins || !havePads || padCounts[id] === component.pinCount) &&
        terms.every((t) => id.toLowerCase().includes(t)),
    );
  }, [all, query, useFilters, usePins, padCounts, havePads, component]);

  useEffect(() => {
    if (!current) return setPreview(undefined);
    let live = true;
    setPreview(null);
    loadPreview(current).then((fp) => live && setPreview(fp));
    return () => {
      live = false;
    };
  }, [current, libraryKey]);

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        // Nested in the assignment table: close only this dialog.
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="modal fp-chooser" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="update-head">
          <strong>
            Footprint for {component.reference} <span className="muted">{component.value}</span>
          </strong>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="fp-filters">
          <input autoFocus placeholder="Search footprints (e.g. “0603”, “sot-23”)…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          {component.fpFilters.length > 0 && (
            <label title="The symbol's own footprint filters">
              <input type="checkbox" checked={useFilters} onChange={(e) => setUseFilters(e.target.checked)} /> Symbol filters <span className="mono small">{component.fpFilters.join(" ")}</span>
            </label>
          )}
          {component.pinCount > 0 && havePads && (
            <label title="Footprints with as many pads as the symbol has pins">
              <input type="checkbox" checked={usePins} onChange={(e) => setUsePins(e.target.checked)} /> {component.pinCount} pads
            </label>
          )}
        </div>
        {used.length > 0 && (
          <div className="power-quick" title="Footprints this project already uses for this symbol">
            <span className="muted small">Used in this project:</span>
            {used.map((f) => (
              <button key={f} className={current === f ? "on" : ""} onClick={() => setCurrent(f)} onDoubleClick={() => onChoose(f, applyToSiblings ? siblings : [])}>
                {f.slice(f.indexOf(":") + 1)}
              </button>
            ))}
          </div>
        )}
        <div className="fp-body">
          <div className="part-list fp-list">
            {!all && <p className="muted small">Loading KiCad's footprint libraries…</p>}
            {all && !rows.length && <p className="muted small">No footprints match. Loosen the filters above.</p>}
            {rows.slice(0, 300).map((id) => (
              <button key={id} className={current === id ? "on" : ""} onClick={() => setCurrent(id)} onDoubleClick={() => onChoose(id, applyToSiblings ? siblings : [])}>
                <span className="part-name">{id.slice(id.indexOf(":") + 1)}</span>
                <span className="muted small">
                  {id.slice(0, id.indexOf(":"))}
                  {havePads && ` · ${padCounts[id] ?? "?"} pads`}
                </span>
              </button>
            ))}
            {rows.length > 300 && <p className="muted small">{rows.length - 300} more: refine the search.</p>}
          </div>
          <div className="fp-side">
            {current ? (
              <>
                <p className="mono small fp-id">{current}</p>
                {preview === null ? <p className="muted small">Loading…</p> : preview ? <Preview fp={preview} /> : <p className="muted small">Not in the installed libraries.</p>}
                {preview && (
                  <p className="muted small">
                    {new Set(preview.pads.map((p) => p.number).filter(Boolean)).size} pads · {preview.pads.some((p) => p.type === "smd") ? "SMD" : "through-hole"}
                    {component.pinCount > 0 && ` · symbol has ${component.pinCount} pins`}
                  </p>
                )}
                {preview && onEditFootprint && (
                  <button className="link" onClick={() => onEditFootprint(current)} title={isProjectFootprint(current) ? "Open it in the footprint editor" : "Copy it into the project's footprint library and open it in the footprint editor"}>
                    {isProjectFootprint(current) ? "Edit footprint" : "Edit a copy"}
                  </button>
                )}
              </>
            ) : (
              <p className="muted small">Pick a footprint to preview it.</p>
            )}
          </div>
        </div>
        <div className="update-actions">
          {siblings.length > 0 && (
            <label className="small fp-siblings" title={siblings.map((o) => o.reference).join(", ")}>
              <input type="checkbox" checked={applyToSiblings} onChange={(e) => setApplyToSiblings(e.target.checked)} /> Also for {siblings.length === 1 ? siblings[0]!.reference : `${siblings.length} other ${component.libId.split(":").pop()} parts`} without a footprint
            </label>
          )}
          {component.footprint && (
            <button onClick={() => onChoose("", [])} title="Clear the Footprint field">
              Clear
            </button>
          )}
          {onDraftFootprint && (
            <button onClick={onDraftFootprint} title="The AI reads the part's datasheet: KiCad's standard footprint if it has one, else the recommended land pattern, every dimension cited">
              <Icon name="spark" size={13} /> Draft from datasheet
            </button>
          )}
          {onEditFootprint && (
            <button onClick={() => onEditFootprint()} title="A footprint of your own, in the project's footprint library">
              New footprint…
            </button>
          )}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!current || current === component.footprint} onClick={() => current && onChoose(current, applyToSiblings ? siblings : [])}>
            Assign
          </button>
        </div>
      </div>
    </div>
  );
}

/** Every part and its footprint, with the missing ones first; click a row to choose. */
export function AssignFootprints({ components, onEdit, onClose, project, onEditFootprint, onDraftFootprint }: { components: ComponentInfo[]; onEdit: (ops: EditOp[]) => void; onClose: () => void; project?: () => import("../render/types").ProjectView; onEditFootprint?: (libId?: string) => Promise<string | undefined> | void; onDraftFootprint?: (c: ComponentInfo) => Promise<string | undefined> }) {
  // The footprint the editor last made while choosing for a part: offered to that part.
  const [createdFor, setCreatedFor] = useState<{ reference: string; libId: string }>();
  const [choosing, setChoosing] = useState<string>();
  // Suggestions from an assistant, when one is available: applied only on request.
  const [ai, setAi] = useState<AssistantStatus>();
  const [suggest, setSuggest] = useState<SuggestProgress>();
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [abort, setAbort] = useState<AbortController>();
  useEffect(() => {
    if (assistant?.suggestFootprints) assistant.status().then(setAi);
  }, []);
  const runSuggest = async () => {
    if (!project || !assistant?.suggestFootprints) return;
    index = kicadFootprintIndex();
    pads = kicadFootprintPads();
    const [idx, pc] = await Promise.all([index, pads]);
    const ctl = new AbortController();
    setAbort(ctl);
    const done = await assistant.suggestFootprints(project, { index: idx, pads: pc }, (p) => {
      setSuggest(p);
      setAccepted(new Set(p.suggestions.map((x) => x.reference)));
    }, ctl.signal);
    setAbort(undefined);
    setSuggest(done);
  };
  const suggestionFor = (ref: string) => suggest?.suggestions.find((x) => x.reference === ref);
  const applySuggestions = () => {
    const ops = (suggest?.suggestions ?? [])
      .filter((x) => accepted.has(x.reference))
      .flatMap((x) => {
        const c = components.find((c) => c.reference === x.reference);
        return c && !c.footprint ? footprintOps(c, x.footprint) : [];
      });
    if (ops.length) onEdit(ops);
    setSuggest(undefined);
  };
  const parts = useMemo(
    () => components.filter((c) => c.onBoard).sort((a, b) => Number(!!a.footprint) - Number(!!b.footprint) || a.reference.localeCompare(b.reference, undefined, { numeric: true })),
    [components],
  );
  const missing = parts.filter((c) => !c.footprint).length;
  const chosen = choosing ? components.find((c) => c.reference === choosing) : undefined;
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal fp-assign" onPointerDown={(e) => e.stopPropagation()}>
        <div className="update-head">
          <strong>
            Assign footprints <span className="muted small">{missing ? `${missing} of ${parts.length} missing` : `all ${parts.length} assigned`}</span>
          </strong>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="fp-table">
          <table>
            <thead>
              <tr>
                <th>Ref</th>
                <th>Value</th>
                <th>Symbol</th>
                <th>Footprint</th>
                {suggest && <th>AI suggestion</th>}
              </tr>
            </thead>
            <tbody>
              {parts.map((c) => (
                <tr key={c.reference} onClick={() => setChoosing(c.reference)} className={c.footprint ? "" : "missing"}>
                  <td className="mono">{c.reference}</td>
                  <td>{c.value}</td>
                  <td className="mono small muted">{c.libId}</td>
                  <td className="mono small">{c.footprint || <span className="error">choose…</span>}</td>
                  {suggest && (
                    <td className="small" onClick={(e) => e.stopPropagation()}>
                      {suggestionFor(c.reference) && !c.footprint && (
                        <label title={suggestionFor(c.reference)!.reason} className="ai-suggestion">
                          <input
                            type="checkbox"
                            checked={accepted.has(c.reference)}
                            onChange={(e) =>
                              setAccepted((s) => {
                                const n = new Set(s);
                                if (e.target.checked) n.add(c.reference);
                                else n.delete(c.reference);
                                return n;
                              })
                            }
                          />
                          <span className="mono">{suggestionFor(c.reference)!.footprint.slice(suggestionFor(c.reference)!.footprint.indexOf(":") + 1)}</span>
                          <span className="muted"> · {suggestionFor(c.reference)!.reason}</span>
                        </label>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="update-actions">
          <span className="muted small" style={{ marginRight: "auto" }}>
            {suggest
              ? suggest.error
                ? suggest.error
                : suggest.done
                  ? `${suggest.suggestions.length} suggestions to review. Hover one for the reasoning.`
                  : (suggest.activity ?? "Thinking…")
              : "Every part on the board needs a footprint before Update PCB can place it."}
          </span>
          {project && ai?.available && ai.tasks?.includes("footprints") && missing > 0 && !suggest && (
            <button onClick={runSuggest} title="The AI proposes footprints from KiCad's library; you review them before anything changes">
              <Icon name="spark" /> Suggest with AI
            </button>
          )}
          {suggest && !suggest.done && abort && <button onClick={() => abort.abort()}>Stop</button>}
          {suggest?.done && (
            <>
              <button onClick={() => setSuggest(undefined)}>Discard</button>
              <button className="primary" disabled={!accepted.size} onClick={applySuggestions}>
                Apply {accepted.size} suggestion{accepted.size === 1 ? "" : "s"}
              </button>
            </>
          )}
        </div>
      </div>
      {chosen && (
        <FootprintChooser
          key={chosen.reference}
          component={chosen}
          components={components}
          onEditFootprint={
            onEditFootprint &&
            (async (id?: string) => {
              const made = await onEditFootprint(id);
              if (made) setCreatedFor({ reference: chosen.reference, libId: made });
            })
          }
          onDraftFootprint={
            onDraftFootprint &&
            (async () => {
              const made = await onDraftFootprint(chosen);
              if (made) setCreatedFor({ reference: chosen.reference, libId: made });
            })
          }
          libraryKey={project?.().projectFootprints.map((f) => `${f.libId}:${f.pads}:${f.text.length}`).join(",")}
          created={createdFor?.reference === chosen.reference ? createdFor.libId : undefined}
          onClose={() => setChoosing(undefined)}
          onChoose={(id, also) => {
            onEdit([chosen, ...also].flatMap((c) => footprintOps(c, id)));
            // Move on to the next part still missing one.
            const done = new Set([chosen, ...also].map((c) => c.reference));
            const next = parts.find((c) => !c.footprint && !done.has(c.reference));
            setChoosing(id && next ? next.reference : undefined);
          }}
        />
      )}
    </div>
  );
}

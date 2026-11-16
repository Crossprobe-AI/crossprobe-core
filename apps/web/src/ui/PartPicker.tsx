/**
 * Part picker for the place tool. Three sources, searched together:
 * parts already used in the project (embedded in its sheets), the project's
 * own symbol libraries (sym-lib-table), and KiCad's installed libraries
 * (loaded lazily; ~23k symbols).
 */
import { useEffect, useMemo, useState } from "react";
import { kicadSymbol, kicadSymbolIndex } from "../load";
import type { ProjectView } from "../render/types";
import type { EditContext } from "./SchematicView";

type Placing = NonNullable<EditContext["placing"]>;
type KicadEntry = Awaited<ReturnType<typeof kicadSymbolIndex>>[number];

let kicadIndex: Promise<KicadEntry[]> | undefined;

interface Row {
  key: string;
  name: string;
  library?: string;
  description: string;
  prefix: string;
  power: boolean;
  pins: number;
  pick: () => Promise<Placing>;
}

/** Score a row against space-separated terms: all must match; name hits rank first. */
function score(terms: string[], name: string, rest: string): number {
  if (!terms.length) return 1;
  const n = name.toLowerCase();
  const r = rest.toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (n === t) s += 100;
    else if (n.startsWith(t)) s += 30;
    else if (n.includes(t)) s += 10;
    else if (r.includes(t)) s += 1;
    else return 0;
  }
  return s - n.length / 100;
}

const LIMIT = 60;

/** One-click rails for the power tool, as KiCad's "power" library names them. */
const COMMON_POWER = ["GND", "+3V3", "+5V", "VCC", "+12V", "GNDA", "+1V8", "VBUS", "PWR_FLAG"];

export function PartPicker({ project, placing, onPick, power = false, onNewSymbol }: { project: ProjectView; placing?: Placing; onPick: (p: Placing) => void; power?: boolean; onNewSymbol?: () => void }) {
  const [query, setQuery] = useState("");
  const [kicad, setKicad] = useState<KicadEntry[] | undefined>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState<string>();

  useEffect(() => {
    kicadIndex ??= kicadSymbolIndex();
    let live = true;
    kicadIndex.then((idx) => live && setKicad(idx));
    return () => {
      live = false;
    };
  }, []);

  const terms = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);

  const sections = useMemo(() => {
    const rank = (rows: Array<Row & { hay: string }>, limit: number) =>
      rows
        .map((r) => ({ r, s: score(terms, r.name, r.hay) }))
        .filter((x) => x.s > 0 && (!power || x.r.power || x.r.library === "power"))
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map((x) => x.r);

    const used = rank(
      project.libraries.map((l) => ({
        key: `e:${l.libId}`,
        name: l.name,
        library: l.libId.includes(":") ? l.libId.slice(0, l.libId.indexOf(":")) : undefined,
        description: l.description,
        prefix: l.prefix,
        power: l.power,
        pins: l.pins,
        hay: `${l.libId} ${l.description}`,
        pick: async () => ({ key: `e:${l.libId}`, source: { kind: "embedded", file: l.file, libId: l.libId }, prefix: l.prefix, name: l.name }),
      })),
      terms.length ? LIMIT : 500,
    );
    const own = rank(
      project.projectSymbols.map((e) => ({
        key: `p:${e.library}:${e.name}`,
        name: e.name,
        library: e.library,
        description: e.description,
        prefix: e.prefix,
        power: e.power,
        pins: e.pins,
        hay: `${e.library}:${e.name} ${e.description} ${e.keywords}`,
        pick: async () => ({ key: `p:${e.library}:${e.name}`, source: { kind: "library", file: e.file, library: e.library, name: e.name }, prefix: e.prefix, name: e.name }),
      })),
      LIMIT,
    );
    // KiCad's libraries are only searched with a query (the full list is huge), except for power symbols.
    const lib =
      kicad && (terms.length || power)
        ? rank(
            kicad.map((e) => ({
              key: `k:${e.library}:${e.name}`,
              name: e.name,
              library: e.library,
              description: e.description,
              prefix: e.prefix,
              power: e.power,
              pins: e.pins,
              hay: `${e.library}:${e.name} ${e.description} ${e.keywords}`,
              pick: async () => ({
                key: `k:${e.library}:${e.name}`,
                source: { kind: "text", text: await kicadSymbol(e.library, e.name) },
                prefix: e.prefix,
                name: e.name,
              }),
            })),
            LIMIT,
          )
        : [];
    return [
      { title: "In this project", rows: used },
      { title: "Project libraries", rows: own },
      { title: "KiCad libraries", rows: lib },
    ];
  }, [project, kicad, terms, power]);

  // After a pick the picker folds into one line, so it doesn't cover the sheet being placed on.
  const [folded, setFolded] = useState(false);
  const pick = async (r: Row) => {
    setError(undefined);
    setLoading(r.key);
    try {
      onPick(await r.pick());
      setFolded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(undefined);
    }
  };

  // The power tool's quick picks: the common rails from KiCad's power library.
  const quick = useMemo(
    () =>
      power && kicad
        ? COMMON_POWER.flatMap((n) => {
            const e = kicad.find((k) => k.library === "power" && k.name === n);
            return e
              ? [
                  {
                    key: `k:power:${n}`,
                    name: n,
                    pick: async (): Promise<Placing> => ({ key: `k:power:${n}`, source: { kind: "text", text: await kicadSymbol("power", n) }, prefix: e.prefix, name: n }),
                  },
                ]
              : [];
          })
        : [],
    [power, kicad],
  );

  if (folded && placing)
    return (
      <div className="part-picker folded">
        <span className="small">
          Placing <b className="mono">{placing.name}</b> · click on the sheet · Esc to stop
        </span>
        <button className="link" onClick={() => setFolded(false)}>
          Change…
        </button>
      </div>
    );

  return (
    <div className="part-picker">
      <input
        autoFocus
        placeholder={power ? "Search power symbols (e.g. “3V3”, “GNDD”)…" : "Search parts (e.g. “ldo 3.3”, “R_Small”)…"}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {quick.length > 0 && (
        <div className="power-quick">
          {quick.map((q) => (
            <button key={q.key} className={placing?.key === q.key ? "on" : ""} onClick={() => pick(q as unknown as Row)} title={q.name === "PWR_FLAG" ? "Marks a net as driven by a power source (fixes ERC 'power pin not driven')" : `Power symbol ${q.name}`}>
              {loading === q.key ? "…" : q.name}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      {onNewSymbol && !power && (
        <button className="link small" onClick={onNewSymbol} title="Draw a symbol of your own, in the project's symbol library">
          + New symbol…
        </button>
      )}
      <div className="part-list">
        {sections.map(
          (sec) =>
            (sec.rows.length > 0 || (sec.title === "KiCad libraries" && terms.length > 0)) && (
              <div key={sec.title} className="part-section">
                <div className="part-section-title">
                  {sec.title}
                  {sec.title === "KiCad libraries" && !kicad && <span className="muted"> · loading…</span>}
                </div>
                {sec.rows.map((r) => (
                  <button key={r.key} className={placing?.key === r.key ? "on" : ""} onClick={() => pick(r)} title={r.description}>
                    <span className="part-name">
                      {r.name}
                      {r.library && <span className="muted small"> {r.library}</span>}
                    </span>
                    <span className="muted small">{loading === r.key ? "loading…" : r.power ? "power" : `${r.prefix} · ${r.pins} pins`}</span>
                  </button>
                ))}
              </div>
            ),
        )}
      </div>
      <p className="muted small">
        {terms.length ? "Placing copies the symbol into this sheet." : "Type to search KiCad's libraries too."}
      </p>
    </div>
  );
}

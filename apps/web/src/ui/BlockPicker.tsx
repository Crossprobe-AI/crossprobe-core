/**
 * Design-block picker for the Add block tool. Lists the library's blocks and,
 * for the chosen one, shows what a person needs before trusting it: whether
 * it has been reviewed, the documents it comes from and the checklist, with
 * page numbers. Then the block is placed with a click on the sheet, or in
 * free space below the existing content.
 */
import type { BlockManifest } from "@crossprobe/kicad-model";
import { useEffect, useState } from "react";
import { blockBoard, blockIndex, blockManifest, blockSchematic, type BlockSummary } from "../load";
import type { EditContext } from "./SchematicView";

type Placing = NonNullable<EditContext["placingBlock"]>;

const SEVERITY = { required: "Required", recommended: "Recommended", info: "Good to know" } as const;

/** "p. 41 · Figure 9-1" for a citation. */
function cite(c: { page?: number; where?: string } | undefined): string {
  if (!c) return "";
  return [c.page ? `p. ${c.page}` : "", c.where].filter(Boolean).join(" · ");
}

export function BlockPicker({ placing, onPick, onInsertFree }: { placing?: Placing; onPick: (p: Placing) => void; onInsertFree: (text: string, pcb?: string) => void }) {
  const [blocks, setBlocks] = useState<BlockSummary[]>();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string>();
  const [pcb, setPcb] = useState<string>();
  const [manifest, setManifest] = useState<BlockManifest>();
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    blockIndex().then(setBlocks);
  }, []);

  const choose = async (b: BlockSummary) => {
    setError(undefined);
    setChosen(b.id);
    setManifest(undefined);
    setPcb(undefined);
    try {
      const m = await blockManifest(b.id);
      const [t, pcb] = await Promise.all([blockSchematic(b.id), m.layout ? blockBoard(b.id) : undefined]);
      setManifest(m);
      setText(t);
      setPcb(pcb);
      onPick({ id: b.id, title: b.title, text: t, pcb });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (blocks ?? []).filter((b) => terms.every((t) => `${b.title} ${b.description} ${b.category} ${b.keywords.join(" ")}`.toLowerCase().includes(t)));
  const docTitle = (id: string) => manifest?.sources.find((s) => s.id === id);

  return (
    <div className="part-picker block-picker">
      <input autoFocus placeholder="Search blocks (e.g. “esp32”, “usb”)…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {error && <p className="error small">{error}</p>}
      <div className="part-list">
        {!blocks && <p className="muted small">Loading…</p>}
        {blocks && !shown.length && <p className="muted small">{blocks.length ? "No block matches." : "No design blocks are available here."}</p>}
        {shown.map((b) => (
          <button key={b.id} className={chosen === b.id ? "on" : ""} onClick={() => choose(b)} title={b.description}>
            <span className="part-name">{b.title}</span>
            <span className={`badge ${b.status}`}>{b.status === "reviewed" ? "reviewed" : "draft"}</span>
          </button>
        ))}
      </div>

      {chosen && manifest && (
        <div className="block-detail">
          <p className="small">{manifest.description}</p>
          {manifest.status === "draft" ? (
            <p className="block-warn small">Draft: drawn from the sources below but not yet checked by a person. Compare the values with the datasheet before you rely on them.</p>
          ) : (
            <p className="muted small">
              Reviewed{manifest.reviewedBy ? ` by ${manifest.reviewedBy}` : ""}
              {manifest.reviewedAt ? ` on ${manifest.reviewedAt}` : ""}.
            </p>
          )}
          <p className="muted small">
            {manifest.parts.length} parts · {manifest.license} ·{" "}
            {manifest.sources.map((s, i) => (
              <span key={s.id}>
                {i > 0 && ", "}
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title}
                </a>
              </span>
            ))}
          </p>
          <details>
            <summary className="small">Checklist ({manifest.checklist.length})</summary>
            <ul className="block-checklist small">
              {manifest.checklist.map((c, i) => (
                <li key={i} className={c.severity}>
                  <b>{SEVERITY[c.severity]}.</b> {c.text}
                  <span className="muted">
                    {" "}
                    {c.source ? `(${docTitle(c.source.doc)?.publisher ?? "source"}, ${cite(c.source)})` : "(common practice)"}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          <div className="block-actions">
            <button className="primary" disabled={!text} onClick={() => text && onInsertFree(text, pcb)} title="Insert below everything else on this sheet, so nothing connects by accident">
              Insert in free space{pcb ? " (with layout)" : ""}
            </button>
            <span className="muted small">{placing?.id === chosen ? "or click the sheet to place it · Esc to stop" : ""}</span>
          </div>
        </div>
      )}
    </div>
  );
}

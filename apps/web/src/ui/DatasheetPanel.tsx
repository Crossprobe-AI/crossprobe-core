/**
 * Datasheet evidence for the selected part: open its datasheet (the link in
 * its Datasheet field, or a PDF you choose), jump to the sections an engineer
 * looks at first, or search it. Every result is the page itself, cropped and
 * highlighted, with the PDF's own text under it. Pin a result to the part to
 * keep it. An assistant (src/extensions) may point to places as well; it only
 * chooses which places to show.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { displayName } from "@crossprobe/kicad-model";
import { assistant, type AskProgress, type AssistantStatus, type Difference } from "../extensions";
import { evidenceId, type PinnedEvidence } from "../datasheet/evidence";
import { openFromFile, openFromLink, renderRegion, runOcr, type OpenDatasheet } from "../datasheet/open";
import { checkPins, checkVoltages, type PinCheck, type VoltageCheck } from "../datasheet/checks";
import { findFigures, findPin, findSection, passageLines, quoteOf, search, SECTIONS, type SectionId } from "../datasheet/search";
import type { Box, Evidence, Hit } from "../datasheet/types";
import type { EditOp } from "../edit/ops";
import type { ProjectView } from "../render/types";
import { Icon } from "./icons";
import type { Selection } from "./selection";

interface Card {
  key: string;
  hit: Hit;
  /** Why this is shown: a section name, "pin 3", the search, or the AI's pointer. */
  why: string;
  byAi?: boolean;
}

const linkOf = (d: string | undefined) => (d && d !== "~" && /^(https?:\/\/|www\.)/i.test(d) ? d : undefined);

export function DatasheetPanel({ project, selection, onEdit, hidden }: { project: ProjectView; selection: Selection; onEdit?: (ops: EditOp[]) => void; hidden: boolean }) {
  const component = selection?.kind === "component" ? project.components.find((c) => c.reference === selection.reference) : undefined;
  const link = linkOf(component?.datasheet);
  const [doc, setDoc] = useState<OpenDatasheet>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [cards, setCards] = useState<Card[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<AssistantStatus>();
  const [ask, setAsk] = useState<AskProgress>();
  const [page, setPage] = useState<{ number: number; box?: Box }>();
  const [more, setMore] = useState(12);
  const [pasted, setPasted] = useState("");
  const [ocr, setOcr] = useState<string>();
  const [compare, setCompare] = useState<Card>();
  const [pinChecks, setPinChecks] = useState<PinCheck[]>();
  const [voltChecks, setVoltChecks] = useState<VoltageCheck[]>();
  const abort = useRef<AbortController>(undefined);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    assistant?.status().then(setStatus);
  }, []);
  useEffect(() => () => abort.current?.abort(), []);

  const reference = component?.reference;
  // A different part: its results no longer apply (the open document stays until another loads).
  useEffect(() => {
    setCards([]);
    setAsk(undefined);
    setError(undefined);
    setPinChecks(undefined);
    setVoltChecks(undefined);
  }, [reference]);

  const load = async (what: string | File) => {
    setLoading(true);
    setError(undefined);
    setCards([]);
    setPinChecks(undefined);
    setVoltChecks(undefined);
    try {
      setDoc(typeof what === "string" ? await openFromLink(what) : await openFromFile(what));
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  };
  // Open the part's datasheet link when the panel is first shown for it.
  useEffect(() => {
    if (hidden || !link || loading || doc?.source === link) return;
    void load(link);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, link]);

  const pins = useMemo(
    () => (reference ? project.nets.flatMap((n) => n.nodes.filter((x) => x.reference === reference).map((x) => ({ number: x.pin, name: x.pinName !== "~" ? x.pinName : "", net: n.name, type: x.pinType }))) : []),
    [project, reference],
  );
  const pinned = project.evidence.filter((e) => e.target.reference === reference);

  const show = (hits: Hit[], why: (h: Hit) => string, empty: string) => {
    const next = hits.map((h) => ({ key: `${h.passage.id}-${why(h)}`, hit: h, why: why(h) }));
    setCards(next);
    setMore(12);
    setError(next.length ? undefined : empty);
  };
  const jump = (id: SectionId) => doc && show(findSection(doc.index, id), (h) => (h.passage.kind === "figure" ? h.why : SECTIONS[id].label), `No “${SECTIONS[id].label}” section found in this document.`);
  const figures = () => doc && show(findFigures(doc.index, query), (h) => h.why, query.trim() ? `No figure matches “${query.trim()}”.` : "No pictures were found in this document.");
  const pinJump = (p: { number: string; name: string }) => doc && show(findPin(doc.index, p), () => `Pin ${p.number}${p.name ? ` ${p.name}` : ""}`, `No row for pin ${p.number} found in the pin tables.`);
  const textSearch = () => doc && query.trim() && show(search(doc.index, query), () => `“${query.trim()}”`, `Nothing in this document matches “${query.trim()}”.`);

  const aiFind = async () => {
    if (!doc || !query.trim() || !assistant?.askDatasheet) return;
    abort.current?.abort();
    abort.current = new AbortController();
    setCards([]);
    setError(undefined);
    const ctx = component ? `${component.reference} (${component.value}${component.libId ? `, symbol ${component.libId}` : ""})` : "";
    const done = await assistant.askDatasheet(
      doc.index,
      query.trim(),
      ctx,
      (p) => {
        setAsk(p);
        if (p.shown.length) setCards(p.shown.map((s) => ({ key: `${s.hit.passage.id}-ai`, hit: s.hit, why: s.label ?? "Chosen by AI", byAi: true })));
      },
      abort.current.signal,
    );
    if (!done.error && !done.shown.length) setError("The AI found nothing in this document that answers that.");
  };

  const evidenceFor = (card: Card): Evidence => {
    const p = card.hit.passage;
    const lines = doc!.index.pages[p.page - 1]!.lines;
    const sel = card.hit.lines.length ? card.hit.lines : undefined;
    const ls = (sel ?? passageLines(p)).map((i) => lines[i]!).filter((l) => !l.furniture).map((l) => l.box);
    // A figure is the picture: its whole box, not the labels inside it.
    if (p.kind === "figure") ls.splice(0, ls.length, p.box);
    const x0 = Math.min(...ls.map((b) => b.x));
    const y0 = Math.min(...ls.map((b) => b.y));
    return {
      doc: { id: doc!.index.id, title: doc!.index.title, source: doc!.source },
      page: p.page,
      label: doc!.index.pages[p.page - 1]!.label,
      box: { x: x0, y: y0, w: Math.max(...ls.map((b) => b.x + b.w)) - x0, h: Math.max(...ls.map((b) => b.y + b.h)) - y0 },
      quote: quoteOf(doc!.index, p, sel),
      heading: p.heading,
    };
  };

  const pin = (card: Card) => {
    if (!onEdit || !reference) return;
    const e = evidenceFor(card);
    const target = { reference };
    const item: PinnedEvidence = { id: evidenceId(e, target), target, evidence: e, pinnedAt: new Date().toISOString() };
    onEdit([{ op: "setEvidence", file: project.evidenceFile, change: { add: item } }]);
  };

  // An assistant lists the tasks it will run for this user; the datasheet finder is available even when the review is not.
  const canAi = (!!assistant?.askDatasheet && status?.tasks?.includes("datasheet")) ?? false;

  return (
    <div className="datasheet" ref={root} style={hidden ? { display: "none" } : undefined}>
      {!component && !doc && <p className="review-note">Select a part to open its datasheet, or choose a PDF.</p>}
      {component && (
        <p className="ds-part">
          <span className="mono">{component.reference}</span> {component.value}
        </p>
      )}

      <div className="ds-source">
        {doc ? (
          <span title={doc.source}>
            <Icon name="doc" /> {doc.index.title} <span className="muted">· {doc.index.pages.length} pages</span>
          </span>
        ) : loading ? (
          <span className="muted">Opening datasheet…</span>
        ) : link ? (
          <span className="muted">Datasheet link not opened yet</span>
        ) : component ? (
          <span className="muted">This part has no datasheet link.</span>
        ) : null}
        <label className="ds-upload">
          {doc ? "Use another PDF…" : "Choose a PDF…"}
          <input type="file" accept="application/pdf,.pdf" hidden onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} />
        </label>
        {link && !doc && !loading && (
          <button className="link" onClick={() => void load(link)}>
            Open the link
          </button>
        )}
      </div>

      {component && (!link || (error && !doc)) && (
        <div className="ds-find">
          <p className="small">
            {link ? "The link did not open. " : ""}Find this part's datasheet:{" "}
            <a href={`https://www.google.com/search?q=${encodeURIComponent(`${component.properties["MPN"] || component.properties["Manufacturer_Part_Number"] || component.value} datasheet filetype:pdf`)}`} target="_blank" rel="noreferrer">
              search the web ↗
            </a>
            , then paste the PDF's link or choose the downloaded file above.
          </p>
          <form
            className="ds-search"
            onSubmit={(e) => {
              e.preventDefault();
              if (pasted.trim()) void load(pasted.trim());
            }}
          >
            <input placeholder="https://…/datasheet.pdf" value={pasted} onChange={(e) => setPasted(e.target.value)} />
            <button type="submit" disabled={!pasted.trim()}>
              Open link
            </button>
          </form>
        </div>
      )}
      {component && onEdit && doc && /^https?:/i.test(doc.source) && doc.source !== component.datasheet && (
        <p className="small">
          <button
            className="link"
            onClick={() => onEdit(component.units.map((u) => ({ op: "setField" as const, file: u.file, uuid: u.uuid, name: "Datasheet", value: doc.source, sheetPath: u.sheet })))}
            title="Writes the link into the part's Datasheet field, so it opens by itself next time"
          >
            Save this link in {component.reference}'s Datasheet field
          </button>
        </p>
      )}

      {doc && doc.index.scanned.length > 0 && !doc.index.ocr && (
        <p className="small ds-scan">
          {doc.index.scanned.length === doc.index.pages.length ? "This PDF is a scan: it has no text to search." : `${doc.index.scanned.length} pages have no text (scans).`} You can still open its pages.{" "}
          {ocr ? (
            <span className="muted">{ocr}</span>
          ) : (
            <button
              className="link"
              onClick={() => {
                setOcr("Starting OCR…");
                runOcr(doc, (d, t) => setOcr(`Reading page ${Math.min(d + 1, t)} of ${t}…`))
                  .then((next) => {
                    setDoc(next);
                    setCards([]);
                  })
                  .catch((e: Error) => setError(`OCR failed: ${e.message}`))
                  .finally(() => setOcr(undefined));
              }}
              title="Reads the pages in your browser. Downloads a ~10 MB language file the first time; the PDF stays here."
            >
              Read the scanned pages (OCR)
            </button>
          )}
        </p>
      )}
      {doc?.index.ocr && <p className="muted small">Text on scanned pages was read by OCR and can contain mistakes: check the highlighted page, not the extracted text.</p>}

      {pinned.length > 0 && (
        <details className="ds-pinned" open>
          <summary>Pinned for {reference} ({pinned.length})</summary>
          {pinned.map((p) => (
            <PinnedItem key={p.id} item={p} doc={doc} onOpen={() => setPage({ number: p.evidence.page, box: p.evidence.box })} onEdit={onEdit} file={project.evidenceFile} />
          ))}
        </details>
      )}

      {doc && (
        <>
          <div className="ds-chips" aria-label="Sections">
            <button className="chip fig" onClick={figures} title="Every picture in the datasheet: circuits, block diagrams, pinouts, layouts, graphs">
              Figures ({doc.index.passages.filter((p) => p.kind === "figure").length})
            </button>
            {(Object.keys(SECTIONS) as SectionId[]).map((id) => (
              <button key={id} className="chip" onClick={() => jump(id)}>
                {SECTIONS[id].label}
              </button>
            ))}
          </div>
          {pins.length > 0 && (
            <div className="ds-pins">
              <span className="muted small">Pin</span>
              {pins.slice(0, 80).map((p) => (
                <button key={p.number} className="chip mono" title={`${p.name} · ${displayName(p.net)}`} onClick={() => pinJump(p)}>
                  {p.number}
                  {p.name ? ` ${p.name}` : ""}
                </button>
              ))}
            </div>
          )}
          {pins.length > 0 && (
            <div className="ds-checks">
              <button
                onClick={() => {
                  setPinChecks(checkPins(doc.index, pins));
                  setVoltChecks(undefined);
                }}
                title="Compare each pin's name and number with the datasheet's pin table"
              >
                Check pins
              </button>
              <button
                onClick={() => {
                  setVoltChecks(checkVoltages(doc.index, pins));
                  setPinChecks(undefined);
                }}
                title="Compare the voltage each net's name promises with the datasheet's ratings for that pin"
              >
                Check voltages
              </button>
            </div>
          )}
          {pinChecks && <PinChecks checks={pinChecks} onShow={(c) => c.hit && show([c.hit], () => `Pin ${c.pin.number} ${c.pin.name}`, "")} />}
          {voltChecks && <VoltageChecks checks={voltChecks} onShow={(c) => show([c.row.hit], () => `${c.pin.name} (pin ${c.pin.number}) on ${c.pin.net}`, "")} />}
          <form
            className="ds-search"
            onSubmit={(e) => {
              e.preventDefault();
              textSearch();
            }}
          >
            <input placeholder="Search this datasheet, e.g. “max VIN”" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button type="submit" disabled={!query.trim()}>
              Find
            </button>
            {canAi && (
              <button type="button" className="ai" disabled={!query.trim() || (!!ask && !ask.done)} onClick={() => void aiFind()} title="The AI searches the datasheet and chooses which places to show you. It never writes the answer.">
                <Icon name="spark" /> Ask AI where
              </button>
            )}
          </form>
        </>
      )}

      {ask && !ask.done && <p className="muted small">{ask.activity}</p>}
      {ask?.error && <p className="error small">{ask.error}</p>}
      {error && <p className="small ds-none">{error}</p>}
      {doc &&
        cards.slice(0, more).map((c) => (
          <EvidenceCard key={c.key} card={c} doc={doc} width={Math.max(240, (root.current?.clientWidth ?? 320) - 28)} onOpen={() => setPage({ number: c.hit.passage.page, box: evidenceFor(c).box })} onPin={onEdit && reference ? () => pin(c) : undefined} onCompare={component && c.hit.passage.kind === "figure" ? () => setCompare(c) : undefined} pinned={pinned.some((p) => p.id === evidenceId(evidenceFor(c), { reference: reference! }))} />
        ))}
      {cards.length > more && (
        <button className="link" onClick={() => setMore(more + 12)}>
          Show {Math.min(12, cards.length - more)} more of {cards.length - more}
        </button>
      )}
      {doc && compare && component && <CompareView card={compare} doc={doc} project={project} reference={component.reference} canAi={(!!assistant?.compareReference && status?.tasks?.includes("reference")) ?? false} onClose={() => setCompare(undefined)} />}
      {doc && page && <PageViewer doc={doc} page={page.number} box={page.box} onPage={(n) => setPage({ number: n })} onClose={() => setPage(undefined)} />}
    </div>
  );
}

function EvidenceCard({ card, doc, width, onOpen, onPin, onCompare, pinned }: { card: Card; doc: OpenDatasheet; width: number; onOpen: () => void; onPin?: () => void; onCompare?: () => void; pinned: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const { passage } = card.hit;
  const page = doc.index.pages[passage.page - 1]!;
  const [visible, setVisible] = useState(false);
  const region = card.hit.box ?? passage.box;
  // Render when scrolled into view: a gallery can hold dozens of pictures.
  useEffect(() => {
    const el = host.current;
    if (!el || typeof IntersectionObserver === "undefined") return setVisible(true);
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setVisible(true), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const marked = passage.kind === "figure" && !card.hit.lines.length ? [] : card.hit.lines.map((i) => page.lines[i]!.box);
    renderRegion(doc, passage.page, region, marked, width).then((canvas) => {
      if (cancelled || !host.current) return;
      host.current.replaceChildren(canvas);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, doc, passage, card.hit.lines, width, page, region]);
  const printed = page.label && page.label !== String(page.number) ? `page ${page.label} (PDF page ${page.number})` : `page ${page.number}`;
  const image = async (): Promise<Blob> => {
    const canvas = await renderRegion(doc, passage.page, region, [], 1500, 6);
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not make the image"))), "image/png"));
  };
  const copyImage = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": image() })]);
    } catch {
      /* clipboard images need a secure context; Save image still works */
    }
  };
  const saveImage = async () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await image());
    a.download = `${doc.index.title.replace(/[^\w.-]+/g, "_")}-p${passage.page}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  return (
    <article className="ds-card">
      <header>
        <b>{card.why}</b>
        {card.byAi && <span className="badge draft" title="Chosen by the AI; the text below is from the PDF">AI pointer</span>}
        <div className="muted small">
          {printed}
          {passage.kind !== "figure" && passage.heading ? ` · ${passage.heading}` : ""}
        </div>
      </header>
      <div className="ds-shot" ref={host} onClick={onOpen} title="Open the whole page" style={{ minHeight: Math.min(220, region.h * (width / Math.max(1, region.w))) }} />
      <details>
        <summary className="small">{passage.kind === "figure" ? "Labels and caption (text from the PDF)" : "Text from the PDF"}</summary>
        <pre className="ds-text">{quoteOf(doc.index, passage)}</pre>
      </details>
      <footer>
        <button className="link" onClick={onOpen}>
          Open page
        </button>
        {onCompare && (
          <button className="link" onClick={onCompare} title="Put this picture next to what your design connects to the selected part">
            Compare with my part
          </button>
        )}
        <button className="link" onClick={() => void saveImage()} title="Save this region of the page as a PNG">
          Save image
        </button>
        <button className="link" onClick={() => void copyImage()} title="Copy this region as an image, e.g. into a design note">
          Copy image
        </button>
        <button className="link" onClick={() => void navigator.clipboard?.writeText(`${doc.index.title}, ${printed}${passage.heading ? `, ${passage.heading}` : ""}`)}>
          Copy citation
        </button>
        {onPin && (
          <button className="link" disabled={pinned} onClick={onPin}>
            {pinned ? "Pinned" : "Pin to part"}
          </button>
        )}
      </footer>
    </article>
  );
}

const PIN_STATUS: Record<PinCheck["status"], { label: string; cls: string }> = {
  ok: { label: "matches", cls: "ok" },
  "ok-packages": { label: "matches (table lists several packages: check yours)", cls: "ok" },
  "number-differs": { label: "name found, number differs", cls: "warn" },
  "name-not-found": { label: "name not found in a pin table", cls: "warn" },
};

function PinChecks({ checks, onShow }: { checks: PinCheck[]; onShow: (c: PinCheck) => void }) {
  const bad = checks.filter((c) => c.status === "number-differs" || c.status === "name-not-found");
  return (
    <div className="ds-check-list">
      <p className="small">
        <b>{checks.length - bad.length}</b> of {checks.length} pins match the datasheet's pin table by name and number
        {bad.length ? `; ${bad.length} to look at:` : "."}
      </p>
      <ul>
        {[...bad, ...checks.filter((c) => !bad.includes(c))].map((c) => (
          <li key={c.pin.number + c.pin.name} className={PIN_STATUS[c.status].cls}>
            <span className="mono">
              {c.pin.number} {c.pin.name}
            </span>{" "}
            <span className="muted small">
              {PIN_STATUS[c.status].label}
              {c.status === "number-differs" && c.numbers ? ` (datasheet: ${c.numbers.join(", ")})` : ""}
            </span>
            {c.hit && (
              <button className="link" onClick={() => onShow(c)}>
                Show row
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small">Compares names and numbers only. A pin that matches by name can still be wired wrong; the table row is shown so you can see for yourself.</p>
    </div>
  );
}

function VoltageChecks({ checks, onShow }: { checks: VoltageCheck[]; onShow: (c: VoltageCheck) => void }) {
  if (!checks.length) return <p className="muted small">No pin of this part is on a net whose name gives a voltage (like +5V or +3V3), or the datasheet has no rating row for those pins.</p>;
  return (
    <div className="ds-check-list">
      <p className="small">Voltage the net name promises, next to the datasheet row for that pin. Names are not measurements: check the real voltage.</p>
      <ul>
        {checks.map((c, i) => (
          <li key={i} className={c.status === "above-abs-max" ? "warn" : ""}>
            <span className="mono">
              {c.pin.name} (pin {c.pin.number})
            </span>{" "}
            on {displayName(c.pin.net)} ≈ {c.volts} V · {c.row.section === "abs-max" ? "absolute maximum row" : "operating conditions row"}{c.row.byName ? "" : " (found by “supply voltage”: the datasheet names this pin differently)"}: <span className="mono">{c.row.values.join(", ")}</span>
            {c.status === "above-abs-max" && <b> — above the largest number in this row</b>}
            <button className="link" onClick={() => onShow(c)}>
              Show row
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PinnedItem({ item, doc, onOpen, onEdit, file }: { item: PinnedEvidence; doc?: OpenDatasheet; onOpen: () => void; onEdit?: (ops: EditOp[]) => void; file: string }) {
  const e = item.evidence;
  const same = doc?.index.id === e.doc.id;
  return (
    <div className="ds-pin-item">
      <div className="small">
        <b>{e.doc.title}</b> · page {e.label && e.label !== String(e.page) ? `${e.label} (PDF ${e.page})` : e.page}
        {e.heading ? ` · ${e.heading}` : ""}
      </div>
      <pre className="ds-text">{e.quote}</pre>
      {!same && <div className="muted small">Open this datasheet to view the page.</div>}
      <div className="ds-actions">
        {same && (
          <button className="link" onClick={onOpen}>
            Open page
          </button>
        )}
        {onEdit && (
          <button className="link" onClick={() => onEdit([{ op: "setEvidence", file, change: { remove: item.id } }])}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function PageViewer({ doc, page, box, onPage, onClose }: { doc: OpenDatasheet; page: number; box?: Box; onPage: (n: number) => void; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const p = doc.index.pages[page - 1]!;
  useEffect(() => {
    let cancelled = false;
    renderRegion(doc, page, { x: 0, y: 0, w: p.width, h: p.height }, box ? [box] : [], Math.max(360, Math.min(900, window.innerWidth - 80, ((window.innerHeight - 110) * p.width) / p.height)), 0).then((c) => {
      if (cancelled || !host.current) return;
      host.current.replaceChildren(c);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, page, box, p]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && page < doc.index.pages.length) onPage(page + 1);
      else if (e.key === "ArrowLeft" && page > 1) onPage(page - 1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [page, doc, onClose, onPage]);
  return (
    <div className="ds-viewer" role="dialog" aria-label="Datasheet page" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ds-viewer-bar">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ←
        </button>
        <span>
          {doc.index.title}: page {p.label && p.label !== String(page) ? `${p.label} (PDF ${page})` : page} of {doc.index.pages.length}
        </span>
        <button disabled={page >= doc.index.pages.length} onClick={() => onPage(page + 1)}>
          →
        </button>
        <span className="spacer" />
        <button onClick={onClose}>Close (Esc)</button>
      </div>
      {/* Clicking beside the page closes it, like Esc. */}
      <div className="ds-viewer-page" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={host} />
      </div>
    </div>
  );
}

/**
 * A datasheet picture beside what the design connects to the selected part:
 * every pin with its net and the other parts on that net. It compares nothing
 * by itself; the engineer looks from one to the other.
 */
function CompareView({ card, doc, project, reference, canAi, onClose }: { card: Card; doc: OpenDatasheet; project: ProjectView; reference: string; canAi: boolean; onClose: () => void }) {
  const [diffs, setDiffs] = useState<Difference[]>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [pick, setPick] = useState<number>();
  const abort = useRef<AbortController>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  const host = useRef<HTMLDivElement>(null);
  const part = project.components.find((c) => c.reference === reference)!;
  const value = (ref: string) => project.components.find((c) => c.reference === ref)?.value ?? "";
  const rows = project.nets
    .flatMap((n) => n.nodes.filter((x) => x.reference === reference).map((x) => ({ pin: x.pin, name: x.pinName !== "~" ? x.pinName : "", net: n.name, others: n.nodes.filter((o) => o.reference !== reference), size: n.nodes.length })))
    .sort((a, b) => a.pin.localeCompare(b.pin, undefined, { numeric: true }));
  const { passage } = card.hit;
  const connections = {
    part: `${reference} ${part.value}`,
    pins: rows.map((r) => ({ pin: r.pin, name: r.name, net: r.net, connectedTo: r.others.slice(0, 12).map((o) => ({ ref: o.reference, value: value(o.reference), pin: o.pin })) })),
  };
  const askAi = async () => {
    abort.current?.abort();
    abort.current = new AbortController();
    setBusy(true);
    setErr(undefined);
    setDiffs(undefined);
    setPick(undefined);
    try {
      // The picture the engineer sees is the picture the model gets.
      const canvas = await renderRegion(doc, passage.page, card.hit.box ?? passage.box, [], 1100);
      setDiffs(await assistant!.compareReference!(canvas.toDataURL("image/png").split(",")[1]!, connections, passage.caption ?? "", abort.current.signal));
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  useEffect(() => {
    let cancelled = false;
    renderRegion(doc, passage.page, card.hit.box ?? passage.box, [], Math.min(620, window.innerWidth * 0.5)).then((c) => {
      if (!cancelled && host.current) host.current.replaceChildren(c);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, passage, card.hit.box]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="ds-viewer" role="dialog" aria-label="Compare with the datasheet" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ds-viewer-bar">
        <span>
          {doc.index.title}, page {passage.page}: {passage.caption ?? "figure"} <span className="muted">· next to {reference} {part.value}</span>
        </span>
        <span className="spacer" />
        <button onClick={onClose}>Close (Esc)</button>
      </div>
      <div className="ds-compare" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div>
          <h4>Datasheet</h4>
          <div className="ds-shot-wrap">
            <div className="ds-shot" ref={host} />
            {diffs?.map((d, i) => (
              <div key={i} className={`ds-diffbox${pick === i ? " on" : ""}${d.severity === "check" ? " check" : ""}`} style={{ left: `${d.box.x * 100}%`, top: `${d.box.y * 100}%`, width: `${d.box.w * 100}%`, height: `${d.box.h * 100}%` }} onClick={() => setPick(i)} title={d.title}>
                <span>{i + 1}</span>
              </div>
            ))}
          </div>
          <details open>
            <summary className="small">Labels in the picture (text from the PDF)</summary>
            <pre className="ds-text">{quoteOf(doc.index, passage)}</pre>
            <p className="muted small">Text extraction can misread symbols (µ often comes out as m): trust the picture.</p>
          </details>
        </div>
        <div>
          <h4>Your design: {reference}</h4>
          <table className="ds-pintable">
            <thead>
              <tr>
                <th>Pin</th>
                <th>Name</th>
                <th>Net</th>
                <th>Connected to</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.pin}>
                  <td className="mono">{r.pin}</td>
                  <td className="mono">{r.name}</td>
                  <td className="mono">{displayName(r.net)}</td>
                  <td>
                    {r.others.slice(0, 6).map((o) => `${o.reference}${value(o.reference) ? ` ${value(o.reference)}` : ""} (pin ${o.pin})`).join(", ")}
                    {r.others.length > 6 ? ` and ${r.others.length - 6} more` : ""}
                    {!r.others.length ? <span className="muted">nothing else</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {canAi && (
            <div className="ds-ai-compare">
              <button className="ai" onClick={() => void askAi()} disabled={busy} title="A vision model reads the picture and lists differences from the connections above, each pointing at a box on the picture">
                <Icon name="spark" /> {busy ? "Looking at the picture…" : diffs ? "Ask again" : "Ask AI for differences"}
              </button>
              {err && <p className="error small">{err}</p>}
              {diffs && (
                <>
                  <p className="small ds-warn">
                    <b>AI reading of the picture.</b> It can misread values and connections: check each point against the numbered box on the datasheet picture.
                  </p>
                  {!diffs.length && <p className="small">The AI found no difference it is sure of. That does not mean there is none.</p>}
                  <ol className="ds-diffs">
                    {diffs.map((d, i) => (
                      <li key={i} className={pick === i ? "on" : ""} onClick={() => setPick(i)}>
                        <b>
                          {i + 1}. {d.title}
                        </b>{" "}
                        <span className={`badge ${d.severity === "check" ? "draft" : ""}`}>{d.severity}</span>
                        <div className="small">
                          <span className="muted">Picture:</span> {d.picture}
                        </div>
                        <div className="small">
                          <span className="muted">Design:</span> {d.design}
                        </div>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          )}
          <p className="muted small">Look for what the reference circuit has that the design lacks (a capacitor, a pull-up, a resistor value) and the reverse. Nothing here is judged for you.</p>
        </div>
      </div>
    </div>
  );
}

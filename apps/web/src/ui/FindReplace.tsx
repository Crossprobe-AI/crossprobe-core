/**
 * KiCad's Find and Replace for the schematic: texts, labels, sheet names and pins, and the
 * fields of parts, on every sheet. Enter goes to the next match; Replace changes the match
 * shown, Replace all every one (one undo step).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { parse } from "@crossprobe/kicad-sexpr";
import { findInSheets, replaceInText, sheetRoot, type FindOptions, type FindTarget } from "@crossprobe/kicad-model";
import { replaceOp, type EditOp } from "../edit/ops";
import type { ProjectView } from "../render/types";
import { Icon } from "./icons";

const KIND: Record<FindTarget["kind"], string> = { text: "Text", label: "Label", field: "Field", sheet: "Sheet", sheetpin: "Sheet pin" };

export function FindReplace({
  focusToken,
  project,
  files,
  editing,
  onEdit,
  onShow,
  onClose,
}: {
  /** Changes when the field should take the cursor again (Ctrl+F with the panel open). */
  focusToken?: number;
  project: ProjectView;
  /** The project's files as they are now (with unsaved edits). */
  files: () => Promise<Record<string, string>>;
  editing: boolean;
  onEdit: (ops: EditOp[]) => void;
  /** Bring a match into view: the sheet instance to open and the item to select. */
  onShow: (sheetPath: string, uuid: string) => void;
  onClose: () => void;
}) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [o, setO] = useState<FindOptions>({});
  const [matches, setMatches] = useState<FindTarget[]>([]);
  const [current, setCurrent] = useState(-1);
  /** The project version the matches were found in: their texts are only good for that version. */
  const matchesOf = useRef<ProjectView | undefined>(undefined);
  /** The search the matches are for: until it equals the one typed, the answer is not in yet. */
  const [searched, setSearched] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // A new function on every render of the app: read it when needed, don't search again because of it.
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusToken]);

  // The sheet files, parsed once per version of the project.
  const parsed = useRef<{ project: ProjectView; sheets: Array<{ file: string; root: ReturnType<typeof sheetRoot> }> }>(undefined);
  const sheetFiles = useMemo(() => [...new Set(project.sheets.map((s) => s.file))], [project]);
  useEffect(() => {
    let stale = false;
    const t = setTimeout(async () => {
      if (!find) return setMatches([]);
      if (parsed.current?.project !== project) {
        const all = await filesRef.current();
        parsed.current = { project, sheets: sheetFiles.filter((f) => all[f] !== undefined).map((file) => ({ file, root: sheetRoot(parse(all[file]!, { recover: true })) })) };
      }
      if (stale) return;
      // In the order of the sheets, as the hierarchy lists them.
      const order = new Map(sheetFiles.map((f, i) => [f, i]));
      setMatches(findInSheets(parsed.current.sheets, find, o).sort((a, b) => order.get(a.file)! - order.get(b.file)!));
      matchesOf.current = project;
      setSearched(find);
      setCurrent(-1);
    }, 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [find, o, project, sheetFiles]);

  const sheetOf = (t: FindTarget) => project.sheets.find((s) => (t.kind === "field" && t.sheetPath ? s.path === t.sheetPath : s.file === t.file));
  const show = (i: number) => {
    const t = matches[i];
    if (!t) return;
    setCurrent(i);
    const sheet = sheetOf(t);
    if (!sheet) return;
    // A shown field is an item of its own; a hidden one shows its part.
    const field = t.kind === "field" ? `${t.uuid}#${t.field}` : undefined;
    onShow(sheet.path, field && sheet.items.some((it) => it.uuid === field) ? field : t.uuid);
  };
  const next = (step = 1) => matches.length && show((current + step + matches.length) % matches.length);
  const replaceCurrent = () => {
    const t = matches[current];
    if (!t) return next();
    // The project changed since the search (its re-run is due): the match's text may be out of date.
    if (matchesOf.current !== project) return;
    const to = replaceInText(t.text, find, replace, o);
    if (to !== undefined && to !== t.text) onEdit([replaceOp(t, to)]);
  };
  const option = (key: keyof FindOptions, label: string, title: string) => (
    <label title={title}>
      <input type="checkbox" checked={!!o[key]} onChange={(e) => setO({ ...o, [key]: e.target.checked })} /> {label}
    </label>
  );
  const where = (t: FindTarget) => {
    const sheet = sheetOf(t);
    const name = sheet ? (sheet.namePath === "/" ? "Root" : sheet.namePath) : t.file;
    return `${name} · ${t.kind === "field" ? t.field : KIND[t.kind]}`;
  };
  return (
    <div className="update-pcb find-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="update-head">
        <strong>{editing ? "Find and replace" : "Find"}</strong>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)">
          <Icon name="close" />
        </button>
      </div>
      <div className="update-body page-settings">
        <label className="prop">
          <span>Find</span>
          <input
            ref={input}
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              // The app's own Ctrl/Cmd keys (Save, Find) still work from here; plain keys stay in the box.
              if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
              if (e.key === "Enter") next(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") onClose();
            }}
          />
        </label>
        {editing && (
          <label className="prop">
            <span>Replace with</span>
            <input value={replace} onChange={(e) => setReplace(e.target.value)} onKeyDown={(e) => !e.ctrlKey && !e.metaKey && e.stopPropagation()} />
          </label>
        )}
        <div className="find-options">
          {option("matchCase", "Match case", "Upper and lower case must match")}
          {option("wholeWord", "Whole words", "Only where the match is not part of a longer word")}
          {option("wildcards", "Wildcards", "* is any text, ? any one character; the whole text must match")}
          {option("references", "References", "Look in reference designators too")}
          {option("hiddenFields", "Hidden fields", "Look in fields that are not shown on the sheet")}
        </div>
        <p className="muted small">
          {find && searched !== find ? "Searching…" : find ? (matches.length ? `${current >= 0 ? `${current + 1} of ` : ""}${matches.length} match${matches.length === 1 ? "" : "es"} · Enter for the next` : "No matches") : "Texts, labels, sheet names and pins, and fields, on every sheet"}
        </p>
        {matches.length > 0 && (
          <ul className="find-list">
            {matches.slice(0, 300).map((t, i) => (
              <li key={`${t.kind}${t.uuid}${"field" in t ? t.field : ""}${"pin" in t ? t.pin : ""}${"sheetPath" in t ? t.sheetPath : ""}`}>
                <button className={`link${i === current ? " on" : ""}`} onClick={() => show(i)}>
                  <span className="mono">{t.text}</span> <span className="muted small">{where(t)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="update-actions">
        <button onClick={() => next(-1)} disabled={!matches.length} title="Previous match (Shift+Enter)">Previous</button>
        <button onClick={() => next()} disabled={!matches.length} title="Next match (Enter)">Next</button>
        {editing && (
          <>
            <button onClick={replaceCurrent} disabled={!matches.length} title="Replace the match shown">Replace</button>
            <button
              className="primary"
              disabled={!matches.length}
              onClick={() => onEdit([{ op: "replaceAll", file: matches[0]!.file, files: sheetFiles, find, replace, options: o }])}
              title="Replace every match, in one step you can undo"
            >
              Replace all
            </button>
          </>
        )}
      </div>
    </div>
  );
}

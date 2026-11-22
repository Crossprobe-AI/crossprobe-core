/// <reference lib="webworker" />
/**
 * The analysis worker holds the open project: its file texts, an undo/redo
 * history of edits, and which files changed since opening. Every request
 * answers with a fresh analysis, so the views, ERC and parity stay current.
 */
import { analyze, type ProjectFiles } from "./analyze";
import { describeOp, Editor, zonesStaleAfter, type EditOp } from "./edit/ops";
import { toStored, writer, type PersistMeta, type StoredFolder } from "./persist";

export type WorkerRequest =
  | {
      id: number;
      type: "open";
      files: ProjectFiles;
      unsaved?: boolean;
      /** Restoring kept changes: the files as last saved, when they differ from `files`. */
      original?: Record<string, string>;
      /** Restoring a linked project: the texts last synced with the link. */
      synced?: Record<string, string>;
      persist?: PersistMeta;
    }
  | { id: number; type: "edit"; ops: EditOp[] }
  | { id: number; type: "undo" }
  | { id: number; type: "redo" }
  | { id: number; type: "files"; paths?: string[] }
  | { id: number; type: "saved"; paths: string[] }
  /** After a new project's first save: it has been saved, and maybe has a folder now. */
  | { id: number; type: "meta"; unsaved: boolean; folder?: StoredFolder }
  /** Stop keeping changes and delete what is kept; answers once it is deleted. */
  | { id: number; type: "forget" }
  | { id: number; type: "flush" }
  /** These files now match the link's remote (reset: and no others do). */
  | { id: number; type: "synced"; paths: string[]; reset?: boolean }
  /** Files that came from the link's remote (null deletes). */
  | { id: number; type: "merge"; files: Record<string, string | null> }
  /** Nothing is synced with a link any more. */
  | { id: number; type: "unlink" }
  /**
   * An extension's link changed (made, moved, or dropped with value undefined): kept with the changes.
   * deepLink: the address the project now reopens from (null: none). saved: the project is no longer unsaved.
   */
  | { id: number; type: "link"; ext: string; value: unknown; deepLink?: string | null; saved?: boolean };

interface Snapshot {
  label: string;
  /** File texts before (undo) or after (redo) the step. */
  before: Record<string, string>;
  after: Record<string, string>;
  /** Whether the zone fills were out of date before and after the step. */
  stale: { before: boolean; after: boolean };
}

let project: ProjectFiles | undefined;
let original: Record<string, string> = {};
const editor = new Editor();
const undo: Snapshot[] = [];
const redo: Snapshot[] = [];
/** The board was edited since its zones were last filled. Undo and redo take it back and forth with the fills. */
let zonesStale = false;
/** Unsaved changes are kept in IndexedDB so they survive a reload (see persist.ts). */
let persist: PersistMeta | undefined;
const store = writer();

/** Store what to keep for the tab: soon after edits (a burst costs one write), at once after anything else. */
function keep(now = false) {
  if (persist) store.write(persist.tab, toStored(project!.project, project!.files, original, persist, synced), now);
}
/**
 * The texts last synced with a link (e.g. committed to or pulled from a
 * repository), when an extension keeps one. A file missing here is new there.
 */
let synced: Record<string, string> | undefined;

function state() {
  const dirty = Object.keys(project!.files).filter((f) => project!.files[f] !== undefined && project!.files[f] !== original[f]);
  return {
    project: analyze(project!),
    dirty,
    undo: undo[undo.length - 1]?.label,
    redo: redo[redo.length - 1]?.label,
    zonesStale,
    unsynced: synced && unsynced(),
  };
}

/** Files that differ from the last sync: changed, new, or deleted here. */
function unsynced(): string[] {
  const files = project!.files;
  const changed = Object.keys(files).filter((f) => files[f] !== undefined && files[f] !== synced![f]);
  const deleted = Object.keys(synced!).filter((f) => files[f] === undefined);
  return [...changed, ...deleted].sort();
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    switch (req.type) {
      case "open":
        project = req.files;
        // A new project has never been saved: every file counts as changed.
        original = req.original ? { ...req.original } : req.unsaved ? {} : { ...req.files.files };
        persist = req.persist;
        undo.length = redo.length = 0;
        zonesStale = false;
        synced = req.synced && { ...req.synced };
        break;
      case "edit": {
        const root = project!.project.replace(/\.kicad_pro$/, ".kicad_sch");
        const after = editor.apply(project!.files, req.ops, root);
        const before = Object.fromEntries(Object.keys(after).map((f) => [f, project!.files[f]!]));
        Object.assign(project!.files, after);
        const stale = { before: zonesStale, after: zonesStaleAfter(req.ops, zonesStale) };
        zonesStale = stale.after;
        undo.push({ label: req.ops.map(describeOp).join(", "), before, after, stale });
        if (undo.length > 100) undo.shift();
        redo.length = 0;
        break;
      }
      case "undo": {
        const step = undo.pop();
        if (step) {
          Object.assign(project!.files, step.before);
          // Files the step created don't exist before it.
          for (const [f, t] of Object.entries(step.before)) if (t === undefined) delete project!.files[f];
          zonesStale = step.stale.before;
          redo.push(step);
        }
        break;
      }
      case "redo": {
        const step = redo.pop();
        if (step) {
          Object.assign(project!.files, step.after);
          zonesStale = step.stale.after;
          undo.push(step);
        }
        break;
      }
      case "files":
        self.postMessage({ id: req.id, ok: true, files: Object.fromEntries((req.paths ?? Object.keys(project!.files)).map((p) => [p, project!.files[p]!])) });
        return;
      case "flush":
        // Store the waiting changes now (the app is about to reload, or has crashed).
        store.flush().then(() => self.postMessage({ id: req.id, ok: true }));
        return;
      case "forget": {
        const tab = persist?.tab;
        persist = undefined;
        if (tab) store.forget(tab).then(() => self.postMessage({ id: req.id, ok: true }));
        else self.postMessage({ id: req.id, ok: true });
        return;
      }
      case "saved":
        for (const p of req.paths) original[p] = project!.files[p]!;
        break;
      case "meta":
        if (persist) persist = { ...persist, unsaved: req.unsaved, folder: req.folder };
        break;
      case "synced":
        if (req.reset || !synced) synced = {};
        for (const p of req.paths) {
          if (project!.files[p] === undefined) delete synced[p];
          else synced[p] = project!.files[p]!;
        }
        break;
      case "unlink":
        synced = undefined;
        break;
      case "link": {
        // Nothing to analyze again: just keep the new link (and the address a reload opens it from).
        if (persist) {
          const links = { ...persist.links };
          if (req.value === undefined) delete links[req.ext];
          else links[req.ext] = req.value;
          persist = { ...persist, links, ...(req.deepLink !== undefined && { link: req.deepLink ?? undefined }), ...(req.saved && { unsaved: false }) };
        }
        keep(true);
        self.postMessage({ id: req.id, ok: true });
        return;
      }
      case "merge":
        // Files from the link's remote (e.g. pulled). The history can't undo across them.
        for (const [p, text] of Object.entries(req.files)) {
          if (text === null) {
            delete project!.files[p];
            delete synced?.[p];
          } else {
            project!.files[p] = text;
            if (synced) synced[p] = text;
          }
        }
        undo.length = redo.length = 0;
        break;
    }
    // Edits, undo and redo come in bursts; a save, a sync or new metadata is stored at once.
    keep(!(req.type === "edit" || req.type === "undo" || req.type === "redo"));
    self.postMessage({ id: req.id, ok: true, ...state() });
  } catch (e) {
    self.postMessage({ id: req.id, ok: false, error: (e as Error).message });
  }
};

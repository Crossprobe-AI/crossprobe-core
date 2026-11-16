/**
 * Unsaved changes survive a page refresh or navigating away by accident.
 *
 * The analysis worker writes the open project's changes to IndexedDB after
 * every edit, keyed by an id kept in sessionStorage, so each tab has its own
 * copy that lives about as long as the tab does. Only the changes are kept:
 * the files as last saved, and the current text of the files that differ.
 * Undo history and the view (sheet, zoom, selection) are not kept.
 *
 * A project an extension links somewhere (a repository, an account) keeps
 * the links too, and the texts last synced with the link, so it can still be
 * synced after a reload. A project with a synced baseline is also kept when
 * it only has changes not yet synced (saved to its folder already).
 */
import type { ProjectLinks } from "./extensions/api";

/** What is stored for a tab's open project. */
export interface StoredProject {
  tab: string;
  /** Path of the .kicad_pro, relative to the project folder. */
  project: string;
  /** Project-relative path → text as last saved (empty for a project never saved). */
  original: Record<string, string>;
  /** Current text of the files that differ from `original`; null for a file that no longer exists. */
  changed: Record<string, string | null>;
  /** Never saved anywhere: saving asks where to put it. */
  unsaved: boolean;
  /** The folder the project was opened from (or saved to), so saving can write there again. */
  folder?: StoredFolder;
  /** The deep link (?demo=… or ?block=…) the project was opened from, if any. */
  link?: string;
  /** Extensions' links to the project, by extension id. */
  links?: ProjectLinks;
  /** The texts last synced with a link, where they differ from `original`; null for a file `original` has and the link doesn't. */
  synced?: Record<string, string | null>;
  savedAt: number;
}

export interface StoredFolder {
  dir: FileSystemDirectoryHandle;
  /** Path of the project folder inside `dir`, ending in "/" (or ""). */
  base: string;
}

/** Details of the open project the worker needs to store it. */
export interface PersistMeta {
  tab: string;
  unsaved: boolean;
  folder?: StoredFolder;
  link?: string;
  links?: ProjectLinks;
}

/** `files` as differences from `base`: changed and new texts, null for a file that is gone. */
function diff(files: Record<string, string>, base: Record<string, string>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [f, t] of Object.entries(files)) if (t !== undefined && t !== base[f]) out[f] = t;
  for (const f of Object.keys(base)) if (files[f] === undefined) out[f] = null;
  return out;
}

function patch(base: Record<string, string>, changes: Record<string, string | null>): Record<string, string> {
  const files: Record<string, string> = { ...base };
  for (const [f, t] of Object.entries(changes)) {
    if (t === null) delete files[f];
    else files[f] = t;
  }
  return files;
}

/**
 * The record for the project as it is now; undefined when there is nothing to keep
 * (nothing unsaved and, with a synced baseline, nothing left to sync).
 * `synced` is what was last synced with a link, when there is one.
 */
export function toStored(
  project: string,
  files: Record<string, string>,
  original: Record<string, string>,
  meta: PersistMeta,
  synced?: Record<string, string>,
): StoredProject | undefined {
  const changed = diff(files, original);
  const links = meta.links && Object.keys(meta.links).length ? meta.links : undefined;
  // A synced baseline only means something while a link is kept with it.
  const base = links && synced;
  if (!Object.keys(changed).length && !(base && Object.keys(diff(files, base)).length)) return undefined;
  return { tab: meta.tab, project, original, changed, unsaved: meta.unsaved, folder: meta.folder, link: meta.link, links, synced: base ? diff(base, original) : undefined, savedAt: Date.now() };
}

/** The project's current files, back from a stored record. */
export function fromStored(s: StoredProject): Record<string, string> {
  return patch(s.original, s.changed);
}

/** What was last synced with a link, back from a stored record. */
export function syncedFromStored(s: StoredProject): Record<string, string> | undefined {
  return s.synced && patch(s.original, s.synced);
}

/** A record kept by an earlier version, which stored the GitHub and account links in fields of their own. */
interface LegacyRecord {
  git?: { link: unknown; synced: Record<string, string | null> };
  cloud?: unknown;
}

/** A stored record in the current form (older records are converted). */
export function upgradeStored(s: StoredProject & LegacyRecord): StoredProject {
  if (!s.git && !s.cloud) return s;
  const { git, cloud, ...rest } = s;
  return { ...rest, links: { ...rest.links, ...(git && { github: git.link }), ...(cloud !== undefined && { cloud }) }, synced: rest.synced ?? git?.synced };
}

const DB = "crossprobe";
const STORE = "projects";
/** Records of tabs closed long ago are dropped. */
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "tab" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = f(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
    });
  } finally {
    d.close();
  }
}

export const readStored = (tab: string) => run<(StoredProject & LegacyRecord) | undefined>("readonly", (s) => s.get(tab)).then((r) => r && upgradeStored(r));
export const writeStored = (p: StoredProject) => run("readwrite", (s) => s.put(p)).then(() => undefined);
export const deleteStored = (tab: string) => run("readwrite", (s) => s.delete(tab)).then(() => undefined);

/** Drop records older than a week (tabs that were closed). */
export async function pruneStored(now = Date.now()) {
  const all = await run<StoredProject[]>("readonly", (s) => s.getAll());
  await Promise.all(all.filter((p) => now - p.savedAt > MAX_AGE_MS).map((p) => deleteStored(p.tab)));
}

/** This tab's id: kept in sessionStorage, so it survives reloads but not closing the tab. */
export function tabId(): string {
  try {
    let id = sessionStorage.getItem("crossprobe.tab");
    if (!id) sessionStorage.setItem("crossprobe.tab", (id = crypto.randomUUID()));
    return id;
  } catch {
    // No sessionStorage (e.g. blocked): changes are kept for this page only.
    return crypto.randomUUID();
  }
}

/**
 * Coalesces writes: the latest state is written once the previous write is
 * done and `delay` ms have passed, so a burst of edits costs one write.
 */
export function writer(delay = 300) {
  let latest: { tab: string; record?: StoredProject } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    timer = undefined;
    const job = latest;
    latest = undefined;
    if (!job) return busy;
    return (busy = busy
      .then(() => (job.record ? writeStored(job.record) : deleteStored(job.tab)))
      .catch((e) => console.warn("Could not keep unsaved changes for this tab:", e)));
  };
  return {
    /**
     * Store this record for the tab soon (undefined: delete the tab's record); `now` writes it
     * at once, for changes that are not part of a burst of edits (a save, a new link), so a
     * reload right after them can't bring back what came before.
     */
    write(tab: string, record: StoredProject | undefined, now = false) {
      latest = { tab, record };
      if (now) {
        clearTimeout(timer);
        void flush();
      } else timer ??= setTimeout(flush, delay);
    },
    /** Delete the tab's record now, after any write in progress; resolves when done. */
    forget(tab: string): Promise<void> {
      clearTimeout(timer);
      latest = { tab };
      return flush();
    },
  };
}

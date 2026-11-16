/** Getting project files into the browser: folder picker, drag & drop, and dev demos. */
import { zipSync } from "fflate";
import { newProject, projectFileName } from "@crossprobe/kicad-model";
import type { ProjectFiles } from "./analyze";
import type { ProjectView } from "./render/types";
import { projectFromBlock } from "./block-project";
import type { EditOp } from "./edit/ops";
import type { BlockManifest } from "@crossprobe/kicad-model";
import { fromStored, syncedFromStored, type PersistMeta, type StoredFolder, type StoredProject } from "./persist";
import type { ProjectLinks } from "./extensions/api";

/** The files a project is read from (shared with the GitHub loader and the MCP server). */
export const KICAD_FILE = /(\.kicad_(sch|pcb|pro|sym|dru|mod)|sym-lib-table|fp-lib-table|\.crossprobe-(evidence|requirements)\.json)$/;
export const MODEL_FILE = /\.(step|stp|wrl)$/i;

export interface ModelData {
  buffer: ArrayBuffer;
  format: "step" | "wrl";
}

/** Fetches a footprint's 3D model by the path written in the board file. */
export type ModelSource = (path: string) => Promise<ModelData | undefined>;

export interface LoadedProject {
  files: ProjectFiles;
  models: ModelSource;
  /** Writes a project-relative file back to where it came from, when the browser allows it. */
  write?: (path: string, text: string) => Promise<void>;
  /** A new project that has not been saved anywhere yet. */
  unsaved?: boolean;
  /** The folder it was opened from, kept so saving can write there again after a reload. */
  folder?: StoredFolder;
  /** Restored after a reload: the files as last saved (the project's `files` hold the unsaved changes). */
  original?: Record<string, string>;
  /** Opened through an extension (or restored linked to it): its link to the project, by extension id. */
  links?: ProjectLinks;
  /** The texts last synced with a link. Restored: what was kept. Freshly opened from a link: undefined, and `syncAll` says every file matches. */
  synced?: Record<string, string>;
  /** Freshly opened from a link: every file matches it (the session starts the synced baseline from them). */
  syncAll?: boolean;
}

/** Is the File System Access API (read/write folders) available? Chromium-based browsers. */
export const canWriteFolders = () => typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

type DirHandle = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };

/** Open a folder with write access (File System Access API). Saving writes the files back in place. */
export async function fromDirectoryPicker(): Promise<LoadedProject> {
  const dir = (await (window as unknown as { showDirectoryPicker(o: object): Promise<DirHandle> }).showDirectoryPicker({ mode: "readwrite" })) as DirHandle;
  const entries: Entry[] = [];
  const handles = new Set<string>();
  const walk = async (d: DirHandle, prefix: string, depth: number) => {
    if (depth > 4) return;
    for await (const h of d.values()) {
      if (h.kind === "directory") {
        if (!h.name.startsWith(".") && h.name !== "node_modules") await walk(h as DirHandle, `${prefix}${h.name}/`, depth + 1);
      } else if (KICAD_FILE.test(h.name) || MODEL_FILE.test(h.name)) {
        const fh = h as FileSystemFileHandle;
        handles.add(prefix + h.name);
        entries.push({ path: prefix + h.name, file: await fh.getFile() });
      }
    }
  };
  await walk(dir, "", 0);
  const project = await toProject(entries);
  // Paths in the project are relative to the .kicad_pro's folder.
  const proPath = [...handles].find((p) => p.endsWith(project.files.project));
  const base = proPath ? proPath.slice(0, proPath.length - project.files.project.length) : "";
  const folder = { dir, base };
  return { ...project, write: folderWriter(folder), folder };
}

/** Writes project-relative files into the folder, creating new files (e.g. a new sheet) and their folders. */
export function folderWriter({ dir, base }: StoredFolder): NonNullable<LoadedProject["write"]> {
  return async (path, text) => {
    let d = dir;
    const parts = (base + path).split("/");
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const h = await d.getFileHandle(parts[parts.length - 1]!, { create: true });
    const w = await (h as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    await w.write(text);
    await w.close();
  };
}

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
};

/**
 * Write access to a folder kept from before a reload. Without `ask` it only
 * checks; asking shows the browser's prompt and needs a click to start it.
 */
export async function folderAccess(folder: StoredFolder, ask: boolean): Promise<boolean> {
  const dir = folder.dir as PermissionHandle;
  try {
    if ((await dir.queryPermission({ mode: "readwrite" })) === "granted") return true;
    return ask && (await dir.requestPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/** A project's unsaved changes, kept from before the page was reloaded. */
export function fromStoredProject(s: StoredProject): LoadedProject {
  // The models were in the folder the browser no longer lets us read without asking; the library still works.
  return {
    files: { project: s.project, files: fromStored(s) },
    models: libraryModel,
    unsaved: s.unsaved,
    folder: s.folder,
    original: s.original,
    links: s.links,
    synced: syncedFromStored(s),
  };
}

/** KiCad library symbols available to place (served at /__demos from KiCad's installed libraries). */
export async function kicadSymbolIndex(): Promise<Array<{ library: string; name: string; description: string; keywords: string; prefix: string; power: boolean; pins: number }>> {
  try {
    const r = await fetch("/__demos/symindex");
    return r.ok ? await r.json() : [];
  } catch {
    return [];
  }
}

export async function kicadSymbol(library: string, name: string): Promise<string> {
  const r = await fetch(`/__demos/symbol?lib=${encodeURIComponent(library)}&name=${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`Symbol ${library}:${name} not available`);
  return r.text();
}

/**
 * The open project's own footprint libraries (fp-lib-table): they come first wherever a footprint
 * is looked up by "Library:Name", as in KiCad.
 */
let projectFootprints: ProjectView["projectFootprints"] = [];
export function setProjectFootprints(list: ProjectView["projectFootprints"]): void {
  projectFootprints = list;
}

/** KiCad library footprints as "Library:Name" (dev server only for now), the project's own first. */
let installedIndex: Promise<string[]> | undefined;
let installedPads: Promise<Record<string, number>> | undefined;
export async function kicadFootprintIndex(): Promise<string[]> {
  const own = projectFootprints.map((f) => f.libId);
  installedIndex ??= fetch("/__demos/fpindex")
    .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
    .catch(() => []);
  return [...own, ...(await installedIndex).filter((id) => !own.includes(id))];
}

/** Is this one of the open project's own footprints (it may change as it's edited)? */
export const isProjectFootprint = (libId: string) => projectFootprints.some((f) => f.libId === libId);

/** Pad count per library footprint ("Library:Name" → pads), for the pin-count filter; empty when unavailable. */
export async function kicadFootprintPads(): Promise<Record<string, number>> {
  const own = Object.fromEntries(projectFootprints.map((f) => [f.libId, f.pads]));
  installedPads ??= fetch("/__demos/fppads")
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, number>>) : {}))
    .catch(() => ({}));
  return { ...(await installedPads), ...own };
}

/** A KiCad library footprint's .kicad_mod text, or undefined if it isn't available. */
export async function kicadFootprint(libId: string): Promise<string | undefined> {
  const own = projectFootprints.find((f) => f.libId === libId);
  if (own) return own.text;
  const [lib, name] = libId.split(":");
  if (!lib || !name) return undefined;
  try {
    const r = await fetch(`/__demos/footprint?lib=${encodeURIComponent(lib)}&name=${encodeURIComponent(name)}`);
    return r.ok ? await r.text() : undefined;
  } catch {
    return undefined;
  }
}

/** A new project in memory with a design block in its schematic; saving asks where to put it. */
export async function fromBlock(id: string): Promise<LoadedProject> {
  const manifest = await blockManifest(id);
  const [text, pcb] = await Promise.all([blockSchematic(id), manifest.layout ? blockBoard(id) : undefined]);
  return { files: projectFromBlock(manifest.id, text, pcb, manifest.title), models: libraryModel, unsaved: true };
}

/** A new, empty project in memory; saving asks where to put it. */
export function fromNewProject(name: string): LoadedProject {
  const { project, files } = newProject(name);
  return { files: { project, files }, models: libraryModel, unsaved: true };
}

/**
 * Ask for a parent folder and create the project folder in it (File System
 * Access API). Returns a writer for project-relative paths.
 */
export async function createProjectFolder(name: string): Promise<StoredFolder> {
  const parent = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: "readwrite" });
  return { dir: await parent.getDirectoryHandle(projectFileName(name), { create: true }), base: "" };
}

/** Download several files as one zip. */
export function downloadZip(name: string, files: Record<string, string | Uint8Array>) {
  const enc = new TextEncoder();
  const data = zipSync(Object.fromEntries(Object.entries(files).map(([p, t]) => [p, typeof t === "string" ? enc.encode(t) : t])));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data as BlobPart], { type: "application/zip" }));
  a.download = name.endsWith(".zip") ? name : `${name}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Fallback save: download a file. */
export function downloadFile(path: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = path.split("/").pop() ?? path;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const formatOf = (name: string): ModelData["format"] => (name.toLowerCase().endsWith(".wrl") ? "wrl" : "step");

async function fetchModel(url: string): Promise<ModelData | undefined> {
  try {
    const r = await fetch(url);
    if (!r.ok || r.status === 204) return undefined;
    return { buffer: await r.arrayBuffer(), format: (r.headers.get("X-Model-Format") as ModelData["format"]) ?? "step" };
  } catch {
    return undefined;
  }
}

/** Library models (${KICADn_3DMODEL_DIR}) via the dev server, when it is there. */
export const libraryModel: ModelSource = (path) => fetchModel(`/__demos/libmodel?path=${encodeURIComponent(path)}`);

/** Models from the opened folder (${KIPRJMOD} or relative paths), else the library. */
function folderModels(assets: Map<string, File>): ModelSource {
  return async (raw) => {
    const rel = raw.replace(/^\$\{KIPRJMOD\}\//, "");
    if (!rel.startsWith("$") && !rel.startsWith("/")) {
      for (const candidate of [rel, rel.replace(/\.wrl$/i, ".step"), rel.replace(/\.(step|stp)$/i, ".wrl")]) {
        const file = assets.get(candidate);
        if (file) return { buffer: await file.arrayBuffer(), format: formatOf(candidate) };
      }
    }
    return libraryModel(raw);
  };
}

export interface Entry {
  path: string;
  file: File;
}

/** Pick the project folder: the shallowest .kicad_pro, files relative to its folder. */
async function toProject(entries: Entry[]): Promise<LoadedProject> {
  const pros = entries.filter((e) => e.path.endsWith(".kicad_pro")).sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  const pro = pros[0];
  if (!pro) throw new Error("No .kicad_pro file found in the selection");
  const dir = pro.path.includes("/") ? pro.path.slice(0, pro.path.lastIndexOf("/") + 1) : "";
  const inside = entries.filter((e) => e.path.startsWith(dir));
  const pairs = await Promise.all(
    inside.filter((e) => KICAD_FILE.test(e.path)).map(async (e) => [e.path.slice(dir.length), await e.file.text()] as const),
  );
  const assets = new Map(inside.filter((e) => MODEL_FILE.test(e.path)).map((e) => [e.path.slice(dir.length), e.file] as const));
  return { files: { project: pro.path.slice(dir.length), files: Object.fromEntries(pairs) }, models: folderModels(assets) };
}

/** Files from anywhere (e.g. an unpacked .zip), with paths relative to the selection. */
export const fromEntries = (entries: Entry[]): Promise<LoadedProject> => toProject(entries);

export function fromFileList(list: FileList): Promise<LoadedProject> {
  return toProject([...list].map((file) => ({ path: file.webkitRelativePath || file.name, file })));
}

/** Folder drag & drop, walking directory entries. */
export async function fromDrop(items: DataTransferItemList): Promise<LoadedProject> {
  const out: Entry[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ path: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children: FileSystemEntry[] = [];
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        children.push(...batch);
      }
      await Promise.all(children.map((c) => walk(c, `${prefix}${entry.name}/`)));
    }
  };
  const entries = [...items].map((i) => i.webkitGetAsEntry()).filter((e): e is FileSystemEntry => !!e);
  await Promise.all(entries.map((e) => walk(e, "")));
  return toProject(out);
}

export interface Demo {
  name: string;
  project: string;
}

export async function listDemos(): Promise<Demo[]> {
  try {
    const r = await fetch("/__demos");
    return r.ok ? ((await r.json()) as Demo[]) : [];
  } catch {
    return [];
  }
}

export async function fromDemo(demo: Demo): Promise<LoadedProject> {
  const r = await fetch(`/__demos/files?project=${encodeURIComponent(demo.project)}`);
  const { root, files } = (await r.json()) as { root: string; files: string[] };
  const texts = await Promise.all(
    files.map(async (f) => [f, await (await fetch(`/__demos/file?path=${encodeURIComponent(`${root}/${f}`)}`)).text()] as const),
  );
  return {
    files: { project: demo.project.slice(root.length + 1), files: Object.fromEntries(texts) },
    models: (path) => fetchModel(`/__demos/model?project=${encodeURIComponent(demo.project)}&path=${encodeURIComponent(path)}`),
  };
}

export interface SessionState {
  project: ProjectView;
  /** Project-relative paths of files changed since opening (or the last save). */
  dirty: string[];
  /** With a synced baseline (a link that syncs files): files that differ from it. */
  unsynced?: string[];
  /** Labels of the next undo / redo steps, when there are any. */
  undo?: string;
  redo?: string;
  /** The board changed since its zones were last filled (undo and redo included). */
  zonesStale: boolean;
}

/**
 * The open project, living in a persistent worker: analysis, edits, undo/redo.
 * Requests are queued so results come back in order.
 */
export class Session {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private next = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; error?: string }>) => {
      const p = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      if (e.data.ok) p?.resolve(e.data);
      else p?.reject(new Error(e.data.error));
    };
  }

  private send<T>(msg: Record<string, unknown>): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  open(files: ProjectFiles, unsaved = false, opts: { original?: Record<string, string>; synced?: Record<string, string>; persist?: PersistMeta } = {}) {
    return this.send<SessionState>({ type: "open", files, unsaved, ...opts });
  }
  /** Tell the worker what it stores with the changes: saved yet, and the folder to save to. */
  meta(unsaved: boolean, folder?: StoredFolder) {
    return this.send<SessionState>({ type: "meta", unsaved, folder });
  }
  edit(ops: EditOp[]) {
    return this.send<SessionState>({ type: "edit", ops });
  }
  undo() {
    return this.send<SessionState>({ type: "undo" });
  }
  redo() {
    return this.send<SessionState>({ type: "redo" });
  }
  /** File texts (all files without `paths`); a deleted file comes back undefined. */
  files(paths?: string[]) {
    return this.send<{ files: Record<string, string> }>({ type: "files", paths }).then((r) => r.files);
  }
  markSaved(paths: string[]) {
    return this.send<SessionState>({ type: "saved", paths });
  }
  /** Stop keeping this project's changes for the tab, and delete what was kept. */
  forget() {
    return this.send<unknown>({ type: "forget" }).then(() => undefined);
  }
  /** These files now match the link's remote; `reset` starts a new baseline (all other files count as not there). */
  markSynced(paths: string[], reset = false) {
    return this.send<SessionState>({ type: "synced", paths, reset });
  }
  /**
   * An extension's link to the project was made, moved or dropped (value undefined): kept with the changes over a reload.
   * deepLink: the address the project reopens from now (null: none). saved: it no longer counts as never saved.
   */
  setLink(ext: string, value: unknown, opts: { deepLink?: string | null; saved?: boolean } = {}) {
    return this.send<unknown>({ type: "link", ext, value, ...opts }).then(() => undefined);
  }
  /** Nothing is synced with a link any more. */
  unlink() {
    return this.send<SessionState>({ type: "unlink" });
  }
  /** Put files from the link's remote (e.g. pulled) into the project (null deletes). */
  merge(files: Record<string, string | null>) {
    return this.send<SessionState>({ type: "merge", files });
  }
  dispose() {
    this.worker.terminate();
  }
}

/** A design block as listed in the library (see blocks/README.md). */
export interface BlockSummary {
  id: string;
  title: string;
  description: string;
  category: string;
  status: "draft" | "reviewed";
  keywords: string[];
  license: string;
  reviewedBy?: string;
  reviewedAt?: string;
  parts: number;
  checklist: number;
}

export async function blockIndex(): Promise<BlockSummary[]> {
  try {
    const r = await fetch("/__blocks/index.json");
    return r.ok ? ((await r.json()) as BlockSummary[]) : [];
  } catch {
    return [];
  }
}

/** The block's schematic text, ready for the insertBlock operation. */
export async function blockSchematic(id: string): Promise<string> {
  const r = await fetch(`/__blocks/${encodeURIComponent(id)}.kicad_sch`);
  if (!r.ok) throw new Error(`Block ${id} is not available`);
  return r.text();
}

/** The block's PCB layout (.kicad_pcb text), for blocks that have one. */
export async function blockBoard(id: string): Promise<string> {
  const r = await fetch(`/__blocks/${encodeURIComponent(id)}.kicad_pcb`);
  if (!r.ok) throw new Error(`The layout of ${id} is not available`);
  return r.text();
}

/** Sources, review status, parts and checklist of a block. */
export async function blockManifest(id: string): Promise<BlockManifest> {
  const r = await fetch(`/__blocks/${encodeURIComponent(id)}.crossprobe.json`);
  if (!r.ok) throw new Error(`Block ${id} is not available`);
  return (await r.json()) as BlockManifest;
}

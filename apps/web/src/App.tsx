import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { boardFrame, landPatternText, newFootprintText, newSymbolNode, withLibrarySymbol, withUuids } from "@crossprobe/kicad-model";
import { arg as sexprArg, parse as parseSexpr, setArg as setSexprArg, str as sexprStr } from "@crossprobe/kicad-sexpr";
import { SymbolEditor } from "./ui/SymbolEditor";
import { assistant, Fill, installed, Slot, SlotProvider, type AppHost, type Cited, type Contribution, type DraftPart, type SaveAction, type ProjectLinks } from "./extensions";
import {
  canWriteFolders,
  createProjectFolder,
  downloadFile,
  downloadZip,
  blockManifest,
  fromBlock,
  fromNewProject,
  kicadFootprint,
  setProjectFootprints,
  kicadSymbol,
  folderAccess,
  folderWriter,
  fromDemo,
  fromDirectoryPicker,
  fromStoredProject,
  fromDrop,
  fromFileList,
  listDemos,
  Session,
  type Demo,
  type LoadedProject,
  type ModelSource,
  type SessionState,
} from "./load";
import type { EditOp } from "./edit/ops";
import { deleteStored, pruneStored, readStored, tabId, type StoredFolder, type StoredProject } from "./persist";
import type { EditContext, Tool } from "./ui/SchematicView";
import type { ProjectView } from "./render/types";
import { BoardView, type BoardTool } from "./ui/BoardView";
import { UpdatePcb } from "./ui/UpdatePcb";
import { FootprintPicker, type PlacingFootprint } from "./ui/FootprintPicker";
import { AssignFootprints } from "./ui/FootprintChooser";
import { FieldsTable } from "./ui/FieldsTable";
import { PlotPanel } from "./ui/PlotPanel";
import { NetInspector } from "./ui/NetInspector";
import { UpdateSchematic } from "./ui/UpdateSchematic";
import { PageSettingsDialog } from "./ui/PageSettings";
import { CleanupTracks } from "./ui/CleanupTracks";
import { LibraryCheck } from "./ui/LibraryCheck";
import { Annotate } from "./ui/Annotate";
import { FindReplace } from "./ui/FindReplace";
import { netlistFile } from "./netlist-file";
import { BoardReannotate } from "./ui/BoardReannotate";
import { BoardStats } from "./ui/BoardStats";
import { FootprintEditor } from "./ui/FootprintEditor";
import { FabExport } from "./ui/FabExport";
import { BoardSetup } from "./ui/BoardSetup";
import { Icon } from "./ui/icons";
import { Logo } from "./ui/Logo";
import { StatusBar } from "./ui/StatusBar";
import { Inspector, type Tab as InspectorTab } from "./ui/Inspector";
import { BlockPicker } from "./ui/BlockPicker";
import { ProjectMenu } from "./ui/ProjectMenu";
import { PartPicker } from "./ui/PartPicker";
import { nextReferences, SchematicView } from "./ui/SchematicView";
import type { Selection } from "./ui/selection";
import { DEFAULT_LAYERS, LayerList, SELECTABLE, SheetTree } from "./ui/Sidebars";

type Mode = "schematic" | "board" | "3d";

/** The deep link a project is opened from (an extension's, ?block=… or ?demo=…), compared with a kept project's. */
function deepLink(params: URLSearchParams): string | undefined {
  for (const e of installed) {
    const link = e.deepLink?.(params);
    if (link) return link;
  }
  const block = params.get("block");
  if (block) return `block=${block}`;
  const demo = params.get("demo");
  return demo ? `demo=${demo}` : undefined;
}

// three.js is large; load the 3D view only when it is opened.
const Board3DView = lazy(() => import("./ui/Board3DView").then((m) => ({ default: m.Board3DView })));

/** A project kept over a reload; an extension may take its 3D models from where it is linked again. */
function restoredProject(kept: StoredProject): LoadedProject {
  return installed.reduce((loaded, e) => (e.restore ? e.restore(kept, loaded) : loaded), fromStoredProject(kept));
}

/** What App passes to each extension's Root, before it is narrowed to the extension's own link. */
type SharedHost = Omit<AppHost, "link" | "setLink" | "contribute"> & {
  links: ProjectLinks;
  setLink(id: string, value: unknown, opts?: { deepLink?: string | null; saved?: boolean }): Promise<void>;
  contribute(id: string, c: Contribution): void;
};

/** An extension's Root, given a host that sees only its own link and contributions. */
function ExtensionRoot({ id, Root, host }: { id: string; Root: NonNullable<(typeof installed)[number]["Root"]>; host: SharedHost }) {
  const { links, setLink, contribute, ...shared } = host;
  const own = useMemo(
    () => ({
      setLink: (value: unknown, opts?: { deepLink?: string | null; saved?: boolean }) => setLink(id, value, opts),
      contribute: (c: Contribution) => contribute(id, c),
    }),
    [id, setLink, contribute],
  );
  return <Root host={{ ...shared, link: links[id], ...own }} />;
}

export function App() {
  const [project, setProject] = useState<ProjectView>();
  // The latest analysis, for long-running tasks that read the design as it changes.
  const projectRef = useRef<ProjectView | undefined>(undefined);
  projectRef.current = project;
  const [models, setModels] = useState<ModelSource>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [demos, setDemos] = useState<Demo[]>([]);
  const [mode, setMode] = useState<Mode>("schematic");
  const [sheetPath, setSheetPath] = useState<string>("");
  const [selection, setSelection] = useState<Selection>(null);
  // Bumped when a selection made outside a view (inspector, lists) should be zoomed to.
  const [focusToken, setFocusToken] = useState(0);
  const [reveal, setReveal] = useState<{ token: number; refs: string[] }>();
  /** References that existed before an insert, so the new parts can be framed once the analysis arrives. */
  const beforeInsert = useRef<Set<string>>(undefined);
  const [flipped, setFlipped] = useState(false);
  const [layers, setLayers] = useState<Set<string>>(new Set());
  // The project's own footprint libraries are where footprints are looked up first.
  if (project) setProjectFootprints(project.projectFootprints);
  // Copper layers added later (Board setup's layer count) show up, as the ones there at opening did.
  const copperKey = project?.board?.copperLayers.join(",") ?? "";
  const seenCopper = useRef<string>("");
  useEffect(() => {
    if (!copperKey) return;
    const before = new Set(seenCopper.current.split(",").filter(Boolean));
    seenCopper.current = copperKey;
    const added = copperKey.split(",").filter((l) => !before.has(l));
    if (before.size && added.length) setLayers((v) => new Set([...v, ...added]));
  }, [copperKey]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const session = useRef<Session | undefined>(undefined);
  const writer = useRef<LoadedProject["write"]>(undefined);
  // A new project not yet saved anywhere: the first save asks for a folder (or downloads a zip).
  const isNew = useRef(false);
  /** This tab's id for keeping unsaved changes over a reload (see persist.ts). */
  const tab = useMemo(tabId, []);
  /** The folder the project saves into, kept with the changes. */
  const folder = useRef<StoredFolder>(undefined);
  /** Restored after a reload into a folder the browser wants permission for again: Save asks. */
  const [needsAccess, setNeedsAccess] = useState(false);
  /** Changes kept from before a reload were restored: offer to discard them. */
  const [restored, setRestored] = useState<StoredProject>();
  /** Has the start-up check for kept changes finished, and did it restore a project? */
  const [startup, setStartup] = useState<"checking" | "restored" | "none">("checking");
  // Bumped per opened project, so views start fresh (and frame the new design).
  const [openCount, setOpenCount] = useState(0);
  const [newName, setNewName] = useState("");
  const [dirty, setDirty] = useState<string[]>([]);
  const [history, setHistory] = useState<{ undo?: string; redo?: string }>({});
  // Extensions' links to the open project (a repository, a stored project), by extension id, and files not yet synced with one.
  const [links, setLinks] = useState<ProjectLinks>({});
  const [unsynced, setUnsynced] = useState<string[]>([]);
  // What each extension asked the app to draw (Save, the project menu's label), by extension id.
  const [contributions, setContributions] = useState<Record<string, Contribution>>({});
  /** Path of the open project's .kicad_pro. */
  const projectPath = useRef("");
  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  // Bumped whenever a tool is chosen (again), so A reopens the full part picker.
  const [pickerOpen, setPickerOpen] = useState(0);
  const chooseTool = useCallback((t: Tool) => {
    setTool(t);
    setPickerOpen((n) => n + 1);
  }, []);
  const [busy, setBusy] = useState(false);
  const [placing, setPlacing] = useState<EditContext["placing"]>();
  const [wideInspector, setWideInspector] = useState(false);
  const [placingBlock, setPlacingBlock] = useState<EditContext["placingBlock"]>();
  const [boardTool, setBoardTool] = useState<BoardTool>("select");
  const [boardLayer, setBoardLayer] = useState("F.Cu");
  const [trackWidth, setTrackWidth] = useState(0); // 0 = the net's net class
  const [viaType, setViaType] = useState<"through" | "blind" | "micro">("through");
  const [grid, setGrid] = useState(0.25);
  // KiCad's selection filter for the PCB editor (everything selectable at first).
  const [selectable, setSelectable] = useState<Set<string>>(() => new Set(SELECTABLE.map(([k]) => k)));
  const [showUpdate, setShowUpdate] = useState(false);
  const [placingFootprint, setPlacingFootprint] = useState<PlacingFootprint>();
  const [zoneNetChoice, setZoneNet] = useState<string>();
  const [showAssign, setShowAssign] = useState(false);
  const [showFields, setShowFields] = useState(false);
  const [showPlot, setShowPlot] = useState(false);
  const [showNets, setShowNets] = useState(false);
  const [showUpdateSch, setShowUpdateSch] = useState(false);
  const [showCleanup, setShowCleanup] = useState(false);
  const [showLibCheck, setShowLibCheck] = useState(false);
  /** Current file texts, for dialogs that need a file as written (stable, so their effects don't rerun). */
  const readBoardFiles = useCallback((paths: string[]) => session.current!.files(paths), []);
  const [showReannotate, setShowReannotate] = useState(false);
  const [showAnnotate, setShowAnnotate] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [showStats, setShowStats] = useState(false);
  /** The sheet file or board whose page settings are open. */
  const [pageFile, setPageFile] = useState<string>();
  const [showFab, setShowFab] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  /** One floating panel at a time: opening one closes the others (and the part/block pickers behind a dialog). */
  const openPanel = useCallback((name: "setup" | "fab" | "update" | "assign" | "fields" | "plot" | "nets" | "updateSch" | "cleanup" | "reannotate" | "libcheck") => {
    setShowSetup((v) => (name === "setup" ? !v : false));
    setShowFab(name === "fab");
    setShowUpdate((v) => (name === "update" ? !v : false));
    setShowAssign(name === "assign");
    setShowFields(name === "fields");
    setShowPlot(name === "plot");
    setShowNets(name === "nets");
    setShowUpdateSch((v) => (name === "updateSch" ? !v : false));
    setShowCleanup((v) => (name === "cleanup" ? !v : false));
    setShowLibCheck((v) => (name === "libcheck" ? !v : false));
    setShowReannotate((v) => (name === "reannotate" ? !v : false));
    if (name === "assign") setTool("select");
  }, []);
  const [outlineMode, setOutlineMode] = useState<"rect" | "poly">("rect");
  const [cornerRadius, setCornerRadius] = useState(0);
  const [inspectorTab, setInspectorTab] = useState<{ tab: InspectorTab }>();

  // Zone fills go stale with board edits until they're refilled. The worker keeps track, undo included.
  const [zonesStale, setZonesStale] = useState(false);
  // The board's page frame: its drawing sheet, else the default one, with its title block.
  const boardPageFrame = useMemo(
    () => (project?.board?.page ? boardFrame(project.board.page, (project.boardFile ?? "").split("/").pop() ?? "", project.boardDrawingSheet, { variables: project.textVariables }) : undefined),
    [project?.board?.page, project?.boardFile, project?.boardDrawingSheet, project?.textVariables],
  );
  /** Take a fresh analysis from the worker, keeping the user's place. */
  const applyState = useCallback((st: SessionState) => {
    setProject(st.project);
    setZonesStale(st.zonesStale);
    setDirty(st.dirty);
    setUnsynced(st.unsynced ?? []);
    setHistory({ undo: st.undo, redo: st.redo });
  }, []);

  const runSession = useCallback(
    async (f: (s: Session) => Promise<SessionState>) => {
      if (!session.current) return;
      setBusy(true);
      try {
        applyState(await f(session.current));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [applyState],
  );
  const edit = useCallback((ops: EditOp[]) => runSession((s) => s.edit(ops)), [runSession]);
  // After "Insert in free space" the block sits below the page: bring the new parts into view.
  useEffect(() => {
    const before = beforeInsert.current;
    if (!before || !project) return;
    const fresh = project.references.filter((r) => !before.has(r));
    if (!fresh.length) return;
    beforeInsert.current = undefined;
    setReveal((r) => ({ token: (r?.token ?? 0) + 1, refs: fresh }));
  }, [project]);
  const undo = useCallback(() => runSession((s) => s.undo()), [runSession]);
  const redo = useCallback(() => runSession((s) => s.redo()), [runSession]);

  /** Save changed files: in place when the folder was opened writable, else as downloads. */
  const saveLocally = useCallback(async () => {
    if (!session.current || !dirty.length) return;
    try {
      // Restored after a reload: the browser asks again before letting us write the folder.
      if (!writer.current && folder.current && needsAccess) {
        if (await folderAccess(folder.current, true)) writer.current = folderWriter(folder.current);
        setNeedsAccess(false);
      }
      if (isNew.current && !writer.current) {
        const name = project?.name ?? "untitled";
        if (canWriteFolders()) {
          folder.current = await createProjectFolder(name);
          writer.current = folderWriter(folder.current);
        } else {
          downloadZip(name, await session.current.files(dirty));
          applyState(await session.current.markSaved(dirty));
          return;
        }
      }
      const files = await session.current.files(dirty);
      for (const [path, text] of Object.entries(files)) {
        if (writer.current) await writer.current(path, text);
        else downloadFile(path, text);
      }
      applyState(await session.current.markSaved(dirty));
      setStatus(writer.current ? `Saved ${dirty.length} file${dirty.length > 1 ? "s" : ""}` : `Downloaded ${dirty.length} changed file${dirty.length > 1 ? "s" : ""}`);
      setTimeout(() => setStatus(undefined), 2500);
      if (isNew.current) applyState(await session.current.meta(false, folder.current));
      isNew.current = false;
    } catch (e) {
      // Cancelling the folder picker is not an error.
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    }
  }, [dirty, applyState, project, needsAccess]);
  /** An extension may take Save over (a stored project saves a revision; one opened from a repository commits). */
  const saveOverride = installed
    .map((e) => contributions[e.id]?.save)
    .reduce<SaveAction | undefined>((best, a) => (a && (!best || (a.priority ?? 0) > (best.priority ?? 0)) ? a : best), undefined);
  const save = useCallback(() => (saveOverride ? saveOverride.run() : saveLocally()), [saveOverride, saveLocally]);

  // Don't lose unsaved edits by accident.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.length) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
  /** Files that came from or went to an extension's remote: written to the project's folder too, when it has one. */
  const writeThrough = useCallback(
    async (paths: string[]) => {
      if (!session.current || !paths.length) return;
      if (writer.current) {
        const texts = await session.current.files(paths);
        for (const [path, text] of Object.entries(texts)) if (text !== undefined) await writer.current(path, text);
      }
      applyState(await session.current.markSaved(paths));
    },
    [applyState],
  );

  const initialBox = useMemo(() => {
    const b = new URLSearchParams(location.search).get("box")?.split(",").map(Number);
    return b?.length === 4 ? { x: b[0]!, y: b[1]!, w: b[2]!, h: b[3]! } : undefined;
  }, []);

  const open = useCallback(async (load: () => Promise<LoadedProject>, then?: (p: ProjectView) => void, link?: string) => {
    setError(undefined);
    setStatus("Reading files…");
    try {
      const { files, models: modelSource, write, unsaved, folder: from, original, links: opened = {}, synced, syncAll } = await load();
      // The address a linked project reopens from (e.g. a stored project's).
      link ??= installed.map((e) => opened[e.id] !== undefined && e.addressOf?.(opened[e.id])).find((a): a is string => !!a);
      setStatus(`Analyzing ${Object.keys(files.files).length} files…`);
      // The open project's kept changes give way to the new one's.
      await session.current?.forget().catch(() => undefined);
      session.current?.dispose();
      session.current = new Session();
      writer.current = write;
      folder.current = from;
      // A folder kept from before a reload: write access may still be granted, else Save asks for it.
      if (from && !write && (await folderAccess(from, false))) writer.current = folderWriter(from);
      setNeedsAccess(!!from && !writer.current);
      setRestored(undefined);
      isNew.current = !!unsaved;
      setOpenCount((n) => n + 1);
      let st = await session.current.open(files, unsaved, { original, synced, persist: { tab, unsaved: !!unsaved, folder: from, link, links: opened } });
      projectPath.current = files.project;
      setLinks(opened);
      // Everything just read from a link's remote matches it (a restored link brings back what was last synced instead).
      if (syncAll && !synced) st = await session.current.markSynced(Object.keys(files.files), true);
      const p = st.project;
      applyState(st);
      setModels(() => modelSource);
      setSheetPath(p.sheets[0]?.path ?? "");
      setSelection(null);
      setMode(p.sheets.length ? "schematic" : "board");
      if (p.board) setLayers(DEFAULT_LAYERS(p.board));
      document.title = `${p.name} · Crossprobe`;
      then?.(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStatus(undefined);
    }
  }, [applyState, tab]);

  // Unsaved changes kept from before the page was reloaded (or left by accident) come back first,
  // unless the page was opened from a different deep link or by going back to the start screen.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      pruneStored().catch(() => undefined);
      const params = new URLSearchParams(location.search);
      if (params.has("home")) {
        await deleteStored(tab).catch(() => undefined);
        params.delete("home");
        window.history.replaceState(window.history.state, "", location.pathname + (params.size ? `?${params}` : "") + location.hash);
      }
      const kept = await readStored(tab).catch(() => undefined);
      if (cancelled) return;
      if (!kept || kept.link !== deepLink(params)) return setStartup("none");
      setStartup("restored");
      await open(() => Promise.resolve(restoredProject(kept)), undefined, kept.link);
      if (!cancelled) setRestored(kept);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tab]);

  /** Drop the restored changes: back to the files as last saved, or to the start screen for a project never saved. */
  const discardRestored = useCallback(async () => {
    const kept = restored;
    if (!kept) return;
    setRestored(undefined);
    if (Object.keys(kept.original).length) return open(() => Promise.resolve(restoredProject({ ...kept, changed: {} })), undefined, kept.link);
    await session.current?.forget().catch(() => undefined);
    session.current?.dispose();
    session.current = undefined;
    writer.current = folder.current = undefined;
    setProject(undefined);
    setLinks({});
    setDirty([]);
    setHistory({});
    setSelection(null);
    document.title = "Crossprobe";
  }, [restored, open]);


  // "Open in Crossprobe" on a block's web page: ?block=<id> opens a new draft project with that block.
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("block");
    if (!id || startup !== "none") return;
    blockManifest(id).then(
      (m) =>
        open(() => fromBlock(id), undefined, `block=${id}`).then(() => {
          setStatus(m.status === "draft" ? `New project from “${m.title}”. This block is a draft: check its values against the datasheet.` : `New project from “${m.title}”.`);
          setTimeout(() => setStatus(undefined), 12000);
        }),
      (e) => setError((e as Error).message),
    );
  }, [open, startup]);

  // Dev convenience / deep links: ?demo=<path to .kicad_pro>&view=board&sheet=<n>&net=<name>&ref=<R1>
  useEffect(() => {
    if (startup === "checking") return;
    listDemos().then((list) => {
      setDemos(list);
      const params = new URLSearchParams(location.search);
      const wanted = params.get("demo");
      const demo = wanted && list.find((d) => d.project === wanted || d.name === wanted);
      if (!demo || startup === "restored") return;
      open(
        () => fromDemo(demo),
        (p) => {
          const view = params.get("view");
          if ((view === "board" || view === "3d") && p.board) setMode(view);
          if (params.get("flip") === "1") setFlipped(true);
          const sheetIndex = Number(params.get("sheet") ?? 0);
          if (p.sheets[sheetIndex]) setSheetPath(p.sheets[sheetIndex]!.path);
          const net = params.get("net");
          const ref = params.get("ref");
          if (net) setSelection({ kind: "net", name: net });
          else if (ref) setSelection({ kind: "component", reference: ref });
          if ((net || ref) && !params.get("box")) setFocusToken((t) => t + 1);
        },
        `demo=${wanted}`,
      );
    });
  }, [open, startup]);

  const ercMarkers = useMemo(
    () => (project?.erc ?? []).map((v) => ({ sheet: v.sheet, at: v.items[0]!.at, severity: v.severity, label: `${v.message}: ${v.items.map((i) => i.description).join(", ")}` })),
    [project],
  );
  const editContext = useMemo<EditContext | undefined>(
    () =>
      project && {
        projectName: project.name,
        sheetPathsOf: (file: string) => project.sheets.filter((s) => s.file === file).map((s) => s.path),
        blockExists: (lib: string, name: string) => project.projectBlocks.some((b) => b.lib === lib && b.name === name),
        references: project.references,
        placing,
        // Placing further units: on to the next one, and back to select after the last.
        onPlaced: () => {
          if (!placing?.units) return;
          if (placing.units.length > 1) setPlacing({ ...placing, units: placing.units.slice(1) });
          else {
            setPlacing(undefined);
            setTool("select");
          }
        },
        placingBlock,
        sheetFileOf: (path: string) => project.sheets.find((s) => s.path === path)?.file,
        nextPage: project.sheets.length + 1,
        hierLabelsOf: (path: string) => [...new Set((project.sheets.find((s) => s.path === path)?.items ?? []).filter((i) => i.kind === "label" && i.prims.some((p) => p.t !== "image" && p.role === "labelHier")).map((i) => i.text ?? ""))],
        fileExists: (file: string) => project.sheets.some((s) => s.file === file),
        projectDir: project.projectFile.includes("/") ? project.projectFile.slice(0, project.projectFile.lastIndexOf("/") + 1) : "",
        netClasses: project.designRules?.classes.map((c) => c.name),
      },
    [project, placing, placingBlock],
  );
  const sheet = useMemo(() => project?.sheets.find((s) => s.path === sheetPath) ?? project?.sheets[0], [project, sheetPath]);
  const missingFootprints = project?.components.filter((c) => c.onBoard && !c.footprint).length ?? 0;
  // Dev-only hook for browser tests: the current analysis.
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__crossprobe = { project, sheet, dirty, selection, files: () => session.current!.files(dirty), edit };
  // New zones go on GND by default (the usual pour), else the chosen net.
  const boardNets = project?.board?.nets;
  const zoneNet = zoneNetChoice ?? (boardNets?.find((n) => /^(GND|\/?GND)$/i.test(n)) ?? boardNets?.find((n) => /gnd/i.test(n)) ?? "");
  /** One-click fixes for common ERC findings: a no-connect flag, or a PWR_FLAG placed on the pin. */
  const quickFix = async (v: import("@crossprobe/kicad-model").ErcViolation) => {
    const sheet = project?.sheets.find((s) => s.path === v.sheet);
    const at = v.items[0]?.at;
    if (!project || !sheet || !at) return;
    if (v.type === "pin_not_connected") return edit([{ op: "addNoConnect", file: sheet.file, at }]);
    if (v.type === "power_pin_not_driven") {
      try {
        const text = await kicadSymbol("power", "PWR_FLAG");
        const [reference] = nextReferences(project.references, ["#FLG"]);
        edit([
          {
            op: "placeSymbol",
            file: sheet.file,
            source: { kind: "text", text },
            at,
            reference: reference!,
            sheetPaths: project.sheets.filter((s) => s.file === sheet.file).map((s) => s.path),
            projectName: project.name,
          },
        ]);
      } catch (e) {
        setError((e as Error).message);
      }
    }
  };
  /** No-connect flags on every listed unconnected pin, as one undoable edit. */
  const noConnectAll = (list: import("@crossprobe/kicad-model").ErcViolation[]) => {
    const ops = list.flatMap((v) => {
      const sheet = project?.sheets.find((s) => s.path === v.sheet);
      const at = v.items[0]?.at;
      return v.type === "pin_not_connected" && sheet && at ? [{ op: "addNoConnect" as const, file: sheet.file, at }] : [];
    });
    if (ops.length) edit(ops);
  };
  /** Four M3 mounting holes inset from the outline's bounding corners (KiCad's MountingHole footprint). */
  // ---- The footprint editor: the project's own footprint library (<project>.pretty) ----
  const [fpEditing, setFpEditing] = useState<{ file: string; libId: string }>();
  const footprintLibrary = () => {
    const pro = project!.projectFile;
    const dir = pro.includes("/") ? pro.slice(0, pro.lastIndexOf("/") + 1) : "";
    const lib = project!.name.replace(/[^A-Za-z0-9_.-]/g, "_") || "project";
    return { dir, lib, libDir: `${lib}.pretty`, table: `${dir}fp-lib-table` };
  };
  /** Open a footprint in the editor: a new one, a copy of a library footprint, or one of the project's own. */
  const openFootprintEditor = async (from?: string): Promise<string | undefined> => {
    if (!project) return undefined;
    const own = from ? project.projectFootprints.find((f) => f.libId === from) : undefined;
    if (own) {
      // Footprints from KiCad's tools may lack item UUIDs: the editor adds them, as KiCad's does.
      const text = withUuids(own.text);
      if (text !== own.text) await edit([{ op: "fpWrite", file: own.file, text, libTable: footprintLibrary().table, lib: own.lib, libDir: own.file.slice(0, own.file.lastIndexOf("/")).split("/").pop()! }]);
      setFpEditing({ file: own.file, libId: own.libId });
      return own.libId;
    }
    const L = footprintLibrary();
    let name: string;
    let text: string;
    if (from) {
      const source = await kicadFootprint(from);
      if (!source) {
        setError(`Footprint ${from} isn't available`);
        return undefined;
      }
      name = from.split(":").pop()!;
      text = withUuids(source);
    } else {
      const asked = window.prompt("Name of the new footprint (e.g. SOIC-8_MyPart)")?.trim();
      if (!asked) return undefined;
      name = asked.replace(/[\\/:*?"<>|]/g, "_");
      text = newFootprintText(name);
    }
    const file = `${L.dir}${L.libDir}/${name}.kicad_mod`;
    if (project.projectFootprints.some((f) => f.file === file) && !window.confirm(`${L.lib}:${name} exists in the project library. Replace it?`)) return undefined;
    await edit([{ op: "fpWrite", file, text, libTable: L.table, lib: L.lib, libDir: L.libDir }]);
    setFpEditing({ file, libId: `${L.lib}:${name}` });
    return `${L.lib}:${name}`;
  };
  // ---- The symbol editor: the project's own symbol library (<project>.kicad_sym) ----
  const [symEditing, setSymEditing] = useState<{ file: string; lib: string; name: string }>();
  /** Open a symbol in the editor: a new one, a copy of a library symbol ("Lib:Name"), or one of the project's own. */
  const openSymbolEditor = async (from?: string) => {
    if (!project) return;
    const L = footprintLibrary();
    const libFile = `${L.dir}${L.lib}.kicad_sym`;
    const own = from ? project.projectSymbols.find((e) => `${e.library}:${e.name}` === from) : undefined;
    if (own) return setSymEditing({ file: own.file, lib: own.library, name: own.name });
    let node: import("@crossprobe/kicad-sexpr").List;
    if (from) {
      const [library, name] = from.split(":") as [string, string];
      let text: string;
      try {
        text = await kicadSymbol(library, name);
      } catch {
        return setError(`Symbol ${from} isn't in the installed libraries`);
      }
      node = parseSexpr(text).children.find((c): c is import("@crossprobe/kicad-sexpr").List => typeof c === "object" && "children" in c)!;
      // A library symbol is named without its library (its units already are).
      setSexprArg(node, 0, sexprStr(name));
    } else {
      const asked = window.prompt("Name of the new symbol (e.g. MYAMP1)")?.trim();
      if (!asked) return;
      node = newSymbolNode(asked.replace(/[\\/:*?"<>|\s]/g, "_"));
    }
    const name = String(sexprArg(node, 0));
    const existing = project.projectSymbolLibraries[libFile]?.text;
    if (existing && project.projectSymbols.some((e) => e.file === libFile && e.name === name) && !window.confirm(`${L.lib}:${name} exists in the project library. Replace it?`)) return;
    await edit([{ op: "symWrite", file: libFile, text: withLibrarySymbol(existing, node), libTable: `${L.dir}sym-lib-table`, lib: L.lib, libFile: `${L.lib}.kicad_sym` }]);
    setSymEditing({ file: libFile, lib: L.lib, name });
  };

  // ---- A footprint from the part's datasheet (an assistant's): the dialog resolves to the footprint to offer ----
  const FootprintDraft = assistant?.FootprintDraft;
  const [drafting, setDrafting] = useState<{ part: DraftPart; datasheet?: string; done: (libId?: string) => void }>();
  const [draftCited, setDraftCited] = useState<Record<string, Cited[]>>({});
  const draftFootprintFor = (c: import("./render/types").ComponentInfo): Promise<string | undefined> =>
    new Promise((done) => {
      const pins = (project?.nets ?? []).flatMap((n) => n.nodes.filter((x) => x.reference === c.reference).map((x) => ({ number: x.pin, name: x.pinName ?? "" })));
      setDrafting({ part: { reference: c.reference, value: c.value, description: c.description, pins }, datasheet: c.datasheet, done });
    });
  const placeCornerHoles = async () => {
    const b = project?.board;
    if (!b?.outline.length || !project?.boardFile) return;
    const text = await kicadFootprint("MountingHole:MountingHole_3.2mm_M3");
    if (!text) return setError("The MountingHole library isn't available");
    const pts = b.outline.flatMap((o) => o.points);
    const x0 = Math.min(...pts.map((p) => p.x)) + 3.5;
    const x1 = Math.max(...pts.map((p) => p.x)) - 3.5;
    const y0 = Math.min(...pts.map((p) => p.y)) + 3.5;
    const y1 = Math.max(...pts.map((p) => p.y)) - 3.5;
    const used = new Set(b.footprints.map((f) => f.reference));
    let n = 1;
    const next = () => {
      while (used.has(`H${n}`)) n++;
      used.add(`H${n}`);
      return `H${n}`;
    };
    edit(
      [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }].map((at) => ({
        op: "placeFootprint" as const,
        file: project.boardFile!,
        text,
        libId: "MountingHole:MountingHole_3.2mm_M3",
        at,
        reference: next(),
        value: "MountingHole_3.2mm_M3",
      })),
    );
  };
  /** A zone covering the board outline's extent on the current layer (it is clipped to the board edge when filled). */
  const fillBoard = () => {
    const b = project?.board;
    if (!b?.outline.length || !project?.boardFile) return;
    const pts = b.outline.flatMap((o) => o.points);
    const x0 = Math.min(...pts.map((p) => p.x));
    const x1 = Math.max(...pts.map((p) => p.x));
    const y0 = Math.min(...pts.map((p) => p.y));
    const y1 = Math.max(...pts.map((p) => p.y));
    const outline = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    edit([
      { op: "addZone", file: project.boardFile, zone: { net: zoneNet, layers: [boardLayer], outline } },
      { op: "refillZones", file: project.boardFile },
    ]);
  };

  // Cross-probing: keep the schematic on a sheet that shows the selection.
  const select = useCallback(
    (s: Selection) => {
      setSelection(s);
      if (!project || !s) return;
      if (s.kind === "marker" && s.sheet === "board") {
        setMode("board");
        return;
      }
      const sheets =
        s.kind === "net"
          ? project.nets.find((n) => n.name === s.name)?.sheets
          : s.kind === "component"
            ? project.components.find((c) => c.reference === s.reference)?.sheets
            : [s.sheet];
      if (sheets?.length && !sheets.includes(sheetPath)) setSheetPath(sheets[0]!);
    },
    [project, sheetPath],
  );

  const selectAndFocus = useCallback(
    (s: Selection) => {
      select(s);
      setFocusToken((t) => t + 1);
    },
    [select],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+F on the schematic: KiCad's Find (and Replace while editing).
      if (e.key === "f" && (e.metaKey || e.ctrlKey) && project && mode === "schematic") {
        e.preventDefault();
        setShowFind(true);
        return;
      }
      if ((e.key === "/" || (e.key === "f" && (e.metaKey || e.ctrlKey))) && project) {
        e.preventDefault();
        document.getElementById("inspector-search")?.focus();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
        return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod) return;
      // An open symbol or footprint editor takes the other keys.
      if (document.querySelector(".fp-editor")) return;
      if (e.key === "F8" && project?.boardUpdate) {
        e.preventDefault();
        setMode("board");
        openPanel("update");
        return;
      }
      if (e.key === "e" && (mode === "schematic" || mode === "board")) setEditing((v) => !v);
      if (editing && (mode === "schematic" || mode === "board")) return; // the editors handle their own keys
      if (e.key === "Escape") setSelection(null);
      if (e.key === "s" && project?.sheets.length) setMode("schematic");
      if (e.key === "b" && project?.board) setMode("board");
      if (e.key === "3" && project?.board) setMode("3d");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project, save, undo, redo, editing, mode]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const items = e.dataTransfer.items;
    if (items?.length) open(() => fromDrop(items));
  };

  // ---- Extensions: what they can do with the open project (see extensions/api.ts) ----
  const showTab = useCallback((t: string) => setInspectorTab({ tab: t as InspectorTab }), []);
  const setLink = useCallback(
    async (id: string, value: unknown, opts: { deepLink?: string | null; saved?: boolean } = {}) => {
      setLinks((l) => {
        const next = { ...l };
        if (value === undefined) delete next[id];
        else next[id] = value;
        return next;
      });
      const s = session.current;
      if (!s) return;
      await s.setLink(id, value, opts);
      // Everything was just stored there: nothing is unsaved, and a new project is no longer new.
      if (opts.saved) {
        isNew.current = false;
        applyState(await s.markSaved(Object.keys(await s.files())));
      }
    },
    [applyState],
  );
  const contribute = useCallback((id: string, c: Contribution) => setContributions((m) => ({ ...m, [id]: c })), []);
  // Functions an extension may depend on in its effects stay the same between renders.
  const needsAccessRef = useRef(needsAccess);
  needsAccessRef.current = needsAccess;
  const stable = useMemo(
    () => ({
      latest: () => projectRef.current,
      session: () => session.current,
      open: (load: () => Promise<LoadedProject>) => open(load),
      hasFolder: () => !!writer.current || needsAccessRef.current,
      projectPath: () => projectPath.current,
    }),
    [open],
  );
  const host: SharedHost = {
    ...stable,
    project,
    startup,
    dirty,
    unsynced,
    applyState,
    writeThrough,
    saveLocally,
    setStatus,
    setError,
    showTab,
    links,
    setLink,
    contribute,
  };

  return (
    <SlotProvider>
    <div
      className={`app${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="topbar">
        {/* Back to the start screen; unsaved edits are guarded by the beforeunload prompt. ?home drops the changes kept for a reload. */}
        <a className="brand" href={`${import.meta.env.BASE_URL}?home`} title="Crossprobe: start screen">
          <Logo className="logo" /> Crossprobe
        </a>
        {project && (
          <>
            <span className="crumb-sep" aria-hidden="true">/</span>
            <span className="project-name" title={`${project.stats.files} files · analyzed in ${project.stats.parseMs} ms`}>
              {project.name}
            </span>
            <div className="segmented">
              <button className={mode === "schematic" ? "on" : ""} disabled={!project.sheets.length} onClick={() => setMode("schematic")}>
                <Icon name="schematic" /> Schematic <kbd>S</kbd>
              </button>
              <button className={mode === "board" ? "on" : ""} disabled={!project.board} onClick={() => setMode("board")}>
                <Icon name="pcb" /> PCB <kbd>B</kbd>
              </button>
              <button className={mode === "3d" ? "on" : ""} disabled={!project.board} onClick={() => setMode("3d")}>
                <Icon name="cube" /> 3D <kbd>3</kbd>
              </button>
            </div>
          </>
        )}
        <div className="spacer" />
        {project && (
          <div className="edit-actions">
            {project.board && (
              <button
                onClick={() => {
                  setMode("board");
                  openPanel("fab");
                }}
                title="Gerbers, drill files, BOM and pick-and-place for ordering boards"
              >
                <Icon name="fab" /> <span className="tl">Fab outputs</span>
              </button>
            )}
            <button onClick={() => openPanel("plot")} title="Plot the schematic or board layers to PDF or SVG">
              <Icon name="doc" /> <span className="tl">Plot</span>
            </button>
            <Slot name="toolbar" />
            <button onClick={undo} disabled={!history.undo || busy} title={history.undo ? `Undo ${history.undo} (⌘Z)` : "Nothing to undo"}>
              <Icon name="undo" />
            </button>
            <button onClick={redo} disabled={!history.redo || busy} title={history.redo ? `Redo ${history.redo} (⇧⌘Z)` : "Nothing to redo"}>
              <Icon name="redo" />
            </button>
          </div>
        )}
        {busy && <span className="muted small">Updating…</span>}
        <ProjectMenu
          open={!!project}
          save={
            saveOverride ?? {
              kind: writer.current || needsAccess ? "save" : "download",
              count: dirty.length,
              title: dirty.length ? `Save ${dirty.join(", ")} (⌘S)` : "No unsaved changes",
              label: writer.current || needsAccess ? "Save to the folder" : "Download changed files",
              run: saveLocally,
            }
          }
          where={Object.values(contributions).flatMap((c) => (c.where ? [c.where] : []))}
          onOpenFolder={() => (canWriteFolders() ? open(fromDirectoryPicker) : fileInput.current?.click())}
          onDownload={async () => project && session.current && downloadZip(project.name, await session.current.files())}
        />
        <input
          ref={fileInput}
          type="file"
          hidden
          // @ts-expect-error non-standard but widely supported
          webkitdirectory=""
          multiple
          onChange={(e) => e.target.files && open(() => fromFileList(e.target.files!))}
        />
        <Slot name="topbar" />
      </header>

      {status && <div className="status">{status}</div>}
      {restored && project && (
        <div className="status restored" role="status">
          <span>
            {Object.keys(restored.changed).length
              ? "Restored your unsaved changes from before the page was reloaded."
              : "Reopened this project from before the page was reloaded."}
            {Object.values(contributions).map((c) => c.restored && ` ${c.restored}`)}
            {needsAccess && " Saving will ask for access to the project folder again."}
          </span>
          {Object.keys(restored.changed).length > 0 && (
            <button className="link" onClick={discardRestored}>
              Discard changes
            </button>
          )}
          <button className="link" onClick={() => setRestored(undefined)} aria-label="Dismiss">
            Keep
          </button>
        </div>
      )}
      {installed.map((e) => e.Root && <ExtensionRoot key={e.id} id={e.id} Root={e.Root} host={host} />)}
      {showAssign && project && <AssignFootprints components={project.components} project={() => projectRef.current!} onEdit={edit} onClose={() => setShowAssign(false)} onEditFootprint={(id) => openFootprintEditor(id)} onDraftFootprint={FootprintDraft && draftFootprintFor} />}
      {showFields && project && <FieldsTable project={project} onEdit={edit} onClose={() => setShowFields(false)} />}
      {showStats && project?.board && <BoardStats board={project.board} name={project.name} onClose={() => setShowStats(false)} />}
      {pageFile && project && (
        <PageSettingsDialog
          file={pageFile}
          sheetFiles={[...new Set(project.sheets.map((x) => x.file))]}
          boardFile={project.boardFile}
          readFiles={(paths) => session.current!.files(paths)}
          onEdit={edit}
          onClose={() => setPageFile(undefined)}
          projectFile={project.projectFile}
          intersheetRefs={project.intersheetRefs}
        />
      )}
      {showNets && project?.board && (
        <NetInspector
          project={project}
          onClose={() => setShowNets(false)}
          onSelectNet={(net) => {
            setShowNets(false);
            setMode("board");
            select({ kind: "net", name: net });
          }}
        />
      )}
      {showPlot && project && <PlotPanel project={project} initial={mode === "board" ? "board" : "schematic"} onClose={() => setShowPlot(false)} />}
      {symEditing && project && project.projectSymbolLibraries[symEditing.file] && (() => {
        const libId = `${symEditing.lib}:${symEditing.name}`;
        const placed = project.components.filter((c) => c.libId === libId).length;
        const sheets = [...new Set(project.sheets.map((sh) => sh.file))];
        return (
          <SymbolEditor
            file={symEditing.file}
            libText={project.projectSymbolLibraries[symEditing.file]!.text}
            name={symEditing.name}
            libId={libId}
            placed={placed}
            onEdit={edit}
            onClose={() => setSymEditing(undefined)}
            onUpdateSchematic={() => edit([{ op: "updateSchematicSymbols", file: sheets[0]!, sheets, libFile: symEditing.file, lib: symEditing.lib, name: symEditing.name }])}
          />
        );
      })()}
      {drafting && project && FootprintDraft && (
        <FootprintDraft
          part={drafting.part}
          datasheet={drafting.datasheet}
          onClose={() => {
            drafting.done(undefined);
            setDrafting(undefined);
          }}
          onUse={(libId) => {
            drafting.done(libId);
            setDrafting(undefined);
          }}
          onCreate={async (pattern, cited) => {
            const L = footprintLibrary();
            const file = `${L.dir}${L.libDir}/${pattern.name}.kicad_mod`;
            await edit([{ op: "fpWrite", file, text: withUuids(landPatternText(pattern)), libTable: L.table, lib: L.lib, libDir: L.libDir }]);
            setDraftCited((m) => ({ ...m, [file]: cited }));
            setFpEditing({ file, libId: `${L.lib}:${pattern.name}` });
            drafting.done(`${L.lib}:${pattern.name}`);
            setDrafting(undefined);
          }}
        />
      )}
      {fpEditing && project && (() => {
        const own = project.projectFootprints.find((f) => f.file === fpEditing.file);
        if (!own) return null;
        const placed = project.board?.footprints.filter((f) => f.libId === fpEditing.libId) ?? [];
        return (
          <FootprintEditor
            models={models}
            file={own.file}
            text={own.text}
            libId={own.libId}
            placed={placed.length}
            onEdit={edit}
            cited={draftCited[own.file]}
            onClose={() => setFpEditing(undefined)}
            onUpdateBoard={project.boardFile ? () => edit([{ op: "updateFootprints", file: project.boardFile!, updates: placed.map((f) => ({ uuid: f.uuid, text: own.text })) }]) : undefined}
          />
        );
      })()}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      {!project ? (
        <main className="welcome">
          <div className="welcome-in">
            <header className="welcome-head">
              <h1>Open a KiCad project</h1>
              <p className="muted">
                Files are read in this browser. Nothing is uploaded.{" "}
                {canWriteFolders()
                  ? "Edits are saved straight back into the folder you choose."
                  : "This browser can't write folders, so saving downloads the changed files."}
              </p>
            </header>
            <div className="welcome-grid">
              <section className="pane open-pane">
                <h2>Drop a project folder anywhere, or choose one</h2>
                <p className="muted">The folder with the .kicad_pro, .kicad_sch and .kicad_pcb files. KiCad 6 to 10.</p>
                <button className="primary big" onClick={() => (canWriteFolders() ? open(fromDirectoryPicker) : fileInput.current?.click())}>
                  <Icon name="folderOpen" size={18} /> Choose folder…
                </button>
                <Slot name="start-open" />
              </section>
              <section className="pane">
                <h2>Start an empty project</h2>
                <form
                  className="new-project"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = newName.trim() || "untitled";
                    open(async () => fromNewProject(name));
                  }}
                >
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Project name" aria-label="Project name" />
                  <button className="primary" type="submit">
                    <Icon name="plus" /> Create
                  </button>
                </form>
                <p className="muted small">An empty schematic and a two-layer board with KiCad's default rules.</p>
              </section>
            </div>
            {demos.length > 0 && (
              <section className="welcome-demos">
                <div className="label-row">
                  <span className="label">KiCad demo projects</span>
                  <span className="label">{demos.length}</span>
                </div>
                <div className="demos">
                  {demos.map((d) => (
                    <button key={d.project} onClick={() => open(() => fromDemo(d))}>
                      {d.name}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        </main>
      ) : (
        <div className={`workspace${wideInspector ? " inspector-wide" : ""}`}>
          <aside className="sidebar">
            {mode === "schematic" && sheet && <SheetTree sheets={project.sheets} current={sheet.path} onOpen={setSheetPath} />}
            {mode === "board" && project.board && (
              <LayerList
                board={project.board}
                flipped={flipped}
                onFlip={setFlipped}
                visible={layers}
                onToggle={(l) =>
                  setLayers((prev) => {
                    const next = new Set(prev);
                    if (next.has(l)) next.delete(l);
                    else next.add(l);
                    return next;
                  })
                }
                onStats={() => setShowStats(true)}
                selectable={editing ? selectable : undefined}
                onSelectable={(k) =>
                  setSelectable((prev) => {
                    const next = new Set(prev);
                    if (next.has(k)) next.delete(k);
                    else next.add(k);
                    return next;
                  })
                }
              />
            )}
            {mode === "3d" && project.board && (
              <div className="side-section">
                <h4>3D view</h4>
                <p className="muted small">
                  Drag to orbit, right-drag or shift-drag to pan, scroll to zoom. Click a part to select it.
                </p>
                <p className="muted small">
                  Models load from the project folder and, when available, the local KiCad library. Parts without a model are shown as boxes.
                </p>
                <p className="muted small">
                  {project.board.footprints.length} footprints · {project.board.thickness ?? 1.6} mm board
                </p>
              </div>
            )}
            {project.warnings.length > 0 && (
              <details className="side-section warnings">
                <summary>{project.warnings.length} warnings</summary>
                <ul>
                  {project.warnings.slice(0, 50).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </aside>
          <main className="canvas">
            {mode === "schematic" && sheet && (
              <>
                <div className="breadcrumb">
                  {sheet.namePath === "/" ? "Root sheet" : sheet.namePath}
                  <span className="muted small"> · {sheet.file}</span>
                </div>
                <div className="edit-toolbar">
                  <button className={editing ? "on" : ""} onClick={() => setEditing((v) => !v)} title="Edit mode (E)">
                    <Icon name="edit" /> {editing ? "Editing" : "Edit"}
                  </button>
                  {editing &&
                    (
                      [
                        ["select", "Select", "Esc", "select"],
                        ["wire", "Wire", "W", "wire"],
                        ["bus", "Bus", "B", "bus"],
                        ["busentry", "Bus entry", "Z", "busEntry"],
                        ["label", "Label", "L", "label"],
                        ["junction", "Junction", "J", "junction"],
                        ["noconnect", "No-connect", "Q", "noConnect"],
                        ["glabel", "Global label", "Ctrl+L", "glabel"],
                        ["hlabel", "Hier. label", "H", "hlabel"],
                        ["text", "Text", "T", "text"],
                        ["textbox", "Text box", "", "textBox"],
                        ["line", "Lines", "", "drawLine"],
                        ["rect", "Rectangle", "", "drawRect"],
                        ["circle", "Circle", "", "drawCircle"],
                        ["arc", "Arc", "", "drawArc"],
                        ["netclass", "Net class", "", "netClass"],
                        ["rulearea", "Rule area", "", "ruleArea"],
                        ["image", "Image", "", "image"],
                        ["sheet", "Sheet", "Shift+S", "sheet"],
                        ["sheetpin", "Sheet pin", "", "sheetPin"],
                        ["place", "Add part", "A", "addPart"],
                        ["power", "Power", "P", "power"],
                        ["block", "Add block", "", "block"],
                      ] as const
                    ).map(([t, label, key, icon]) => (
                      <Fragment key={t}>
                        {(t === "wire" || t === "text" || t === "place") && <span className="tb-sep" />}
                        <button className={tool === t ? "on" : ""} onClick={() => chooseTool(t)} title={key ? `${label} (${key})` : label}>
                          <Icon name={icon} /> <span className="tl">{label}</span>
                        </button>
                      </Fragment>
                    ))}
                  {editing && <span className="tb-sep" />}
                  {editing && (
                    <details className="menu">
                      <summary title="Annotate references">
                        <Icon name="annotate" /> <span className="tl">Annotate</span>
                      </summary>
                      <div className="menu-items">
                        <button onClick={(e) => { edit([{ op: "annotate", file: sheet.file, mode: "unannotated" }]); (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>
                          Number new parts (R? → R14)
                        </button>
                        <button onClick={(e) => { edit([{ op: "annotate", file: sheet.file, mode: "all", order: "x" }]); (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>
                          Renumber all, left to right
                        </button>
                        <button onClick={(e) => { edit([{ op: "annotate", file: sheet.file, mode: "all", order: "y" }]); (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>
                          Renumber all, top to bottom
                        </button>
                        <button onClick={(e) => { setShowAnnotate(true); (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>
                          More options…
                        </button>
                      </div>
                    </details>
                  )}
                  {editing && (
                    <button
                      className={missingFootprints ? "attention" : ""}
                      onClick={() => openPanel("assign")}
                      title={missingFootprints ? `Assign footprints (${missingFootprints} parts have none)` : "Assign footprints"}
                    >
                      <Icon name="pcb" /> <span className="tl">Footprints</span>
                      {missingFootprints > 0 && <span className="count">{missingFootprints}</span>}
                    </button>
                  )}
                  <button
                    onClick={async () => session.current && downloadFile(`${project.name}.net`, netlistFile(await session.current.files(), project.projectFile))}
                    title="Export the netlist in KiCad's format (.net), for Pcbnew and other tools"
                  >
                    <Icon name="download" /> <span className="tl">Netlist</span>
                  </button>
                  <button className={showFind ? "on" : ""} onClick={() => setShowFind((v) => !v)} title="Find (and replace, while editing) in texts, labels and fields on every sheet (Ctrl+F)">
                    <Icon name="search" /> <span className="tl">Find</span>
                  </button>
                  {editing && (
                    <>
                    <button onClick={() => openPanel("fields")} title="Symbol fields table: every part's fields, edited in one place">
                      <Icon name="table" /> <span className="tl">Fields</span>
                    </button>
                    <button onClick={() => sheet && setPageFile(sheet.file)} title="Page settings: paper size and the title block (title, date, revision, company, comments)">
                      <Icon name="doc" /> <span className="tl">Page</span>
                    </button>
                    </>
                  )}
                </div>
                {editing && (tool === "place" || tool === "power") && <PartPicker key={`${tool}-${pickerOpen}`} power={tool === "power"} project={project} placing={placing} onPick={setPlacing} onNewSymbol={() => void openSymbolEditor()} />}
                {editing && tool === "block" && (
                  <BlockPicker
                    projectBlocks={project.projectBlocks}
                    placing={placingBlock}
                    onPick={setPlacingBlock}
                    onInsertFree={(blockText, blockPcb) => {
                      beforeInsert.current = new Set(project.references);
                      setTool("select"); // closes the picker; the new parts are framed once they exist
                      return edit([{ op: "insertBlock", file: sheet.file, blockText, blockPcb, at: "free", sheetPaths: editContext?.sheetPathsOf(sheet.file) ?? [sheet.path], projectName: project.name }]);
                    }}
                  />
                )}
                <SchematicView
                  sheet={sheet}
                  selection={selection}
                  onSelect={select}
                  onOpenSheet={setSheetPath}
                  box={sheet.path === project.sheets[0]?.path ? initialBox : undefined}
                  focusToken={focusToken}
                  reveal={reveal}
                  markers={ercMarkers}
                  editing={editing}
                  tool={tool}
                  onTool={chooseTool}
                  onEdit={edit}
                  ctx={editContext}
                />
                {showAnnotate && editing && <Annotate sheet={sheet} onEdit={edit} onClose={() => setShowAnnotate(false)} />}
                {showFind && (
                  <FindReplace
                    project={project}
                    files={async () => (session.current ? session.current.files() : {})}
                    editing={editing}
                    onEdit={edit}
                    onShow={(path, uuid) => {
                      setSheetPath(path);
                      setReveal((r) => ({ token: (r?.token ?? 0) + 1, refs: [], uuids: [uuid] }));
                    }}
                    onClose={() => setShowFind(false)}
                  />
                )}
              </>
            )}
            {mode === "board" && project.board && (
              <>
                <div className="edit-toolbar">
                  <button className={editing ? "on" : ""} onClick={() => setEditing((v) => !v)} title="Edit mode (E)">
                    <Icon name="edit" /> {editing ? "Editing" : "Edit"}
                  </button>
                  {editing &&
                    (
                      [
                        ["select", "Select", "Esc", "select"],
                        ["route", "Route", "X", "route"],
                        ["via", "Via", "V", "via"],
                        ["footprint", "Footprint", "A", "addPart"],
                        ["outline", "Outline", "", "outline"],
                        ["zone", "Zone", "", "zone"],
                        ["text", "Text", "", "text"],
                        ["textbox", "Text box", "", "textbox"],
                        ["dimension", "Dimension", "", "dimension"],
                      ] as const
                    ).map(([t, label, key, icon]) => (
                      <button
                        key={t}
                        className={boardTool === t ? "on" : ""}
                        onClick={() => setBoardTool(t)}
                        title={t === "outline" ? "Board outline on Edge.Cuts" : t === "zone" ? "Copper zone (pour)" : t === "text" ? "Silkscreen text" : t === "textbox" ? "Text box: click two corners, then type the text (it wraps to the box)" : t === "dimension" ? "Dimension: click two points, then the offset (O: horizontal/vertical)" : `${label} (${key})`}
                      >
                        <Icon name={icon} /> <span className="tl">{label}</span>
                      </button>
                    ))}
                  {editing && (
                    <>
                      <select value={boardLayer} onChange={(e) => setBoardLayer(e.target.value)} title="Routing layer">
                        {project.board.copperLayers.map((l) => (
                          <option key={l}>{l}</option>
                        ))}
                      </select>
                      {boardTool === "zone" && (
                        <>
                          <select value={zoneNet} onChange={(e) => setZoneNet(e.target.value)} title="Net for new zones">
                            <option value="">(no net)</option>
                            {project.board.nets.filter((n) => n).map((n) => (
                              <option key={n}>{n}</option>
                            ))}
                          </select>
                          {project.board.outline.length > 0 && (
                            <button onClick={() => fillBoard()} title="A zone covering the whole board outline on this layer">
                              <Icon name="zone" /> <span className="tl">Whole board</span>
                            </button>
                          )}
                        </>
                      )}
                      {boardTool === "outline" && (
                        <>
                          <select value={outlineMode === "poly" ? "poly" : String(cornerRadius)} onChange={(e) => (e.target.value === "poly" ? setOutlineMode("poly") : (setOutlineMode("rect"), setCornerRadius(Number(e.target.value))))} title="Outline shape">
                            <option value="0">Rectangle</option>
                            <option value="1">Rounded r = 1 mm</option>
                            <option value="2">Rounded r = 2 mm</option>
                            <option value="3">Rounded r = 3 mm</option>
                            <option value="poly">Polygon</option>
                          </select>
                          {project.board.outline.length > 0 && (
                            <button onClick={() => placeCornerHoles()} title="Four M3 mounting holes, 3.5 mm in from the outline's corners">
                              <Icon name="hole" /> <span className="tl">4 × M3 holes</span>
                            </button>
                          )}
                        </>
                      )}
                      {boardTool !== "zone" && boardTool !== "outline" && boardTool !== "text" && boardTool !== "textbox" && boardTool !== "dimension" && (
                      <select value={trackWidth} onChange={(e) => setTrackWidth(Number(e.target.value))} title="Track width (mm)">
                        <option value={0}>Net class width</option>
                        {[...new Set([0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.8, 1, ...project.board.tracks.map((t) => t.width)])]
                          .sort((a, b) => a - b)
                          .map((w) => (
                            <option key={w} value={w}>{w} mm</option>
                          ))}
                      </select>
                      )}
                      {project.board.copperLayers.length > 2 && (boardTool === "route" || boardTool === "via") && (
                        <select value={viaType} onChange={(e) => setViaType(e.target.value as typeof viaType)} title="Vias placed while routing and with the via tool: through, or blind/buried and micro vias joining just the two layers">
                          <option value="through">Through vias</option>
                          <option value="blind">Blind/buried vias</option>
                          <option value="micro">Microvias</option>
                        </select>
                      )}
                      <select value={grid} onChange={(e) => setGrid(Number(e.target.value))} title="Grid (mm)">
                        {[0.05, 0.1, 0.25, 0.5, 0.635, 1, 1.27, 2.54].map((g) => (
                          <option key={g} value={g}>grid {g}</option>
                        ))}
                      </select>
                    </>
                  )}
                  {editing && <span className="tb-sep" />}
                  {editing && project.board.zones.some((z) => !z.keepout) && (
                    <button
                      className={zonesStale ? "attention" : ""}
                      onClick={() => edit([{ op: "refillZones", file: project.boardFile! }])}
                      title="Refill copper zones (B)"
                    >
                      <Icon name="layers" /> <span className="tl">Refill</span>
                    </button>
                  )}
                  {editing && project.unconnected.length > 0 && (
                    <button
                      onClick={() => {
                        // Nets with a copper pour are left to the pour.
                        const poured = new Set(project.board!.zones.filter((z) => !z.keepout).map((z) => z.net));
                        const todo = project.unconnected.filter((u) => !poured.has(u.net));
                        // Then the pours are refilled around the new tracks, and pads they no longer reach get a via down to them.
                        const f = project.boardFile!;
                        const stitch: EditOp[] = poured.size ? [{ op: "refillZones", file: f }, { op: "stitchPours", file: f }, { op: "refillZones", file: f }, { op: "stitchPours", file: f }, { op: "refillZones", file: f }] : [];
                        // Fine-pitch ground pins get their vias first, before signal routes can hem them in.
                        const fanout: EditOp[] = poured.size ? [{ op: "stitchPours", file: f, fanout: true }] : [];
                        if (todo.length || stitch.length) edit([...fanout, ...(todo.length ? [{ op: "autoroute" as const, file: f, connections: todo.map((u) => ({ from: u.a.at, to: u.b.at, net: u.net })) }] : []), ...stitch]);
                      }}
                      title="Route every unrouted connection automatically (nets with a copper pour are left to it); undo if you don't like it"
                    >
                      <Icon name="route" /> <span className="tl">Route all</span>
                    </button>
                  )}
                  {editing && project.board!.tracks.length > 0 && (
                    <button
                      onClick={() => edit([{ op: "teardrops", file: project.boardFile! }, { op: "refillZones", file: project.boardFile! }])}
                      title="Teardrops where tracks meet pads and vias (stronger joints for fabrication); run again after re-routing to update them"
                    >
                      <Icon name="via" /> <span className="tl">Teardrops</span>
                    </button>
                  )}
                  {editing && project.board!.zones.some((z) => z.teardrop) && (
                    <button onClick={() => edit([{ op: "teardrops", file: project.boardFile!, remove: true }, { op: "refillZones", file: project.boardFile! }])} title="Remove all teardrops">
                      <Icon name="close" /> <span className="tl">No teardrops</span>
                    </button>
                  )}
                  <span className="tb-sep" />
                  <button className={showSetup ? "on" : ""} onClick={() => openPanel("setup")} title="Board setup: design rules and net class sizes">
                    <Icon name="edit" /> <span className="tl">Setup</span>
                  </button>
                  <button className={showReannotate ? "on" : ""} onClick={() => openPanel("reannotate")} title="Renumber the board's references by position (geographical reannotation); Update schematic then sends them to the schematic">
                    <Icon name="annotate" /> <span className="tl">Renumber</span>
                  </button>
                  <button className={showCleanup ? "on" : ""} onClick={() => openPanel("cleanup")} title="Cleanup tracks & vias: merge collinear segments, remove redundant and dangling tracks and vias">
                    <Icon name="route" /> <span className="tl">Cleanup</span>
                  </button>
                  <button className={showLibCheck ? "on" : ""} onClick={() => openPanel("libcheck")} title="Compare every footprint with its library copy (KiCad's library parity check), and update the ones that differ">
                    <Icon name="sync" /> <span className="tl">Libraries</span>
                  </button>
                  <button onClick={() => project.boardFile && setPageFile(project.boardFile)} title="Page settings: the board's paper size and title block">
                    <Icon name="doc" /> <span className="tl">Page</span>
                  </button>
                  <button onClick={() => openPanel("nets")} title="Net inspector: length, vias and pads of every net">
                    <Icon name="net" /> <span className="tl">Nets</span>
                  </button>
                  {project.schematicUpdate && (
                    <button className={showUpdateSch ? "on" : ""} onClick={() => openPanel("updateSch")} title="Update schematic from PCB: references, values, footprints and fields changed on the board">
                      <Icon name="schematic" /> <span className="tl">Update schematic</span>
                      {project.schematicUpdate.updates.length > 0 && <span className="count">{project.schematicUpdate.updates.length}</span>}
                    </button>
                  )}
                  {project.boardUpdate && (
                    <button className={showUpdate ? "on" : ""} onClick={() => openPanel("update")} title="Update PCB from schematic (F8)">
                      <Icon name="sync" /> <span className="tl">Update PCB</span>
                      {(() => {
                        const n = project.boardUpdate.updates.length + project.boardUpdate.missing.length;
                        return n ? <span className="count">{n}</span> : null;
                      })()}
                    </button>
                  )}
                </div>
                {editing && boardTool === "footprint" && <FootprintPicker placing={placingFootprint} onPick={setPlacingFootprint} />}
                {showSetup && <BoardSetup project={project} onEdit={edit} onClose={() => setShowSetup(false)} />}
                {showFab && (
                  <FabExport project={project} zonesStale={zonesStale} onRefill={() => edit([{ op: "refillZones", file: project.boardFile! }])} onClose={() => setShowFab(false)} />
                )}
                {showReannotate && <BoardReannotate project={project} onEdit={edit} onClose={() => setShowReannotate(false)} onDone={() => openPanel("updateSch")} />}
                {showCleanup && (
                  <CleanupTracks
                    project={project}
                    onEdit={edit}
                    onClose={() => setShowCleanup(false)}
                    onShow={(at) => {
                      select({ kind: "marker", sheet: "board", at, label: "Cleanup" });
                      setFocusToken((t) => t + 1);
                    }}
                  />
                )}
                {showLibCheck && project.board && project.boardFile && (
                  <LibraryCheck
                    project={project}
                    readFiles={readBoardFiles}
                    onEdit={edit}
                    onClose={() => setShowLibCheck(false)}
                    onShow={(reference) => {
                      select({ kind: "component", reference });
                      setFocusToken((t) => t + 1);
                    }}
                  />
                )}
                {showUpdateSch && <UpdateSchematic project={project} onEdit={edit} onClose={() => setShowUpdateSch(false)} />}
                {showUpdate && <UpdatePcb project={project} onEdit={edit} onClose={() => setShowUpdate(false)} onAssignFootprints={() => openPanel("assign")} />}
                <BoardView
                  key={openCount}
                  board={project.board}
                  visible={layers}
                  selectable={selectable}
                  selection={selection}
                  onSelect={select}
                  focusToken={focusToken}
                  flipped={flipped}
                  ratsnest={project.unconnected}
                  drc={project.clearance}
                  netClasses={project.netClasses}
                  designRules={project.designRules}
                  dirty={zonesStale}
                  frame={boardPageFrame}
                  edit={
                    project.boardFile
                      ? {
                          editing,
                          tool: boardTool,
                          onTool: setBoardTool,
                          file: project.boardFile,
                          onEdit: edit,
                          layer: boardLayer,
                          onLayer: setBoardLayer,
                          trackWidth,
                          viaType,
                          onTrackWidth: setTrackWidth,
                          grid,
                          onGrid: setGrid,
                          placingFootprint,
                          zoneNet,
                          outlineMode,
                          cornerRadius,
                        }
                      : undefined
                  }
                />
              </>
            )}
            {mode === "3d" && project.board && (
              <Suspense fallback={<div className="viewport board3d" />}>
                <Board3DView name={project.name} board={project.board} models={models} selection={selection} onSelect={select} />
              </Suspense>
            )}
          </main>
          <Inspector
            project={project}
            editing={editing && mode === "schematic"}
            boardEditing={editing && mode === "board"}
            onEdit={edit}
            onQuickFix={quickFix}
            onNoConnectAll={noConnectAll}
            onEditFootprint={(id) => void openFootprintEditor(id)}
            onEditSymbol={(id) => void openSymbolEditor(id)}
            onPlaceUnits={(c, units) => {
              setMode("schematic");
              setPlacing({ key: `u:${c.reference}`, source: { kind: "embedded", file: c.units[0]!.file, libId: c.libId }, prefix: c.reference.replace(/\d+$/, ""), name: c.value, reference: c.reference, units });
              setTool("place");
            }}
            selection={selection}
            openTab={inspectorTab}
            onWide={setWideInspector}
            onSelect={selectAndFocus}
            onOpenSheet={(p) => {
              setSheetPath(p);
              setMode("schematic");
            }}
          />
        </div>
      )}
      {project && (
        <StatusBar
          project={project}
          mode={mode}
          where={
            mode === "schematic"
              ? sheet ? (sheet.namePath === "/" ? "Root sheet" : sheet.namePath) : ""
              : project.board ? `${project.board.copperLayers.length} copper layers${flipped ? " · bottom view" : ""}` : ""
          }
          selection={selection}
          editing={editing && mode !== "3d" ? (mode === "board" ? boardTool : tool) : undefined}
          dirty={dirty}
          busy={busy}
          onIssues={() => setInspectorTab({ tab: "issues" })}
        />
      )}
      {dragging && <div className="dropzone">Drop the KiCad project folder</div>}
    </div>
    </SlotProvider>
  );
}

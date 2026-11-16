/**
 * What an extension can add to the app. The app on its own is a KiCad editor
 * that runs in the browser; an extension adds a way to open or keep a project
 * somewhere else (a repository, an account), panels in the inspector, or an
 * assistant behind some of the editor's buttons.
 *
 * Extensions are chosen when the app is built: `@crossprobe/extensions` resolves to
 * the list this build includes (installed.ts), and the app renders without any.
 * An extension contributes in three ways:
 *
 * - **Static capabilities** on the Extension object: inspector tabs, the
 *   assistant functions some panels call, how to restore a kept project.
 * - **A Root component** the app renders once with an AppHost: its own state,
 *   dialogs and banners, and effects (deep links, checks on focus).
 * - **Fills** (slots.tsx), from inside Root, into the slots the app leaves in
 *   the top bar, the toolbar, the project menu and the start screen; and
 *   `host.contribute` for what the app itself draws (Save, the project menu's label).
 */
import type { ComponentType, ReactNode } from "react";
import type { EditOp } from "../edit/ops";
import type { LoadedProject, Session, SessionState } from "../load";
import type { StoredProject } from "../persist";
import type { LandPattern } from "@crossprobe/kicad-model";
import type { DatasheetIndex, Hit, Passage } from "../datasheet/types";
import type { ComponentInfo, ProjectView } from "../render/types";
import type { IconName } from "../ui/icons";
import type { Selection } from "../ui/selection";

/** An extension's link to the open project (a repository and commit, a stored project and revision), by extension id. */
export type ProjectLinks = Record<string, unknown>;

/** What the app offers an extension's Root. */
export interface AppHost {
  /** The open project, if any, and the latest one for long-running work. */
  project?: ProjectView;
  latest(): ProjectView | undefined;
  /** The open project's worker session. */
  session(): Session | undefined;
  /** "none" once the app has decided no project kept from before a reload comes back. */
  startup: "checking" | "restored" | "none";
  /** Open a project; replaces the open one. */
  open(load: () => Promise<LoadedProject>): Promise<void>;
  /** Files with unsaved changes, and files that differ from the link's last synced state. */
  dirty: string[];
  unsynced: string[];
  /** The project has a folder to save into (writable now, or once the browser grants access again). */
  hasFolder(): boolean;
  /** Path of the open project's .kicad_pro. */
  projectPath(): string;
  /** This extension's link to the open project (undefined: none). */
  link: unknown;
  /**
   * Set or clear (undefined) this extension's link; it is kept with the project over a reload.
   * `deepLink`: the address the project now reopens from (e.g. "cloud=<id>"), or null for none.
   * `saved`: everything was just stored, so nothing is unsaved and the project is no longer new.
   */
  setLink(value: unknown, opts?: { deepLink?: string | null; saved?: boolean }): Promise<void>;
  /** What the app draws for this extension (Save, the project menu's label); replaces what it contributed before. */
  contribute(c: Contribution): void;
  applyState(st: SessionState): void;
  /** Write these files to the project's folder, when it has one, and mark them saved. */
  writeThrough(paths: string[]): Promise<void>;
  /** Save to the folder, or download (the app's own Save). */
  saveLocally(): Promise<void>;
  setStatus(s: string | undefined): void;
  setError(s: string | undefined): void;
  /** Show an inspector tab (the app's or an extension's). */
  showTab(tab: string): void;
}

/** What Save does when an extension takes it over. */
export interface SaveAction {
  /** "commit" when it sends files somewhere (the button says Commit), "save" otherwise. */
  kind: "save" | "commit";
  count: number;
  title: string;
  /** The menu item's text. */
  label: string;
  run(): void;
  /** When two extensions take Save over, the higher priority wins (default 0; ties: the first installed). */
  priority?: number;
}

/** What an extension's Root tells the app to draw. */
export interface Contribution {
  /** Takes over Save (e.g. a project opened from a repository commits). */
  save?: SaveAction;
  /** The project menu's button: where the project lives (icon and short label), and its tooltip line. */
  where?: { icon: IconName; label: string; title: string; count?: number; incoming?: number | true };
  /** A line for the banner shown when a kept project comes back after a reload. */
  restored?: string;
}

/** An inspector tab an extension adds. */
export interface InspectorTab {
  id: string;
  title: string;
  label: ReactNode;
  menuLabel: ReactNode;
  className?: string;
  /** Rendered all the time (to keep its state), hidden when another tab is shown. */
  Panel: ComponentType<InspectorTabProps>;
  /** The selection card stays above this tab. */
  showsSelection?: boolean;
  /** Ask for a wide inspector. */
  wide?: boolean;
}

export interface InspectorTabProps {
  project: ProjectView;
  selection: Selection;
  selectedComponent?: ComponentInfo;
  onSelect(s: Selection): void;
  onEdit?(ops: EditOp[]): void;
  hidden: boolean;
}

/** A section an extension adds to the top of the Review tab (above requirements and compatibility). */
export type ReviewSection = ComponentType<{ project: ProjectView; onSelect(s: Selection): void; onEdit?(ops: EditOp[]): void }>;

// ---------------------------------------------------------------------------
// Assistant functions the editor's panels call when an extension provides them
// ---------------------------------------------------------------------------

/** Whether an assistant can run now, and if not why. */
export interface AssistantStatus {
  available: boolean;
  reason?: string;
  /** Which tasks it runs: "datasheet", "reference", "footprints", "footprint_draft". */
  tasks?: string[];
}

/** A passage the assistant pointed to in a datasheet. */
export interface Shown {
  hit: Hit;
  /** A pointer from the model, kept only when it adds no numbers of its own. */
  label?: string;
}

export interface AskProgress {
  activity?: string;
  shown: Shown[];
  /** The model's one-sentence wrap-up (never values). */
  note: string;
  done: boolean;
  error?: string;
}

/** A difference between a datasheet's reference circuit and how the design connects the part. */
export interface Difference {
  title: string;
  picture: string;
  design: string;
  severity: "check" | "note";
  /** Fractions of the picture's width and height, from the top-left. */
  box: { x: number; y: number; w: number; h: number };
}

/** A footprint the assistant suggests for a part. */
export interface FootprintSuggestion {
  reference: string;
  footprint: string;
  reason: string;
}

export interface SuggestProgress {
  text: string;
  activity?: string;
  suggestions: FootprintSuggestion[];
  done: boolean;
  error?: string;
}

/** A dimension of a drafted footprint and the datasheet passage it comes from. */
export interface Cited {
  field: string;
  value: number;
  passage: Passage;
  quote: string;
}

/** A part that needs a footprint drafted from its datasheet. */
export interface DraftPart {
  reference: string;
  value: string;
  description: string;
  /** Pin numbers and names from the symbol. */
  pins: Array<{ number: string; name: string }>;
}

/** Props of the dialog that drafts a footprint from a part's datasheet. */
export interface FootprintDraftProps {
  part: DraftPart;
  datasheet?: string;
  /** Build it in the project library and open the editor on it. */
  onCreate(pattern: LandPattern, cited: Cited[]): void;
  /** Take KiCad's standard footprint for the part. */
  onUse(libId: string): void;
  onClose(): void;
}

/** What an assistant does for the editor's panels. Each is optional; a panel offers only what is there. */
export interface Assistant {
  status(): Promise<AssistantStatus>;
  /** Find the passages of an indexed datasheet that answer a question. */
  askDatasheet?(index: DatasheetIndex, question: string, context: string, onProgress: (p: AskProgress) => void, signal: AbortSignal): Promise<AskProgress>;
  /** Compare a reference circuit (a PNG, base64) with how the design connects the part. */
  compareReference?(png: string, connections: unknown, caption: string, signal: AbortSignal): Promise<Difference[]>;
  /** Suggest footprints for parts that have none, from KiCad's footprint library. */
  suggestFootprints?(project: () => ProjectView, library: { index: string[]; pads: Record<string, number> }, onProgress: (p: SuggestProgress) => void, signal: AbortSignal): Promise<SuggestProgress>;
  /** The dialog that drafts a footprint from a part's datasheet. */
  FootprintDraft?: ComponentType<FootprintDraftProps>;
}

// ---------------------------------------------------------------------------

export interface Extension {
  id: string;
  /** Before the app first renders (e.g. finishing a sign-in redirect). */
  boot?(): Promise<void> | void;
  /** The deep link (e.g. "cloud=<id>") a project kept over a reload must have been opened from, given the address. */
  deepLink?(params: URLSearchParams): string | undefined;
  /** The address (e.g. "cloud=<id>") a project linked by this extension is opened from, given its link. */
  addressOf?(link: unknown): string | undefined;
  /** A kept project comes back after a reload: e.g. fetch its 3D models from where it is linked. */
  restore?(kept: StoredProject, loaded: LoadedProject): LoadedProject;
  /** It adds "Keep in sync" items to the project menu (the "sync" slot): the menu shows that section. */
  syncsProjects?: boolean;
  /** Fetch a datasheet link for the browser (most sites don't allow reading their PDFs from another page). */
  fetchDatasheet?(url: string): Promise<Response>;
  Root?: ComponentType<{ host: AppHost }>;
  inspectorTabs?: InspectorTab[];
  reviewSection?: ReviewSection;
  /** A sentence added where the requirements list is empty: who else reads the results. */
  requirementsNote?: string;
  /** The Review tab's label and title when this extension adds to it. */
  reviewTab?: { label: ReactNode; menuLabel: ReactNode; title: string; className?: string };
  assistant?: Assistant;
}

/**
 * Where the project comes from and goes to, in one place in the top bar:
 * Save, and a menu to open a project (a folder, or what extensions add), to
 * download it, and to keep it in sync where extensions offer.
 *
 * The menu's button says where the open project lives: what extensions
 * linked it to (a branch, a revision), or just "Project".
 */
import type { Contribution } from "../extensions";
import { installed, Slot } from "../extensions";

/** An extension adds "Keep in sync" items. */
const SYNCS = installed.some((e) => e.syncsProjects);
import { Icon } from "./icons";
import { Menu } from "./Menu";

export interface ProjectMenuProps {
  /** A project is open. */
  open: boolean;
  /** What Save does now (an extension may have taken it over), and how many files it would save (0: nothing to save). */
  save: { kind: "save" | "download" | "commit"; count: number; title: string; label: string; run: () => void };
  /** Where extensions say the project lives. */
  where: NonNullable<Contribution["where"]>[];
  onOpenFolder: () => void;
  onDownload: () => void;
}

export function ProjectMenu(p: ProjectMenuProps) {
  const { save, where } = p;
  const linked = where.length > 0;
  const label = where.map((w) => w.label).join(" · ");
  const title = !p.open ? "Open a project" : where.map((w) => w.title).join("\n") || "Open, save and sync this project";
  const count = where.reduce((n, w) => n + (w.count ?? 0), 0);
  const incoming = where.find((w) => w.incoming)?.incoming;
  return (
    <div className={`project-control${p.open ? "" : " alone"}`}>
      {p.open && (
        <button className={save.count ? "save dirty" : "save"} onClick={save.run} disabled={!save.count} title={save.title}>
          <Icon name={save.kind === "commit" ? "upload" : save.kind} /> <span className="tl">{save.kind === "commit" ? "Commit" : save.kind === "download" ? "Download" : "Save"}</span>
          {save.count > 0 && <span className="count">{save.count}</span>}
        </button>
      )}
      <Menu
        className={`project-menu git-btn${linked ? " linked" : ""}${p.open ? "" : " primary"}`}
        label="Project"
        title={title}
        summary={
          <>
            <Icon name={where[0]?.icon ?? "folderOpen"} /> <span className="tl">{label || (p.open ? "Project" : "Open project")}</span>
            {count > 0 && <span className="count">{count}</span>}
            {incoming && (
              <span className="count incoming" aria-label="Newer changes are available">
                ↓{incoming === true ? "" : incoming}
              </span>
            )}
          </>
        }
      >
        <span className="menu-label">Open</span>
        <button onClick={p.onOpenFolder}>
          <Icon name="folderOpen" /> Open a folder…
        </button>
        <Slot name="open" />
        {p.open && (
          <>
            <hr />
            <span className="menu-label">Save</span>
            <button onClick={save.run} disabled={!save.count} title={save.title}>
              <Icon name={save.kind === "commit" ? "upload" : save.kind} /> {save.label}
              <span className="kbd">⌘S</span>
            </button>
            <button onClick={p.onDownload}>
              <Icon name="download" /> Download the project (.zip)
            </button>
            {SYNCS && (
              <>
                <hr />
                <span className="menu-label">Keep in sync</span>
              </>
            )}
            <Slot name="sync" />
          </>
        )}
      </Menu>
    </div>
  );
}

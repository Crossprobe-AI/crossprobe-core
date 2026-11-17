/**
 * Page settings (KiCad's dialog): paper size and orientation, and the title block, for the
 * current schematic sheet or the board, optionally copied to every sheet and the board.
 */
import { useEffect, useState } from "react";
import { PAPER_SIZES, pageSettings, sheetRoot, boardRoot, type PageSettings } from "@crossprobe/kicad-model";
import { parse } from "@crossprobe/kicad-sexpr";
import type { EditOp } from "../edit/ops";
import { Icon } from "./icons";

export function PageSettingsDialog({
  file,
  sheetFiles,
  boardFile,
  readFiles,
  onEdit,
  onClose,
  projectFile,
  intersheetRefs,
}: {
  /** The project file, and how its global labels list their pages (schematic sheets only). */
  projectFile?: string;
  intersheetRefs?: import("@crossprobe/kicad-model").IntersheetRefSettings;
  /** The sheet file or board being set up. */
  file: string;
  /** Every schematic sheet file (for "all sheets"). */
  sheetFiles: string[];
  boardFile?: string;
  readFiles: (paths: string[]) => Promise<Record<string, string>>;
  onEdit: (ops: EditOp[]) => void;
  onClose: () => void;
}) {
  const [s, setS] = useState<PageSettings>();
  const [everywhere, setEverywhere] = useState(false);
  const [refs, setRefs] = useState(intersheetRefs);
  const isBoard = file.endsWith(".kicad_pcb");
  useEffect(() => {
    void readFiles([file]).then((f) => {
      const text = f[file];
      if (!text) return;
      const doc = parse(text);
      setS(pageSettings(isBoard ? boardRoot(doc) : sheetRoot(doc)));
    });
  }, [file, isBoard, readFiles]);
  if (!s) return null;
  const set = (patch: Partial<PageSettings>) => setS({ ...s, ...patch });
  const size = s.paper === "User" ? [s.width ?? 297, s.height ?? 210] : PAPER_SIZES[s.paper] ?? [297, 210];
  const [w, h] = s.portrait && s.paper !== "User" ? [size[1], size[0]] : size;

  const apply = async () => {
    const ops: EditOp[] = [{ op: "setPageSettings", file, settings: s }];
    if (everywhere) {
      // Others keep their paper; the title block is copied.
      const others = [...sheetFiles, ...(boardFile ? [boardFile] : [])].filter((f) => f !== file);
      const texts = await readFiles(others);
      for (const f of others) {
        const text = texts[f];
        if (!text) continue;
        const doc = parse(text);
        const own = pageSettings(f.endsWith(".kicad_pcb") ? boardRoot(doc) : sheetRoot(doc));
        ops.push({ op: "setPageSettings", file: f, settings: { ...s, paper: own.paper, width: own.width, height: own.height, portrait: own.portrait } });
      }
    }
    if (projectFile && refs && intersheetRefs && JSON.stringify(refs) !== JSON.stringify(intersheetRefs)) {
      ops.push({
        op: "setSchematicDrawing",
        file: projectFile,
        drawing: { intersheets_ref_show: refs.show, intersheets_ref_own_page: refs.ownPage, intersheets_ref_short: refs.short, intersheets_ref_prefix: refs.prefix, intersheets_ref_suffix: refs.suffix },
      });
    }
    onEdit(ops);
    onClose();
  };
  const today = () => new Date().toISOString().slice(0, 10);

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal page-settings" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <div className="update-head">
          <strong>
            Page settings <span className="muted small mono">{file.split("/").pop()}</span>
          </strong>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="page-grid">
          <label className="prop">
            <span>Paper</span>
            <select value={s.paper} onChange={(e) => set({ paper: e.target.value })}>
              {[...Object.keys(PAPER_SIZES), "User"].map((p) => (
                <option key={p} value={p}>
                  {p === "User" ? "User size" : `${p} (${PAPER_SIZES[p]![0]} × ${PAPER_SIZES[p]![1]} mm)`}
                </option>
              ))}
            </select>
          </label>
          {s.paper === "User" ? (
            <>
              <label className="prop">
                <span>Width</span>
                <input type="number" step="0.1" value={s.width ?? 297} onChange={(e) => set({ width: Number(e.target.value) })} /> mm
              </label>
              <label className="prop">
                <span>Height</span>
                <input type="number" step="0.1" value={s.height ?? 210} onChange={(e) => set({ height: Number(e.target.value) })} /> mm
              </label>
            </>
          ) : (
            <label className="prop">
              <span>Orientation</span>
              <select value={s.portrait ? "portrait" : "landscape"} onChange={(e) => set({ portrait: e.target.value === "portrait" })}>
                <option value="landscape">Landscape</option>
                <option value="portrait">Portrait</option>
              </select>
            </label>
          )}
          <p className="muted small">
            {w} × {h} mm
          </p>
          <label className="prop">
            <span>Title</span>
            <input value={s.title} onChange={(e) => set({ title: e.target.value })} />
          </label>
          <label className="prop">
            <span>Date</span>
            <input value={s.date} onChange={(e) => set({ date: e.target.value })} />
            <button className="link" onClick={() => set({ date: today() })}>
              Today
            </button>
          </label>
          <label className="prop">
            <span>Revision</span>
            <input value={s.rev} onChange={(e) => set({ rev: e.target.value })} />
          </label>
          <label className="prop">
            <span>Company</span>
            <input value={s.company} onChange={(e) => set({ company: e.target.value })} />
          </label>
          {s.comments.map((c, i) => (
            <label className="prop" key={i}>
              <span>Comment {i + 1}</span>
              <input value={c} onChange={(e) => set({ comments: s.comments.map((x, j) => (j === i ? e.target.value : x)) })} />
            </label>
          ))}
        </div>
        {!isBoard && refs && (
          <fieldset className="page-refs">
            <legend>
              <label title="Next to each global label, the pages its net also has a global label on (project-wide)">
                <input type="checkbox" checked={refs.show} onChange={(e) => setRefs({ ...refs, show: e.target.checked })} /> Show the pages of global labels
              </label>
            </legend>
            {refs.show && (
              <div className="page-grid">
                <label className="prop">
                  <span />
                  <span>
                    <input type="checkbox" checked={refs.ownPage} onChange={(e) => setRefs({ ...refs, ownPage: e.target.checked })} /> Include the label's own page
                  </span>
                </label>
                <label className="prop">
                  <span />
                  <span>
                    <input type="checkbox" checked={refs.short} onChange={(e) => setRefs({ ...refs, short: e.target.checked })} /> Short form (2..5)
                  </span>
                </label>
                <label className="prop">
                  <span>Before</span>
                  <input value={refs.prefix} onChange={(e) => setRefs({ ...refs, prefix: e.target.value })} placeholder="e.g. [" />
                </label>
                <label className="prop">
                  <span>After</span>
                  <input value={refs.suffix} onChange={(e) => setRefs({ ...refs, suffix: e.target.value })} placeholder="e.g. ]" />
                </label>
              </div>
            )}
          </fieldset>
        )}
        {(sheetFiles.length > 1 || (boardFile && !isBoard) || (isBoard && sheetFiles.length)) && (
          <label className="prop page-everywhere">
            <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} /> Same title block on every sheet{boardFile ? " and the board" : ""} (each keeps its paper)
          </label>
        )}
        <div className="update-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void apply()}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

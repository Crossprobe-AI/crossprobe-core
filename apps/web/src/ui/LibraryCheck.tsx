/**
 * Footprints against their library copies (KiCad's DRC library parity:
 * lib_footprint_mismatch and lib_footprint_issues): each placed footprint is
 * compared with the copy in its library (the project's libraries, then
 * KiCad's), by footprintDifference. Differing ones can be updated from the
 * library in one undoable edit (KiCad's Update Footprints from Library).
 */
import { useEffect, useState } from "react";
import { boardRoot, findBoardItem, footprintDifference } from "@crossprobe/kicad-model";
import { parse } from "@crossprobe/kicad-sexpr";
import type { EditOp } from "../edit/ops";
import { kicadFootprint } from "../load";
import type { ProjectView } from "../render/types";
import { Icon } from "./icons";

type Row = { uuid: string; reference: string; libId: string; reason?: string; text?: string };

export function LibraryCheck({
  project,
  readFiles,
  onEdit,
  onClose,
  onShow,
}: {
  project: ProjectView;
  readFiles: (paths: string[]) => Promise<Record<string, string>>;
  onEdit: (ops: EditOp[]) => void;
  onClose: () => void;
  onShow: (reference: string) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [done, setDone] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const board = project.board!;
    const file = project.boardFile!;
    void (async () => {
      const text = (await readFiles([file]))[file];
      if (!text || cancelled) return;
      const root = boardRoot(parse(text, { recover: true }));
      const layers = board.layers.map((l) => l.name);
      const libs = new Map<string, Promise<string | undefined>>();
      const out: Row[] = [];
      let n = 0;
      for (const fp of board.footprints) {
        if (cancelled) return;
        const [lib, name] = fp.libId.split(":");
        if (!lib || !name) continue;
        if (!libs.has(fp.libId)) libs.set(fp.libId, kicadFootprint(fp.libId));
        const mod = await libs.get(fp.libId)!;
        const node = findBoardItem(root, fp.uuid);
        if (!mod) out.push({ uuid: fp.uuid, reference: fp.reference, libId: fp.libId, reason: "not found in the libraries" });
        else if (node) {
          const reason = footprintDifference(node, mod, { layers, copperLayers: board.copperLayers });
          if (reason) out.push({ uuid: fp.uuid, reference: fp.reference, libId: fp.libId, reason, text: mod });
        }
        // Let the page breathe on big boards.
        if (++n % 25 === 0) {
          setDone(n);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      if (!cancelled) {
        setDone(n);
        setRows(out);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.board, project.boardFile, readFiles]);
  const differing = rows?.filter((r) => r.text) ?? [];
  const missing = rows?.filter((r) => !r.text) ?? [];
  const update = () => {
    if (differing.length) onEdit([{ op: "updateFootprints", file: project.boardFile!, updates: differing.map((r) => ({ uuid: r.uuid, text: r.text! })) }]);
    onClose();
  };
  return (
    <div className="update-pcb library-check" onPointerDown={(e) => e.stopPropagation()}>
      <div className="update-head">
        <strong>Footprints against libraries</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="update-body">
        {!rows ? (
          <p className="muted small">
            Comparing… {done} of {project.board!.footprints.length}
          </p>
        ) : !rows.length ? (
          <p className="muted small">Every footprint matches its library copy.</p>
        ) : (
          <ul className="update-list small">
            {differing.length > 0 && (
              <li>
                <details open>
                  <summary>
                    <strong>{differing.length}</strong> differ from their library copy
                  </summary>
                  <ul>
                    {differing.slice(0, 200).map((r) => (
                      <li key={r.uuid}>
                        <button className="link" onClick={() => onShow(r.reference)}>
                          {r.reference}
                        </button>{" "}
                        <span className="muted">
                          {r.libId}: {r.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            )}
            {missing.length > 0 && (
              <li>
                <details>
                  <summary>
                    <strong>{missing.length}</strong> not in the libraries
                  </summary>
                  <ul>
                    {missing.slice(0, 200).map((r) => (
                      <li key={r.uuid}>
                        <button className="link" onClick={() => onShow(r.reference)}>
                          {r.reference}
                        </button>{" "}
                        <span className="muted">{r.libId}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            )}
          </ul>
        )}
        <p className="muted small">Texts, 3D models and clearance overrides aren't compared, as in KiCad's DRC.</p>
      </div>
      <div className="update-actions">
        <button onClick={onClose}>Close</button>
        <button className="primary" disabled={!differing.length} onClick={update}>
          <Icon name="sync" /> Update {differing.length || ""} from library
        </button>
      </div>
    </div>
  );
}

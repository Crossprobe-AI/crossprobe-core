/**
 * Board statistics (KiCad's dialog and `kicad-cli pcb export stats`): parts by mount type and
 * side, pads and vias by type, the board's size and area, the thinnest track and smallest drill,
 * and the drill table. The numbers equal kicad-cli's on the demo boards (test/board-stats).
 */
import { useMemo } from "react";
import { boardStatistics, type Board } from "@crossprobe/kicad-model";
import { downloadFile } from "../load";
import { Icon } from "./icons";

const f = (v: number | undefined, d = 2) => (v === undefined ? "—" : v.toFixed(d));

export function BoardStats({ board, name, onClose }: { board: Board; name: string; onClose: () => void }) {
  const s = useMemo(() => boardStatistics(board), [board]);
  const c = s.components;
  const csv = () => {
    const rows = [["Count", "Shape", "X (mm)", "Y (mm)", "Plated", "Source", "Start", "Stop"], ...s.drills.map((d) => [d.count, d.shape, d.x.toFixed(4), d.y.toFixed(4), d.plated ? "PTH" : "NPTH", d.source, d.start, d.stop])];
    downloadFile(`${name}-drills.csv`, rows.map((r) => r.join(",")).join("\n") + "\n");
  };
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal board-stats" onPointerDown={(e) => e.stopPropagation()}>
        <div className="update-head">
          <strong>Board statistics</strong>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="stats-grid">
          <table>
            <thead>
              <tr>
                <th>Parts</th>
                <th>Front</th>
                <th>Back</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {(["tht", "smd", "unspecified"] as const).map((k) => (
                <tr key={k}>
                  <td>{k === "tht" ? "Through-hole" : k === "smd" ? "SMD" : "Other"}</td>
                  <td>{c[k].front}</td>
                  <td>{c[k].back}</td>
                  <td>{c[k].front + c[k].back}</td>
                </tr>
              ))}
              <tr className="total">
                <td>All</td>
                <td>{c.tht.front + c.smd.front + c.unspecified.front}</td>
                <td>{c.tht.back + c.smd.back + c.unspecified.back}</td>
                <td>{c.tht.front + c.smd.front + c.unspecified.front + c.tht.back + c.smd.back + c.unspecified.back}</td>
              </tr>
            </tbody>
          </table>
          <table>
            <thead>
              <tr>
                <th>Pads</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr><td>Through-hole</td><td>{s.pads.throughHole}</td></tr>
              <tr><td>SMD</td><td>{s.pads.smd}</td></tr>
              <tr><td>Connector</td><td>{s.pads.connector}</td></tr>
              <tr><td>NPTH</td><td>{s.pads.npth}</td></tr>
              {s.pads.castellated > 0 && <tr><td>Castellated</td><td>{s.pads.castellated}</td></tr>}
              {s.pads.pressFit > 0 && <tr><td>Press-fit</td><td>{s.pads.pressFit}</td></tr>}
            </tbody>
          </table>
          <table>
            <thead>
              <tr>
                <th>Vias</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr><td>Through</td><td>{s.vias.through}</td></tr>
              <tr><td>Blind</td><td>{s.vias.blind}</td></tr>
              <tr><td>Buried</td><td>{s.vias.buried}</td></tr>
              <tr><td>Micro</td><td>{s.vias.micro}</td></tr>
            </tbody>
          </table>
          <table>
            <thead>
              <tr>
                <th>Board</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr><td>Size</td><td>{s.board.hasOutline ? `${f(s.board.width)} × ${f(s.board.height)} mm` : "no outline"}</td></tr>
              <tr><td>Area</td><td>{s.board.hasOutline ? `${f(s.board.area, 1)} mm²` : "—"}</td></tr>
              <tr><td>Thickness</td><td>{f(s.board.thickness)} mm</td></tr>
              <tr><td>Thinnest track</td><td>{f(s.board.minTrackWidth, 3)} mm</td></tr>
              <tr><td>Smallest drill</td><td>{f(s.board.minDrill, 3)} mm</td></tr>
            </tbody>
          </table>
        </div>
        <h4>Drill holes</h4>
        <div className="fields-scroll stats-drills">
          <table>
            <thead>
              <tr>
                {["Count", "Shape", "X", "Y", "Plated", "Via/pad", "Start", "Stop"].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.drills.map((d, i) => (
                <tr key={i}>
                  <td className="num">{d.count}</td>
                  <td>{d.shape}</td>
                  <td className="num">{d.x.toFixed(3)}</td>
                  <td className="num">{d.y.toFixed(3)}</td>
                  <td>{d.plated ? "PTH" : "NPTH"}</td>
                  <td>{d.source}</td>
                  <td className="mono">{d.start}</td>
                  <td className="mono">{d.stop}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="update-actions">
          <button onClick={csv}>Drill table CSV</button>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

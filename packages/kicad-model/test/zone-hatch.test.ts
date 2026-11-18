/**
 * Hatched zone fills against KiCad's: pic_programmer's GND zone made hatched (straight, turned
 * 30°, and with chamfered and rounded holes), refilled by KiCad's pcbnew, and by us. Our fill
 * covers the same copper: the area where the two differ is a small part of KiCad's. One case
 * adds GND vias, which a hatched zone relieves like thermal pads.
 * Env: KICAD_DEMOS, KICAD_PYTHON.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fillDifference, fillZones, parseBoard, projectDesignRules } from "../src/index.js";

const DEMOS = process.env.KICAD_DEMOS!;
const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";
const PCB = join(DEMOS ?? "", "pic_programmer/pic_programmer.kicad_pcb");

// GND vias across the zone, clear of other copper (KiCad gives a via on a track that track's net),
// some alone in a hatch hole: KiCad relieves them, with rings and spokes.
function gndVias(text: string): string {
  const b = parseBoard(text);
  const copper = [...b.tracks.flatMap((t) => [t.start, t.end, { x: (t.start.x + t.end.x) / 2, y: (t.start.y + t.end.y) / 2 }]), ...b.vias.map((v) => v.at), ...b.footprints.flatMap((f) => [f.at, ...f.pads.map((p) => p.at)])];
  const segDist = (p: { x: number; y: number }) =>
    Math.min(
      ...b.tracks.map((t) => {
        const dx = t.end.x - t.start.x, dy = t.end.y - t.start.y;
        const k = Math.max(0, Math.min(1, ((p.x - t.start.x) * dx + (p.y - t.start.y) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(p.x - t.start.x - k * dx, p.y - t.start.y - k * dy) - t.width / 2;
      }),
    );
  const out: string[] = [];
  for (let y = 50; y <= 130 && out.length < 14; y += 9.1)
    for (let x = 80; x <= 225 && out.length < 14; x += 13.3) {
      const p = { x, y };
      if (segDist(p) < 2.5 || copper.some((q) => Math.hypot(q.x - x, q.y - y) < 4)) continue;
      out.push(`\t(via (at ${x.toFixed(3)} ${y.toFixed(3)}) (size 1.2) (drill 0.6) (layers "F.Cu" "B.Cu") (net "GND") (uuid "7a26e5f1-0000-4000-8000-0000000001${String(out.length).padStart(2, "0")}"))\n`);
    }
  return out.join("");
}

// Thin lines have more edge per mm²: the same small differences along it are a larger share.
const CASES: Array<{ name: string; hatch: string; vias?: boolean; limit?: number }> = [
  { name: "1 mm lines, 1.5 mm gaps", hatch: "(hatch_thickness 1) (hatch_gap 1.5) (hatch_orientation 0)" },
  { name: "turned 30°, 0.6 mm lines", hatch: "(hatch_thickness 0.6) (hatch_gap 1) (hatch_orientation 30)" },
  { name: "chamfered holes", hatch: "(hatch_thickness 0.8) (hatch_gap 1.6) (hatch_orientation 0) (hatch_smoothing_level 1) (hatch_smoothing_value 0.5)" },
  { name: "rounded holes, 45°", hatch: "(hatch_thickness 0.8) (hatch_gap 1.6) (hatch_orientation 45) (hatch_smoothing_level 2) (hatch_smoothing_value 0.6)" },
  { name: "GND vias, thin lines, wide gaps", hatch: "(hatch_thickness 0.4) (hatch_gap 2.5) (hatch_orientation 0)", vias: true, limit: 0.06 },
];

describe.skipIf(!existsSync(PCB) || !existsSync(PY))("hatched zone fill as KiCad's", () => {
  for (const c of CASES)
    it(c.name, () => {
      let text = readFileSync(PCB, "utf8").replace(/\(fill yes\n(\t+)\(thermal_gap/, (_, t: string) => `(fill yes\n${t}(mode hatch) ${c.hatch} (hatch_min_hole_area 0.3)\n${t}(thermal_gap`);
      if (c.vias) text = text.slice(0, text.lastIndexOf(")")) + gndVias(text) + ")\n";
      expect(text).toContain("(mode hatch)");
      const dir = mkdtempSync(join(tmpdir(), "crossprobe-hatch-"));
      writeFileSync(join(dir, "in.kicad_pcb"), text);
      try {
        execFileSync(PY, [join(import.meta.dirname, "pcbnew-refill.py"), join(dir, "in.kicad_pcb"), join(dir, "out.kicad_pcb")], { stdio: "ignore" });
      } catch {
        // pcbnew may crash on exit after saving.
      }
      const theirs = parseBoard(readFileSync(join(dir, "out.kicad_pcb"), "utf8"));
      // KiCad kept the vias' net (none on other copper).
      if (c.vias) expect(theirs.vias.filter((v) => v.net === "GND").length).toBe(14);
      const pro = PCB.replace(/\.kicad_pcb$/, ".kicad_pro");
      const ours = fillZones(parseBoard(text), projectDesignRules(readFileSync(pro, "utf8")));
      let kicad = 0, diff = 0;
      for (const f of ours) {
        const z = theirs.zones.find((x) => x.uuid === f.zone.uuid)!;
        const d = fillDifference(f.paths, z.fills.filter((p) => p.layer === f.layer).map((p) => p.points));
        kicad += d.kicadArea;
        diff += d.xorArea;
      }
      if (process.env.ORACLE_VERBOSE) writeFileSync(join(process.env.ORACLE_VERBOSE, `${c.name.replace(/\W+/g, "_")}.txt`), `${c.name}: ${((100 * diff) / kicad).toFixed(2)}% of ${kicad.toFixed(0)} mm²\n`);
      expect(kicad).toBeGreaterThan(1000);
      expect(diff / kicad).toBeLessThan(c.limit ?? 0.04);
    });
});

/**
 * A board of one hatched GND zone and one small GND via, placed so a hatch hole encloses the via's
 * relief while the ring's outer edge crosses the hole: KiCad keeps that hole (it drops a hole only
 * when it encloses a ring's outer contour), so the via hangs on its spokes.
 */
function oneVia(via?: { x: number; y: number }): string {
  const head = readFileSync(PCB, "utf8");
  const setupEnd = head.indexOf("\n\t)\n", head.indexOf("\n\t(setup")) + 4;
  return (
    head.slice(0, setupEnd) +
    `\t(gr_rect (start 0 0) (end 40 30) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "7a26e5f1-0000-4000-8000-000000000201"))
${via ? `\t(via (at ${via.x} ${via.y}) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "GND") (uuid "7a26e5f1-0000-4000-8000-000000000202"))\n` : ""}\t(zone (net "GND") (layer "B.Cu") (uuid "7a26e5f1-0000-4000-8000-000000000203") (hatch edge 0.5) (connect_pads (clearance 0.3)) (min_thickness 0.25)
\t\t(fill yes (mode hatch) (thermal_gap 0.5) (thermal_bridge_width 0.5) (hatch_thickness 0.3) (hatch_gap 2.5) (hatch_orientation 0) (hatch_min_hole_area 0.3))
\t\t(polygon (pts (xy 1 1) (xy 39 1) (xy 39 29) (xy 1 29))))
)
`
  );
}

describe.skipIf(!existsSync(PCB) || !existsSync(PY))("hatch holes around a small via, as KiCad's", () => {
  it("a hole enclosing the relief but crossed by the ring stays", () => {
    // Ours against KiCad's, with the via and without: the via adds next to nothing to the
    // difference (the rest is along the zone's edges). Dropping that hole added about 1.4 mm².
    const xor = (text: string, name: string) => {
      const dir = mkdtempSync(join(tmpdir(), "crossprobe-hatch-via-"));
      writeFileSync(join(dir, "in.kicad_pcb"), text);
      try {
        execFileSync(PY, [join(import.meta.dirname, "pcbnew-refill.py"), join(dir, "in.kicad_pcb"), join(dir, "out.kicad_pcb")], { stdio: "ignore" });
      } catch {
        // pcbnew may crash on exit after saving.
      }
      const theirs = parseBoard(readFileSync(join(dir, "out.kicad_pcb"), "utf8"));
      const d = fillDifference(fillZones(parseBoard(text), projectDesignRules("{}"))[0]!.paths, theirs.zones[0]!.fills.map((p) => p.points));
      if (process.env.ORACLE_VERBOSE) writeFileSync(join(process.env.ORACLE_VERBOSE, `one_via_${name}.txt`), `${name}: xor ${d.xorArea.toFixed(3)} of ${d.kicadArea.toFixed(2)} mm²\n`);
      expect(d.kicadArea).toBeGreaterThan(200);
      return d.xorArea;
    };
    expect(xor(oneVia({ x: 20.8, y: 15.4 }), "via") - xor(oneVia(), "none")).toBeLessThan(0.2);
  });
});

/**
 * Zone properties as KiCad's zone dialog sets them. Ours are written into the
 * demo boards' zones and read back by KiCad's pcbnew: every property must be
 * what was set, and our own parse must agree.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "@crossprobe/kicad-sexpr";
import { boardRoot, findBoardItem, parseBoard, setZoneProps, type ZoneProps } from "../src/index.js";

const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";
const DEMOS = process.env.KICAD_DEMOS!;
const BOARDS = ["pic_programmer/pic_programmer.kicad_pcb", "stickhub/StickHub.kicad_pcb", "video/video.kicad_pcb"].filter((b) => existsSync(join(DEMOS, b)));

// KiCad's ZONE_CONNECTION: 1 thermal, 2 solid (full), 0 none, 3 through-hole thermal.
const CONNECT = { thermal: 1, solid: 2, none: 0, tht: 3 } as const;

describe.skipIf(!existsSync(PY) || !BOARDS.length)("zone properties KiCad reads back", () => {
  const sets: ZoneProps[] = [
    { name: "Pour A", priority: 3, clearance: 0.3, minThickness: 0.2, thermalGap: 0.4, thermalWidth: 0.45, islandMode: 2, islandAreaMin: 2.5, connect: "solid" },
    { name: "", priority: 0, clearance: 0.127, minThickness: 0.254, thermalGap: 0.25, thermalWidth: 0.3, islandMode: 1, connect: "tht" },
  ];
  it.each(BOARDS)("%s", (rel) => {
    const text = readFileSync(join(DEMOS, rel), "utf8");
    const zones = parseBoard(text).zones.filter((z) => !z.keepout);
    for (const props of sets) {
      const doc = parse(text);
      const root = boardRoot(doc);
      for (const z of zones) setZoneProps(root, findBoardItem(root, z.uuid)!, props);
      const dir = mkdtempSync(join(tmpdir(), "zone-"));
      writeFileSync(join(dir, "z.kicad_pcb"), serialize(doc));
      try {
        execFileSync(PY, [join(import.meta.dirname, "pcbnew-zone.py"), join(dir, "z.kicad_pcb"), join(dir, "z.json")], { stdio: "ignore" });
      } catch {
        // pcbnew may crash on exit after writing its output.
      }
      const theirs = JSON.parse(readFileSync(join(dir, "z.json"), "utf8"));
      const ours = parseBoard(serialize(doc));
      for (const z of zones) {
        const k = theirs[z.uuid];
        const want = {
          name: props.name,
          priority: props.priority,
          clearance: props.clearance,
          minThickness: props.minThickness,
          thermalGap: props.thermalGap,
          thermalWidth: props.thermalWidth,
          islandMode: props.islandMode,
          connect: CONNECT[props.connect!],
        };
        expect({ ...k, islandAreaMin: undefined }, `${rel} ${z.uuid}`).toEqual({ ...want, islandAreaMin: undefined });
        if (props.islandMode === 2) expect(k.islandAreaMin).toBeCloseTo(props.islandAreaMin!, 6);
        const o = ours.zones.find((x) => x.uuid === z.uuid)!;
        expect({ name: o.name, priority: o.priority, clearance: o.clearance, minThickness: o.minThickness, thermalGap: o.thermalGap, thermalWidth: o.thermalWidth, islandMode: o.islandMode, connect: o.connect }).toEqual({ ...want, connect: props.connect });
      }
    }
  });
});

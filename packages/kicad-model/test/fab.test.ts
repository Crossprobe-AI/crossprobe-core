/**
 * Fabrication outputs checked against KiCad's own plots (kicad-cli): each
 * Gerber layer read back as polygons must cover the same copper, silkscreen
 * and text as KiCad's (text in KiCad's own stroke font, so exactly),
 * drill files must hold the same holes, and position files must be identical.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { drillFile, fabricationFiles, parseBoard, positionCsv } from "../src/index.js";
import { area, readGerber, xor } from "./gerber-read.js";

const DEMOS = "/Library/Application Support/kicad/demos";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
let ok = existsSync(DEMOS);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  ok = false;
}

const BOARDS = ["pic_programmer/pic_programmer.kicad_pcb", "stickhub/StickHub.kicad_pcb", "video/video.kicad_pcb"];

/** Holes as [diameter, x, y, (x2, y2 for slots)] in mm. */
function holes(text: string): number[][] {
  const tools = new Map<string, number>();
  let d = 0;
  const out: number[][] = [];
  for (const l of text.split(/\r?\n/)) {
    let m = /^T(\d+)C([\d.]+)/.exec(l);
    if (m) {
      tools.set(m[1]!, Number(m[2]));
      continue;
    }
    m = /^T(\d+)$/.exec(l);
    if (m) {
      d = tools.get(m[1]!) ?? 0;
      continue;
    }
    m = /^X(-?[\d.]+)Y(-?[\d.]+)(?:G85X(-?[\d.]+)Y(-?[\d.]+))?/.exec(l);
    if (m) out.push([d, ...m.slice(1).filter(Boolean).map(Number)]);
  }
  return out;
}

/** Holes of `a` with no hole of the same size within 0.01 mm in `b`. */
function unmatched(a: number[][], b: number[][]): number[][] {
  const pool = new Map<string, number[][]>();
  const key = (h: number[]) => `${h[0]!.toFixed(3)}:${Math.round(h[1]!)}:${Math.round(h[2]!)}`;
  for (const h of b) pool.set(key(h), [...(pool.get(key(h)) ?? []), h]);
  return a.filter((h) => {
    for (const dx of [-1, 0, 1])
      for (const dy of [-1, 0, 1]) {
        const k = `${h[0]!.toFixed(3)}:${Math.round(h[1]!) + dx}:${Math.round(h[2]!) + dy}`;
        const list = pool.get(k);
        const i = list?.findIndex((q) => q.length === h.length && q.every((v, j) => Math.abs(v - h[j]!) <= 0.01)) ?? -1;
        if (i >= 0) {
          list!.splice(i, 1);
          return false;
        }
      }
    return true;
  });
}

describe.skipIf(!ok)("fabrication outputs vs KiCad", () => {
  for (const rel of BOARDS) {
    const name = rel.split("/").pop()!.replace(".kicad_pcb", "");
    it(`${name}: Gerbers, drill and positions match KiCad's`, () => {
      const file = join(DEMOS, rel);
      const dir = mkdtempSync(join(tmpdir(), "crossprobe-fab-"));
      execFileSync(KICAD_CLI, ["pcb", "export", "gerbers", "--no-protel-ext", "-o", dir + "/", file], { stdio: "ignore" });
      execFileSync(KICAD_CLI, ["pcb", "export", "drill", "--excellon-separate-th", "--excellon-units", "mm", "-o", dir + "/", file], { stdio: "ignore" });
      execFileSync(KICAD_CLI, ["pcb", "export", "pos", "--format", "csv", "--units", "mm", "-o", join(dir, "pos.csv"), file], { stdio: "ignore" });
      const board = parseBoard(readFileSync(file, "utf8"));
      const ours = fabricationFiles(board, { name });

      for (const [f, text] of Object.entries(ours)) {
        if (!f.endsWith(".gbr")) continue;
        const kicad = readGerber(readFileSync(join(dir, f), "utf8"));
        const mine = readGerber(text);
        const ka = area(kicad);
        const layer = board.layers.find((l) => f.endsWith(`-${(l.userName ?? l.name).replace(/\./g, "_")}.gbr`))?.name ?? f;
        if (ka < 1e-6) {
          expect(area(mine), f).toBeLessThan(1e-3);
        } else {
          expect(area(xor(kicad, mine)) / ka, f).toBeLessThan(0.01);
        }
      }

      for (const [plated, suffix] of [[true, "PTH"], [false, "NPTH"]] as const) {
        const kf = readdirSync(dir).find((f) => f.endsWith(`-${suffix}.drl`));
        const theirs = kf ? holes(readFileSync(join(dir, kf), "utf8")) : [];
        const mine = holes(drillFile(board, plated, { name }));
        expect(mine.length, suffix).toBe(theirs.length);
        expect(unmatched(mine, theirs), suffix).toEqual([]);
      }

      const rows = (t: string) => t.trim().split("\n").slice(1).map((l) => l.replace(/"/g, "")).sort();
      expect(rows(positionCsv(board))).toEqual(rows(readFileSync(join(dir, "pos.csv"), "utf8")));
    }, 120_000);
  }
});

/**
 * Footprints against their library copies, as KiCad's DRC checks them
 * (lib_footprint_mismatch). On each demo board, every footprint whose library
 * KiCad finds (the project's library table, then the global one, as on this
 * computer) is compared with its library copy; we must flag exactly the ones
 * `kicad-cli pcb drc` flags. Env: KICAD_DEMOS, KICAD_CLI, KICAD_FOOTPRINTS,
 * KICAD_FP_LIB_TABLE (the global table; ~/Library/Preferences/kicad/10.0 by default).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "@crossprobe/kicad-sexpr";
import { boardRoot, findBoardItem, footprintDifference, parseBoard } from "../src/index.js";

const DEMOS = process.env.KICAD_DEMOS!;
const KICAD_CLI = process.env.KICAD_CLI!;
const GLOBAL = process.env.KICAD_FP_LIB_TABLE ?? join(homedir(), "Library/Preferences/kicad/10.0/fp-lib-table");
const CACHE = join(tmpdir(), "crossprobe-libparity-cache");
mkdirSync(CACHE, { recursive: true });
const ok = existsSync(DEMOS) && existsSync(GLOBAL) && existsSync(process.env.KICAD_FOOTPRINTS!);

function boards(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) boards(p, out);
    else if (name.endsWith(".kicad_pcb")) out.push(p);
  }
  return out;
}

/** A library table's rows (nested "Table" rows read in turn), with paths resolved. */
function libTable(file: string, prjDir: string, out = new Map<string, string>()): Map<string, string> {
  if (!existsSync(file)) return out;
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\(lib \(name "([^"]*)"\)\s*\(type "([^"]*)"\)\s*\(uri "([^"]*)"\)/g)) {
    const [, name, type, raw] = m;
    const uri = raw!
      .replace(/\$\{KIPRJMOD\}/g, prjDir)
      .replace(/\$\{KICAD\d*_FOOTPRINT_DIR\}/g, process.env.KICAD_FOOTPRINTS!);
    if (type === "Table") libTable(uri, prjDir, out);
    else if (!out.has(name!)) out.set(name!, uri);
  }
  return out;
}

describe.skipIf(!ok)("footprints against their library copies, as KiCad's DRC", () => {
  it.each(ok ? boards(DEMOS) : [])("%s", (pcb) => {
    const report = join(CACHE, `${basename(pcb)}-${statSync(pcb).mtimeMs}.json`);
    if (!existsSync(report)) execFileSync(KICAD_CLI, ["pcb", "drc", "--severity-all", "--format", "json", "-o", report, pcb], { stdio: "ignore" });
    const r = JSON.parse(readFileSync(report, "utf8")) as { violations: Array<{ type: string; items: Array<{ description: string }> }> };
    const flagged = (type: string) => new Set(r.violations.filter((v) => v.type === type).map((v) => /Footprint (\S+)/.exec(v.items[0]!.description)?.[1] ?? ""));
    const mismatched = flagged("lib_footprint_mismatch");
    // KiCad stops reporting a type after 200; past that we can't tell.
    if (mismatched.size >= 199) return;
    const issues = flagged("lib_footprint_issues");
    // The project's table first, then the global one (as KiCad looks them up).
    const tables = libTable(join(dirname(pcb), "fp-lib-table"), dirname(pcb));
    libTable(GLOBAL, dirname(pcb), tables);
    const text = readFileSync(pcb, "utf8");
    const board = parseBoard(text);
    const root = boardRoot(parse(text, { recover: true }));
    const layers = board.layers.map((l) => l.name);
    const missed: string[] = [], extra: string[] = [];
    let compared = 0;
    for (const fp of board.footprints) {
      const [lib, name] = fp.libId.split(":");
      if (!lib || !name || issues.has(fp.reference)) continue;
      const file = tables.get(lib) && join(tables.get(lib)!, `${name}.kicad_mod`);
      if (!file || !existsSync(file)) continue;
      compared++;
      let diff: string | undefined;
      try {
        diff = footprintDifference(findBoardItem(root, fp.uuid)!, readFileSync(file, "utf8"), { layers, copperLayers: board.copperLayers });
      } catch (e) {
        throw new Error(`${fp.reference} ${file}: ${(e as Error).message}`);
      }
      const theirs = mismatched.has(fp.reference);
      if (theirs && !diff) missed.push(`${fp.reference} (${fp.libId})`);
      if (diff && !theirs) extra.push(`${fp.reference} (${fp.libId}): ${diff}`);
    }
    expect({ missed, extra }, `${compared} footprints compared`).toEqual({ missed: [], extra: [] });
  });
});

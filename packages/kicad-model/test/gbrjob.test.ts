/**
 * Gerber job files as KiCad writes them. For every demo board, the general specs (size, layers,
 * thickness, finish), the design rules and the material stackup equal those in the job file of
 * `kicad-cli pcb export gerbers`. For a few boards, fabricationFiles' whole job file (with its
 * file list) does too, and so do the Gerbers' project ids.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fabLayers, fabricationFiles, gerberJob, parseBoard, parseDru, projectDesignRules } from "../src/index.js";

const CORPUS = process.env.KICAD_CORPUS ?? "/Library/Application Support/kicad/demos";
const KICAD_CLI = process.env.KICAD_CLI ?? "kicad-cli";
let cli = existsSync(CORPUS);
try {
  execFileSync(KICAD_CLI, ["version"], { stdio: "ignore" });
} catch {
  cli = false;
}
const boards: string[] = [];
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith(".kicad_pcb")) boards.push(p);
  }
};
if (cli) walk(CORPUS);

const rulesFor = (pcb: string) => {
  const pro = pcb.replace(/\.kicad_pcb$/, ".kicad_pro");
  const dru = pcb.replace(/\.kicad_pcb$/, ".kicad_dru");
  const rules = projectDesignRules(existsSync(pro) ? readFileSync(pro, "utf8") : undefined);
  if (existsSync(dru)) rules.custom = parseDru(readFileSync(dru, "utf8"));
  return rules;
};
// KiCad writes -0.0 where a clearance is unset; it means 0.
const json = (t: string) => JSON.parse(t, (_k, v) => (v === 0 ? 0 : v));
const kicadJob = (pcb: string, dir: string, layers: string[]) => {
  execFileSync(KICAD_CLI, ["pcb", "export", "gerbers", "--no-protel-ext", "-l", layers.join(","), "-o", dir + "/", pcb], { stdio: "ignore" });
  return readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".gbrjob"))!), "utf8");
};

describe.skipIf(!cli)("Gerber job file matches kicad-cli", () => {
  it.each(boards)("%s", (pcb) => {
    const theirs = json(kicadJob(pcb, mkdtempSync(join(tmpdir(), "gbrjob-")), ["Edge.Cuts"]));
    const board = parseBoard(readFileSync(pcb, "utf8"), { recover: true });
    const ours = json(gerberJob(board, { name: basename(pcb, ".kicad_pcb"), files: [], rules: rulesFor(pcb) }));
    expect(ours.GeneralSpecs).toEqual(theirs.GeneralSpecs);
    expect(ours.DesignRules).toEqual(theirs.DesignRules);
    expect(ours.MaterialStackup).toEqual(theirs.MaterialStackup);
  });

  const full = boards.filter((b) => /(pic_programmer|StickHub|kit-dev-coldfire-xilinx_5213)\.kicad_pcb$/.test(b));
  it.each(full)("whole set: %s", (pcb) => {
    const board = parseBoard(readFileSync(pcb, "utf8"), { recover: true });
    const dir = mkdtempSync(join(tmpdir(), "gbrjob-"));
    const text = kicadJob(pcb, dir, fabLayers(board));
    const name = basename(pcb, ".kicad_pcb");
    const files = fabricationFiles(board, { name, rules: rulesFor(pcb) });
    const ours = files[`${name}-job.gbrjob`]!;
    // Everything but who wrote it and when, to the character.
    const body = (t: string) => t.slice(t.indexOf('  "GeneralSpecs"'));
    expect(body(ours)).toBe(body(text));
    // The Gerbers carry the same project id (name, GUID, revision) as KiCad's.
    const id = (t: string) => /%TF\.ProjectId,[^*]*\*%/.exec(t)?.[0];
    const theirGerber = readFileSync(join(dir, `${name}-Edge_Cuts.gbr`), "utf8");
    expect(id(files[`${name}-Edge_Cuts.gbr`] as string)).toBe(id(theirGerber));
  });
});

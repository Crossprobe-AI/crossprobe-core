/**
 * Round-trip every KiCad S-expression file in a corpus directory.
 *
 * Defaults to the demo projects bundled with a KiCad install; override with
 * KICAD_CORPUS=/path/to/projects (colon-separated for several). Skipped when
 * no corpus is found, so CI without KiCad still passes the unit tests.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, serialize } from "../src/index.js";

const DEFAULT_CORPORA = [
  "/Library/Application Support/kicad/demos", // macOS
  "/usr/share/kicad/demos", // Linux
  "C:\\Program Files\\KiCad\\share\\kicad\\demos", // Windows (default install)
];

const EXTENSIONS = [".kicad_pcb", ".kicad_sch", ".kicad_sym", ".kicad_mod", ".kicad_dru", ".kicad_wks"];

function findFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) findFiles(p, out);
    else if (EXTENSIONS.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const roots = (process.env.KICAD_CORPUS?.split(":") ?? DEFAULT_CORPORA).filter((d) => existsSync(d));
const files = roots.flatMap((r) => findFiles(r));

describe.skipIf(files.length === 0)(`corpus round-trip (${files.length} files)`, () => {
  it.each(files)("%s", (file) => {
    const text = readFileSync(file, "utf8");
    const doc = parse(text, { comments: file.endsWith(".kicad_dru"), recover: true });
    for (const d of doc.diagnostics) console.warn(`${file}:${d.line}:${d.column}: ${d.message}`);
    const out = serialize(doc);
    if (out !== text) {
      let i = 0;
      while (i < text.length && text[i] === out[i]) i++;
      expect.fail(`first difference at offset ${i}: ${JSON.stringify(text.slice(i, i + 40))}`);
    }
  });
});

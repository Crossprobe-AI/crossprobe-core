/**
 * What a build of the app adds to the editor: a module of extensions
 * (src/extensions/api.ts) and, for the dev server, a module of extra endpoints.
 * The editor on its own has neither.
 *
 * A build names them in a `crossprobe.build.json` in a folder above the app
 * (the nearest one wins), with paths relative to that file:
 *
 *   { "extensions": "my-extensions/index.tsx", "devBackend": "my-server/dev.ts" }
 *
 * or in the environment, which wins over the file: CROSSPROBE_EXTENSIONS and
 * CROSSPROBE_DEV_BACKEND (paths relative to the working directory).
 *
 * The extensions module exports `extensions: Extension[]`. The dev backend
 * exports `handle(req, res, next)`: it gets the /__ requests the editor's own
 * dev endpoints don't answer.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildSetup {
  /** The module `@crossprobe/extensions` resolves to. */
  extensions: string;
  /** The dev server's extra endpoints, if any. */
  devBackend?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const NONE = join(HERE, "src/extensions/none.ts");
const FILE = "crossprobe.build.json";

export function buildSetup(env: NodeJS.ProcessEnv = process.env): BuildSetup {
  let fromFile: { extensions?: string; devBackend?: string } = {};
  for (let dir = HERE; ; dir = dirname(dir)) {
    const file = join(dir, FILE);
    if (existsSync(file)) {
      const json = JSON.parse(readFileSync(file, "utf8")) as { extensions?: string; devBackend?: string };
      fromFile = { extensions: json.extensions && resolve(dir, json.extensions), devBackend: json.devBackend && resolve(dir, json.devBackend) };
      break;
    }
    if (dirname(dir) === dir) break;
  }
  const extensions = (env.CROSSPROBE_EXTENSIONS && resolve(env.CROSSPROBE_EXTENSIONS)) || fromFile.extensions || NONE;
  const devBackend = (env.CROSSPROBE_DEV_BACKEND && resolve(env.CROSSPROBE_DEV_BACKEND)) || fromFile.devBackend;
  for (const f of [extensions, devBackend]) if (f && !existsSync(f)) throw new Error(`${FILE}: ${f} does not exist`);
  return { extensions, devBackend };
}

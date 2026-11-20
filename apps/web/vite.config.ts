import { buildSetup } from "./build-setup";
import { bundledFootprintFile, bundledFootprintIds, bundledSymbolLibraries, bundledSymbolLibrary } from "./server/bundled-libs";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";
// Built package (npm run build): used by the dev server to index KiCad's symbol libraries.
import { creditedIndex, indexLibrary, resolveLibrarySymbol, type LibrarySymbolEntry } from "@crossprobe/kicad-model";
import { serialize } from "@crossprobe/kicad-sexpr";

/**
 * The favicon keeps its URL, so browsers hold on to an old copy after the logo changes.
 * Link it with a content hash, as the site does. Runs after Vite has applied the base (/app/).
 */
function versionedFavicon(): Plugin {
  const v = createHash("sha256").update(readFileSync(fileURLToPath(new URL("./public/favicon.svg", import.meta.url)))).digest("hex").slice(0, 10);
  return { name: "crossprobe-favicon-version", transformIndexHtml: (html) => html.replace(/href="([^"]*\/favicon\.svg)"/, `href="$1?v=${v}"`) };
}

const pkg = (name: string) => fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));
/** What this build adds to the editor: extensions and dev endpoints (build-setup.ts). None by default. */
const SETUP = buildSetup();

/** Where KiCad's bundled demo projects live; served in dev for quick testing. */
const DEMOS =
  process.env.KICAD_DEMOS ??
  ["/Library/Application Support/kicad/demos", "/usr/share/kicad/demos"].find((d) => existsSync(d)) ??
  "";

/** The design-block library (blocks/library), served in dev at /__blocks as the flat files build-blocks.mjs --web writes. */
const BLOCKS = fileURLToPath(new URL("../../blocks/library/crossprobe.kicad_blocks/", import.meta.url));

function blocks(): Plugin {
  const read = (id: string, ext: string) => {
    if (!/^[a-z0-9-]+$/.test(id)) return undefined;
    const file = join(BLOCKS, `${id}.kicad_block`, `${id}${ext}`);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  };
  return {
    name: "crossprobe-blocks",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__blocks", (req, res) => {
        const name = decodeURIComponent((req.url ?? "/").split("?")[0]!.replace(/^\//, ""));
        const send = (status: number, body: string, type: string) => {
          res.statusCode = status;
          res.setHeader("Content-Type", type);
          res.setHeader("Cache-Control", "no-store");
          res.end(body);
        };
        if (name === "index.json") {
          const index = existsSync(BLOCKS)
            ? readdirSync(BLOCKS)
                .filter((d) => d.endsWith(".kicad_block"))
                .map((d) => d.replace(/\.kicad_block$/, ""))
                .sort()
                .map((id) => {
                  const m = JSON.parse(read(id, ".crossprobe.json") ?? "{}");
                  return { id, title: m.title, description: m.description, category: m.category, status: m.status, keywords: m.keywords, license: m.license, reviewedBy: m.reviewedBy, reviewedAt: m.reviewedAt, parts: m.parts?.length ?? 0, checklist: m.checklist?.length ?? 0 };
                })
            : [];
          return send(200, JSON.stringify(index), "application/json");
        }
        const m = /^([a-z0-9-]+)(\.kicad_sch|\.kicad_pcb|\.crossprobe\.json)$/.exec(name);
        const text = m && read(m[1]!, m[2]!);
        if (!text) return send(404, JSON.stringify({ error: "not found" }), "application/json");
        send(200, text, m![2] === ".crossprobe.json" ? "application/json" : "text/plain; charset=utf-8");
      });
    },
  };
}

// Project files, and project libraries (footprints with their table) for the library checks.
const KICAD_FILE = /(\.kicad_(sch|pcb|pro|sym|dru|mod|wks)|sym-lib-table|fp-lib-table|design-block-lib-table|\.kicad_block\/[^/]+\.json)$/;

/** KiCad's symbol libraries, for the part picker in dev. */
const SYMBOLS =
  process.env.KICAD_SYMBOLS ??
  ["/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols", "/usr/share/kicad/symbols"].find((d) => existsSync(d)) ??
  "";

/** Index of every library symbol; built once (a few seconds), then cached on disk. */
let symbolIndex: LibrarySymbolEntry[] | undefined;
function getSymbolIndex(): LibrarySymbolEntry[] {
  if (symbolIndex) return symbolIndex;
  if (!SYMBOLS) return (symbolIndex = bundledIndex());
  const libs = readdirSync(SYMBOLS).filter((f) => f.endsWith(".kicad_sym"));
  const stamp = libs.map((f) => statSync(join(SYMBOLS, f)).mtimeMs).reduce((a, b) => Math.max(a, b), 0);
  const cache = join(tmpdir(), `crossprobe-symindex-${libs.length}-${Math.round(stamp)}.json`);
  if (existsSync(cache)) return (symbolIndex = [...(JSON.parse(readFileSync(cache, "utf8")) as LibrarySymbolEntry[]), ...bundledIndex()]);
  const all: LibrarySymbolEntry[] = [];
  for (const f of libs) {
    try {
      all.push(...indexLibrary(readFileSync(join(SYMBOLS, f), "utf8"), f.replace(/\.kicad_sym$/, "")));
    } catch {
      // A library we can't read is skipped, not fatal.
    }
  }
  writeFileSync(cache, JSON.stringify(all));
  return (symbolIndex = [...all, ...bundledIndex()]);
}

/** The symbols of the libraries that ship with Crossprobe (third_party/kicad-libraries). */
function bundledIndex(): LibrarySymbolEntry[] {
  return bundledSymbolLibraries().flatMap((n) => {
    try {
      return creditedIndex(indexLibrary(bundledSymbolLibrary(n)!, n));
    } catch {
      return [];
    }
  });
}

const FOOTPRINTS =
  process.env.KICAD_FOOTPRINTS ??
  ["/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints", "/usr/share/kicad/footprints"].find((d) => existsSync(d)) ??
  "";

/** Every library footprint as "Library:Name" (file names only, so cheap). */
let footprintIndex: string[] | undefined;
function getFootprintIndex(): string[] {
  if (footprintIndex) return footprintIndex;
  if (!FOOTPRINTS) return (footprintIndex = bundledFootprintIds());
  const out: string[] = bundledFootprintIds();
  for (const lib of readdirSync(FOOTPRINTS).filter((d) => d.endsWith(".pretty"))) {
    const name = lib.replace(/\.pretty$/, "");
    for (const f of readdirSync(join(FOOTPRINTS, lib))) if (f.endsWith(".kicad_mod")) out.push(`${name}:${f.replace(/\.kicad_mod$/, "")}`);
  }
  return (footprintIndex = out);
}

/**
 * Pad count per library footprint ("Library:Name" → distinct pad numbers,
 * unnumbered pads such as NPTH holes left out), as KiCad's footprint
 * chooser counts them for its pin-count filter. Cached on disk.
 */
let footprintPads: Record<string, number> | undefined;
function getFootprintPads(): Record<string, number> {
  if (footprintPads) return footprintPads;
  const padCount = (text: string) => new Set([...text.matchAll(/\(pad\s+(?:"([^"]*)"|([^\s()"]+))/g)].map((m) => m[1] ?? m[2]).filter((n) => n)).size;
  const bundled = Object.fromEntries(bundledFootprintIds().map((id) => [id, padCount(readFileSync(bundledFootprintFile(id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1))!, "utf8"))]));
  if (!FOOTPRINTS) return (footprintPads = bundled);
  const libs = readdirSync(FOOTPRINTS).filter((d) => d.endsWith(".pretty"));
  const stamp = libs.map((d) => statSync(join(FOOTPRINTS, d)).mtimeMs).reduce((a, b) => Math.max(a, b), 0);
  const cache = join(tmpdir(), `crossprobe-fppads-${libs.length}-${Math.round(stamp)}.json`);
  if (existsSync(cache)) return (footprintPads = { ...(JSON.parse(readFileSync(cache, "utf8")) as Record<string, number>), ...bundled });
  const out: Record<string, number> = {};
  for (const lib of libs) {
    for (const f of readdirSync(join(FOOTPRINTS, lib))) {
      if (!f.endsWith(".kicad_mod")) continue;
      const text = readFileSync(join(FOOTPRINTS, lib, f), "utf8");
      const numbers = new Set([...text.matchAll(/\(pad\s+(?:"([^"]*)"|([^\s()"]+))/g)].map((m) => m[1] ?? m[2]).filter((n) => n));
      out[`${lib.replace(/\.pretty$/, "")}:${f.replace(/\.kicad_mod$/, "")}`] = numbers.size;
    }
  }
  writeFileSync(cache, JSON.stringify(out));
  return (footprintPads = { ...out, ...bundled });
}

/** KiCad's 3D model library, for resolving ${KICADn_3DMODEL_DIR} in dev. */
const MODELS3D =
  process.env.KICAD_3DMODELS ??
  ["/Applications/KiCad/KiCad.app/Contents/SharedSupport/3dmodels", "/usr/share/kicad/3dmodels"].find((d) => existsSync(d)) ??
  "";
const MODEL_FILE = /\.(step|stp|wrl)$/i;

/** Resolve a footprint's model path the way KiCad does, including .wrl ↔ .step fallback. */
function resolveModel(raw: string, projectDir: string): string | undefined {
  let p = raw.replace(/\$\{KIPRJMOD\}/g, projectDir).replace(/\$\{(KICAD\d*_3DMODEL_DIR|KISYS3DMOD)\}/g, MODELS3D);
  if (!p.startsWith("/")) p = join(projectDir, p);
  const candidates = [p, p.replace(/\.wrl$/i, ".step"), p.replace(/\.(step|stp)$/i, ".wrl")];
  return candidates.find((c) => MODEL_FILE.test(c) && existsSync(c));
}

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out, depth + 1);
    else out.push(p);
  }
  return out;
}

/** What a dev backend module exports. */
interface DevBackend {
  handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void>;
}

/**
 * More dev-server endpoints, when the build names a dev backend (build-setup.ts):
 * a /__ request the endpoints before this one don't answer goes to it. Loaded
 * through Vite on the first such request, not with this config.
 */
function backend(): Plugin {
  const file = SETUP.devBackend;
  return {
    name: "crossprobe-backend",
    apply: "serve",
    configureServer(server) {
      if (!file) return;
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "/";
        if (!url.startsWith("/__")) return next();
        try {
          const mod = (await server.ssrLoadModule(file)) as DevBackend;
          await mod.handle(req, res, next);
        } catch (e) {
          next(e);
        }
      });
    },
  };
}

/**
 * Dev-only endpoints:
 *   GET /__demos                → [{ name, project }] (project = path of .kicad_pro under DEMOS)
 *   GET /__demos/files?project= → { root, files: [relative paths] } for that project's folder
 *   GET /__demos/file?path=     → file contents (path relative to DEMOS)
 *   GET /__demos/model?project=&path= → a footprint's 3D model (STEP or VRML)
 */
function demos(): Plugin {
  return {
    name: "crossprobe-demos",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__demos", (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        const send = (status: number, body: unknown, type = "application/json") => {
          res.statusCode = status;
          res.setHeader("Content-Type", type);
          res.end(type === "application/json" ? JSON.stringify(body) : (body as string));
        };
        if (!DEMOS && !/^\/(libmodel|symindex|symbol|fpindex|fppads|footprint)/.test(url.pathname)) return send(200, []);
        const inside = (p: string) => {
          const abs = resolve(DEMOS, p);
          return abs.startsWith(resolve(DEMOS) + sep) ? abs : undefined;
        };
        if (url.pathname === "/" || url.pathname === "") {
          const projects = walk(DEMOS)
            .filter((p) => p.endsWith(".kicad_pro"))
            .map((p) => relative(DEMOS, p))
            .sort();
          return send(200, projects.map((project) => ({ name: project.split("/").pop()!.replace(".kicad_pro", ""), project })));
        }
        if (url.pathname === "/files") {
          const pro = inside(url.searchParams.get("project") ?? "");
          if (!pro) return send(400, { error: "bad project" });
          const dir = resolve(pro, "..");
          const files = walk(dir)
            .filter((p) => KICAD_FILE.test(p))
            .map((p) => relative(dir, p));
          return send(200, { root: relative(DEMOS, dir), files });
        }
        if (url.pathname === "/model") {
          const pro = inside(url.searchParams.get("project") ?? "");
          const file = pro && resolveModel(url.searchParams.get("path") ?? "", resolve(pro, ".."));
          // 204: "no model" is a normal answer (the view shows a box), not an error.
          if (!file) return send(204, "", "text/plain");
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("X-Model-Format", file.toLowerCase().endsWith(".wrl") ? "wrl" : "step");
          res.setHeader("Cache-Control", "max-age=3600");
          return res.end(readFileSync(file));
        }
        if (url.pathname === "/symindex") return send(200, getSymbolIndex());
        if (url.pathname === "/symbol") {
          const lib = (url.searchParams.get("lib") ?? "").replace(/[^A-Za-z0-9_.+-]/g, "");
          const file = join(SYMBOLS, `${lib}.kicad_sym`);
          const text = bundledSymbolLibrary(lib) ?? (SYMBOLS && existsSync(file) ? readFileSync(file, "utf8") : undefined);
          if (text === undefined) return send(404, { error: "no such library" });
          try {
            return send(200, serialize(resolveLibrarySymbol(text, lib, url.searchParams.get("name") ?? "")), "text/plain; charset=utf-8");
          } catch (e) {
            return send(404, { error: (e as Error).message });
          }
        }
        if (url.pathname === "/fpindex") return send(200, getFootprintIndex());
        if (url.pathname === "/fppads") return send(200, getFootprintPads());
        if (url.pathname === "/footprint") {
          const clean = (v: string | null) => (v ?? "").replace(/[^A-Za-z0-9_.,+\-() ]/g, "").replace(/\.\./g, "");
          const file = bundledFootprintFile(clean(url.searchParams.get("lib")), clean(url.searchParams.get("name"))) ?? join(FOOTPRINTS, `${clean(url.searchParams.get("lib"))}.pretty`, `${clean(url.searchParams.get("name"))}.kicad_mod`);
          if (!existsSync(file) || (!FOOTPRINTS && !file.includes("kicad-libraries"))) return send(404, { error: "no such footprint" });
          return send(200, readFileSync(file, "utf8"), "text/plain; charset=utf-8");
        }
        if (url.pathname === "/libmodel") {
          // Library models only (no project): for projects opened from disk in dev.
          const raw = url.searchParams.get("path") ?? "";
          const file = /^\$\{(KICAD\d*_3DMODEL_DIR|KISYS3DMOD)\}/.test(raw) ? resolveModel(raw, MODELS3D) : undefined;
          if (!file) return send(204, "", "text/plain");
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("X-Model-Format", file.toLowerCase().endsWith(".wrl") ? "wrl" : "step");
          res.setHeader("Cache-Control", "max-age=3600");
          return res.end(readFileSync(file));
        }
        if (url.pathname === "/file") {
          const file = inside(url.searchParams.get("path") ?? "");
          if (!file || !KICAD_FILE.test(file) || !existsSync(file)) return send(404, { error: "not found" });
          return send(200, readFileSync(file, "utf8"), "text/plain; charset=utf-8");
        }
        send(404, { error: "not found" });
      });
    },
  };
}

/** Serve / emit OpenCascade's STEP importer (wasm) under /occt/, next to public/occt/step-worker.js. */
function occt(): Plugin {
  // Wherever the package is installed (this repository's node_modules, or a workspace root above it).
  const dir = dirname(createRequire(import.meta.url).resolve("occt-import-js"));
  const files = ["occt-import-js.js", "occt-import-js.wasm"];
  return {
    name: "crossprobe-occt",
    configureServer(server) {
      server.middlewares.use("/occt", (req, res, next) => {
        const name = (req.url ?? "").replace(/^\//, "").split("?")[0]!;
        if (!files.includes(name)) return next();
        res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        res.end(readFileSync(join(dir, name)));
      });
    },
    generateBundle() {
      for (const name of files) this.emitFile({ type: "asset", fileName: `occt/${name}`, source: readFileSync(join(dir, name)) });
    },
  };
}

/**
 * Where a build is served: /app/ by default (beside a website at /), or the path in
 * CROSSPROBE_BASE, e.g. "/" for the editor alone at the root of its own domain.
 */
function buildBase(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CROSSPROBE_BASE?.trim() || "/app/";
  if (!base.startsWith("/") || !base.endsWith("/")) throw new Error(`CROSSPROBE_BASE must start and end with "/": ${base}`);
  return base;
}

export default defineConfig(({ command }) => ({
  // A build serves the app under its base (buildBase); the dev server stays at /.
  base: command === "build" ? buildBase() : "/",
  // The app's own endpoints first; backend() takes what they leave.
  plugins: [react(), demos(), blocks(), occt(), backend(), versionedFavicon()],
  resolve: { alias: { "@crossprobe/kicad-sexpr": pkg("kicad-sexpr"), "@crossprobe/kicad-model": pkg("kicad-model"), "@crossprobe/extensions": SETUP.extensions } },
  // The dev server serves files from this checkout's workspace and, when a build adds extensions from a
  // folder outside it, from that folder's workspace too (its packages, e.g. the fonts the stylesheet loads,
  // are installed there).
  server: { fs: { allow: [...new Set([searchForWorkspaceRoot(process.cwd()), searchForWorkspaceRoot(dirname(SETUP.extensions))])] } },
  worker: { format: "es" },
  // The lazily loaded 3D view (three.js) is one large chunk by design.
  build: { chunkSizeWarningLimit: 800 },
}));

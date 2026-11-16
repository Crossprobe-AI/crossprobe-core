/**
 * The libraries from other publishers that ship with Crossprobe
 * (third_party/kicad-libraries), for the servers that otherwise read KiCad's
 * libraries from the KiCad installed on the computer: the dev server.
 *
 * Run from source they are in the repository; a built server carries a copy
 * beside its bundle (copyBundledLibraries, in its Vite config).
 */
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { THIRD_PARTY_LIBRARIES } from "@crossprobe/kicad-model";

export const BUNDLED_DIR = "kicad-libraries";

let found: string | undefined | null = null;
/** The folder that holds one folder per library, or undefined when this build has none. */
export function bundledRoot(): string | undefined {
  if (found !== null) return found;
  const here = dirname(fileURLToPath(import.meta.url));
  // Beside the bundle (or one up, from a chunk folder); else the repository, from apps/web/server or apps/web.
  const tries = [join(here, BUNDLED_DIR), join(here, "..", BUNDLED_DIR), join(here, "..", "..", "..", "third_party", BUNDLED_DIR), join(here, "..", "..", "third_party", BUNDLED_DIR)];
  return (found = tries.find((d) => existsSync(d)));
}

const nicknames = () => (bundledRoot() ? THIRD_PARTY_LIBRARIES.map((l) => l.nickname).filter((n) => existsSync(join(bundledRoot()!, n))) : []);

/** A bundled symbol library's text by nickname. */
export function bundledSymbolLibrary(nickname: string): string | undefined {
  if (!nicknames().includes(nickname)) return undefined;
  const file = join(bundledRoot()!, nickname, `${nickname}.kicad_sym`);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** Nicknames of the bundled libraries that have symbols. */
export const bundledSymbolLibraries = (): string[] => nicknames().filter((n) => existsSync(join(bundledRoot()!, n, `${n}.kicad_sym`)));

/** A bundled footprint's file, by library nickname and footprint name; undefined if there is none. */
export function bundledFootprintFile(nickname: string, name: string): string | undefined {
  if (!nicknames().includes(nickname) || /[\\/]/.test(name) || name.includes("..")) return undefined;
  const file = join(bundledRoot()!, nickname, `${nickname}.pretty`, `${name}.kicad_mod`);
  return existsSync(file) ? file : undefined;
}

/** Every bundled footprint as "Library:Name". */
export function bundledFootprintIds(): string[] {
  const out: string[] = [];
  for (const n of nicknames()) {
    const dir = join(bundledRoot()!, n, `${n}.pretty`);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) if (f.endsWith(".kicad_mod")) out.push(`${n}:${f.replace(/\.kicad_mod$/, "")}`);
  }
  return out;
}

/** For the Vite configs that bundle a server: copy the libraries next to the bundle, where bundledRoot looks first. */
export function copyBundledLibraries(outDir: string) {
  return {
    name: "crossprobe-bundled-libraries",
    writeBundle() {
      const from = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "third_party", BUNDLED_DIR);
      cpSync(from, join(outDir, BUNDLED_DIR), { recursive: true });
    },
  };
}

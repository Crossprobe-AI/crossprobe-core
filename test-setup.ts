/**
 * Finds KiCad for the tests that compare with it, so they run wherever it is
 * installed and say so when it is not.
 *
 * Each of these is taken from the environment when set, else from the usual
 * places on macOS and Linux:
 *   KICAD_CLI        kicad-cli
 *   KICAD_DEMOS      KiCad's demo projects (not shipped with every installer;
 *                    they are the `demos` folder of KiCad's source)
 *   KICAD_CORPUS     projects for the corpus tests, colon-separated; the demos by default
 *   KICAD_SYMBOLS, KICAD_FOOTPRINTS, KICAD_3DMODELS   KiCad's libraries
 *
 * A variable that can't be resolved is set to a path that does not exist, so a
 * test reads it without a fallback and skips itself.
 */
import { existsSync } from "node:fs";

const MAC = "/Applications/KiCad/KiCad.app/Contents";
const first = (name: string, candidates: string[]): string => {
  const found = process.env[name] ?? candidates.find((c) => existsSync(c)) ?? candidates[0]!;
  process.env[name] = found;
  return found;
};

first("KICAD_CLI", [`${MAC}/MacOS/kicad-cli`, "/usr/bin/kicad-cli", "kicad-cli"].filter((c) => c === "kicad-cli" || existsSync(c)));
const demos = first("KICAD_DEMOS", ["/Library/Application Support/kicad/demos", "/usr/share/kicad/demos"]);
process.env.KICAD_CORPUS ??= demos;
first("KICAD_SYMBOLS", [`${MAC}/SharedSupport/symbols`, "/usr/share/kicad/symbols"]);
first("KICAD_FOOTPRINTS", [`${MAC}/SharedSupport/footprints`, "/usr/share/kicad/footprints"]);
first("KICAD_3DMODELS", [`${MAC}/SharedSupport/3dmodels`, "/usr/share/kicad/3dmodels"]);

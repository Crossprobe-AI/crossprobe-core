import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { buildSetup } from "./apps/web/build-setup";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));
// The extensions this build adds to the web app (apps/web/build-setup.ts); none by default.
const extensions = buildSetup().extensions;

export default defineConfig({
  resolve: {
    // Run tests against sources so no build step is needed.
    alias: { "@crossprobe/kicad-sexpr": src("kicad-sexpr"), "@crossprobe/kicad-model": src("kicad-model"), "@crossprobe/extensions": extensions },
  },
  test: { include: ["packages/*/test/**/*.test.ts", "apps/web/test/**/*.test.ts"], testTimeout: 120000 },
});

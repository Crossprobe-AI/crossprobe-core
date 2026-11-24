import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { buildSetup } from "./apps/web/build-setup";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));
// The extensions this build adds to the web app (apps/web/build-setup.ts); none by default.
const extensions = buildSetup().extensions;
const alias = { "@crossprobe/kicad-sexpr": src("kicad-sexpr"), "@crossprobe/kicad-model": src("kicad-model"), "@crossprobe/extensions": extensions };
// The app's web fonts, wherever npm installed them (in a workspace this one is part of, too): the
// test browser loads them, so the text it measures is in the app's own face.
const fonts = ["@fontsource-variable/schibsted-grotesk", "@fontsource/ibm-plex-mono"].map((p) => dirname(createRequire(import.meta.url).resolve(`${p}/index.css`)));

export default defineConfig({
  // Run tests against sources so no build step is needed.
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", setupFiles: [fileURLToPath(new URL("./test-setup.ts", import.meta.url))], include: ["packages/*/test/**/*.test.ts", "apps/web/test/**/*.test.ts"], testTimeout: 120000 },
      },
      {
        // Component tests for the editor's controls (menus, tabs, buttons), in a real
        // browser with the app's stylesheet, so layout, focus and clicks are the real ones.
        // Needs Chromium for Playwright: `npx playwright install chromium` once.
        extends: true,
        // The editor's own controls, without what a build adds (crossprobe.build.json).
        resolve: { alias: { ...alias, "@crossprobe/extensions": fileURLToPath(new URL("./apps/web/src/extensions/none.ts", import.meta.url)) } },
        server: { fs: { allow: [fileURLToPath(new URL(".", import.meta.url)), ...fonts] } },
        test: {
          name: "ui",
          include: ["apps/web/test/ui/**/*.test.tsx"],
          browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: "chromium", viewport: { width: 1280, height: 800 } }] },
        },
      },
    ],
  },
});

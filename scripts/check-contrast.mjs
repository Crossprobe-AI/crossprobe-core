#!/usr/bin/env node
// Checks WCAG contrast of the app's colour tokens (apps/web/src/styles.css) in light and dark.
// Text pairs need 4.5:1 (AA for the 11–13 px UI text), control borders 3:1 (WCAG 1.4.11).
// Usage: node scripts/check-contrast.mjs [path/to/styles.css]   (exits 1 on any failure)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = process.argv[2] ?? fileURLToPath(new URL("../apps/web/src/styles.css", import.meta.url));
const css = readFileSync(file, "utf8");

/** Custom properties with a plain hex value in the first block that starts with `selector {`. */
function tokens(selector) {
  const start = css.indexOf(selector + " {");
  if (start < 0) throw new Error(`${selector} not found in ${file}`);
  const body = css.slice(start, css.indexOf("}", start));
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2];
  return out;
}

const light = tokens(":root");
const dark = { ...light, ...tokens(':root:not([data-theme="light"])') };

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const surfaces = ["--bg", "--panel", "--panel-2"];
const text = ["--text", "--text-2", "--muted", "--accent", "--error", "--warn", "--info", "--ok", "--ai"];
const checks = [
  ...text.flatMap((fg) => surfaces.map((bg) => [fg, bg, 4.5])),
  ["--accent", "--accent-soft", 4.5],
  ["--ai", "--ai-soft", 4.5],
  ["--text", "--raised", 4.5],
  ...surfaces.map((bg) => ["--border-control", bg, 3]),
];

let failed = 0;
for (const [name, t] of [["light", light], ["dark", dark]]) {
  for (const [fg, bg, min] of checks) {
    if (!t[fg] || !t[bg]) {
      console.log(`MISSING ${name.padEnd(5)} ${fg} / ${bg}`);
      failed++;
      continue;
    }
    const r = ratio(t[fg], t[bg]);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(5)} ${fg.padEnd(16)} on ${bg.padEnd(13)} ${r.toFixed(2).padStart(5)} (min ${min})`);
  }
}
console.log(failed ? `\n${failed} contrast check(s) failed` : "\nAll contrast checks passed");
process.exit(failed ? 1 : 0);

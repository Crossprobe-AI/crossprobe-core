// End-to-end, STEP export: pic_programmer's 3D view exports the board and its parts as a STEP
// assembly (the download), which OpenCascade reads back with the board body and the part models,
// within 0.1% of the volume of kicad-cli's STEP export (test/step.test.ts compares them in detail).
// The view seats the parts where KiCad's 3D viewer does.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-step.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import occtimportjs from "occt-import-js";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/step");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
const volume = async (bytes) => {
  const occt = await occtimportjs();
  const r = occt.ReadStepFile(bytes, null);
  let v = 0;
  for (const m of r.meshes) {
    const p = m.attributes.position.array, x = m.index.array;
    for (let i = 0; i < x.length; i += 3) {
      const a = x[i] * 3, b = x[i + 1] * 3, c = x[i + 2] * 3;
      v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    }
  }
  return { meshes: r.meshes.length, volume: v };
};

await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("3D")).click());
await page.waitForSelector(".board3d .view-tools", { timeout: 20000 });
await page.evaluate(() => [...document.querySelectorAll(".board3d .view-tools button")].find((b) => b.textContent.includes("STEP")).click());
let file;
for (let i = 0; i < 100 && !file; i++) {
  await wait(300);
  file = readdirSync(OUT).find((f) => f.endsWith(".step"));
}
const note = await page.evaluate(() => document.querySelector(".step-note")?.textContent);
expect(!!file, `downloaded ${file}; ${note}`);
// The view seats parts as KiCad's 3D viewer does: on the paste (0.04 mm) over F.Cu, which sits
// on the 1.51 mm body; the bottom side mirrors that under B.Cu.
const seat = await page.evaluate(() => window.__board3d?.seat);
expect(Math.abs(seat?.top - (1.51 + 0.035 + 0.04)) < 1e-6 && Math.abs(seat?.bottom + (0.035 + 0.04)) < 1e-6, `parts sit at z ${seat?.top?.toFixed(3)} (top) and ${seat?.bottom?.toFixed(3)} (bottom)`);
await page.screenshot({ path: `${OUT}/3d.png` });
await browser.close();
if (file) {
  const ours = await volume(new Uint8Array(readFileSync(`${OUT}/${file}`)));
  spawnSync("kicad-cli", ["pcb", "export", "step", "-f", "-o", `${OUT}/kicad.step`, `${process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos"}/pic_programmer/pic_programmer.kicad_pcb`], { stdio: "ignore" });
  const k = await volume(new Uint8Array(readFileSync(`${OUT}/kicad.step`)));
  expect(ours.meshes === k.meshes && Math.abs(ours.volume - k.volume) / k.volume < 1e-3, `OpenCascade reads ${ours.meshes} meshes, ${ours.volume.toFixed(0)} mm³ (KiCad's: ${k.meshes}, ${k.volume.toFixed(0)} mm³)`);
}
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");

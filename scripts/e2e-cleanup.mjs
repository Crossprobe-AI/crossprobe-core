// End-to-end, Cleanup Tracks & Vias: on pic_programmer's board the dialog finds the collinear
// segments to merge and the tracks inside pads; applying it is one undoable edit, and kicad-cli's
// DRC of the saved board has no more violations or unconnected items than the original.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-cleanup.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/cleanup");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const DEMO = `${process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos"}/pic_programmer`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(DEMO, OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = () => page.waitForFunction(() => !document.body.textContent.includes("Updating…"), { timeout: 60000 });
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
const drc = (f) => {
  try { execFileSync("kicad-cli", ["pcb", "drc", "--format", "json", "-o", `${f}.json`, f], { stdio: "ignore" }); } catch {}
  const r = JSON.parse(readFileSync(`${f}.json`, "utf8"));
  return { unconnected: r.unconnected_items.length, violations: r.violations.length };
};
const pcb = `${OUT}/pic_programmer.kicad_pcb`;
const before = drc(pcb);

await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
const tracks0 = await page.evaluate(() => window.__crossprobe.project.board.tracks.length);
await page.evaluate(() => document.querySelector('button[title^="Cleanup tracks"]')?.click());
await page.waitForSelector(".cleanup-tracks");
const found = await page.evaluate(() => [...document.querySelectorAll(".cleanup-tracks summary")].map((s) => s.textContent.trim()));
expect(found.some((f) => /merged tracks/.test(f)) && found.some((f) => /track in pad/.test(f)), `found: ${found.join("; ")}`);
await page.screenshot({ path: `${OUT}/dialog.png` });
await page.evaluate(() => [...document.querySelectorAll(".cleanup-tracks button.primary")][0].click());
await idle();
await wait(400);
const tracks1 = await page.evaluate(() => window.__crossprobe.project.board.tracks.length);
expect(tracks1 < tracks0, `tracks ${tracks0} → ${tracks1}`);
await page.keyboard.down("Meta");
await page.keyboard.press("z");
await page.keyboard.up("Meta");
await idle();
await wait(300);
expect((await page.evaluate(() => window.__crossprobe.project.board.tracks.length)) === tracks0, "undo brings them back");
await page.keyboard.down("Meta");
await page.keyboard.down("Shift");
await page.keyboard.press("z");
await page.keyboard.up("Shift");
await page.keyboard.up("Meta");
await idle();
await wait(300);
const files = await page.evaluate(() => window.__crossprobe.files());
writeFileSync(pcb, files[Object.keys(files).find((f) => f.endsWith(".kicad_pcb"))]);
const after = drc(pcb);
expect(after.unconnected <= before.unconnected && after.violations <= before.violations, `KiCad DRC: unconnected ${before.unconnected} → ${after.unconnected}, violations ${before.violations} → ${after.violations}`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

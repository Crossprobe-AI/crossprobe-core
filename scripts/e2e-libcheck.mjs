// End-to-end, footprints against libraries: on KiCad's video demo the board toolbar's "Libraries"
// compares every footprint with its library copy. It flags exactly the footprints KiCad's DRC flags
// (lib_footprint_mismatch). "Update from library" replaces them, and KiCad's DRC of the saved board
// then flags none of them.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-libcheck.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/libcheck");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const DEMOS = process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
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
/** KiCad's DRC of a board: the references it says differ from their library copy. */
const kicadMismatched = (file, name) => {
  try {
    execFileSync("kicad-cli", ["pcb", "drc", "--severity-all", "--format", "json", "-o", `${OUT}/${name}.json`, file], { stdio: "ignore" });
  } catch {
    // kicad-cli exits non-zero when it finds violations.
  }
  const r = JSON.parse(readFileSync(`${OUT}/${name}.json`, "utf8"));
  return new Set(r.violations.filter((v) => v.type === "lib_footprint_mismatch").map((v) => /Footprint (\S+)/.exec(v.items[0].description)?.[1]));
};

// KiCad's DRC needs the project next to the board: work on a copy of the demo.
cpSync(`${DEMOS}/video`, `${OUT}/video`, { recursive: true });
const theirs = kicadMismatched(`${OUT}/video/video.kicad_pcb`, "before");
console.log(`KiCad's DRC: ${theirs.size} footprints differ from their library copy`);

await page.goto(URL + "?demo=video/video.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await wait(300);

console.log("-- Libraries: compare every footprint");
await page.evaluate(() => document.querySelector('button[title^="Compare every footprint"]').click());
await page.waitForFunction(() => !document.querySelector(".library-check")?.textContent.includes("Comparing"), { timeout: 240000 });
await page.screenshot({ path: `${OUT}/check.png` });
const ours = await page.evaluate(() => [...document.querySelectorAll(".library-check details")].filter((d) => d.querySelector("summary").textContent.includes("differ")).flatMap((d) => [...d.querySelectorAll("li button.link")].map((b) => b.textContent)));
const missed = [...theirs].filter((r) => !ours.includes(r));
const extra = ours.filter((r) => !theirs.has(r));
expect(ours.length === theirs.size && !missed.length && !extra.length, `${ours.length} flagged, as KiCad's (missed ${missed.join(" ") || "none"}, extra ${extra.join(" ") || "none"})`);

console.log("-- Update from library");
await page.evaluate(() => [...document.querySelectorAll(".library-check .update-actions button")].find((b) => b.textContent.includes("Update")).click());
await idle();
await wait(1000);
const files = await page.evaluate(() => window.__crossprobe.files());
writeFileSync(`${OUT}/video/video.kicad_pcb`, Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))[1]);
const after = kicadMismatched(`${OUT}/video/video.kicad_pcb`, "after");
expect(after.size === 0, `KiCad's DRC after the update: ${after.size} differ${after.size ? ` (${[...after].slice(0, 10).join(" ")})` : ""}`);

console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

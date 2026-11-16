// End-to-end, Update Schematic from PCB: on pic_programmer's board R1 becomes R50 and C2 330uF
// (the PCB editor's field edits). The PCB toolbar's "Update schematic" lists both; applying them
// changes the schematic in one undoable step, and kicad-cli's schematic parity check of the saved
// project finds nothing it didn't find before.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-backannotate.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "scripts/e2e-out/backannotate";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const DEMO = `${process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos"}/pic_programmer`;
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
const parity = (tag) => {
  execFileSync("kicad-cli", ["pcb", "drc", "--schematic-parity", "--format", "json", "-o", `${OUT}/parity-${tag}.json`, `${OUT}/pic_programmer.kicad_pcb`], { stdio: "pipe" });
  return JSON.parse(readFileSync(`${OUT}/parity-${tag}.json`, "utf8")).schematic_parity.length;
};
const before = parity("before");

console.log("-- board edits");
await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await page.evaluate(() => {
  const p = window.__crossprobe.project;
  const fp = (r) => p.board.footprints.find((f) => f.reference === r).uuid;
  return window.__crossprobe.edit([
    { op: "setFootprintField", file: p.boardFile, uuid: fp("R1"), name: "Reference", value: "R50" },
    { op: "setFootprintField", file: p.boardFile, uuid: fp("C2"), name: "Value", value: "330uF" },
  ]);
});
await idle();
await wait(500);
const n = await page.evaluate(() => window.__crossprobe.project.schematicUpdate?.updates.length);
expect(n === 2, `${n} parts to update`);
await page.evaluate(() => document.querySelector('button[title^="Update schematic from PCB"]')?.click());
await page.waitForSelector(".update-sch");
const listed = await page.evaluate(() => document.querySelector(".update-sch .update-list")?.textContent ?? "");
expect(listed.includes("R1") && listed.includes("→ R50") && listed.includes("C2") && listed.includes("→ 330uF"), `listed: ${listed.slice(0, 120)}`);
await page.screenshot({ path: `${OUT}/dialog.png` });
await page.evaluate(() => [...document.querySelectorAll(".update-sch button.primary")][0]?.click());
await idle();
await wait(500);
const after = await page.evaluate(() => ({ left: window.__crossprobe.project.schematicUpdate?.updates.length, r50: window.__crossprobe.project.components.find((c) => c.reference === "R50")?.value, c2: window.__crossprobe.project.components.find((c) => c.reference === "C2")?.value }));
expect(after.left === 0 && after.r50 && after.c2 === "330uF", `schematic now: R50 ${after.r50}, C2 ${after.c2}; ${after.left} left`);

const files = await page.evaluate(() => window.__crossprobe.files());
for (const [k, v] of Object.entries(files)) if (/\.kicad_(sch|pcb)$/.test(k)) writeFileSync(`${OUT}/${k.split("/").pop()}`, v);
const p = parity("after");
expect(p === before, `kicad-cli parity: ${p} findings (${before} before the edits)`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

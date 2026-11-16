// End-to-end, geographical reannotation: pic_programmer's board renumbered top to bottom, left
// to right; Update schematic sends the references to the schematic, and Update PCB the net
// names that come from references. kicad-cli's schematic
// parity check of the saved project finds nothing, and every reference is unique.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-renumber.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/renumber");
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

await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await page.evaluate(() => document.querySelector('button[title^="Renumber the board"]')?.click());
await page.waitForSelector(".board-reannotate");
const n = await page.evaluate(() => Number(/(\d+) reference/.exec(document.querySelector(".board-reannotate summary").textContent)[1]));
expect(n > 10, `${n} references change`);
await page.screenshot({ path: `${OUT}/dialog.png` });
await page.evaluate(() => [...document.querySelectorAll(".board-reannotate button.primary")][0].click());
await idle();
await wait(500);
await page.waitForSelector(".update-sch", { timeout: 5000 });
const pending = await page.evaluate(() => window.__crossprobe.project.schematicUpdate.updates.length);
expect(pending === n, `Update schematic lists ${pending} parts`);
await page.evaluate(() => [...document.querySelectorAll(".update-sch button.primary")][0].click());
await idle();
await wait(500);
const p = await page.evaluate(() => ({ left: window.__crossprobe.project.schematicUpdate.updates.length, refs: window.__crossprobe.project.components.map((c) => c.reference) }));
expect(p.left === 0 && new Set(p.refs).size === p.refs.length, `schematic in step, ${p.refs.length} unique references`);
// Net names made from references (Net-(C5-Pad1)) follow in the schematic; Update PCB brings them to the board.
await page.evaluate(() => document.querySelector('button[title^="Update PCB"]')?.click());
await wait(400);
await page.evaluate(() => [...document.querySelectorAll(".update-pcb button.primary")].find((b) => b.textContent === "Update PCB")?.click());
await idle();
await wait(500);
const files = await page.evaluate(() => window.__crossprobe.files());
for (const [k, v] of Object.entries(files)) if (/\.kicad_(sch|pcb)$/.test(k)) writeFileSync(`${OUT}/${k.split("/").pop()}`, v);
try { execFileSync("kicad-cli", ["pcb", "drc", "--schematic-parity", "--format", "json", "-o", `${OUT}/parity.json`, `${OUT}/pic_programmer.kicad_pcb`], { stdio: "ignore" }); } catch {}
const parity = JSON.parse(readFileSync(`${OUT}/parity.json`, "utf8")).schematic_parity;
expect(parity.length === 0, `kicad-cli parity: ${parity.length} findings`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

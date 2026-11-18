// End-to-end, intersheet references. On KiCad's complex_hierarchy demo (one sheet used twice),
// global labels are placed with the Global label tool on the root and in the reused sheet; in Page
// settings "Show the pages of global labels" is switched on, with brackets. Each label then shows
// the other pages its net is on ([2,3] on the root, [1,3] and [1,2] in the two instances), the
// setting is in the saved project file, and KiCad's plot of the saved project shows the same lists.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-intersheet-refs.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/intersheet-refs");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const DEMOS = process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("dialog", (d) => d.accept(globalThis.nextPrompt ?? ""));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = () => page.waitForFunction(() => !document.body.textContent.includes("Updating…"), { timeout: 60000 });
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
const clickSch = async (p) => {
  const c = await page.evaluate((p) => window.__schematicView.toClient(p), p);
  await page.mouse.click(c.x, c.y);
  await wait(200);
};
const tool = (label) => page.evaluate((l) => [...document.querySelectorAll(".tool-rail button")].find((b) => b.querySelector(".tl")?.textContent === l).click(), label);
const openSheet = (i) => page.evaluate((i) => document.querySelectorAll(".tree button")[i].click(), i);
/** The page-list texts drawn on the sheet that is open. */
const lists = () => page.evaluate(() => [...document.querySelectorAll(".viewport.schematic g.i-label text")].map((t) => t.textContent).filter((t) => /^\[[0-9,]*\]$/.test(t)).sort());

await page.goto(`${URL}?demo=complex_hierarchy/complex_hierarchy.kicad_pro`, { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await wait(800);
await page.keyboard.press("e");
await wait(300);

console.log("-- global labels on the root and in the reused sheet");
for (const [sheet, at] of [[0, { x: 25.4, y: 25.4 }], [1, { x: 25.4, y: 25.4 }]]) {
  await openSheet(sheet);
  await wait(500);
  await tool("Global label");
  globalThis.nextPrompt = "SYNC";
  await clickSch(at);
  await idle();
  await page.keyboard.press("Escape");
}
expect((await lists()).length === 0, "no page lists yet (the project has them off)");

console.log("-- switch them on in Page settings");
await openSheet(0);
await wait(400);
await page.evaluate(() => document.querySelector('button[title^="Page settings"]').click());
await page.waitForSelector(".page-refs", { timeout: 5000 });
await page.evaluate(() => document.querySelector(".page-refs legend input").click());
await wait(200);
const type = async (label, text) => {
  const el = await page.evaluateHandle((l) => [...document.querySelectorAll(".page-refs label")].find((x) => x.textContent.startsWith(l)).querySelector("input"), label);
  await el.type(text);
};
await type("Before", "[");
await type("After", "]");
await page.evaluate(() => [...document.querySelectorAll(".modal.page-settings .update-actions button")].pop().click());
await idle();
await wait(600);
const root = await lists();
await page.screenshot({ path: `${OUT}/root.png` });
await openSheet(1);
await wait(600);
const first = await lists();
await openSheet(2);
await wait(600);
const second = await lists();
expect(JSON.stringify(root) === '["[2,3]"]', `the root's label lists pages 2 and 3 (${root})`);
expect(JSON.stringify(first) === '["[1,3]"]' && JSON.stringify(second) === '["[1,2]"]', `each instance of the reused sheet lists the other two (${first}; ${second})`);

const dir = `${OUT}/complex_hierarchy`;
cpSync(`${DEMOS}/complex_hierarchy`, dir, { recursive: true });
const files = await page.evaluate(() => window.__crossprobe.files());
for (const [k, t] of Object.entries(files)) writeFileSync(`${dir}/${k.split("/").pop()}`, t);
const drawing = JSON.parse(readFileSync(`${dir}/complex_hierarchy.kicad_pro`, "utf8")).schematic.drawing;
expect(drawing.intersheets_ref_show === true && drawing.intersheets_ref_prefix === "[" && drawing.intersheets_ref_suffix === "]", "the project file has the setting");
execFileSync("kicad-cli", ["sch", "export", "svg", "-o", `${dir}/svg`, `${dir}/complex_hierarchy.kicad_sch`], { stdio: "ignore" });
const kicad = readdirSync(`${dir}/svg`).flatMap((f) => [...readFileSync(`${dir}/svg/${f}`, "utf8").matchAll(/<text[^>]*>(\[[0-9,]*\])</g)].map((m) => m[1])).sort();
expect(JSON.stringify(kicad) === JSON.stringify([...root, ...first, ...second].sort()), `KiCad's plot shows the same lists (${kicad})`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

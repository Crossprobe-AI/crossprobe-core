// End-to-end, the side panels: shut and open both with their buttons, resize them with the
// mouse, the canvas and its drawing follow; the layout is kept across a reload; the panel
// shut by dragging past its narrowest; the board's view follows too; Tab skips a shut panel.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-side-panels.mjs [out-dir]
// BROWSER = a Chromium-based browser executable; APP_URL = the app (default http://localhost:5173/).
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/side-panels");
mkdirSync(OUT, { recursive: true });
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("dialog", (d) => d.accept());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
const rect = (sel) => page.$eval(sel, (e) => JSON.parse(JSON.stringify(e.getBoundingClientRect())));
const width = async (sel) => (await rect(sel)).width;
const expanded = (side) => page.$eval(`.side-panel.${side} .side-panel-toggle`, (b) => b.getAttribute("aria-expanded") === "true");
/** Drag a panel's edge with the mouse, from a point above its toggle. */
async function drag(side, dx) {
  const r = await rect(`.side-panel.${side} .side-panel-edge`);
  const x = r.x + r.width / 2;
  const y = r.y + 60;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y);
  await page.mouse.up();
  await wait(400);
}
/** The drawing's box (the schematic's or the board's svg/canvas). */
const drawing = () => page.evaluate(() => {
  const v = document.querySelector("main.canvas .viewport");
  return v && JSON.parse(JSON.stringify(v.getBoundingClientRect()));
});

console.log("-- a new project, at the default layout");
await page.goto(URL + "?home", { waitUntil: "networkidle0" });
await page.evaluate(() => localStorage.removeItem("crossprobe.panels"));
await page.type('input[aria-label="Project name"]', "panels");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__crossprobe?.project, { timeout: 60000 });
await wait(800);
const canvas0 = await width("main.canvas");
expect((await width(".side-panel.left")) === 230 && (await width(".side-panel.right")) === 340, "the panels open at 230 and 340 px");
await page.screenshot({ path: `${OUT}/1-open.png` });

console.log("-- shut both with their buttons");
await page.click(".side-panel.left .side-panel-toggle");
await page.click(".side-panel.right .side-panel-toggle");
await wait(450);
expect((await width(".side-panel.left")) === 0 && (await width(".side-panel.right")) === 0, "both columns are shut");
expect((await width("main.canvas")) === 1400, "the canvas takes the whole width");
const d = await drawing();
expect(d && d.width > canvas0, `the schematic's view follows (${d?.width} > ${canvas0})`);
const t = await rect(".side-panel.left .side-panel-toggle");
expect(t.x >= 0 && (await page.evaluate((x, y) => !!document.elementFromPoint(x, y)?.closest(".side-panel-toggle"), t.x + t.width / 2, t.y + t.height / 2)), "the shut panel's button is in view and on top");
await page.screenshot({ path: `${OUT}/2-shut.png` });

console.log("-- Tab skips a shut panel's content");
await page.focus(".side-panel.left .side-panel-toggle");
await page.keyboard.press("Tab");
expect(await page.evaluate(() => !document.activeElement.closest(".side-panel-body")), "the focus goes past the shut sheets");

console.log("-- open them again, and resize with the mouse");
await page.click(".side-panel.left .side-panel-toggle");
await page.click(".side-panel.right .side-panel-toggle");
await wait(450);
expect((await expanded("left")) && (await expanded("right")), "both are open again");
await drag("left", 90);
await drag("right", -160);
expect((await width(".side-panel.left")) === 320, `the sheets are 320 px (${await width(".side-panel.left")})`);
expect((await width(".side-panel.right")) === 500, `the inspector is 500 px (${await width(".side-panel.right")})`);
const after = await drawing();
expect(after && Math.abs(after.width - (await width("main.canvas"))) < 2, "the drawing fills the narrower canvas");
await page.screenshot({ path: `${OUT}/3-resized.png` });

console.log("-- kept across a reload");
await page.reload({ waitUntil: "networkidle0" });
await page.waitForFunction(() => window.__crossprobe?.project, { timeout: 60000 });
await wait(800);
expect((await width(".side-panel.left")) === 320 && (await width(".side-panel.right")) === 500, "the widths are as they were");

console.log("-- dragging past the narrowest shuts the panel");
await drag("left", -400);
expect(!(await expanded("left")) && (await width(".side-panel.left")) === 0, "the sheets are shut");
await drag("left", 260);
expect((await expanded("left")) && (await width(".side-panel.left")) === 260, "dragged back out, they open at 260 px");

console.log("-- the board's view follows the panels too");
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB"))?.click());
await wait(800);
const b0 = await drawing();
await page.click(".side-panel.right .side-panel-toggle");
await wait(450);
const b1 = await drawing();
expect(b0 && b1 && b1.width > b0.width + 400, `the board's view widens with the inspector shut (${b0?.width} → ${b1?.width})`);
await page.screenshot({ path: `${OUT}/4-board.png` });

console.log("-- the canvas keeps its minimum in a narrow window");
await page.click(".side-panel.right .side-panel-toggle");
await page.setViewport({ width: 900, height: 900 });
await wait(500);
expect((await width("main.canvas")) >= 319, `the canvas is at least 320 px (${await width("main.canvas")})`);
await page.screenshot({ path: `${OUT}/5-narrow.png` });

await browser.close();
console.log(problems.length ? `${problems.length} problems` : "all ok");
process.exit(problems.length ? 1 : 0);

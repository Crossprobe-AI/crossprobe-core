// End-to-end, the footprint editor's 3D model preview: pic_programmer's R1 footprint opened in
// the editor shows its model on a patch of board; a new Z rotation shows at once (the file's
// (model …) rotate changes and the preview loads the model again).
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-model-preview.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/model-preview");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
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
await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await page.keyboard.press("e");
await page.evaluate(() => [...document.querySelectorAll(".tabs [role=tab]")].find((b) => b.textContent.includes("Parts"))?.click());
await wait(200);
await page.evaluate(() => [...document.querySelectorAll(".inspector .item")].find((b) => b.textContent.trim().startsWith("R1"))?.click());
await wait(300);
await page.evaluate(() => [...document.querySelectorAll(".inspector button.link")].find((b) => b.textContent === "Edit footprint")?.click());
await page.waitForSelector(".fp-editor .model-preview canvas", { timeout: 15000 });
const loaded = () => page.waitForFunction(() => { const t = document.querySelector(".model-preview")?.textContent ?? ""; return !t.includes("Loading"); }, { timeout: 30000 }).then(() => page.evaluate(() => document.querySelector(".model-preview")?.textContent ?? ""));
let t = await loaded();
expect(!t.includes("isn't available"), `model loaded${t ? ` (${t})` : ""}`);
await page.screenshot({ path: `${OUT}/preview.png` });
const el = await page.evaluateHandle(() => [...document.querySelectorAll(".fpe-side label.prop")].find((l) => l.querySelector("span")?.textContent === "Rotate Z")?.querySelector("input"));
await el.asElement().click();
await el.evaluate((e) => e.select());
await el.asElement().type("90");
await page.keyboard.press("Enter");
await idle();
await wait(300);
const file = await page.evaluate(() => document.querySelector(".fp-editor .update-head .muted")?.textContent);
const text = await page.evaluate((f) => window.__crossprobe.project.projectFootprints.find((x) => x.file === f)?.text, file);
expect(/\(rotate\s*\(xyz 0 0 90\)\s*\)/.test(text.replace(/\s+/g, " ")), "the footprint's model rotation is 90");
t = await loaded();
expect(!t.includes("isn't available"), "the preview loads it again");
await page.screenshot({ path: `${OUT}/rotated.png` });
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

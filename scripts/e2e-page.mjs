// End-to-end, page settings: on pic_programmer's root sheet the Page dialog sets A3 and a new
// title block, copied to every sheet and the board. The app's sheet is A3 and shows the title;
// kicad-cli's SVG of the saved schematic has both sheets with the new title block (the second
// keeping its paper), and the board file carries it too.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-page.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/page");
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
async function field(label, value) {
  const el = await page.evaluateHandle((label) => [...document.querySelectorAll(".page-settings label.prop")].find((l) => l.querySelector("span")?.textContent === label)?.querySelector("input, select"), label);
  if ((await el.evaluate((e) => e.tagName)) === "SELECT") await el.evaluate((e, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(e, v); e.dispatchEvent(new Event("change", { bubbles: true })); }, value);
  else {
    await el.asElement().click();
    await el.evaluate((e) => e.select());
    await el.asElement().type(value);
  }
  await wait(50);
}

await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await page.keyboard.press("e");
await wait(300);
const before = await page.evaluate(() => window.__crossprobe.project.sheets.map((s) => ({ file: s.file, paper: s.paper })));
await page.evaluate(() => document.querySelector('button[title^="Page settings: paper"]')?.click());
await page.waitForSelector(".page-settings");
await field("Paper", "A3");
await field("Title", "Programmer, rev for test");
await field("Revision", "7");
await field("Comment 1", "Set from Crossprobe");
await page.evaluate(() => document.querySelector(".page-everywhere input").click());
await page.screenshot({ path: `${OUT}/dialog.png` });
await page.evaluate(() => [...document.querySelectorAll(".page-settings button.primary")][0].click());
await idle();
await wait(400);
const after = await page.evaluate(() => window.__crossprobe.project.sheets.map((s) => ({ file: s.file, paper: s.paper, title: s.title })));
expect(after[0].paper.w === 420 && after[0].paper.h === 297, `root sheet ${after[0].paper.w} × ${after[0].paper.h}`);
expect(after.every((s) => s.title.title === "Programmer, rev for test" && s.title.rev === "7"), `title blocks: ${after.map((s) => `${s.title.title}/${s.title.rev}`).join("; ")}`);
expect(after[1].paper.w === before[1].paper.w, "the other sheet keeps its paper");

const files = await page.evaluate(() => window.__crossprobe.files());
for (const [k, v] of Object.entries(files)) if (/\.kicad_(sch|pcb)$/.test(k)) writeFileSync(`${OUT}/${k.split("/").pop()}`, v);
mkdirSync(`${OUT}/svg`);
execFileSync("kicad-cli", ["sch", "export", "svg", "-o", `${OUT}/svg`, `${OUT}/pic_programmer.kicad_sch`], { stdio: "pipe" });
const svgs = readdirSync(`${OUT}/svg`).map((f) => readFileSync(`${OUT}/svg/${f}`, "utf8"));
expect(svgs.length === 2 && svgs.every((t) => t.includes("Programmer, rev for test") && t.includes("Rev: 7") && t.includes("Set from Crossprobe")), `kicad-cli: ${svgs.length} sheets with the new title block`);
expect(svgs.some((t) => Math.round(Number(/width="([\d.]+)mm"/.exec(t)[1])) === 420), "kicad-cli: the root sheet on A3");
expect(readFileSync(`${OUT}/pic_programmer.kicad_pcb`, "utf8").includes('(rev "7")'), "the board's title block");
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

// End-to-end, plotting: KiCad's pic_programmer demo through the Plot dialog. The schematic as
// SVGs (a zip, one per sheet) and as a PDF (the print window, saved with the browser's own PDF
// printer: a page per sheet at its paper size); then the board's copper as SVGs and a PDF.
// The board SVGs themselves are checked against kicad-cli by scripts/check-plot-svg.mjs.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-plot.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/plot-e2e");
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
const click = (sel, text) => page.evaluate((sel, text) => [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().startsWith(text))?.click(), sel, text);
async function downloaded(pattern) {
  for (let i = 0; i < 50; i++) {
    const f = readdirSync(OUT).find((f) => pattern.test(f) && !f.endsWith(".crdownload"));
    if (f) return `${OUT}/${f}`;
    await wait(200);
  }
}
/** Click PDF, catch the print window, and print it to a PDF file with the browser's own printer. */
async function pdf(file) {
  const target = browser.waitForTarget((t) => t.opener() === page.target() && t.type() === "page", { timeout: 10000 });
  await page.evaluate(() => { window.__realOpen ??= window.open; });
  await click(".plot-panel button", "PDF");
  const w = await (await target).page();
  await w.evaluate(() => { window.print = () => {}; });
  await w.waitForSelector(".page svg");
  const n = await w.evaluate(() => document.querySelectorAll(".page").length);
  await w.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
  await w.close();
  return n;
}
/** Page sizes of a PDF (mm), from its MediaBoxes. */
function pdfPages(file) {
  const text = readFileSync(file, "latin1");
  return [...text.matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)].map((m) => [Number(m[1]) * 25.4 / 72, Number(m[2]) * 25.4 / 72]);
}

console.log("-- schematic");
await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await wait(800);
const sheets = await page.evaluate(() => window.__crossprobe.project.sheets.map((s) => ({ name: s.namePath, paper: s.paper })));
await page.evaluate(() => document.querySelector('button[title^="Plot the schematic"]')?.click());
await page.waitForSelector(".plot-panel");
await click(".plot-panel button", "SVG");
const zip = await downloaded(/schematic-svg\.zip$/);
expect(!!zip, "schematic SVG zip");
if (zip) {
  const list = execFileSync("unzip", ["-o", "-d", `${OUT}/sch`, zip]).toString();
  const svgs = readdirSync(`${OUT}/sch`).filter((f) => f.endsWith(".svg"));
  expect(svgs.length === sheets.length, `${svgs.length} SVGs for ${sheets.length} sheets`);
  const first = readFileSync(`${OUT}/sch/${svgs[0]}`, "utf8");
  expect(first.includes(`width="${sheets[0].paper.w}mm"`), "first sheet at its paper size");
  void list;
}
let n = await pdf(`${OUT}/schematic.pdf`);
const sp = pdfPages(`${OUT}/schematic.pdf`);
expect(n === sheets.length && sp.length === sheets.length, `PDF: ${sp.length} pages for ${sheets.length} sheets`);
expect(sp.every((p, i) => Math.abs(p[0] - sheets[i].paper.w) < 1 && Math.abs(p[1] - sheets[i].paper.h) < 1), `PDF page sizes ${sp.map((p) => p.map((v) => v.toFixed(0)).join("×")).join(", ")}`);
// A look at page 1 (pdftoppm, if installed).
try {
  execFileSync("pdftoppm", ["-png", "-r", "60", "-f", "1", "-l", "1", `${OUT}/schematic.pdf`, `${OUT}/schematic-p`], { stdio: "ignore" });
} catch {}

console.log("-- board");
await click(".plot-panel .segmented button", "Board");
await page.evaluate(() => {
  // Just the copper layers.
  for (const l of document.querySelectorAll(".plot-layers label")) {
    const on = /^(F|B)\.Cu$/.test(l.dataset.layer);
    const box = l.querySelector("input");
    if (box.checked !== on) box.click();
  }
});
await wait(100);
await page.screenshot({ path: `${OUT}/dialog-board.png` });
await click(".plot-panel button", "SVG");
const bzip = await downloaded(/board-svg\.zip$/);
expect(!!bzip, "board SVG zip");
if (bzip) {
  execFileSync("unzip", ["-o", "-d", `${OUT}/brd`, bzip]);
  const svgs = readdirSync(`${OUT}/brd`).sort();
  expect(svgs.length === 2 && svgs.some((f) => f.includes("F_Cu")) && svgs.some((f) => f.includes("B_Cu")), `board SVGs: ${svgs.join(" ")}`);
  const b = readFileSync(`${OUT}/brd/${svgs.find((f) => f.includes("B_Cu"))}`, "utf8");
  expect(b.includes("scale(-1 1)"), "bottom copper mirrored");
}
n = await pdf(`${OUT}/board.pdf`);
expect(n === 2 && pdfPages(`${OUT}/board.pdf`).length === 2, "board PDF: 2 pages");
expect(statSync(`${OUT}/board.pdf`).size > 20000, `board PDF ${statSync(`${OUT}/board.pdf`).size} bytes`);
await page.screenshot({ path: `${OUT}/dialog.png` });
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

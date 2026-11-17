// End-to-end, the board's page frame: interf_u's board names a drawing sheet (pagelayout_logo.kicad_wks)
// in its project; the board view draws it around the board, with the title block filled from the
// board's page settings, and the "Drawing sheet" visibility toggle hides it. pic_programmer's board
// names none and gets the default frame.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-board-sheet.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/board-sheet");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
const boardCanvas = () => [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
/** Pixels on the board canvas in the drawing sheet's colour (#c872ab). */
const sheetPixels = () =>
  page.evaluate((find) => {
    const c = new Function(`return (${find})()`)();
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 0xc8) < 12 && Math.abs(d[i + 1] - 0x72) < 12 && Math.abs(d[i + 2] - 0xab) < 12) n++;
    return n;
  }, boardCanvas.toString());
const openBoard = async (demo) => {
  await page.goto(URL + `?demo=${demo}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".viewport", { timeout: 60000 });
  await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
  await wait(800);
  // Zoom out to the whole page.
  const c = await page.evaluate((find) => {
    const r = new Function(`return (${find})()`)().getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, boardCanvas.toString());
  await page.mouse.move(c.x, c.y);
  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel({ deltaY: 300 });
    await wait(120);
  }
  await wait(500);
};
const toggleSheet = async () => {
  await page.evaluate(() => [...document.querySelectorAll("label.layer")].find((x) => x.textContent.trim() === "Drawing sheet").querySelector("input").click());
  await wait(500);
};

console.log("interf_u: the project's drawing sheet");
await openBoard("interf_u/interf_u.kicad_pro");
expect(await page.evaluate(() => !!window.__crossprobe.project.boardDrawingSheet), "the board's drawing sheet (pcbnew.page_layout_descr_file) is read");
const on = await sheetPixels();
await page.screenshot({ path: `${OUT}/interf_u.png` });
expect(on > 500, `the frame is drawn (${on} px)`);
await toggleSheet();
const off = await sheetPixels();
expect(off < on / 20, `"Drawing sheet" off hides it (${off} px)`);
await toggleSheet();

console.log("pic_programmer: the default frame");
await openBoard("pic_programmer/pic_programmer.kicad_pro");
expect(!(await page.evaluate(() => window.__crossprobe.project.boardDrawingSheet)), "no drawing sheet named");
const dflt = await sheetPixels();
await page.screenshot({ path: `${OUT}/pic_programmer.png` });
expect(dflt > 500, `the default frame is drawn (${dflt} px)`);

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log("\nall good");

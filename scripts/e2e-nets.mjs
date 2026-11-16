// End-to-end, the net inspector: KiCad's video demo (4 layers). /DQ17's row must show what KiCad's
// own length calculation gives (82.805 mm in total, 4 vias, checked in net-stats.test.ts), the
// table sorts by length, CSV comes out, and a row selects its net on the board.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-nets.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/nets");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
const table = () =>
  page.evaluate(() => {
    const heads = [...document.querySelectorAll(".net-inspector th")].map((th) => th.textContent.replace(/ [▲▼]$/, ""));
    return [...document.querySelectorAll(".net-inspector tbody tr")].map((tr) => Object.fromEntries([...tr.children].map((td, i) => [heads[i], td.textContent])));
  });

console.log("-- open the board, the net inspector");
await page.goto(URL + "?demo=video/video.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await wait(300);
await page.evaluate(() => document.querySelector('button[title^="Net inspector"]')?.click());
await page.waitForSelector(".net-inspector tbody tr", { timeout: 20000 });
let rows = await table();
const dq = rows.find((r) => r.Net === "/DQ17");
console.log(`  ${rows.length} nets; /DQ17: ${JSON.stringify(dq)}`);
expect(!!dq && Math.abs(Number(dq.Total) - 82.805) < 0.01, `/DQ17 total ${dq?.Total} (KiCad 82.805)`);
expect(dq?.Vias === "4" && dq?.Pads === "3", "/DQ17 4 vias, 3 pads");
const layerCols = Object.keys(dq ?? {}).filter((k) => !["Net", "Class", "Pads", "Vias", "Via length", "Track length", "Total", "Unrouted"].includes(k));
expect(Math.abs(layerCols.reduce((n, k) => n + Number(dq[k] || 0), 0) - Number(dq["Track length"])) < 0.005, `per-layer columns (${layerCols.join(", ")}) add up to the track length`);

console.log("-- sort by total, filter, CSV");
await page.evaluate(() => [...document.querySelectorAll(".net-inspector th")].find((th) => th.textContent.startsWith("Total"))?.click());
await wait(200);
rows = await table();
expect(rows.every((r, i) => i === 0 || Number(r.Total || 0) <= Number(rows[i - 1].Total || 0)), `sorted by total, longest first: ${rows[0].Net} ${rows[0].Total}`);
await page.type(".net-inspector input:not([type])", "DQ1");
await wait(200);
rows = await table();
expect(rows.length > 0 && rows.every((r) => r.Net.includes("DQ1")), `filter: ${rows.length} nets`);
await page.screenshot({ path: `${OUT}/nets.png` });
await page.evaluate(() => [...document.querySelectorAll(".net-inspector button")].find((b) => b.textContent === "CSV")?.click());
let csv;
for (let i = 0; i < 25 && !csv; i++) {
  csv = readdirSync(OUT).find((f) => f.endsWith("-nets.csv"));
  await wait(200);
}
expect(!!csv && readFileSync(`${OUT}/${csv}`, "utf8").split("\n").length === rows.length + 2, `CSV ${csv}`);

console.log("-- a row selects its net");
await page.evaluate(() => [...document.querySelectorAll(".net-inspector tbody tr")].find((tr) => tr.firstChild.textContent === "/DQ17")?.click());
await wait(500);
const sel = await page.evaluate(() => window.__crossprobe.selection);
const open = await page.evaluate(() => !!document.querySelector(".net-inspector"));
expect(!open && sel?.kind === "net" && sel?.name === "/DQ17", `dialog closed, selected ${JSON.stringify(sel)}`);
await page.screenshot({ path: `${OUT}/selected.png` });
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

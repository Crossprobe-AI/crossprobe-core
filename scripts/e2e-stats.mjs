// End-to-end, board statistics: pic_programmer's statistics dialog shows kicad-cli's numbers
// (pcb export stats): parts, pads, vias, the board size and the drill table's rows.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-stats.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/stats");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const PCB = `${process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos"}/pic_programmer/pic_programmer.kicad_pcb`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
execFileSync("kicad-cli", ["pcb", "export", "stats", "--format", "json", "-o", `${OUT}/kicad.json`, PCB], { stdio: "ignore" });
const k = JSON.parse(readFileSync(`${OUT}/kicad.json`, "utf8"));
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
await page.evaluate(() => [...document.querySelectorAll("button.link")].find((b) => b.textContent === "Statistics…")?.click());
await page.waitForSelector(".board-stats");
const ui = await page.evaluate(() => {
  const cells = (t) => [...t.querySelectorAll("tbody tr")].map((r) => [...r.children].map((c) => c.textContent));
  const tables = [...document.querySelectorAll(".board-stats .stats-grid table")].map(cells);
  return { tables, drills: cells(document.querySelector(".stats-drills table")) };
});
await page.screenshot({ path: `${OUT}/stats.png` });
const all = ui.tables[0].find((r) => r[0] === "All");
expect(Number(all[3]) === k.components.total.total, `parts ${all[3]} (KiCad ${k.components.total.total})`);
expect(Number(ui.tables[1].find((r) => r[0] === "Through-hole")[1]) === k.pads.through_hole, `through-hole pads (KiCad ${k.pads.through_hole})`);
expect(Number(ui.tables[2].find((r) => r[0] === "Through")[1]) === k.vias.through, `vias (KiCad ${k.vias.through})`);
expect(ui.tables[3].find((r) => r[0] === "Size")[1].startsWith(Number(k.board.width.split(" ")[0]).toFixed(2)), `size ${ui.tables[3][0][1]} (KiCad ${k.board.width} × ${k.board.height})`);
expect(ui.drills.length === k.drill_holes.length && ui.drills.reduce((n, r) => n + Number(r[0]), 0) === k.drill_holes.reduce((n, r) => n + r.count, 0), `${ui.drills.length} drill rows (KiCad ${k.drill_holes.length})`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

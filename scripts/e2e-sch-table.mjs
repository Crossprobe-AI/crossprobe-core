// End-to-end, a KiCad 9 table. jetson-agx-thor-baseboard's power sheet (a KiCad 9 file) has a
// table without a UUID of its own. Clicking a cell selects the table; dragging a cell moves the
// whole table; a box selection around it takes the table, not its cells, and moving that keeps
// every cell in the grid; Delete removes it. The file is checked after each step.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-sch-table.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/sch-table");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = () => page.waitForFunction(() => !document.body.textContent.includes("Updating…"), { timeout: 60000 });
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
const sch = (p) => page.evaluate((p) => window.__schematicView.toClient(p), p);
/** The table as drawn: how many tables, and the top-left corners of its first four cells. */
const cells = () =>
  page.evaluate(() => {
    const items = window.__crossprobe.sheet.items;
    return {
      tables: items.filter((i) => i.kind === "graphic" && i.uuid?.startsWith("table-of:")).length,
      at: items.filter((i) => i.kind === "cell").slice(0, 4).map((i) => [Math.round(i.bbox.x * 1e4) / 1e4, Math.round(i.bbox.y * 1e4) / 1e4]),
    };
  });
/** The power sheet's text, once edited. */
const fileText = () =>
  page.evaluate(async () => Object.entries(await window.__crossprobe.files()).find(([k]) => k === "power.kicad_sch" || k.endsWith("/power.kicad_sch"))?.[1] ?? "");
const cellCentre = (i) => page.evaluate((i) => {
  const r = [...document.querySelectorAll(".viewport.schematic g.i-cell")][i].getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, i);
const selected = () => page.evaluate(() => /(\d+) selected/.exec(document.body.textContent)?.[1]);

await page.goto(`${URL}?demo=jetson-agx-thor-baseboard/jetson-agx-thor-baseboard.kicad_pro`, { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 90000 });
await page.evaluate(() => [...document.querySelectorAll(".tree button")].find((b) => b.textContent.startsWith("Power")).click());
await page.waitForFunction(() => window.__crossprobe.sheet.namePath === "/Power/", { timeout: 30000 });
await wait(800);
await page.keyboard.press("e");
await wait(500);
const start = await cells();
expect(start.tables === 1 && start.at.length === 4, `one table (${JSON.stringify(start)})`);

console.log("-- click a cell");
let c = await cellCentre(5);
await page.mouse.click(c.x, c.y);
await wait(400);
expect((await selected()) === "1", "clicking a cell selects the table");

console.log("-- drag a cell");
const mm = ((await sch({ x: 10, y: 0 })).x - (await sch({ x: 0, y: 0 })).x) / 10;
await page.mouse.move(c.x, c.y);
await page.mouse.down();
await page.mouse.move(c.x + 1.27 * mm, c.y, { steps: 4 });
await page.mouse.move(c.x + 2.54 * mm, c.y, { steps: 4 });
await page.mouse.up();
await idle();
await wait(500);
const dragged = await cells();
expect(/\n\t\(table\b/.test(await fileText()) && !/\(table\s+\(column_count[\s\S]*?\(uuid[\s\S]*?\(cells/.test((await fileText()).slice((await fileText()).indexOf("\n\t(table"))), "the file keeps a KiCad 9 table (no table uuid)");
expect(dragged.at.every(([x, y], i) => Math.abs(x - start.at[i][0] - 2.54) < 1e-6 && y === start.at[i][1]), `every cell moved 2.54 mm (${JSON.stringify(dragged.at)})`);

console.log("-- box selection");
await page.keyboard.press("Escape");
await wait(300);
const box = await page.evaluate(() => {
  const g = window.__crossprobe.sheet.items.find((i) => i.kind === "graphic" && i.uuid?.startsWith("table-of:"));
  return g && g.bbox;
});
expect(!!box, "the table has an id and a box");
const a = await sch({ x: box.x - 2, y: box.y - 2 });
const b = await sch({ x: box.x + box.w + 2, y: box.y + box.h + 2 });
await page.keyboard.down("Shift");
await page.mouse.move(a.x, a.y);
await page.mouse.down();
await page.mouse.move(b.x, b.y, { steps: 6 });
await page.mouse.up();
await page.keyboard.up("Shift");
await wait(400);
const picked = await selected();
expect(picked === "1", `the box takes the table alone (${picked} selected)`);
// Dragged down by a cell, as selected by the box.
c = await cellCentre(2);
await page.mouse.move(c.x, c.y);
await page.mouse.down();
await page.mouse.move(c.x, c.y + 1.27 * mm, { steps: 4 });
await page.mouse.move(c.x, c.y + 2.54 * mm, { steps: 4 });
await page.mouse.up();
await idle();
await wait(500);
const nudged = await cells();
const dy = nudged.at[0][1] - dragged.at[0][1];
expect(dy > 0 && nudged.at.every(([x, y], i) => x === dragged.at[i][0] && Math.abs(y - dragged.at[i][1] - dy) < 1e-6), `moved together, still in the grid (dy ${dy})`);

console.log("-- delete");
await page.keyboard.press("Delete");
await idle();
await wait(500);
expect((await cells()).tables === 0 && !/\n\t\(table\b/.test(await fileText()), "Delete removes the table, from the file too");
await page.screenshot({ path: `${OUT}/after.png` });
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

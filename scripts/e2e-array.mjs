// End-to-end, Create Array: on pic_programmer's board a box selection (33 items: six of R1–R6 and
// D2–D7, tracks, texts) is copied into a 3 × 1 grid 30 mm apart from the right-click menu's
// "Create Array…".
// kicad-cli reads the saved board: its position file has every copied footprint 30 and 60 mm right
// of its source, under a new, unique reference. Undo removes the copies.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-array.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/array");
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
/** A point in the board view, as fractions of its width and height. */
const at = (p) =>
  page.evaluate((p) => {
    const r = document.querySelector(".viewport").getBoundingClientRect();
    return { x: r.left + r.width * p.x, y: r.top + r.height * p.y };
  }, p);
const footprints = () => page.evaluate(() => window.__crossprobe.project.board.footprints.map((f) => ({ uuid: f.uuid, ref: f.reference, x: f.at.x, y: f.at.y, value: f.value })));
/** Set a number field of the dialog by its label. */
const setField = (label, value) =>
  page.evaluate(
    (label, value) => {
      const l = [...document.querySelectorAll(".create-array label")].find((x) => x.textContent.trim().startsWith(label));
      const i = l?.querySelector("input");
      if (!i) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, String(value));
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    label,
    value,
  );

await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await wait(300);

console.log("-- shift-drag a box in the R1–R6, D2–D7 corner");
// From below the board: a press on an item would pick it instead.
const a = await at({ x: 0.105, y: 0.9 });
const b = await at({ x: 0.27, y: 0.64 });
await page.keyboard.down("Shift");
await page.mouse.move(a.x, a.y);
await page.mouse.down();
await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
await page.mouse.move(b.x, b.y, { steps: 5 });
await page.mouse.up();
await page.keyboard.up("Shift");
await wait(300);
const before = await footprints();

console.log("-- Create Array…: 3 columns, 1 row, 30 mm apart");
const items = await page.evaluate(() => document.body.textContent.match(/(\d+) selected/)?.[1]);
expect(Number(items) > 10, `${items} items selected`);
// Right-click outside the board: the selection stays.
const c = await at({ x: 0.03, y: 0.5 });
await page.mouse.click(c.x, c.y, { button: "right" });
await wait(200);
const opened = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".context-menu button")].find((x) => x.textContent.startsWith("Create Array"));
  b?.click();
  return !!b;
});
expect(opened, "menu: Create Array…");
await page.waitForSelector(".create-array", { timeout: 3000 });
expect(await setField("Columns", 3), "columns");
expect(await setField("Rows", 1), "rows");
expect(await setField("Column spacing", 30), "spacing");
await wait(100);
await page.screenshot({ path: `${OUT}/dialog.png` });
await page.evaluate(() => [...document.querySelectorAll(".create-array .update-actions button")].find((x) => x.textContent.includes("Create")).click());
await idle();
await wait(500);
const after = await footprints();
const old = new Set(before.map((f) => f.uuid));
const made = after.filter((f) => !old.has(f.uuid));
const selectedFps = made.length / 2;
expect(made.length >= 4 && Number.isInteger(selectedFps), `${made.length} footprints copied (${selectedFps} selected, 2 copies each)`);
await page.screenshot({ path: `${OUT}/array.png` });

console.log("-- kicad-cli reads the saved board");
const files = await page.evaluate(() => window.__crossprobe.files());
const pcb = Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))[1];
writeFileSync(`${OUT}/array.kicad_pcb`, pcb);
execFileSync("kicad-cli", ["pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both", "-o", `${OUT}/pos.csv`, `${OUT}/array.kicad_pcb`], { stdio: "ignore" });
const rows = readFileSync(`${OUT}/pos.csv`, "utf8").trim().split("\n").slice(1).map((l) => l.split(",").map((s) => s.replace(/"/g, "")));
const refs = rows.map((r) => r[0]);
expect(new Set(refs).size === refs.length, `${refs.length} references in KiCad's position file, all unique`);
// KiCad's position file has y up: compare x, and y negated.
const pos = new Map(rows.map((r) => [r[0], [Number(r[3]), -Number(r[4])]]));
const srcs = before.filter((f) => made.some((m) => m.value === f.value));
let placed = 0;
for (const m of made) {
  const p = pos.get(m.ref);
  if (p && srcs.some((s) => s.value === m.value && [30, 60].some((d) => Math.abs(p[0] - (s.x + d)) < 0.002 && Math.abs(p[1] - s.y) < 0.002))) placed++;
}
expect(placed === made.length, `KiCad finds ${placed} of ${made.length} copies 30 or 60 mm right of a part like them`);

console.log("-- undo");
await page.keyboard.down("Meta");
await page.keyboard.press("z");
await page.keyboard.up("Meta");
await idle();
await wait(400);
expect((await footprints()).length === before.length, "copies gone");

console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

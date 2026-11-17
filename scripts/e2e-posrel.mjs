// End-to-end, Position Relative To: on pic_programmer's board a box selection (six footprints with
// their tracks and texts) is moved with Shift+P so its top-left footprint sits 120, 100 mm from the
// grid origin (the board has none set: 0, 0), then again by 10 mm at 90° (polar) from an item picked
// on the board. kicad-cli's position file of the saved board has the footprints there, all moved by
// the same amount. Undo puts them back.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-posrel.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/posrel");
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
      const l = [...document.querySelectorAll(".position-relative label")].find((x) => x.textContent.trim().startsWith(label));
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
const button = (label) => page.evaluate((label) => {
  const b = [...document.querySelectorAll(".position-relative button")].find((x) => x.textContent.trim().startsWith(label));
  b?.click();
  return !!b;
}, label);
/** KiCad's footprint positions in the saved board (y down, as the board's). */
const kicadPositions = async (name) => {
  const files = await page.evaluate(() => window.__crossprobe.files());
  writeFileSync(`${OUT}/${name}.kicad_pcb`, Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))[1]);
  execFileSync("kicad-cli", ["pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both", "-o", `${OUT}/${name}.csv`, `${OUT}/${name}.kicad_pcb`], { stdio: "ignore" });
  const rows = readFileSync(`${OUT}/${name}.csv`, "utf8").trim().split("\n").slice(1).map((l) => l.split(",").map((s) => s.replace(/"/g, "")));
  return new Map(rows.map((r) => [r[0], [Number(r[3]), -Number(r[4])]]));
};
const near = (p, q) => Math.abs(p[0] - q[0]) < 0.0015 && Math.abs(p[1] - q[1]) < 0.0015;

console.log("-- Shift+P: grid origin, offset 120, 100");
await page.keyboard.down("Shift");
await page.keyboard.press("P");
await page.keyboard.up("Shift");
await page.waitForSelector(".position-relative", { timeout: 3000 });
expect(await button("Grid origin"), "grid origin");
expect(await setField("Offset X", 120), "offset x");
expect(await setField("Offset Y", 100), "offset y");
await wait(100);
await page.screenshot({ path: `${OUT}/dialog.png` });
expect(await button("Move"), "move");
await idle();
await wait(400);
const after = await footprints();
const moved = before.filter((f) => { const g = after.find((x) => x.uuid === f.uuid); return g.x !== f.x || g.y !== f.y; });
expect(moved.length >= 2, `${moved.length} footprints moved`);
const anchor = moved.reduce((m, f) => (!m || f.x < m.x || (f.x === m.x && f.y < m.y) ? f : m), undefined);
let k = await kicadPositions("grid");
expect(near(k.get(anchor.ref), [120, 100]), `KiCad has ${anchor.ref}, the top-left one, at ${k.get(anchor.ref)}`);
const d = [k.get(anchor.ref)[0] - anchor.x, k.get(anchor.ref)[1] - anchor.y];
expect(moved.every((f) => near(k.get(f.ref), [f.x + d[0], f.y + d[1]])), "the others moved by the same amount");

console.log("-- again: from an item picked on the board, 10 mm at 90° (polar)");
await page.keyboard.down("Shift");
await page.keyboard.press("P");
await page.keyboard.up("Shift");
await page.waitForSelector(".position-relative", { timeout: 3000 });
expect(await button("Select item"), "select item");
// A part in the middle of the fitted view (P3, the 40-pin socket).
const c = await at({ x: 0.59, y: 0.6 });
await page.mouse.click(c.x, c.y);
await wait(300);
const ref = await page.evaluate(() => document.querySelector(".position-relative p").textContent);
expect(/Reference: /.test(ref), ref);
const refAt = ref.match(/\(([-\d.]+), ([-\d.]+)\)/).slice(1).map(Number);
await page.evaluate(() => [...document.querySelectorAll(".position-relative label")].find((l) => l.textContent.includes("Polar")).querySelector("input").click());
expect(await setField("Distance", 10), "distance");
expect(await setField("Angle", 90), "angle");
expect(await button("Move"), "move");
await idle();
await wait(400);
k = await kicadPositions("polar");
expect(near(k.get(anchor.ref), [refAt[0], refAt[1] + 10]), `KiCad has ${anchor.ref} 10 mm below the picked reference (${refAt}): ${k.get(anchor.ref)}`);
await page.screenshot({ path: `${OUT}/moved.png` });

console.log("-- undo twice");
await page.keyboard.down("Meta");
await page.keyboard.press("z");
await page.keyboard.press("z");
await page.keyboard.up("Meta");
await idle();
await wait(400);
const undone = await footprints();
expect(before.every((f) => { const g = undone.find((x) => x.uuid === f.uuid); return g.x === f.x && g.y === f.y; }), "back where they were");

console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

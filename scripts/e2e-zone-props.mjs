// End-to-end, zone properties: pic_programmer's copper zone is selected by its edge and, in its
// properties panel, given a name, priority 2, clearance 0.3, minimum width 0.2, thermal gap 0.6,
// spoke width 0.4 and "remove islands below 5 mm²". The zones refill. KiCad's pcbnew reads every
// property back from the saved board as set. Undo restores them.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-zone-props.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/zone-props");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";
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
/** Where a board point is on the screen (the view's map is affine: solved from three points). */
const screenOf = (p) =>
  page.evaluate((p) => {
    const v = window.__crossprobeBoardView;
    const o = v.toBoard(0, 0), ex = v.toBoard(100, 0), ey = v.toBoard(0, 100);
    const a = (ex.x - o.x) / 100, b = (ey.x - o.x) / 100, c = (ex.y - o.y) / 100, d = (ey.y - o.y) / 100;
    const det = a * d - b * c;
    const dx = p.x - o.x, dy = p.y - o.y;
    return { x: (d * dx - b * dy) / det, y: (-c * dx + a * dy) / det };
  }, p);
/** Type into the properties panel's field labelled `label`, and commit it (Enter). */
const field = async (label, value) => {
  const ok = await page.evaluate((label) => {
    const l = [...document.querySelectorAll("label.prop")].find((x) => x.querySelector("span")?.textContent === label);
    const i = l?.querySelector("input");
    if (!i) return false;
    i.focus();
    i.select();
    return true;
  }, label);
  if (!ok) return false;
  await page.keyboard.type(String(value));
  await page.keyboard.press("Enter");
  await idle();
  await wait(400);
  return true;
};
const choose = (label, value) =>
  page.evaluate(
    (label, value) => {
      const s = [...document.querySelectorAll("label.prop")].find((x) => x.querySelector("span")?.textContent === label)?.querySelector("select");
      if (!s) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, value);
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    label,
    value,
  );
const zone = () => page.evaluate(() => { const z = window.__crossprobe.project.board.zones.find((x) => !x.keepout); return { uuid: z.uuid, name: z.name, priority: z.priority, clearance: z.clearance, minThickness: z.minThickness, thermalGap: z.thermalGap, thermalWidth: z.thermalWidth, islandMode: z.islandMode, islandAreaMin: z.islandAreaMin }; });

await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await wait(300);
const before = await zone();
console.log("zone:", JSON.stringify(before));

console.log("-- select the zone by its left edge, and set its properties");
const s = await screenOf({ x: 74.295, y: 90 });
await page.mouse.click(s.x, s.y);
await wait(300);
expect(await field("Name", "Ground pour"), "name");
expect(await field("Priority", 2), "priority");
expect(await field("Clearance", 0.3), "clearance");
expect(await field("Minimum width", 0.2), "minimum width");
expect(await field("Thermal gap", 0.6), "thermal gap");
expect(await field("Spoke width", 0.4), "spoke width");
expect(await choose("Islands", "2"), "islands: below an area");
await idle();
await wait(400);
expect(await field("Minimum island", 5), "minimum island");
await page.screenshot({ path: `${OUT}/panel.png` });
const after = await zone();
const want = { uuid: before.uuid, name: "Ground pour", priority: 2, clearance: 0.3, minThickness: 0.2, thermalGap: 0.6, thermalWidth: 0.4, islandMode: 2, islandAreaMin: 5 };
expect(JSON.stringify(after) === JSON.stringify(want), `in the model: ${JSON.stringify(after)}`);

console.log("-- KiCad reads them back");
const files = await page.evaluate(() => window.__crossprobe.files());
writeFileSync(`${OUT}/zone.kicad_pcb`, Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))[1]);
try {
  execFileSync(PY, [new globalThis.URL("../packages/kicad-model/test/pcbnew-zone.py", import.meta.url).pathname, `${OUT}/zone.kicad_pcb`, `${OUT}/zone.json`], { stdio: "ignore" });
} catch {
  // pcbnew may crash on exit after writing its output.
}
const k = JSON.parse(readFileSync(`${OUT}/zone.json`, "utf8"))[before.uuid];
const near = (a, b) => Math.abs(a - b) < 1e-6;
expect(k.name === "Ground pour" && k.priority === 2 && near(k.clearance, 0.3) && near(k.minThickness, 0.2) && near(k.thermalGap, 0.6) && near(k.thermalWidth, 0.4) && k.islandMode === 2 && near(k.islandAreaMin, 5), `pcbnew: ${JSON.stringify(k)}`);
const filled = await page.evaluate(() => window.__crossprobe.project.board.zones.find((x) => !x.keepout).fills.length);
expect(filled > 0, `refilled (${filled} fill polygons)`);

console.log("-- undo, step by step");
let steps = 0;
while (steps < 20 && JSON.stringify(await zone()) !== JSON.stringify(before)) {
  await page.keyboard.down("Meta");
  await page.keyboard.press("z");
  await page.keyboard.up("Meta");
  await idle();
  await wait(300);
  steps++;
}
// Eight changes: name, priority, clearance, width, gap, spokes, island mode, island area.
expect(JSON.stringify(await zone()) === JSON.stringify(before) && steps === 8, `properties as they were after ${steps} undos`);

console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

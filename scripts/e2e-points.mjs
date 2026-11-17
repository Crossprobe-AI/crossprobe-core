// End-to-end, the point editor on a zone: pic_programmer's copper zone is selected by its edge,
// a corner is dragged to 240, 50, the top edge is dragged up by its middle to y = 40 (its corners
// sliding along the neighbouring edges, as KiCad's), a corner is added on the left edge and the
// corner at 74.295, 127.635 is removed, all from its handles and right-click menu.
// KiCad's pcbnew reads the saved board's zone outline back as exactly those corners. Undo restores it.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-points.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/points");
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
const zone = () => page.evaluate(() => window.__crossprobe.project.board.zones.find((z) => !z.keepout).outline.map((p) => [p.x, p.y]));
const drag = async (from, to) => {
  const a = await screenOf(from), b = await screenOf(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await idle();
  await wait(400);
};
const menu = async (at, label) => {
  const s = await screenOf(at);
  await page.mouse.click(s.x, s.y, { button: "right" });
  await wait(200);
  const ok = await page.evaluate((label) => {
    const b = [...document.querySelectorAll(".context-menu button")].find((x) => x.textContent.startsWith(label));
    b?.click();
    return !!b;
  }, label);
  await idle();
  await wait(400);
  return ok;
};
// To the file's precision (six decimals).
const same = (p, q) => p.length === q.length && p.every((a, i) => Math.abs(a[0] - q[i][0]) < 2e-6 && Math.abs(a[1] - q[i][1]) < 2e-6);

await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await wait(300);
const before = await zone();
console.log("zone:", JSON.stringify(before));

console.log("-- select the zone by its left edge");
const s = await screenOf({ x: 74.295, y: 90 });
await page.mouse.click(s.x, s.y);
await wait(300);
const sel = await page.evaluate(() => document.body.textContent.match(/(\d+) selected/)?.[1] ?? document.querySelector(".board-props")?.textContent?.slice(0, 40));
console.log("  selection:", sel);
await page.screenshot({ path: `${OUT}/selected.png` });

console.log("-- drag the corner at 232.41, 53.975 to 240, 50");
await drag({ x: 232.41, y: 53.975 }, { x: 240, y: 50 });
let z = await zone();
const want1 = before.map((p) => (p[0] === 232.41 && p[1] === 53.975 ? [240, 50] : p));
expect(same(z, want1), `corner moved: ${JSON.stringify(z)}`);

console.log("-- drag the top edge (y 41.91) up by its middle to y 40");
// Its corners slide along the neighbouring edges: (240, 50)–(219.71, 41.91) and (74.295, 48.895)–(81.28, 41.91).
const along = (p, q, y) => [p[0] + ((q[0] - p[0]) * (y - p[1])) / (q[1] - p[1]), y];
await drag({ x: (219.71 + 81.28) / 2, y: 41.91 }, { x: (219.71 + 81.28) / 2, y: 40 });
z = await zone();
const want2 = want1.map((p) => (p[0] === 219.71 && p[1] === 41.91 ? along([240, 50], [219.71, 41.91], 40) : p[0] === 81.28 && p[1] === 41.91 ? along([74.295, 48.895], [81.28, 41.91], 40) : p));
expect(same(z, want2), `edge moved: ${JSON.stringify(z)}`);

console.log("-- Add Corner on the left edge, Remove Corner at 74.295, 127.635");
expect(await menu({ x: 74.295, y: 90 }, "Add Corner"), "menu: Add Corner");
z = await zone();
// On the edge, at the grid point nearest the click (0.25 mm grid).
expect(z.length === want2.length + 1 && z.some((p) => p[0] === 74.295 && Math.abs(p[1] - 90) <= 0.25), `corner added on the left edge near y 90: ${JSON.stringify(z)}`);
const want3 = z;
expect(await menu({ x: 74.295, y: 127.635 }, "Remove Corner"), "menu: Remove Corner");
z = await zone();
const want4 = want3.filter((p) => !(p[0] === 74.295 && p[1] === 127.635));
expect(same(z, want4), `corner removed: ${JSON.stringify(z)}`);
await page.screenshot({ path: `${OUT}/edited.png` });

console.log("-- KiCad reads the outline back");
const files = await page.evaluate(() => window.__crossprobe.files());
writeFileSync(`${OUT}/points.kicad_pcb`, Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))[1]);
const py = `import pcbnew, json, sys
b = pcbnew.LoadBoard(sys.argv[1])
z = [z for z in b.Zones() if not z.GetIsRuleArea()][0]
o = z.Outline()
open(sys.argv[2], "w").write(json.dumps([[o.CVertex(i).x / 1e6, o.CVertex(i).y / 1e6] for i in range(o.TotalVertices())]))`;
writeFileSync(`${OUT}/outline.py`, py);
try {
  execFileSync(PY, [`${OUT}/outline.py`, `${OUT}/points.kicad_pcb`, `${OUT}/outline.json`], { stdio: "ignore" });
} catch {
  // pcbnew may crash on exit after writing its output.
}
const theirs = JSON.parse(readFileSync(`${OUT}/outline.json`, "utf8"));
expect(same(theirs, want4), `pcbnew's outline: ${JSON.stringify(theirs)}`);

console.log("-- undo four times");
await page.keyboard.down("Meta");
for (let k = 0; k < 4; k++) await page.keyboard.press("z");
await page.keyboard.up("Meta");
await idle();
await wait(400);
expect(same(await zone(), before), "outline as it was");

console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

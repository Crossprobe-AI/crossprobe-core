// End-to-end, groups: on pic_programmer's board a box selection (six footprints with their tracks
// and texts) becomes a group with Ctrl+G. Clicking one of its parts then selects the whole group,
// and dragging moves all of it. L locks the group (a drag then moves nothing); Ctrl+Shift+G
// ungroups it, and a click picks one part again. KiCad's pcbnew reads the saved board's group,
// its members and its lock, as made here.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-groups.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/groups");
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
const selected = () => page.evaluate(() => Number(document.body.textContent.match(/(\d+) selected/)?.[1] ?? 0));
const kicadGroups = async (name) => {
  const files = await page.evaluate(() => window.__crossprobe.files());
  writeFileSync(`${OUT}/${name}.kicad_pcb`, Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))[1]);
  try {
    execFileSync(PY, [new globalThis.URL("../packages/kicad-model/test/pcbnew-groups.py", import.meta.url).pathname, `${OUT}/${name}.kicad_pcb`, `${OUT}/${name}.json`], { stdio: "ignore" });
  } catch {
    // pcbnew may crash on exit after writing its output.
  }
  return JSON.parse(readFileSync(`${OUT}/${name}.json`, "utf8"));
};
const r1 = () => page.evaluate(() => { const f = window.__crossprobe.project.board.footprints.find((x) => x.reference === "R1"); return { x: f.pads[0].at.x, y: f.pads[0].at.y, at: f.at }; });
const clickAt = async (p) => {
  const s = await screenOf(p);
  await page.mouse.click(s.x, s.y);
  await wait(300);
};
const dragBy = async (p, d) => {
  const a = await screenOf(p), b = await screenOf({ x: p.x + d.x, y: p.y + d.y });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await idle();
  await wait(400);
};
const ctrl = async (key, shift = false) => {
  await page.keyboard.down("Control");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await idle();
  await wait(400);
};

await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await wait(300);

console.log("-- box-select and group (Ctrl+G)");
const vp = await page.evaluate(() => { const r = document.querySelector(".viewport").getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
await page.keyboard.down("Shift");
await page.mouse.move(vp.l + vp.w * 0.105, vp.t + vp.h * 0.9);
await page.mouse.down();
await page.mouse.move(vp.l + vp.w * 0.19, vp.t + vp.h * 0.77, { steps: 5 });
await page.mouse.move(vp.l + vp.w * 0.27, vp.t + vp.h * 0.64, { steps: 5 });
await page.mouse.up();
await page.keyboard.up("Shift");
await wait(300);
const n = await selected();
expect(n > 10, `${n} items selected`);
await ctrl("g");
const groups = await page.evaluate(() => window.__crossprobe.project.board.groups);
expect(groups.length === 1 && groups[0].members.length === n, `one group of ${groups[0]?.members.length} members`);
let k = await kicadGroups("grouped");
const kg = k[groups[0].uuid];
expect(kg && kg.members.length === n && JSON.stringify(kg.members) === JSON.stringify([...groups[0].members].sort()), `pcbnew reads the group with its ${kg?.members.length} members`);

console.log("-- a click on R1 selects the whole group; a drag moves all of it");
await page.keyboard.press("Escape");
await wait(200);
const p0 = await r1();
await clickAt(p0);
expect((await selected()) === n, `${await selected()} selected by one click`);
await page.screenshot({ path: `${OUT}/group-selected.png` });
const before = await page.evaluate(() => window.__crossprobe.project.board.footprints.map((f) => [f.uuid, f.at.x, f.at.y]));
await dragBy(p0, { x: 5, y: 0 });
const after = await page.evaluate(() => window.__crossprobe.project.board.footprints.map((f) => [f.uuid, f.at.x, f.at.y]));
const members = new Set(groups[0].members);
const moved = after.filter((f, i) => f[1] !== before[i][1]);
// All by the same amount: about 5 mm (the drag snaps the first footprint onto the grid).
const dx = moved.map((f) => f[1] - before.find((b) => b[0] === f[0])[1]);
expect(moved.length >= 6 && moved.every((f) => members.has(f[0])) && dx.every((d) => Math.abs(d - dx[0]) < 1e-6 && Math.abs(d - 5) <= 0.25), `${moved.length} grouped footprints moved ${dx[0]?.toFixed(3)} mm, nothing else`);

console.log("-- L locks the group: a drag moves nothing");
await page.keyboard.press("l");
await idle();
await wait(400);
k = await kicadGroups("locked");
expect(k[groups[0].uuid]?.locked === true, "pcbnew reads the group locked");
const p1 = await r1();
await dragBy(p1, { x: 5, y: 0 });
expect((await r1()).at.x === p1.at.x, "locked: not moved");
await page.keyboard.press("l");
await idle();
await wait(300);

console.log("-- ungroup (Ctrl+Shift+G): a click picks one part again");
await clickAt(await r1());
await ctrl("g", true);
expect((await page.evaluate(() => window.__crossprobe.project.board.groups.length)) === 0, "no groups left");
k = await kicadGroups("ungrouped");
expect(Object.keys(k).length === 0, "pcbnew finds no groups");
await page.keyboard.press("Escape");
await wait(200);
await clickAt(await r1());
expect((await selected()) === 1, `${await selected()} selected by one click`);

console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

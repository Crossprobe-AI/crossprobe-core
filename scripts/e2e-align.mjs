// End-to-end, Align/Distribute: on pic_programmer's board a box selection is aligned to the top
// from the right-click menu, then distributed horizontally with even gaps. KiCad itself (pcbnew's
// bounding boxes of the saved board, footprints without their text, as its align tool takes them)
// finds the moved items' tops equal, then the gaps between them equal. Undo puts them back.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-align.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/align");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";
const DEMOS = process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos";
const BBOX = fileURLToPath(new globalThis.URL("../packages/kicad-model/test/pcbnew-bbox.py", import.meta.url));
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
/** Where each footprint, via, track and board text is. */
const positions = () =>
  page.evaluate(() => {
    const b = window.__crossprobe.project.board;
    return Object.fromEntries([...b.footprints, ...b.vias, ...b.texts.filter((t) => t.uuid)].map((f) => [f.uuid, [f.at.x, f.at.y]]).concat(b.tracks.map((t) => [t.uuid, [t.start.x, t.start.y]])));
  });
/** Right-click outside the board (the selection stays), then a menu entry under Align/Distribute. */
const arrange = async (label) => {
  const c = await at({ x: 0.03, y: 0.5 });
  await page.mouse.click(c.x, c.y, { button: "right" });
  await page.waitForSelector(".context-sub", { timeout: 3000 });
  await page.hover(".context-sub > button");
  await wait(150);
  await page.screenshot({ path: `${OUT}/menu.png` });
  const clicked = await page.evaluate((label) => {
    const b = [...document.querySelectorAll(".context-sub .context-menu button")].find((x) => x.textContent === label);
    b?.click();
    return !!b;
  }, label);
  expect(clicked, `menu: ${label}`);
  await idle();
  await wait(400);
};
/** KiCad's boxes of the saved board. */
const kicadBoxes = (name) => {
  const files = page.evaluate(() => window.__crossprobe.files());
  return files.then((files) => {
    // Only changed files are there: before any edit, the demo's own board.
    const pcb = Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))?.[1] ?? readFileSync(`${DEMOS}/pic_programmer/pic_programmer.kicad_pcb`, "utf8");
    writeFileSync(`${OUT}/${name}.kicad_pcb`, pcb);
    try {
      execFileSync(PY, [BBOX, `${OUT}/${name}.kicad_pcb`, `${OUT}/${name}.json`], { stdio: "ignore" });
    } catch {
      // pcbnew may crash on exit after writing its output.
    }
    const k = JSON.parse(readFileSync(`${OUT}/${name}.json`, "utf8"));
    return { ...k.footprints, ...k.vias, ...k.tracks, ...k.texts };
  });
};

await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await wait(300);

console.log("-- shift-drag a box around R1–R6 and D2–D7");
// From off the board: a press on an item would pick it instead.
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
const n = await page.evaluate(() => /(\d+) selected/.exec(document.body.textContent)?.[1]);
await page.screenshot({ path: `${OUT}/selected.png` });
expect(Number(n) >= 3, `${n} items selected`);
const before = await positions();
const k0 = await kicadBoxes("before");

console.log("-- Align to Top");
await arrange("Align to Top");
const aligned = await positions();
const moved = Object.keys(before).filter((u) => before[u][1] !== aligned[u][1] || before[u][0] !== aligned[u][0]);
expect(moved.length >= 3, `${moved.length} items moved`);
expect(moved.every((u) => k0[u]), `all of them footprints, vias, tracks or texts ${moved.filter((u) => !k0[u]).join(" ")}`);
expect(moved.every((u) => before[u][0] === aligned[u][0]), "only vertically");
await page.screenshot({ path: `${OUT}/aligned.png` });
let k = await kicadBoxes("aligned");
const kA = k;
const tops = new Set(moved.map((u) => k[u][1]));
expect(tops.size === 1, `KiCad finds one top for them: ${[...tops].join(", ")}`);

console.log("-- Distribute Horizontally with Even Gaps");
await arrange("Distribute Horizontally with Even Gaps");
k = await kicadBoxes("distributed");
// The selection: what moved, and the item that set the top (it stays).
const sel = Object.keys(k).filter((u) => kA[u][1] === [...tops][0] && (moved.includes(u) || k0[u][1] === [...tops][0]));
// In the order they had (left edges before distributing): with this many items the gaps overlap.
const spans = sel.sort((p, q) => kA[p][0] - kA[q][0]).map((u) => [k[u][0], k[u][2]]);
const gaps = spans.slice(1).map((s, i) => s[0] - spans[i][1]);
// KiCad rounds each position to the nanometre.
expect(gaps.length >= 2 && Math.max(...gaps) - Math.min(...gaps) <= 2, `KiCad finds even gaps: ${gaps.map((g) => (g / 1e6).toFixed(4)).join(", ")} mm`);
await page.screenshot({ path: `${OUT}/distributed.png` });

console.log("-- undo twice");
await page.keyboard.down("Meta");
await page.keyboard.press("z");
await page.keyboard.press("z");
await page.keyboard.up("Meta");
await idle();
await wait(400);
const undone = await positions();
expect(Object.keys(before).every((u) => before[u][0] === undone[u][0] && before[u][1] === undone[u][1]), "back where they were");

console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

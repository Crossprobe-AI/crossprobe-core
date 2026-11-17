// End-to-end, groups holding items the app doesn't model (#37): pic_programmer's board is served
// with a group of R1, R2 and a layer alignment target (KiCad's `target`, not modelled here), R1 also
// locked on its own. A click on R2 selects the group (its two footprints); a drag moves the target
// with them; a box around them picks the group, so Ctrl+Shift+G ungroups it. L locks the group, and
// L again unlocks it with R1's own lock.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-groups-unmodelled.mjs
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const DEMOS = process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos";
const R1 = "00000000-0000-0000-0000-00005a22ac23";
const R2 = "00000000-0000-0000-0000-00005a22ac39";
const TARGET = "7a26e5f1-0000-4000-8000-0000000000a1";
const GROUP = "7a26e5f1-0000-4000-8000-0000000000a2";

// The board, with R1 locked, a target between R1 and R2, and the group.
let text = readFileSync(`${DEMOS}/pic_programmer/pic_programmer.kicad_pcb`, "utf8");
const fpStart = text.lastIndexOf("(footprint ", text.indexOf(`"${R1}"`));
const nameEnd = text.indexOf("\n", fpStart);
text = text.slice(0, nameEnd) + "\n\t\t(locked yes)" + text.slice(nameEnd);
const end = text.lastIndexOf(")");
text =
  text.slice(0, end) +
  `\t(target plus (at 95 116.3) (size 1) (width 0.1) (layer "Edge.Cuts") (uuid "${TARGET}"))\n` +
  `\t(group "pair" (uuid "${GROUP}") (members "${R1}" "${R2}" "${TARGET}"))\n` +
  text.slice(end);

const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.setRequestInterception(true);
page.on("request", (req) => {
  if (req.url().includes("/__demos/file") && decodeURIComponent(req.url()).includes("pic_programmer.kicad_pcb")) req.respond({ status: 200, contentType: "text/plain", body: text });
  else req.continue();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = () => page.waitForFunction(() => !document.body.textContent.includes("Updating…"), { timeout: 60000 });
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
const screenOf = (p) =>
  page.evaluate((p) => {
    const v = window.__crossprobeBoardView;
    const o = v.toBoard(0, 0), ex = v.toBoard(100, 0), ey = v.toBoard(0, 100);
    const a = (ex.x - o.x) / 100, b = (ey.x - o.x) / 100, c = (ex.y - o.y) / 100, d = (ey.y - o.y) / 100;
    const det = a * d - b * c;
    const dx = p.x - o.x, dy = p.y - o.y;
    return { x: (d * dx - b * dy) / det, y: (-c * dx + a * dy) / det };
  }, p);
const selected = () => page.evaluate(() => Number(document.body.textContent.match(/(\d+) selected/)?.[1] ?? (document.body.textContent.includes("Nothing selected") ? 0 : 1)));
const board = () => page.evaluate(() => window.__crossprobe.project.board);
const targetAt = async () => {
  const files = await page.evaluate(() => window.__crossprobe.files());
  const pcb = Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))[1];
  const m = /\(target plus \(at ([\d.-]+) ([\d.-]+)\)/.exec(pcb);
  return { x: Number(m[1]), y: Number(m[2]) };
};
const pinOf = async (ref) => (await board()).footprints.find((f) => f.reference === ref).pads[0].at;
const clickAt = async (p) => {
  const s = await screenOf(p);
  await page.mouse.click(s.x, s.y);
  await wait(300);
};
const press = async (key) => {
  await page.keyboard.press(key);
  await idle();
  await wait(400);
};

await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await wait(300);
const g0 = (await board()).groups;
expect(g0.length === 1 && g0[0].members.length === 3, "the served board has the group of three");

console.log("-- a click on R2 selects the group; a drag moves the target too");
await clickAt(await pinOf("R2"));
expect((await selected()) === 2, `${await selected()} selected (R1 and R2)`);
const t0 = { x: 95, y: 116.3 };
const p = await pinOf("R2");
const a = await screenOf(p), b = await screenOf({ x: p.x + 5.08, y: p.y });
await page.mouse.move(a.x, a.y);
await page.mouse.down();
await page.mouse.move((a.x + b.x) / 2, a.y, { steps: 4 });
await page.mouse.move(b.x, b.y, { steps: 4 });
await page.mouse.up();
await idle();
await wait(500);
const t1 = await targetAt();
const r1Moved = (await board()).footprints.find((f) => f.reference === "R1").at.x !== 87.63;
expect(!r1Moved, "R1 (locked on its own) stays");
const dx = (await pinOf("R2")).x - p.x;
expect(Math.abs(dx) > 1 && Math.abs(t1.x - t0.x - dx) < 1e-6, `the target moved with R2 (${(t1.x - t0.x).toFixed(3)} mm, R2 ${dx.toFixed(3)} mm)`);

console.log("-- L locks the group; L again unlocks it and R1");
await page.keyboard.press("Escape");
await clickAt(await pinOf("R2"));
await press("l");
expect((await board()).groups[0].locked === true, "group locked");
await press("l");
const bd = await board();
expect(!bd.groups[0].locked && !bd.footprints.find((f) => f.reference === "R1").locked, "group and R1 unlocked");

console.log("-- a box around the group picks it; Ctrl+Shift+G ungroups");
await page.keyboard.press("Escape");
await wait(200);
const r1 = await pinOf("R1"), r2 = await pinOf("R2");
// From off the board's left edge (a press on a track would pick it), to well past both resistors.
// From the view's bottom-left corner, below the board (a press on an item would drag it).
const lo = await page.evaluate(() => { const r = document.querySelector(".viewport").getBoundingClientRect(); return { x: r.left + 12, y: r.bottom - 12 }; }), hi = await screenOf({ x: Math.max(r1.x, r2.x) + 30, y: Math.min(r1.y, r2.y) - 12 });
const j1 = (await board()).footprints.find((f) => f.reference === "J1").at;
await page.keyboard.down("Shift");
await page.mouse.move(lo.x, lo.y);
await page.mouse.down();
await page.mouse.move((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, { steps: 5 });
await page.mouse.move(hi.x, hi.y, { steps: 5 });
await page.mouse.up();
await page.keyboard.up("Shift");
await wait(300);
await page.screenshot({ path: process.env.SHOT ?? "/dev/null" });
expect((await selected()) >= 2, `${await selected()} selected by the box`);
const j1After = (await board()).footprints.find((f) => f.reference === "J1").at;
expect(j1After.x === j1.x && j1After.y === j1.y, "the box drag moved nothing");
await page.keyboard.down("Control");
await page.keyboard.down("Shift");
await page.keyboard.press("g");
await page.keyboard.up("Shift");
await page.keyboard.up("Control");
await idle();
await wait(400);
expect((await board()).groups.length === 0, "ungrouped");

await browser.close();
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
if (problems.length) process.exit(1);

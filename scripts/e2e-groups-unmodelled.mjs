// End-to-end, groups holding items the app doesn't model (#37, #50): pic_programmer's board is
// served with a group of R1, R2, a layer alignment target (KiCad's `target`, not modelled here) and
// a locked image, R1 also locked on its own, and a second group of R4 and a target.
// - A click on R2 selects the group (its two footprints); a drag moves the target with them, not
//   the locked image.
// - L locks the group, and L again unlocks it with R1's own lock.
// - R on R4's group turns its target about R4, as R4 turns.
// - Position Relative (Shift+P) and Align to Top move the target with its group, by the group's amount.
// - A box around the group picks it, so Ctrl+Shift+G ungroups it.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-groups-unmodelled.mjs
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const DEMOS = process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos";
const R1 = "00000000-0000-0000-0000-00005a22ac23";
const R2 = "00000000-0000-0000-0000-00005a22ac39";
const TARGET = "7a26e5f1-0000-4000-8000-0000000000a1";
const GROUP = "7a26e5f1-0000-4000-8000-0000000000a2";
const IMAGE = "7a26e5f1-0000-4000-8000-0000000000a3";
const R4 = "00000000-0000-0000-0000-00005a22ac65";
const TARGET2 = "7a26e5f1-0000-4000-8000-0000000000a4";
const GROUP2 = "7a26e5f1-0000-4000-8000-0000000000a5";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

// The board, with R1 locked, a target between R1 and R2, and the group.
let text = readFileSync(`${DEMOS}/pic_programmer/pic_programmer.kicad_pcb`, "utf8");
const fpStart = text.lastIndexOf("(footprint ", text.indexOf(`"${R1}"`));
const nameEnd = text.indexOf("\n", fpStart);
text = text.slice(0, nameEnd) + "\n\t\t(locked yes)" + text.slice(nameEnd);
const end = text.lastIndexOf(")");
text =
  text.slice(0, end) +
  `\t(target plus (at 95 116.3) (size 1) (width 0.1) (layer "Edge.Cuts") (uuid "${TARGET}"))\n` +
  `\t(image (at 92 121) (layer "F.SilkS") (locked yes) (uuid "${IMAGE}") (data "${PNG}"))\n` +
  `\t(target plus (at 96 106) (size 1) (width 0.1) (layer "Edge.Cuts") (uuid "${TARGET2}"))\n` +
  `\t(group "pair" (uuid "${GROUP}") (members "${R1}" "${R2}" "${TARGET}" "${IMAGE}"))\n` +
  `\t(group "one" (uuid "${GROUP2}") (members "${R4}" "${TARGET2}"))\n` +
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
/** Where an item the app doesn't model is in the board file (its `at`). */
const posOf = async (uuid) => {
  const files = await page.evaluate(() => window.__crossprobe.files());
  const pcb = Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))?.[1] ?? text;
  const i = pcb.indexOf(`"${uuid}"`);
  const from = Math.max(pcb.lastIndexOf("(target", i), pcb.lastIndexOf("(image", i));
  const m = /\(at ([\d.-]+) ([\d.-]+)\)/.exec(pcb.slice(from, i));
  return { x: Number(m[1]), y: Number(m[2]) };
};
const near = (p, q) => Math.abs(p.x - q.x) < 1e-4 && Math.abs(p.y - q.y) < 1e-4;
const fpAt = async (uuid) => (await board()).footprints.find((f) => f.uuid === uuid).at;
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
expect(g0.length === 2 && g0.find((g) => g.uuid === GROUP).members.length === 4, "the served board has its two groups");

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
expect(near(await posOf(IMAGE), { x: 92, y: 121 }), "the locked image stayed");

console.log("-- L locks the group; L again unlocks it and R1");
await page.keyboard.press("Escape");
await clickAt(await pinOf("R2"));
await press("l");
expect((await board()).groups[0].locked === true, "group locked");
await press("l");
const bd = await board();
expect(!bd.groups[0].locked && !bd.footprints.find((f) => f.reference === "R1").locked, "group and R1 unlocked");

console.log("-- R on a group of one footprint and a target: the target turns about the footprint");
await page.keyboard.press("Escape");
await clickAt(await pinOf("R4"));
expect((await selected()) === 1, `${await selected()} selected (R4)`);
const c4 = await fpAt(R4), q0 = await posOf(TARGET2);
await press("r");
const q1 = await posOf(TARGET2), c4b = await fpAt(R4);
// KiCad's +90° about c: (x, y) goes to (cx + y - cy, cy - x + cx). The centre R4 turned about:
const cx = (c4b.x - c4.y + c4b.y + c4.x) / 2, cy = (c4b.y + c4.x - c4b.x + c4.y) / 2;
const want = { x: cx + q0.y - cy, y: cy - q0.x + cx };
expect(!near(c4b, c4) && near(q1, want), `target at (${q1.x}, ${q1.y}), turned with R4 about (${cx.toFixed(3)}, ${cy.toFixed(3)}): (${want.x.toFixed(3)}, ${want.y.toFixed(3)})`);

console.log("-- Position Relative moves the target with its group");
await page.keyboard.press("Escape");
await clickAt(await pinOf("R2"));
const r2a = await fpAt(R2), ta = await posOf(TARGET);
await page.keyboard.down("Shift");
await page.keyboard.press("P");
await page.keyboard.up("Shift");
await page.waitForSelector(".position-relative", { timeout: 3000 });
await page.evaluate(() => [...document.querySelectorAll(".position-relative button")].find((b) => b.textContent.includes("Grid origin")).click());
const setField = (label, v) =>
  page.evaluate((label, v) => {
    const l = [...document.querySelectorAll(".position-relative label")].find((x) => x.textContent.includes(label));
    const i = l.querySelector("input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, String(v));
    i.dispatchEvent(new Event("input", { bubbles: true }));
    i.dispatchEvent(new Event("change", { bubbles: true }));
  }, label, v);
await setField("Offset X", 120);
await setField("Offset Y", 100);
await wait(100);
await page.evaluate(() => [...document.querySelectorAll(".position-relative button")].find((b) => b.textContent.trim() === "Move").click());
await idle();
await wait(400);
const r2b = await fpAt(R2), tb = await posOf(TARGET);
const d1 = { x: r2b.x - r2a.x, y: r2b.y - r2a.y };
expect(Math.hypot(d1.x, d1.y) > 1 && near({ x: tb.x - ta.x, y: tb.y - ta.y }, d1), `target moved by the group's (${d1.x.toFixed(3)}, ${d1.y.toFixed(3)})`);
expect(near(await posOf(IMAGE), { x: 92, y: 121 }), "the locked image stayed");

console.log("-- Align to Top: the group moves as one, its target with it");
const r1c = await fpAt(R1), r2c = await fpAt(R2), tc = await posOf(TARGET), r4c = await fpAt(R4), t2c = await posOf(TARGET2);
await page.keyboard.down("Shift");
await clickAt(await pinOf("R4"));
await page.keyboard.up("Shift");
expect((await selected()) === 3, `${await selected()} selected (the group and R4)`);
const v = await page.evaluate(() => { const r = document.querySelector(".viewport").getBoundingClientRect(); return { x: r.left + 12, y: r.bottom - 12 }; });
await page.mouse.click(v.x, v.y, { button: "right" });
await page.waitForSelector(".context-sub", { timeout: 3000 });
await page.hover(".context-sub > button");
await wait(150);
expect(await page.evaluate(() => { const b = [...document.querySelectorAll(".context-sub .context-menu button")].find((x) => x.textContent === "Align to Top"); b?.click(); return !!b; }), "menu: Align to Top");
await idle();
await wait(400);
const r1d = await fpAt(R1), r2d = await fpAt(R2), td = await posOf(TARGET), r4d = await fpAt(R4), t2d = await posOf(TARGET2);
const d2 = { x: r2d.x - r2c.x, y: r2d.y - r2c.y }, d3 = { x: r4d.x - r4c.x, y: r4d.y - r4c.y };
expect(near({ x: r1d.x - r1c.x, y: r1d.y - r1c.y }, d2) && near({ x: td.x - tc.x, y: td.y - tc.y }, d2), `R1, R2 and their target together (${d2.x.toFixed(3)}, ${d2.y.toFixed(3)})`);
expect(near({ x: t2d.x - t2c.x, y: t2d.y - t2c.y }, d3), `R4 and its target together (${d3.x.toFixed(3)}, ${d3.y.toFixed(3)})`);
expect(Math.abs(d2.y) + Math.abs(d3.y) > 0.1 && !d2.x && !d3.x, "one group moved up to the other's top");

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

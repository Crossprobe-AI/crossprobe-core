// End-to-end, PCB edit mode: a click selects and changes nothing; a drag moves.
// StickHub's J2 sits off the edit grid, so a drag snaps it on. A press and release in
// one spot used to count as such a drag and moved the footprint.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-click.mjs
import puppeteer from "puppeteer-core";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
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
const REF = "J2";
const PAD = "3";
const state = () =>
  page.evaluate((ref) => {
    const { project, dirty, selection } = window.__crossprobe;
    const f = project.board.footprints.find((f) => f.reference === ref);
    return { at: `${f.at.x},${f.at.y}`, dirty: dirty.length, drc: project.drc?.length ?? 0, selected: selection?.reference ?? null };
  }, REF);

const demo = "?demo=stickhub/StickHub.kicad_pro&view=board";
await page.goto(URL + demo, { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.waitForFunction(() => window.__crossprobe?.project?.board, { timeout: 60000 });
const pad = await page.evaluate(
  ([ref, number]) => {
    const p = window.__crossprobe.project.board.footprints.find((f) => f.reference === ref).pads.find((p) => p.number === number);
    return { x: p.at.x, y: p.at.y };
  },
  [REF, PAD],
);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
// Frame a small box around the pad and find the pad on the screen.
await page.evaluate((p) => window.__boardView.frame({ x: p.x - 4, y: p.y - 3, w: 8, h: 6 }), pad);
await wait(500);
const mid = await page.evaluate((p) => window.__boardView.toClient(p), pad);
const before = await state();

console.log("-- a click on a pad");
await page.mouse.move(mid.x, mid.y);
await page.mouse.down();
await wait(80);
await page.mouse.up();
await wait(400);
await idle();
const clicked = await state();
expect(clicked.selected === REF, `selects ${REF} (${clicked.selected})`);
expect(clicked.at === before.at, `${REF} stays at ${before.at} (${clicked.at})`);
expect(clicked.dirty === 0, `nothing to save (${clicked.dirty} unsaved)`);
expect(clicked.drc === before.drc, `DRC count unchanged (${before.drc} → ${clicked.drc})`);

console.log("-- a press that wobbles by a pixel");
await page.mouse.move(mid.x, mid.y);
await page.mouse.down();
await page.mouse.move(mid.x + 1, mid.y + 1);
await page.mouse.up();
await wait(400);
await idle();
const wobbled = await state();
expect(wobbled.at === before.at && wobbled.dirty === 0, `still nothing moved (${wobbled.at}, ${wobbled.dirty} unsaved)`);

console.log("-- a drag");
await page.mouse.move(mid.x, mid.y);
await page.mouse.down();
await page.mouse.move(mid.x + 60, mid.y + 40, { steps: 8 });
await page.mouse.up();
await wait(400);
await idle();
const dragged = await state();
expect(dragged.at !== before.at && dragged.dirty === 1, `moves ${REF} to ${dragged.at}, 1 unsaved (${dragged.dirty})`);

await browser.close();
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
process.exit(problems.length ? 1 : 0);

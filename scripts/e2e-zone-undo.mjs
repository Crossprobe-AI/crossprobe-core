// End-to-end, PCB edit mode: undo and redo around a zone refill.
// Undoing a refill brings back the fill from before it, in the model and on the canvas,
// and the "zones are out of date" notice follows the history both ways.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-zone-undo.mjs
import puppeteer from "puppeteer-core";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = async () => {
  await wait(300);
  await page.waitForFunction(() => !document.body.textContent.includes("Updating…"), { timeout: 120000 });
  await wait(500);
};
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
/** The fills (a hash of their points), what the canvas shows, and the notice. */
const state = () =>
  page.evaluate(() => {
    const hash = (text, step) => {
      let h = 0;
      for (let i = 0; i < text.length; i += step) h = (h * 31 + text.charCodeAt(i)) | 0;
      return h;
    };
    const board = window.__crossprobe.project.board;
    return {
      fills: hash(JSON.stringify(board.zones.map((z) => z.fills)), 1),
      canvas: [...document.querySelectorAll("canvas")].map((c) => hash(c.toDataURL(), 7)).join("/"),
      tracks: board.tracks.length,
      stale: document.body.textContent.includes("Copper zones are out of date"),
    };
  });
const key = async (k, ...mods) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(k);
  for (const m of mods.reverse()) await page.keyboard.up(m);
  await idle();
  return state();
};

await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro&view=board", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.__crossprobe?.project?.board, { timeout: 60000 });
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await page.mouse.move(5, 5);
await idle();
const opened = await state();

console.log("-- delete a track, then refill");
await page.evaluate(() => {
  const { project, edit } = window.__crossprobe;
  const poured = new Set(project.board.zones.map((z) => z.net));
  edit([{ op: "boardDelete", file: project.boardFile, uuids: [project.board.tracks.find((t) => !poured.has(t.net)).uuid] }]);
});
await idle();
const deleted = await state();
expect(deleted.tracks === opened.tracks - 1 && deleted.fills === opened.fills && deleted.stale, "one track fewer, the old fill, and the notice that zones are out of date");
const refilled = await key("b");
expect(refilled.fills !== deleted.fills && refilled.canvas !== deleted.canvas && !refilled.stale, "a new fill, drawn, and no notice");

console.log("-- undo, twice");
const undone = await key("z", "Meta");
expect(undone.fills === deleted.fills, "the fill from before the refill is back");
expect(undone.canvas === deleted.canvas, "and the board is drawn as it was then");
expect(undone.stale, "the zones are out of date again");
const start = await key("z", "Meta");
expect(start.tracks === opened.tracks && start.fills === opened.fills && start.canvas === opened.canvas && !start.stale, "the track is back and nothing is out of date");

console.log("-- redo, twice");
await key("z", "Meta", "Shift");
const again = await key("z", "Meta", "Shift");
expect(again.fills === refilled.fills && again.canvas === refilled.canvas && !again.stale, "the refill is back");

await browser.close();
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
process.exit(problems.length ? 1 : 0);

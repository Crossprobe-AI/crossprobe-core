// End-to-end, text boxes: on pic_programmer's board the text box tool draws a 30 × 12 mm box (two
// clicks, then the text). KiCad's pcbnew reads the saved box back: its corners, and its text wrapped
// to the box exactly as ours (KiCad's GetShownText against our textBoxText). R turns it a quarter,
// and the properties panel changes its text: pcbnew reads both. Undo removes it.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-textbox.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/textbox");
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
const { parseBoard, textBoxText } = await import(new globalThis.URL("../packages/kicad-model/dist/index.js", import.meta.url).href);
const TEXT = "Programming header: connect the ICSP cable here, pin 1 at the square pad";
let answer = TEXT;
page.on("dialog", (d) => d.accept(answer));
/** The saved board's text boxes as KiCad's pcbnew reads them. */
const kicadBoxes = async (name) => {
  const files = await page.evaluate(() => window.__crossprobe.files());
  const text = Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))[1];
  writeFileSync(`${OUT}/${name}.kicad_pcb`, text);
  const py = `import pcbnew, json, sys
b = pcbnew.LoadBoard(sys.argv[1])
out = []
for d in b.GetDrawings():
    if d.Type() == pcbnew.PCB_TEXTBOX_T:
        out.append({"uuid": d.m_Uuid.AsString(), "text": d.GetText(), "shown": d.GetShownText(True), "angle": d.GetTextAngle().AsDegrees(),
                    "corners": [[c.x / 1e6, c.y / 1e6] for c in d.GetCorners()]})
open(sys.argv[2], "w").write(json.dumps(out))`;
  writeFileSync(`${OUT}/boxes.py`, py);
  try {
    execFileSync(PY, [`${OUT}/boxes.py`, `${OUT}/${name}.kicad_pcb`, `${OUT}/${name}.json`], { stdio: "ignore" });
  } catch {
    // pcbnew may crash on exit after writing its output.
  }
  return { kicad: JSON.parse(readFileSync(`${OUT}/${name}.json`, "utf8")), ours: parseBoard(text).textBoxes };
};
const clickAt = async (p) => {
  const s = await screenOf(p);
  await page.mouse.move(s.x, s.y);
  await page.mouse.click(s.x, s.y);
  await wait(300);
};

await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await wait(300);

console.log("-- the text box tool: two corners, then the text");
await page.evaluate(() => document.querySelector('button[title^="Text box"]').click());
await wait(200);
await clickAt({ x: 150, y: 140 });
await clickAt({ x: 180, y: 152 });
await idle();
await wait(500);
await page.screenshot({ path: `${OUT}/drawn.png` });
let { kicad, ours } = await kicadBoxes("drawn");
expect(ours.length === 1 && kicad.length === 1, `one text box (ours ${ours.length}, pcbnew ${kicad.length})`);
const box = ours[0];
const shown = textBoxText(box).text;
expect(kicad[0].text === TEXT, "pcbnew reads its text");
expect(kicad[0].shown === shown, `wrapped as KiCad wraps it: ${JSON.stringify(shown)} / pcbnew ${JSON.stringify(kicad[0].shown)}`);
const key = (pts) => pts.map((p) => `${(+p[0]).toFixed(4)},${(+p[1]).toFixed(4)}`).sort().join(" ");
// Where the clicks landed on the 0.25 mm grid: pcbnew has our corners, about 30 × 12 mm from 150, 140.
expect(key(kicad[0].corners) === key(box.corners.map((p) => [p.x, p.y])), `pcbnew's corners ${key(kicad[0].corners)} are ours`);
expect(box.corners.every((p, i) => Math.abs(p.x - [150, 180, 180, 150][i]) <= 0.25 && Math.abs(p.y - [140, 140, 152, 152][i]) <= 0.25), "about where clicked");

console.log("-- select it, R turns it a quarter");
await page.evaluate(() => document.querySelector('button[title^="Select"]')?.click());
await page.keyboard.press("Escape");
await wait(200);
await clickAt({ x: 165, y: 146 });
await page.keyboard.press("r");
await idle();
await wait(400);
({ kicad } = await kicadBoxes("turned"));
expect(Math.round(kicad[0].angle) === 90, `pcbnew reads it at ${kicad[0].angle}°`);

console.log("-- a new text from the properties panel");
const ok = await page.evaluate(() => {
  const l = [...document.querySelectorAll("label.prop")].find((x) => x.querySelector("span")?.textContent === "Text");
  const i = l?.querySelector("input, textarea");
  if (!i) return false;
  i.focus();
  i.select();
  return true;
});
expect(ok, "text field");
await page.keyboard.type("ICSP");
await page.keyboard.press("Enter");
await idle();
await wait(400);

({ kicad } = await kicadBoxes("edited"));
expect(kicad[0]?.text === "ICSP", `pcbnew reads "${kicad[0]?.text}"`);

console.log("-- undo three times");
await page.keyboard.down("Meta");
for (let n = 0; n < 3; n++) await page.keyboard.press("z");
await page.keyboard.up("Meta");
await idle();
await wait(400);
expect((await page.evaluate(() => window.__crossprobe.project.board.textBoxes.length)) === 0, "no text box left");

console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

// End-to-end, a part's fields on the sheet. On KiCad's pic_programmer demo, R1's value is dragged
// away from the part, turned (R) and double-clicked to change it; then the part itself is dragged
// and its fields go with it. KiCad reads the saved sheet (`sch upgrade`) with the field where it
// was put.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-field-move.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/field-move");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const DEMOS = process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("dialog", (d) => d.accept(globalThis.nextPrompt ?? ""));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = () => page.waitForFunction(() => !document.body.textContent.includes("Updating…"), { timeout: 60000 });
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
/** Where an item is on screen (its centre) and on the sheet (its box). */
const item = (kind, ref, field) =>
  page.evaluate(
    (kind, ref, field) => {
      const it = window.__crossprobe.sheet.items.find((i) => i.kind === kind && i.ref === ref && (!field || i.field === field));
      // Aim at what is drawn (the text itself, for a field).
      const r = document.querySelector(`g.i-${kind}[data-uuid="${CSS.escape(it.uuid)}"] ${kind === "field" ? "text" : "path"}`).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, bbox: it.bbox, text: it.prims[0]?.text, angle: it.prims[0]?.angle };
    },
    kind,
    ref,
    field,
  );
/** Drag from a screen point by a distance in sheet mm. */
const drag = async (from, dx, dy) => {
  const scale = await page.evaluate(() => {
    const a = window.__schematicView.toClient({ x: 0, y: 0 });
    const b = window.__schematicView.toClient({ x: 10, y: 0 });
    return (b.x - a.x) / 10;
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (dx * scale) / 2, from.y + (dy * scale) / 2, { steps: 4 });
  await page.mouse.move(from.x + dx * scale, from.y + dy * scale, { steps: 4 });
  await page.mouse.up();
  await idle();
  await wait(400);
};
/** The field's (at x y angle) in the saved file. */
const fieldAt = (text, ref, name) => {
  const sym = text.split(/\n\t\(symbol\n/).find((b) => new RegExp(`\\(property "Reference" "${ref}"`).test(b));
  const m = new RegExp(`\\(property "${name}" "([^"]*)"\\s+\\(at ([-\\d.]+) ([-\\d.]+) ([-\\d.]+)\\)`).exec(sym);
  return { value: m[1], x: Number(m[2]), y: Number(m[3]), angle: Number(m[4]) };
};

await page.goto(`${URL}?demo=pic_programmer/pic_programmer.kicad_pro`, { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await wait(800);
await page.keyboard.press("e");
await wait(300);
const original = fieldAt(readFileSync(`${DEMOS}/pic_programmer/pic_programmer.kicad_sch`, "utf8"), "R1", "Value");

console.log("-- drag R1's value, turn it, change it");
let v = await item("field", "R1", "Value");
const symbolBefore = await item("symbol", "R1");
await drag(v, 2.54, 10.16);
let now = await item("field", "R1", "Value");
expect(Math.abs(now.bbox.x - v.bbox.x - 2.54) < 0.01 && Math.abs(now.bbox.y - v.bbox.y - 10.16) < 0.01, `the value moved by 2.54, 10.16 (${(now.bbox.x - v.bbox.x).toFixed(2)}, ${(now.bbox.y - v.bbox.y).toFixed(2)})`);
expect((await item("symbol", "R1")).bbox.x === symbolBefore.bbox.x, "the part stayed");
const angle = now.angle;
await page.keyboard.press("r");
await idle();
await wait(400);
now = await item("field", "R1", "Value");
expect(now.angle !== angle, `R turned it (${angle}° → ${now.angle}°)`);
globalThis.nextPrompt = "22K";
await page.mouse.click(now.x, now.y, { count: 2 });
await idle();
await wait(400);
now = await item("field", "R1", "Value");
expect(now.text === "22K", `double-click changed it to ${now.text}`);
expect((await page.evaluate(() => window.__crossprobe.project.components.find((c) => c.reference === "R1").value)) === "22K", "the part's value is 22K");

console.log("-- drag the part: its fields go along");
await page.keyboard.press("Escape");
const s = await item("symbol", "R1");
await drag(s, 0, 12.7);
const moved = await item("field", "R1", "Value");
expect(Math.abs(moved.bbox.y - now.bbox.y - 12.7) < 0.01, `the value followed the part (${(moved.bbox.y - now.bbox.y).toFixed(2)} mm down)`);
await page.screenshot({ path: `${OUT}/moved.png` });

const dir = `${OUT}/pic_programmer`;
cpSync(`${DEMOS}/pic_programmer`, dir, { recursive: true });
const files = await page.evaluate(() => window.__crossprobe.files());
for (const [k, t] of Object.entries(files)) writeFileSync(`${dir}/${k.split("/").pop()}`, t);
const ours = fieldAt(readFileSync(`${dir}/pic_programmer.kicad_sch`, "utf8"), "R1", "Value");
expect(ours.value === "22K" && Math.abs(ours.x - original.x - 2.54) < 1e-6 && Math.abs(ours.y - original.y - 22.86) < 1e-6 && ours.angle !== original.angle, `the file has it at ${ours.x}, ${ours.y}, ${ours.angle}° (was ${original.x}, ${original.y}, ${original.angle}°)`);
execFileSync("kicad-cli", ["sch", "upgrade", "--force", `${dir}/pic_programmer.kicad_sch`], { stdio: "ignore" });
const theirs = fieldAt(readFileSync(`${dir}/pic_programmer.kicad_sch`, "utf8"), "R1", "Value");
expect(JSON.stringify(theirs) === JSON.stringify(ours), "KiCad reads and writes the field back where it was put");
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

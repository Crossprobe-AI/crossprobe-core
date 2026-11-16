// End-to-end, blind/buried and micro vias: a new four-layer board, the via tool with
// "Microvias" chosen places a microvia from F.Cu to In1.Cu, and "Blind/buried" on In1.Cu one to
// In2.Cu. The saved board reads in KiCad (kicad-cli's drill export makes their span files),
// and the fab zip carries the same drill files. (Their contents are checked in via-types.test.ts.)
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-vias.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/vias");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
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
/** Click in the board view, `p` as fractions of its width and height. */
const clickBrd = async (p) => {
  const c = await page.evaluate((p) => {
    const r = document.querySelector(".viewport").getBoundingClientRect();
    return { x: r.left + r.width * p.x, y: r.top + r.height * p.y };
  }, p);
  await page.mouse.move(c.x, c.y);
  await page.mouse.click(c.x, c.y);
  await wait(200);
};
const choose = (title, value) =>
  page.evaluate(
    (title, value) => {
      const s = [...document.querySelectorAll("select")].find((x) => x.title.startsWith(title));
      if (!s) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, value);
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    title,
    value,
  );

console.log("-- a new four-layer board");
await page.goto(URL, { waitUntil: "networkidle0" });
await page.type('input[aria-label="Project name"]', "vias");
await page.click(".new-project button");
await page.waitForSelector(".viewport.schematic svg", { timeout: 20000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await page.evaluate(() => window.__crossprobe.edit([{ op: "setCopperLayers", file: window.__crossprobe.project.boardFile, count: 4 }]));
await idle();
await wait(400);

console.log("-- via tool: a microvia on F.Cu, a blind/buried via on In1.Cu");
await page.keyboard.press("v");
await wait(200);
expect(await choose("Vias placed", "micro"), "via type menu");
await clickBrd({ x: 0.45, y: 0.5 });
await idle();
expect(await choose("Active layer", "In1.Cu").catch(() => false) || (await page.evaluate(() => { const s = [...document.querySelectorAll("select")].find((x) => [...x.options].some((o) => o.value === "In1.Cu")); if (!s) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "In1.Cu"); s.dispatchEvent(new Event("change", { bubbles: true })); return true; })), "layer In1.Cu");
await choose("Vias placed", "blind");
await clickBrd({ x: 0.55, y: 0.5 });
await idle();
await wait(300);
const vias = await page.evaluate(() => window.__crossprobe.project.board.vias.map((v) => `${v.type ?? "through"} ${v.layers.join("-")}`));
expect(vias.join("; ") === "micro F.Cu-In1.Cu; buried In1.Cu-In2.Cu", `vias: ${vias.join("; ")}`);
await page.screenshot({ path: `${OUT}/vias.png` });

const files = await page.evaluate(() => window.__crossprobe.files());
for (const [k, v] of Object.entries(files)) writeFileSync(`${OUT}/${k.split("/").pop()}`, v);
const pcb = Object.keys(files).find((f) => f.endsWith(".kicad_pcb")).split("/").pop();
mkdirSync(`${OUT}/drl`);
execFileSync("kicad-cli", ["pcb", "export", "drill", "--excellon-separate-th", "-o", `${OUT}/drl/`, `${OUT}/${pcb}`], { stdio: "pipe" });
const kicad = readdirSync(`${OUT}/drl`).filter((f) => !f.endsWith("NPTH.drl")).sort();
// The model's own drill files, from this checkout's source (the dev server serves it under /@fs).
const MODEL_SRC = fileURLToPath(new URL("../packages/kicad-model/src/index.ts", import.meta.url));
const ours = await page.evaluate(async (src) => {
  const m = await import("/@fs" + src).catch(() => null);
  return m ? Object.keys(m.fabricationFiles(window.__crossprobe.project.board, { name: "vias" })).filter((f) => f.endsWith(".drl")).sort() : null;
}, MODEL_SRC);
expect(kicad.includes("vias-front-in1.drl") && kicad.includes("vias-in1-in2.drl"), `KiCad's drill files: ${kicad.join(" ")}`);
if (ours) expect(JSON.stringify(ours) === JSON.stringify(kicad), `ours: ${ours.join(" ")}`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

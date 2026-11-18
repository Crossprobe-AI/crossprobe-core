// End-to-end, the footprint editor's mirror, renumber, custom pads and 3D model, on a copy of
// pic_programmer's R1 footprint (Edit footprint): a custom-shaped pad drawn as a polygon, both
// pads mirrored left to right, renumbered in reverse with a prefix, and a 3D model offset. KiCad
// (pcbnew's FootprintLoad) reads the saved footprint back with all of it.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-footprint-more.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/footprint-more");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const PY = process.env.KICAD_PYTHON ?? "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3";
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
const fpView = (p) =>
  page.evaluate((p) => {
    const g = document.querySelector(".fpe-canvas svg > g");
    const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(g.getAttribute("transform"));
    const r = document.querySelector(".fpe-canvas").getBoundingClientRect();
    return { x: r.left + Number(m[1]) + p.x * Number(m[3]), y: r.top + Number(m[2]) + p.y * Number(m[3]) };
  }, p);
const clickAt = async (c, count = 1) => {
  await page.mouse.move(c.x, c.y);
  await page.mouse.click(c.x, c.y, { count });
  await wait(150);
};
const tool = (label) => page.evaluate((label) => [...document.querySelectorAll(".fpe-tools button")].find((b) => b.textContent === label)?.click(), label);
async function sideField(label, value) {
  const el = await page.evaluateHandle((label) => [...document.querySelectorAll(".fpe-side label.prop")].find((l) => l.querySelector("span")?.textContent === label)?.querySelector("input"), label);
  if (!el.asElement()) return expect(false, `field ${label}`);
  await el.asElement().click();
  await el.evaluate((e) => e.select());
  await el.asElement().type(String(value));
  await page.keyboard.press("Enter");
  await idle();
  await wait(150);
}

console.log("-- R1's footprint in the editor");
await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await page.keyboard.press("e");
await page.evaluate(() => [...document.querySelectorAll(".tabs [role=tab]")].find((b) => b.textContent.includes("Parts"))?.click());
await wait(200);
await page.evaluate(() => [...document.querySelectorAll(".inspector .item")].find((b) => b.textContent.trim().startsWith("R1"))?.click());
await wait(300);
await page.evaluate(() => [...document.querySelectorAll(".inspector button.link")].find((b) => b.textContent === "Edit footprint")?.click());
await page.waitForSelector(".fp-editor", { timeout: 10000 });
await wait(400);
const file = await page.evaluate(() => document.querySelector(".fp-editor .update-head .muted")?.textContent);
const lib = () => page.evaluate((f) => window.__crossprobe.project.projectFootprints.find((x) => x.file === f)?.text, file);
const pads = async () => (await lib()).match(/\(pad "[^"]*" \w+ \w+/g) ?? [];
console.log(`  ${file}: ${(await pads()).join(" | ")}`);

console.log("-- a custom pad, drawn as a polygon");
await tool("Custom pad");
for (const p of [{ x: 4, y: -2 }, { x: 6, y: -2 }, { x: 6, y: -1 }, { x: 5, y: -0.5 }]) await clickAt(await fpView(p));
await page.keyboard.press("Enter");
await idle();
await wait(300);
expect((await pads()).some((p) => p.endsWith(" custom")), `pads now: ${(await pads()).join(" | ")}`);

console.log("-- select everything, mirror, renumber backwards");
await tool("Select");
await page.keyboard.down("Shift");
const all = await page.evaluate(() => window.__crossprobe.project.projectFootprints.length);
void all;
const padsAt = await page.evaluate((f) => {
  const t = window.__crossprobe.project.projectFootprints.find((x) => x.file === f).text;
  return [...t.matchAll(/\(pad "[^"]*"[\s\S]*?\(at ([-\d.]+) ([-\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
}, file);
for (const p of padsAt) await clickAt(await fpView(p));
await page.keyboard.up("Shift");
const xsBefore = padsAt.map((p) => p.x);
await page.evaluate(() => [...document.querySelectorAll(".fpe-mirror button")].find((b) => b.textContent.startsWith("Mirror ↔"))?.click());
await idle();
await wait(300);
const after = await page.evaluate((f) => {
  const t = window.__crossprobe.project.projectFootprints.find((x) => x.file === f).text;
  return [...t.matchAll(/\(pad "[^"]*"[\s\S]*?\(at ([-\d.]+) ([-\d.]+)/g)].map((m) => Number(m[1]));
}, file);
const mid = (Math.min(...xsBefore) + Math.max(...xsBefore)) / 2;
expect(after.every((x, i) => Math.abs(x - (2 * mid - xsBefore[i])) < 0.001), `mirrored: x ${xsBefore.join(",")} → ${after.join(",")}`);
await page.keyboard.press("Escape");
await tool("Renumber");
await sideField("Prefix", "P");
// Each click waits for its renumbering, and comes after the double-click time: pads a few pixels apart,
// clicked quickly, may count as one double click (the distance allowed differs by platform).
for (const p of [...padsAt].reverse()) {
  const was = (await pads()).join();
  await clickAt(await fpView({ x: 2 * mid - p.x, y: p.y }));
  for (let t = 0; t < 40 && (await pads()).join() === was; t++) await wait(100);
  await wait(600);
}
const nums = (await pads()).map((p) => /"([^"]*)"/.exec(p)[1]);
expect(nums.join() === ["P3", "P2", "P1"].slice(3 - nums.length).join(), `numbers: ${nums.join(" ")}`);
await page.keyboard.press("Escape");
await tool("Select");
await page.keyboard.press("Escape");
await wait(100);
await sideField("3D model", "${KICAD10_3DMODEL_DIR}/Resistor_THT.3dshapes/R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal.wrl");
await sideField("Offset Z", "0.5");
await page.screenshot({ path: `${OUT}/editor.png` });

console.log("-- KiCad reads it back");
const text = await lib();
const dir = `${OUT}/lib.pretty`;
mkdirSync(dir, { recursive: true });
const name = file.split("/").pop().replace(".kicad_mod", "");
writeFileSync(`${dir}/${name}.kicad_mod`, text);
const script = `
import sys, json, pcbnew
fp = pcbnew.FootprintLoad(sys.argv[1], sys.argv[2])
b = pcbnew.BOARD(); b.Add(fp)
out = {"pads": sorted([[p.GetNumber(), int(p.GetShape(pcbnew.PADSTACK.ALL_LAYERS)), round(p.GetEffectivePolygon(pcbnew.F_Cu, pcbnew.ERROR_INSIDE).Area() / 1e12, 3)] for p in fp.Pads()]),
       "models": [[m.m_Filename, m.m_Offset.z] for m in fp.Models()]}
open(sys.argv[3], "w").write(json.dumps(out))
`;
spawnSync(PY, ["-c", script, dir, name, `${OUT}/kicad.json`], { stdio: "ignore" });
const k = JSON.parse(readFileSync(`${OUT}/kicad.json`, "utf8"));
console.log(`  KiCad: ${JSON.stringify(k)}`);
expect(k.pads.some((p) => p[1] === 6 /* PAD_SHAPE_CUSTOM */ && p[2] > 1.5), "the custom pad, with its drawn area");
expect(k.pads.map((p) => p[0]).sort().join() === nums.slice().sort().join(), "the new numbers");
expect(k.models.length === 1 && k.models[0][1] === 0.5, "the 3D model, offset");
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

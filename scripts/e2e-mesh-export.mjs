// End-to-end, mesh exports: pic_programmer's 3D view exports the board and its parts as a GLB,
// VRML-only models included. Against kicad-cli's GLB export (--subst-models, so both use a STEP
// model where there is one), every part is there and sits in the same box, and so does the whole
// board, to 0.05 mm. The STL and PLY exports hold the same geometry: their whole box is KiCad's
// STL / PLY box (mm, Z up), the STL encloses KiCad's volume (to 1%: every face points outwards),
// and the PLY has a colour per vertex.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-mesh-export.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseBoard } from "@crossprobe/kicad-model";
import { glbBoxes } from "./lib/glb.mjs";
import { plyBox, stlBox } from "./lib/mesh.mjs";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/mesh-export");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const PCB = `${process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos"}/pic_programmer/pic_programmer.kicad_pcb`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("3D")).click());
await page.waitForSelector(".board3d .view-tools", { timeout: 20000 });
async function download(fmt) {
  await page.evaluate((fmt) => [...document.querySelectorAll(".board3d .view-tools button")].find((b) => b.textContent.trim() === fmt).click(), fmt);
  let f;
  for (let i = 0; i < 400 && !f; i++) {
    await wait(300);
    f = readdirSync(OUT).find((x) => x.endsWith(`.${fmt.toLowerCase()}`) && !x.startsWith("kicad"));
  }
  await wait(1000);
  const note = await page.evaluate(() => document.querySelector(".step-note")?.textContent);
  expect(!!f, `downloaded ${f}; ${note}`);
  return f;
}
const file = await download("GLB");
const stl = await download("STL");
const ply = await download("PLY");
const off = (a, b) => Math.max(...[0, 1, 2].flatMap((i) => [Math.abs(a.min[i] - b.min[i]), Math.abs(a.max[i] - b.max[i])]));
await browser.close();
if (file) {
  execFileSync("kicad-cli", ["pcb", "export", "glb", "--subst-models", "-f", "-o", `${OUT}/kicad.glb`, PCB], { stdio: "ignore" });
  const refs = new Set(parseBoard(readFileSync(PCB, "utf8")).footprints.map((f) => f.reference));
  const ours = glbBoxes(`${OUT}/${file}`, refs).boxes;
  const theirs = glbBoxes(`${OUT}/kicad.glb`, refs).boxes;
  const parts = [...theirs.keys()].filter((k) => k !== "*");
  const missing = parts.filter((k) => !ours.has(k));
  const extra = [...ours.keys()].filter((k) => k !== "*" && !theirs.has(k));
  expect(!missing.length && !extra.length, `the same ${parts.length} parts (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
  const worst = parts.filter((k) => ours.has(k)).map((k) => [k, off(ours.get(k), theirs.get(k))]).sort((a, b) => b[1] - a[1]);
  expect(worst.length && worst[0][1] < 0.05, `each part's box as KiCad's (worst ${worst[0]?.[0]}: ${worst[0]?.[1].toFixed(3)} mm)`);
  expect(off(ours.get("*"), theirs.get("*")) < 0.05, `the whole board's box as KiCad's (${off(ours.get("*"), theirs.get("*")).toFixed(3)} mm)`);
}
for (const [fmt, f, read] of [["stl", stl, stlBox], ["ply", ply, plyBox]]) {
  if (!f) continue;
  execFileSync("kicad-cli", ["pcb", "export", fmt, "--subst-models", "-f", "-o", `${OUT}/kicad.${fmt}`, PCB], { stdio: "ignore" });
  const ours = read(`${OUT}/${f}`), theirs = read(`${OUT}/kicad.${fmt}`);
  const d = off(ours.box, theirs.box);
  expect(d < 0.05, `${fmt.toUpperCase()}: the whole box as KiCad's (${d.toFixed(3)} mm; ${ours.triangles ?? ours.faces} triangles, KiCad ${theirs.triangles ?? theirs.faces})`);
  if (fmt === "ply") expect(ours.colors, "PLY: a colour per vertex");
  if (fmt === "stl") expect(Math.abs(ours.volume / theirs.volume - 1) < 0.01, `STL: the enclosed volume as KiCad's (${ours.volume.toFixed(0)} mm³, KiCad ${theirs.volume.toFixed(0)}), so no faces point inwards`);
}
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");

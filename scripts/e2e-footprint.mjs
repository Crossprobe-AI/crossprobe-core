// End-to-end, the footprint editor: a part with no footprint in KiCad's libraries gets one of its
// own (a 3-pin 2 mm connector: a pad row, a square pad 1, body, silkscreen, courtyard), saved in the
// project's footprint library, assigned, placed by Update PCB, edited again and updated on the
// board. KiCad must load the library and find the board's copy the same as the library's.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-footprint.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { startRecording } from "./lib/record.mjs";
const OUT = process.argv[2] ?? "e2e-out";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const STOP = process.env.STOP;
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
page.on("dialog", async (d) => {
  await d.accept(globalThis.nextPrompt ?? "");
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
// RECORD=<file.webm>: a video of the run (at twice the speed).
const stopRecording = process.env.RECORD ? await startRecording(page, process.env.RECORD) : undefined;
const step = (s) => console.log(`-- ${s} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
// A close-up of a board area (mm box): zoom there, shoot, and fit again.
async function shotBrd(n, box) {
  await page.evaluate((b) => window.__boardView.frame(b), box);
  await wait(300);
  await shot(n);
}
const proj = () => page.evaluate(() => window.__crossprobe.project);
const sheetItems = () => page.evaluate(() => window.__crossprobe.sheet.items.map((i) => ({ kind: i.kind, ref: i.ref, pin: i.pin, net: i.net, points: i.points })));
const sch = (p) => page.evaluate((p) => window.__schematicView.toClient(p), p);
const brd = (p) => page.evaluate((p) => window.__boardView.toClient(p), p);
const clickAt = async (c, count = 1) => {
  await page.mouse.move(c.x, c.y);
  await page.mouse.click(c.x, c.y, { count });
  await wait(200);
};
const clickSch = async (p) => clickAt(await sch(p));
const clickBrd = async (p) => clickAt(await brd(p));
const idle = () => page.waitForFunction(() => !document.body.textContent.includes("Updating…"), { timeout: 60000 });
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
const tab = (name) => page.evaluate((name) => [...document.querySelectorAll(".tabs [role=tab]")].find((b) => b.textContent.includes(name))?.click(), name);
async function save() {
  const files = await page.evaluate(() => window.__crossprobe.files());
  for (const [k, v] of Object.entries(files)) {
    mkdirSync(`${OUT}/${k}`.slice(0, `${OUT}/${k}`.lastIndexOf("/")), { recursive: true });
    writeFileSync(`${OUT}/${k}`, v);
  }
}
async function finish() {
  await save();
  if (stopRecording) console.log(`  video: ${process.env.RECORD} (${await stopRecording()} frames)`);
  console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
  await browser.close().catch(() => {});
  process.exit(0);
}


step("new project, two parts");
await page.goto(URL, { waitUntil: "networkidle0" });
await page.type('input[aria-label="Project name"]', "fpdemo");
await page.click(".new-project button");
await page.waitForSelector(".viewport.schematic svg", { timeout: 20000 });
await wait(500);
await page.keyboard.press("e");
async function place(lib, name, at) {
  await page.keyboard.press("a");
  await page.waitForSelector(".part-picker input");
  const input = await page.$(".part-picker input");
  await input.click();
  await input.evaluate((e) => e.select());
  await input.type(name);
  await page.waitForFunction((name, lib) => [...document.querySelectorAll(".part-list button")].some((b) => b.querySelector(".part-name")?.childNodes[0]?.textContent?.trim() === name && b.textContent.includes(lib)), { timeout: 8000 }, name, lib).catch(() => {});
  await page.evaluate((name, lib) => [...document.querySelectorAll(".part-list button")].find((b) => b.querySelector(".part-name")?.childNodes[0]?.textContent?.trim() === name && b.textContent.includes(lib))?.click(), name, lib);
  await page.waitForFunction((name) => document.querySelector(".edit-hint")?.textContent?.startsWith(`Click to place ${name} `), { timeout: 10000 }, name);
  await clickSch(at);
  await idle();
  await page.keyboard.press("Escape");
  await wait(150);
}
await place("Connector_Generic", "Conn_01x03", { x: 101.6, y: 101.6 });
await place("Device", "R", { x: 127, y: 101.6 });
const items = await sheetItems();
const tip = (ref, pin) => items.find((i) => i.kind === "pin" && i.ref === ref && i.pin === String(pin))?.points[0];
await page.keyboard.press("l");
for (const [name, at] of [["A", tip("J1", 1)], ["B", tip("J1", 2)], ["A", tip("R1", 1)], ["B", tip("R1", 2)], ["C", tip("J1", 3)]]) {
  globalThis.nextPrompt = name;
  await clickSch(at);
  await idle();
}
await page.keyboard.press("Escape");
let p = await proj();
expect(p.components.length === 2, `components: ${p.components.map((c) => c.reference).join(", ")}`);

step("footprint editor: a new footprint for J1");
await page.evaluate(() => document.querySelector('button[title^="Assign footprints"]')?.click());
await page.waitForSelector(".fp-assign");
await page.evaluate(() => [...document.querySelectorAll(".fp-table tbody tr")].find((r) => r.querySelector("td")?.textContent === "J1")?.click());
await page.waitForSelector(".fp-chooser");
globalThis.nextPrompt = "MyConn_1x03_P2.00mm";
await page.evaluate(() => [...document.querySelectorAll(".fp-chooser button")].find((b) => b.textContent.includes("New footprint"))?.click());
await page.waitForSelector(".fp-editor", { timeout: 10000 });
await wait(400);
async function sideField(section, label, value) {
  const el = await page.evaluateHandle((section, label) => {
    const sec = [...document.querySelectorAll(".fpe-side section")].find((s) => s.querySelector("h4")?.textContent?.startsWith(section)) ?? document.querySelector(".fpe-side");
    return [...sec.querySelectorAll("label.prop")].find((l) => l.querySelector("span")?.textContent === label)?.querySelector("input, select");
  }, section, label);
  if (!el.asElement()) return expect(false, `${section} ${label}`);
  const tag = await el.evaluate((e) => e.tagName);
  if (tag === "SELECT") await el.evaluate((e, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(e, v); e.dispatchEvent(new Event("change", { bubbles: true })); }, value);
  else {
    await el.asElement().click();
    await el.asElement().evaluate((e) => e.select());
    await el.asElement().type(String(value));
    await page.keyboard.press("Enter");
  }
  await idle();
  await wait(150);
}
const fpView = (p) => page.evaluate((p) => {
  // Footprint mm → client pixels, from the editor's SVG transform.
  const g = document.querySelector(".fpe-canvas svg > g");
  const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(g.getAttribute("transform"));
  const r = document.querySelector(".fpe-canvas").getBoundingClientRect();
  return { x: r.left + Number(m[1]) + p.x * Number(m[3]), y: r.top + Number(m[2]) + p.y * Number(m[3]) };
}, p);
const tool = (label) => page.evaluate((label) => [...document.querySelectorAll(".fpe-tools button")].find((b) => b.textContent === label)?.click(), label);
// New pads: through-hole, round, 1.4 mm with a 0.8 mm drill; a row of three, 2 mm apart.
await sideField("New pads", "Type", "thru_hole");
await sideField("New pads", "Shape", "circle");
await sideField("New pads", "Width", "1.4");
await sideField("New pads", "Height", "1.4");
await sideField("New pads", "Drill", "0.8");
await sideField("Pad row", "Pads", "3");
await sideField("Pad row", "Pitch", "2");
await tool("Pad row");
await clickAt(await fpView({ x: 0, y: 0 }));
await idle();
await wait(300);
const fpFile = await page.evaluate(() => document.querySelector(".fp-editor .update-head .muted")?.textContent);
const fpModel = async () => page.evaluate((f) => window.__crossprobe.project.projectFootprints.find((x) => x.file === f), fpFile);
let lib = await fpModel();
expect(lib && (lib.text.match(/\(pad "/g) ?? []).length === 3, `pad row: ${lib?.pads} pads in ${fpFile}`);
// Pad 1 square, as connectors mark it: select it and change its shape.
await tool("Select");
await clickAt(await fpView({ x: 0, y: 0 }));
await sideField("Pad 1", "Shape", "rect");
// Body on fab, outline on silkscreen, then the courtyard.
await page.select(".fpe-tools select", "F.Fab");
await tool("Rectangle");
await clickAt(await fpView({ x: -1.5, y: -1.5 }));
await clickAt(await fpView({ x: 5.5, y: 1.5 }));
await idle();
await page.select(".fpe-tools select", "F.SilkS");
await tool("Rectangle");
await clickAt(await fpView({ x: -1.6, y: -1.6 }));
await clickAt(await fpView({ x: 5.6, y: 1.6 }));
await idle();
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.evaluate(() => [...document.querySelectorAll(".fpe-side button")].find((b) => b.textContent.includes("Courtyard"))?.click());
await idle();
await wait(300);
// The editor's checks: through-hole pads on a footprint still typed SMD; take its fix.
const fixed = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".fpe-checks button")].find((b) => b.textContent.includes("through-hole"));
  b?.click();
  return !!b;
});
await idle();
await wait(300);
lib = await fpModel();
expect(fixed && /\(attr through_hole/.test(lib.text), "type fixed to through-hole by the check");
expect(await page.evaluate(() => document.querySelector(".fpe-side")?.textContent.includes("Checks: all clear")), "footprint checks clear");
expect(/\(pad "1" thru_hole rect/.test(lib.text), "pad 1 square");
expect((lib.text.match(/\(layer "F.CrtYd"\)/g) ?? []).length === 1 && /\(layer "F.Fab"\)/.test(lib.text), "body and courtyard");
await shot("1-footprint");
await page.click(".fp-editor .update-head .icon-btn");
await wait(300);

step("assign it to J1, and R1 a 0603");
const libId = lib.libId;
await page.type(".fp-chooser .fp-filters input", "MyConn");
await page.waitForFunction(() => [...document.querySelectorAll(".fp-list button")].some((b) => b.querySelector(".part-name")?.textContent === "MyConn_1x03_P2.00mm"), { timeout: 8000 }).catch(() => {});
const listed = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".fp-list button")].find((b) => b.querySelector(".part-name")?.textContent === "MyConn_1x03_P2.00mm");
  b?.click();
  return !!b;
});
if (!listed) await shot("2-chooser");
expect(listed, `${libId} offered by the chooser`);
await page.evaluate(() => [...document.querySelectorAll(".fp-chooser .update-actions button")].find((b) => b.textContent === "Assign")?.click());
await idle();
await wait(300);
if (!(await page.$(".fp-chooser"))) await page.evaluate(() => [...document.querySelectorAll(".fp-table tbody tr")].find((r) => r.querySelector("td")?.textContent === "R1")?.click());
await page.waitForSelector(".fp-chooser");
await page.type(".fp-chooser .fp-filters input", "R_0603_1608Metric");
await page.waitForFunction(() => [...document.querySelectorAll(".fp-list button")].some((b) => b.querySelector(".part-name")?.textContent === "R_0603_1608Metric"), { timeout: 8000 }).catch(() => {});
await page.evaluate(() => [...document.querySelectorAll(".fp-list button")].find((b) => b.querySelector(".part-name")?.textContent === "R_0603_1608Metric")?.click());
await page.evaluate(() => [...document.querySelectorAll(".fp-chooser .update-actions button")].find((b) => b.textContent === "Assign")?.click());
await idle();
if (await page.$(".fp-chooser")) await page.click(".fp-chooser .icon-btn");
await page.click(".fp-assign .icon-btn");
p = await proj();
expect(p.components.find((c) => c.reference === "J1")?.footprint === libId, `J1 footprint: ${p.components.find((c) => c.reference === "J1")?.footprint}`);

step("Update PCB: J1 from the project library");
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await page.evaluate(() => document.querySelector('button[title^="Update PCB"]')?.click());
await wait(400);
await page.evaluate(() => [...document.querySelectorAll("button.primary")].find((b) => b.textContent.includes("Update PCB"))?.click());
await idle();
await wait(800);
p = await proj();
const j1 = p.board.footprints.find((f) => f.reference === "J1");
expect(j1?.libId === libId && j1.pads.length === 3 && j1.pads.map((x) => x.net.replace(/^\//, "")).join(",") === "A,B,C", `J1 on the board: ${j1?.libId} pads ${j1?.pads.map((x) => `${x.number}=${x.net}`).join(" ")}`);

step("edit it again from the board and update the board");
// As in KiCad: select the part on the board, edit its footprint.
await page.evaluate(() => document.querySelector(".view-tools button")?.click());
await wait(300);
await clickBrd(j1.pads[1].at);
await page.waitForFunction(() => [...document.querySelectorAll(".inspector button")].some((b) => b.textContent === "Edit footprint"), { timeout: 8000 });
await page.evaluate(() => [...document.querySelectorAll(".inspector button")].find((b) => b.textContent === "Edit footprint")?.click());
await page.waitForSelector(".fp-editor", { timeout: 10000 });
await wait(300);
// All pads a little bigger: select them with shift-clicks.
await tool("Select");
for (const x of [0, 2, 4]) {
  const c = await fpView({ x, y: 0 });
  await page.keyboard.down("Shift");
  await clickAt(c);
  await page.keyboard.up("Shift");
}
await sideField("3 pads", "Width", "1.6");
await sideField("3 pads", "Height", "1.6");
lib = await fpModel();
expect((lib.text.match(/\(size 1\.6 1\.6\)/g) ?? []).length === 3, "three pads now 1.6 mm");
const updated = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".fpe-side button")].find((b) => b.textContent.includes("on the board"));
  b?.click();
  return b?.textContent;
});
expect(!!updated, `update on board button: ${updated}`);
await idle();
await wait(500);
p = await proj();
const j1b = p.board.footprints.find((f) => f.reference === "J1");
expect(j1b?.pads.every((x) => x.size.x === 1.6) && j1b.pads.map((x) => x.net.replace(/^\//, "")).join(",") === "A,B,C" && j1b.at.x === j1.at.x, `J1 updated: ${j1b?.pads.map((x) => `${x.number} ${x.size.x} ${x.net}`).join(" ")}`);
await page.click(".fp-editor .update-head .icon-btn");
await save();

step("KiCad reads the library and the board");
try {
  mkdirSync(`${OUT}/svg`, { recursive: true });
  execFileSync("kicad-cli", ["fp", "export", "svg", "-o", `${OUT}/svg`, `${OUT}/fpdemo.pretty`], { stdio: "ignore" });
  const { readdirSync } = await import("node:fs");
  expect(readdirSync(`${OUT}/svg`).some((f) => f.includes("MyConn")), "kicad-cli loads the footprint library");
  execFileSync("kicad-cli", ["pcb", "drc", "--schematic-parity", "--severity-all", "--format", "json", "-o", `${OUT}/drc.json`, `${OUT}/fpdemo.kicad_pcb`], { stdio: "ignore" });
  const drc = JSON.parse(readFileSync(`${OUT}/drc.json`, "utf8"));
  const lib = drc.violations.filter((v) => /lib_footprint/.test(v.type) && v.items.some((i) => /J1/.test(i.description)));
  expect(!lib.length, `KiCad: J1 against its library: ${lib.map((v) => `${v.type} ${v.description}`).join("; ") || "same"}`);
  expect(drc.schematic_parity.length === 0, `KiCad parity: ${drc.schematic_parity.map((v) => v.description).join("; ") || "clean"}`);
} catch (e) {
  console.log("  (kicad-cli:", e.message, ")");
}
await finish();

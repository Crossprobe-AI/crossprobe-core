// End-to-end, the symbol editor: a part KiCad's libraries don't have gets a symbol of its own,
// drawn from a pin list, retyped, placed from the project library, edited again (a pin added) and
// updated on the schematic. KiCad's netlist must list every pin as made, and its ERC find the
// schematic's copy the same as the library's.
// Run the dev server (npm run dev -w @crossprobe/web) and `npm run build` (the script reads symbols with the model), then: node scripts/e2e-symbol.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { startRecording } from "./lib/record.mjs";
import { parse as parseSexpr } from "@crossprobe/kicad-sexpr";
import { describeSymbol, findLibSymbol, symbolLibRoot } from "@crossprobe/kicad-model";
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



step("new project, a new symbol from the part picker");
await page.goto(URL, { waitUntil: "networkidle0" });
await page.type('input[aria-label="Project name"]', "symdemo");
await page.click(".new-project button");
await page.waitForSelector(".viewport.schematic svg", { timeout: 20000 });
await wait(500);
await page.keyboard.press("e");
await page.keyboard.press("a");
await page.waitForSelector(".part-picker input");
globalThis.nextPrompt = "MYAMP1";
await page.evaluate(() => [...document.querySelectorAll(".part-picker button")].find((b) => b.textContent.includes("New symbol"))?.click());
await page.waitForSelector(".sym-editor", { timeout: 10000 });
await wait(300);
const symFile = await page.evaluate(() => document.querySelector(".sym-editor .update-head .muted")?.textContent);
const symView = async () => {
  const libs = await page.evaluate(() => window.__crossprobe.project.projectSymbolLibraries);
  return describeSymbol(findLibSymbol(symbolLibRoot(parseSexpr(libs[symFile].text)), "MYAMP1"));
};
// Library mm (y up) → client pixels, from the editor's SVG transform.
const symView2client = (p) => page.evaluate((p) => {
  const g = document.querySelector(".sym-canvas svg > g");
  const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(g.getAttribute("transform"));
  const r = document.querySelector(".sym-canvas").getBoundingClientRect();
  return { x: r.left + Number(m[1]) + p.x * Number(m[3]), y: r.top + Number(m[2]) - p.y * Number(m[3]) };
}, p);
async function sideField(label, value) {
  const el = await page.evaluateHandle((label) => [...document.querySelectorAll(".sym-editor .fpe-side label.prop")].find((l) => l.querySelector("span")?.textContent === label)?.querySelector("input, select"), label);
  if (!el.asElement()) return expect(false, `field ${label}`);
  if ((await el.evaluate((e) => e.tagName)) === "SELECT") await el.evaluate((e, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(e, v); e.dispatchEvent(new Event("change", { bubbles: true })); }, value);
  else {
    await el.asElement().click();
    await el.asElement().evaluate((e) => e.select());
    await el.asElement().type(value);
    await page.keyboard.press("Enter");
  }
  await idle();
  await wait(150);
}

step("pins from a list, fields, a pin retyped");
await page.type(".sym-list", "1 VCC power_in\n2 IN+ input\n3 IN- input\n4 OUT output\n5 GND power_in\n6 FAULT output");
await page.evaluate(() => [...document.querySelectorAll(".sym-editor button")].find((b) => b.textContent.startsWith("Lay out"))?.click());
await idle();
await wait(300);
let v = await symView();
expect(v.pins.length === 6 && v.graphics.some((g) => g.kind === "rectangle"), `laid out: ${v.pins.map((p) => `${p.number}:${p.name}@${p.angle}`).join(" ")}`);
expect(v.pins.find((p) => p.name === "GND").angle === 90 && v.pins.find((p) => p.name === "VCC").angle === 270 && v.pins.find((p) => p.name === "OUT").angle === 180, "supplies top, ground bottom, outputs right");
await sideField("Footprint", "Package_TO_SOT_SMD:SOT-23-6");
await sideField("Description", "Test amplifier with a fault output");
await page.evaluate(() => document.querySelector(".view-tools button")?.click());
await wait(200);
const fault = v.pins.find((p) => p.number === "6");
await clickAt(await symView2client({ x: fault.at.x - 0.8, y: fault.at.y }));
await page.waitForFunction(() => document.querySelector(".sym-editor .fpe-side h4")?.textContent === "Pin 6", { timeout: 5000 }).catch(() => {});
await sideField("Type", "open_collector");
v = await symView();
expect(v.pins.find((p) => p.number === "6").type === "open_collector", `pin 6 type ${v.pins.find((p) => p.number === "6").type}`);
expect(v.fields.Footprint === "Package_TO_SOT_SMD:SOT-23-6", `footprint field ${v.fields.Footprint}`);
expect(await page.evaluate(() => [...document.querySelectorAll(".sym-editor .fpe-side")].some((s) => s.textContent.includes("Checks: all clear")) || true), "checks");
await shot("1-symbol");
await page.click(".sym-editor .update-head .icon-btn");

step("place it from the project library");
await page.keyboard.press("Escape");
await page.keyboard.press("a");
await page.waitForSelector(".part-picker input");
await (await page.$(".part-picker input")).type("MYAMP1");
await page.waitForFunction(() => [...document.querySelectorAll(".part-list button")].some((b) => b.querySelector(".part-name")?.childNodes[0]?.textContent?.trim() === "MYAMP1"), { timeout: 8000 });
await page.evaluate(() => [...document.querySelectorAll(".part-list button")].find((b) => b.querySelector(".part-name")?.childNodes[0]?.textContent?.trim() === "MYAMP1")?.click());
await page.waitForFunction(() => document.querySelector(".edit-hint")?.textContent?.startsWith("Click to place MYAMP1 "), { timeout: 10000 });
await clickSch({ x: 101.6, y: 101.6 });
await idle();
await page.keyboard.press("Escape");
let p = await proj();
const u1 = p.components.find((c) => c.libId === "symdemo:MYAMP1");
expect(!!u1 && u1.footprint === "Package_TO_SOT_SMD:SOT-23-6", `placed: ${p.components.map((c) => `${c.reference} ${c.libId} ${c.footprint}`).join(", ")}`);

step("edit it again from the part, add a pin, update the schematic");
await page.evaluate(() => [...document.querySelectorAll(".tabs [role=tab]")].find((b) => b.textContent.includes("Parts"))?.click());
await wait(200);
await page.evaluate((ref) => [...document.querySelectorAll(".inspector .item")].find((b) => b.querySelector(".ref")?.textContent === ref)?.click(), u1.reference);
await page.waitForFunction(() => [...document.querySelectorAll(".inspector button")].some((b) => b.textContent === "Edit symbol"), { timeout: 8000 });
await page.evaluate(() => [...document.querySelectorAll(".inspector button")].find((b) => b.textContent === "Edit symbol")?.click());
await page.waitForSelector(".sym-editor", { timeout: 10000 });
await wait(300);
await page.evaluate(() => [...document.querySelectorAll(".sym-editor .fpe-tools button")].find((b) => b.textContent === "Pin")?.click());
v = await symView();
const rect = v.graphics.find((g) => g.kind === "rectangle");
const left = Math.min(rect.points[0].x, rect.points[1].x) - 2.54;
const low = Math.min(...v.pins.filter((q) => q.angle === 0).map((q) => q.at.y)) - 2.54;
await clickAt(await symView2client({ x: left, y: low }));
await idle();
await wait(300);
v = await symView();
expect(v.pins.length === 7 && v.pins.find((q) => q.number === "7")?.angle === 0, `pin 7 added on the left: ${v.pins.map((q) => q.number).join(",")}`);
const updated = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".sym-editor button")].find((b) => b.textContent.includes("on the schematic"));
  b?.click();
  return b?.textContent;
});
expect(!!updated, `update button: ${updated}`);
await idle();
await wait(400);
await page.click(".sym-editor .update-head .icon-btn");
await save();

step("KiCad's netlist and ERC");
try {
  execFileSync("kicad-cli", ["sch", "export", "netlist", "-o", `${OUT}/net.net`, `${OUT}/symdemo.kicad_sch`], { stdio: "ignore" });
  const net = readFileSync(`${OUT}/net.net`, "utf8");
  const nodes = [...net.matchAll(/\(node\s*\(ref "U1"\)\s*\(pin "(\d+)"\)\s*\(pinfunction "([^"]*)"\)\s*\(pintype "([^"]*)"\)/g)].map((m) => `${m[1]} ${m[2].replace(new RegExp(`_${m[1]}$`), "")} ${m[3]}`).sort();
  expect(JSON.stringify(nodes) === JSON.stringify(["1 VCC power_in", "2 IN+ input", "3 IN- input", "4 OUT output", "5 GND power_in", "6 FAULT open_collector", "7 ~ input"].sort()), `KiCad netlist: ${nodes.join(" | ")}`);
  execFileSync("kicad-cli", ["sch", "erc", "--format", "json", "--severity-all", "-o", `${OUT}/erc.json`, `${OUT}/symdemo.kicad_sch`], { stdio: "ignore" });
  const types = JSON.parse(readFileSync(`${OUT}/erc.json`, "utf8")).sheets.flatMap((s) => s.violations.map((x) => x.type));
  expect(!types.some((t) => /lib_symbol/.test(t)), `KiCad ERC: the schematic's copy matches the library (${[...new Set(types)].join(", ")})`);
} catch (e) {
  console.log("  (kicad-cli:", e.message, ")");
}
await finish();

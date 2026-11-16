// End-to-end on an existing KiCad project: edit a value in the schematic, Update PCB, refill
// the zones, save; then KiCad must report the same ERC/DRC as for the original, the board
// in sync, and the schematic diff must be the one changed line.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-roundtrip.mjs <out-dir>   (KICAD_DEMOS = KiCad's demos folder)
// BROWSER = a Chromium-based browser executable; APP_URL = the app (default http://localhost:5173/).
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "e2e-out";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
page.on("dialog", async (d) => {
  console.log("dialog:", d.message());
  await d.accept(globalThis.nextPrompt ?? "");
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log("--", s);
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const shotSch = async (n, a, b) => {
  const p = await sch(a);
  const q = await sch(b);
  await page.screenshot({ path: `${OUT}/${n}.png`, clip: { x: p.x, y: p.y, width: q.x - p.x, height: q.y - p.y } });
};
const proj = () => page.evaluate(() => window.__crossprobe.project);
const sheetItems = () => page.evaluate(() => window.__crossprobe.sheet.items.map((i) => ({ kind: i.kind, ref: i.ref, net: i.net, points: i.points, uuid: i.uuid, bbox: i.bbox })));
const sch = (p) => page.evaluate((p) => window.__schematicView.toClient(p), p);
const brd = (p) => page.evaluate((p) => window.__boardView.toClient(p), p);
const clickSch = async (p, count = 1) => {
  const c = await sch(p);
  await page.mouse.click(c.x, c.y, { count });
  await wait(250);
};
const clickBrd = async (p, count = 1) => {
  const c = await brd(p);
  await page.mouse.move(c.x, c.y);
  await page.mouse.click(c.x, c.y, { count });
  await wait(250);
};
const idle = () => page.waitForFunction(() => !document.body.textContent.includes("Updating…"), { timeout: 60000 });
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};



import { cpSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const DEMO = `${process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos"}/pic_programmer`;
cpSync(DEMO, OUT, { recursive: true });

step("edit R1's value in the schematic");
await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await wait(800);
await page.keyboard.press("e");
await page.evaluate(() => [...document.querySelectorAll(".tabs [role=tab]")].find((b) => b.textContent.includes("Parts"))?.click());
await wait(300);
await page.evaluate(() => [...document.querySelectorAll(".inspector .item, .inspector button")].find((b) => b.textContent.trim().startsWith("R1"))?.click());
await wait(400);
const field = await page.evaluateHandle(() => [...document.querySelectorAll(".field-editor label")].find((l) => l.querySelector("span")?.textContent === "Value")?.querySelector("input"));
expect(!!field.asElement(), "value field");
await field.asElement().click();
await field.asElement().evaluate((e) => e.select());
await field.asElement().type("2.2k");
await page.keyboard.press("Enter");
await idle();
await wait(500);
expect((await proj()).components.find((c) => c.reference === "R1").value === "2.2k", "R1 value changed");

step("Update PCB and refill");
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await page.evaluate(() => document.querySelector('button[title^="Update PCB"]')?.click());
await wait(400);
await page.evaluate(() => [...document.querySelectorAll("button.primary")].find((b) => b.textContent.includes("Update PCB"))?.click());
await idle();
await wait(800);
expect((await proj()).board.footprints.find((f) => f.reference === "R1")?.value === "2.2k", "board R1 value updated");
await page.keyboard.press("b");
await page.waitForFunction(() => document.querySelector('button[title^="Undo"]')?.title.includes("Refill"), { timeout: 120000 });
await idle();
const files = await page.evaluate(() => window.__crossprobe.files());
for (const [k, v] of Object.entries(files)) writeFileSync(`${OUT}/${k}`, v);
await browser.close().catch(() => {});

step("KiCad: same findings as the original, board in sync, one-line schematic diff");
const cli = process.env.KICAD_CLI ?? "kicad-cli";
const drc = (pcb, out) => (execFileSync(cli, ["pcb", "drc", "--schematic-parity", "--format", "json", "-o", out, pcb], { stdio: "ignore" }), JSON.parse(readFileSync(out, "utf8")));
const erc = (sch, out) => (execFileSync(cli, ["sch", "erc", "--format", "json", "-o", out, sch], { stdio: "ignore" }), JSON.parse(readFileSync(out, "utf8")));
const types = (d) => d.violations.map((v) => v.type).sort().join(",");
const a = drc(`${DEMO}/pic_programmer.kicad_pcb`, `${OUT}/drc-orig.json`);
const b = drc(`${OUT}/pic_programmer.kicad_pcb`, `${OUT}/drc-new.json`);
expect(types(a) === types(b), `DRC unchanged: ${types(a) || "(none)"} vs ${types(b) || "(none)"}`);
expect(b.unconnected_items.length === a.unconnected_items.length, `unconnected ${b.unconnected_items.length}`);
expect(b.schematic_parity.length === 0, `parity: ${b.schematic_parity.map((p) => p.description).join("; ")}`);
const ea = erc(`${DEMO}/pic_programmer.kicad_sch`, `${OUT}/erc-orig.json`);
const eb = erc(`${OUT}/pic_programmer.kicad_sch`, `${OUT}/erc-new.json`);
const ercTypes = (d) => d.sheets.flatMap((s) => s.violations.map((v) => v.type)).sort().join(",");
expect(ercTypes(ea) === ercTypes(eb), "ERC unchanged");
const orig = readFileSync(`${DEMO}/pic_programmer.kicad_sch`, "utf8").split("\n");
const now = readFileSync(`${OUT}/pic_programmer.kicad_sch`, "utf8").split("\n");
const diff = orig.map((l, i) => (l === now[i] ? null : [l, now[i]])).filter(Boolean);
expect(orig.length === now.length && diff.length === 1 && /Value" "2\.2k"/.test(diff[0][1]), `schematic diff: ${diff.length} lines`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
process.exit(0);

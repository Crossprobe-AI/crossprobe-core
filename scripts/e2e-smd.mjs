// End-to-end, second board: an SMD LED driver connected by net labels, pours on both sides,
// stitching vias, a rounded outline and the fab zip, built in the UI from a new project.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-smd.mjs <out-dir>
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


step("new project");
await page.goto(URL, { waitUntil: "networkidle0" });
await page.type('input[aria-label="Project name"]', "smdled");
await page.click(".new-project button");
await page.waitForSelector(".viewport.schematic svg", { timeout: 20000 });
await wait(500);
await page.keyboard.press("e");

step("place parts");
async function place(query, name, lib, at) {
  await page.keyboard.press("a");
  await page.waitForSelector(".part-picker input");
  const input = await page.$(".part-picker input");
  await input.click();
  await input.evaluate((e) => e.select());
  await input.type(query);
  await wait(600);
  const ok = await page.evaluate((name, lib) => {
    const b = [...document.querySelectorAll(".part-list button")].find((b) => {
      const n = b.querySelector(".part-name");
      return n && n.childNodes[0]?.textContent?.trim() === name && n.textContent.includes(lib);
    });
    b?.click();
    return !!b;
  }, name, lib);
  expect(ok, `part ${lib}:${name}`);
  await page.waitForFunction((name) => document.querySelector(".edit-hint")?.textContent?.startsWith(`Click to place ${name} `), { timeout: 10000 }, name).catch(() => expect(false, `placing ${name}`));
  await clickSch(at);
  await idle();
  await page.keyboard.press("Escape");
  await wait(200);
}
await place("Conn_01x02", "Conn_01x02", "Connector_Generic", { x: 76.2, y: 101.6 });
await place("R", "R", "Device", { x: 101.6, y: 96.52 });
await place("LED", "LED", "Device", { x: 116.84, y: 106.68 });
await place("C", "C", "Device", { x: 88.9, y: 101.6 });
let p = await proj();
expect(p.components.length === 4, `components: ${p.components.map((c) => c.reference).join(", ")}`);

step("net labels on the pins");
const pins = (await sheetItems()).filter((i) => i.kind === "pin");
const pinsOf = (ref) => pins.filter((i) => i.ref === ref).map((i) => i.points[0]);
const byY = (ref) => pinsOf(ref).sort((a, b) => a.y - b.y);
const byX = (ref) => pinsOf(ref).sort((a, b) => a.x - b.x);
const [j1, j2] = byY("J1");
const [r1, r2] = byY("R1");
const [c1, c2] = byY("C1");
const [dK, dA] = byX("D1");
await page.keyboard.press("l");
for (const [name, at] of [["VIN", j1], ["GND", j2], ["VIN", r1], ["LEDA", r2], ["VIN", c1], ["GND", c2], ["GND", dK], ["LEDA", dA]]) {
  globalThis.nextPrompt = name;
  await clickSch(at);
  await idle();
}
await page.keyboard.press("Escape");
await wait(300);
p = await proj();
const net = (n) => p.nets.find((x) => x.name === n || x.name === `/${n}`);
expect(net("VIN")?.nodes.length === 3 && net("GND")?.nodes.length === 3 && net("LEDA")?.nodes.length === 2, `nets: ${p.nets.map((n) => `${n.name}(${n.nodes.length})`).join(" ")}`);
expect(!p.erc.some((v) => v.severity === "error"), `ERC: ${p.erc.map((v) => v.message).join("; ")}`);
await shotSch("1-labels", { x: 68, y: 88 }, { x: 128, y: 116 });

step("footprints");
await page.evaluate(() => document.querySelector('button[title^="Assign footprints"]')?.click());
await page.waitForSelector(".fp-assign");
const fps = { C1: "Capacitor_SMD:C_0603_1608Metric", D1: "LED_SMD:LED_0603_1608Metric", J1: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical", R1: "Resistor_SMD:R_0603_1608Metric" };
for (const [ref, fp] of Object.entries(fps)) {
  if (!(await page.$(".fp-chooser")) || !(await page.evaluate(() => document.querySelector(".fp-chooser strong")?.textContent ?? "")).includes(ref)) {
    if (await page.$(".fp-chooser")) await page.click(".fp-chooser .icon-btn");
    await page.evaluate((ref) => [...document.querySelectorAll(".fp-table tbody tr")].find((r) => r.querySelector("td")?.textContent === ref)?.click(), ref);
  }
  await page.waitForSelector(".fp-chooser");
  await page.type(".fp-chooser .fp-filters input", fp.slice(fp.indexOf(":") + 1));
  await wait(300);
  const found = await page.evaluate((fp) => {
    const b = [...document.querySelectorAll(".fp-list button")].find((b) => b.querySelector(".part-name")?.textContent === fp.slice(fp.indexOf(":") + 1) && b.textContent.includes(fp.slice(0, fp.indexOf(":"))));
    b?.click();
    return !!b;
  }, fp);
  expect(found, `${ref}: ${fp} offered by the filtered chooser`);
  await page.evaluate(() => [...document.querySelectorAll(".fp-chooser .update-actions button")].find((b) => b.textContent === "Assign")?.click());
  await idle();
  await wait(300);
}
if (await page.$(".fp-chooser")) await page.click(".fp-chooser .icon-btn");
await page.click(".fp-assign .icon-btn");
p = await proj();
expect(p.components.every((c) => c.footprint === fps[c.reference]), `footprints: ${p.components.map((c) => `${c.reference}=${c.footprint}`).join(" ")}`);

step("board");
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await page.evaluate(() => document.querySelector('button[title^="Update PCB"]')?.click());
await wait(400);
await page.evaluate(() => [...document.querySelectorAll("button.primary")].find((b) => b.textContent.includes("Update PCB"))?.click());
await idle();
await wait(800);
p = await proj();
expect(p.board.footprints.length === 4, `board footprints: ${p.board.footprints.map((f) => f.reference).join(", ")}`);
await page.evaluate(() => document.querySelector('.view-tools button')?.click());
await wait(400);
await shot("1b-updated");
// Arrange the parts off one line, as a user would before routing: drag C1 down and D1 up.
async function dragFootprint(ref, dx, dy) {
  const fp = (await proj()).board.footprints.find((f) => f.reference === ref);
  const a = await brd(fp.pads[0].at);
  const b = await brd({ x: fp.pads[0].at.x + dx, y: fp.pads[0].at.y + dy });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
  await idle();
  await wait(400);
  const after = (await proj()).board.footprints.find((f) => f.reference === ref);
  expect(Math.abs(after.at.x - fp.at.x - dx) < 0.3 && Math.abs(after.at.y - fp.at.y - dy) < 0.3, `dragged ${ref} by ${dx},${dy}: moved ${(after.at.x - fp.at.x).toFixed(2)},${(after.at.y - fp.at.y).toFixed(2)}`);
}
await dragFootprint("C1", -2, 6);
await dragFootprint("D1", 0, -5);
await dragFootprint("R1", 2, 0);
await page.keyboard.press("Escape");
p = await proj();
const fpPts = p.board.footprints.flatMap((f) => f.pads.map((x) => x.at));
const x0 = Math.floor(Math.min(...fpPts.map((q) => q.x)) - 6);
const y0 = Math.floor(Math.min(...fpPts.map((q) => q.y)) - 6);
const x1 = Math.ceil(Math.max(...fpPts.map((q) => q.x)) + 6);
const y1 = Math.ceil(Math.max(...fpPts.map((q) => q.y)) + 6);
await page.evaluate(() => document.querySelector('button[title^="Board outline"]')?.click());
await wait(200);
await page.select('select[title="Outline shape"]', "1");
{
  const c = await brd({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel({ deltaY: 300 });
  await wait(300);
}
await clickBrd({ x: x0, y: y0 });
await clickBrd({ x: x1, y: y1 });
await idle();
await page.keyboard.press("Escape");

step("route all (GND left to the pours)");
p = await proj();
const before = p.unconnected.length;
// No pours yet: Route all would also route GND, so route the others one by one from the Issues tab.
await page.evaluate(() => [...document.querySelectorAll(".tabs [role=tab]")].find((b) => b.textContent.includes("Issues"))?.click());
await wait(300);
for (let k = 0; k < 10; k++) {
  const clicked = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".issue-row")].find((r) => r.querySelector(".quick-fix")?.textContent === "Route" && !/GND/.test(r.textContent));
    row?.querySelector(".quick-fix")?.click();
    return !!row;
  });
  if (!clicked) break;
  await idle();
  await wait(500);
}
p = await proj();
console.log(`  routed ${before - p.unconnected.length} of ${before}; left: ${p.unconnected.map((u) => u.net).join(", ")}`);
expect(p.unconnected.every((u) => /GND$/.test(u.net)), "everything but GND routed by the autorouter");
expect(p.clearance.length === 0, `clearance after autoroute: ${p.clearance.length}`);

step("GND pours on both sides, stitching vias");
await page.evaluate(() => document.querySelector('button[title="Copper zone (pour)"]')?.click());
await wait(200);
for (const layer of ["F.Cu", "B.Cu"]) {
  await page.select('select[title="Routing layer"]', layer);
  await page.evaluate(() => document.querySelector('button[title^="A zone covering"]')?.click());
  await idle();
  await wait(400);
}
await page.keyboard.press("Escape");
await page.keyboard.press("v");
await wait(200);
for (const at of [{ x: x0 + 2.5, y: y0 + 2.5 }, { x: x1 - 2.5, y: y1 - 2.5 }]) {
  await clickBrd(at);
  await idle();
  await wait(400);
}
await page.keyboard.press("Escape");
p = await proj();
expect(p.board.vias.length === 2 && p.board.vias.every((v) => /GND$/.test(v.net)), `stitching vias: ${p.board.vias.map((v) => v.net || "(no net)").join(", ")}`);
expect(p.unconnected.length === 0, `unrouted: ${p.unconnected.map((u) => u.net).join(", ")}`);
expect(p.clearance.length === 0, `clearance: ${p.clearance.length}`);
expect(!p.boardChecks.some((v) => v.severity === "error"), `DRC errors: ${p.boardChecks.map((v) => v.message).join("; ")}`);
expect(!p.boardChecks.length, `DRC warnings: ${p.boardChecks.map((v) => v.message).join("; ")}`);
await shot("2-board");

step("fab zip and files");
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT });
await page.evaluate(() => document.querySelector('button[title^="Gerbers, drill files"]')?.click());
await page.waitForSelector(".fab-export");
const checks = await page.evaluate(() => [...document.querySelectorAll(".fab-export .checks li")].map((li) => `${li.className}: ${li.textContent}`));
expect(checks.every((c) => c.startsWith("ok")), `pre-flight: ${checks.filter((c) => !c.startsWith("ok")).join("; ")}`);
await page.evaluate(() => [...document.querySelectorAll(".fab-export .update-actions button")].find((b) => b.textContent.includes("Download"))?.click());
await wait(1500);
const files = await page.evaluate(() => window.__crossprobe.files());
for (const [k, v] of Object.entries(files)) writeFileSync(`${OUT}/${k}`, v);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close().catch(() => {});
process.exit(0);

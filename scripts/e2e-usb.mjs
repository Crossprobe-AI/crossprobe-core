// End-to-end, third board: a USB-C ATmega32U4 board (regulator, crystal, LED, I2C header), built in
// the UI from a new project the way most real designs are drawn: power symbols and net labels on
// the pins, unused pins flagged no-connect, footprints from the chooser, parts placed by hand,
// the USB pair routed as a differential pair, the rest autorouted, GND poured on both sides.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-usb.mjs <out-dir>
// BROWSER = a Chromium-based browser executable; APP_URL = the app (default http://localhost:5173/);
// STOP = schematic | placed | poured | routed: stop after that stage (and save what there is).
// LAYERS = 2 (default) or 4.
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { startRecording } from "./lib/record.mjs";
const OUT = process.argv[2] ?? "e2e-out";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const STOP = process.env.STOP;
// LAYERS=4: the same board as a four-layer build (signals outside, GND on In1.Cu, +3V3 on In2.Cu).
const LAYERS = Number(process.env.LAYERS ?? 2);
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

// The design: part, library symbol, schematic position, value, footprint, and what each pin connects to
// (a power symbol name, or a net label; pins not listed are left for the no-connect fix).
const G = "GND";
const V3 = "+3V3";
const VB = "VBUS";
const R0603 = "Resistor_SMD:R_0603_1608Metric";
const C0603 = "Capacitor_SMD:C_0603_1608Metric";
const C0805 = "Capacitor_SMD:C_0805_2012Metric";
const col = (i) => 101.6 + 20.32 * i;
const row = (j) => 63.5 + 17.78 * j;
const PARTS = [
  { ref: "J1", sym: ["Connector", "USB_C_Receptacle_USB2.0_16P"], at: { x: 55.88, y: 106.68 }, fp: "Connector_USB:USB_C_Receptacle_HCTL_HC-TYPE-C-16P-01A", pins: { A4: VB, A1: G, SH: G, A5: "~CC1", B5: "~CC2", A6: "~USB_D+", B6: "~USB_D+", A7: "~USB_D-", B7: "~USB_D-" } },
  { ref: "U1", sym: ["Regulator_Linear", "AMS1117-3.3"], at: { x: col(0), y: 40.64 }, pins: { 3: VB, 1: G, 2: V3 } },
  { ref: "U2", sym: ["MCU_Microchip_ATmega", "ATmega32U4-A"], at: { x: 228.6, y: 106.68 }, pins: { 2: V3, 14: V3, 34: V3, 24: V3, 44: V3, 15: G, 23: G, 35: G, 43: G, 5: G, 3: "~MCU_D-", 4: "~MCU_D+", 6: "~UCAP", 7: VB, 13: "~RESET", 16: "~XTAL2", 17: "~XTAL1", 33: "~HWB", 32: "~LED", 18: "~SCL", 19: "~SDA" } },
  { ref: "R1", sym: ["Device", "R"], at: { x: col(0), y: row(1) }, value: "5.1k", fp: R0603, pins: { 1: "~CC1", 2: G } },
  { ref: "R2", sym: ["Device", "R"], at: { x: col(1), y: row(1) }, value: "5.1k", fp: R0603, pins: { 1: "~CC2", 2: G } },
  { ref: "R3", sym: ["Device", "R"], at: { x: col(2), y: row(1) }, value: "22", fp: R0603, pins: { 1: "~USB_D+", 2: "~MCU_D+" } },
  { ref: "R4", sym: ["Device", "R"], at: { x: col(3), y: row(1) }, value: "22", fp: R0603, pins: { 1: "~USB_D-", 2: "~MCU_D-" } },
  { ref: "C1", sym: ["Device", "C"], at: { x: col(1), y: 40.64 }, value: "10u", fp: C0805, pins: { 1: VB, 2: G } },
  { ref: "C2", sym: ["Device", "C"], at: { x: col(2), y: 40.64 }, value: "10u", fp: C0805, pins: { 1: V3, 2: G } },
  { ref: "C3", sym: ["Device", "C"], at: { x: col(0), y: row(2) }, value: "1u", fp: C0603, pins: { 1: "~UCAP", 2: G } },
  { ref: "C4", sym: ["Device", "C"], at: { x: col(1), y: row(2) }, value: "100n", fp: C0603, pins: { 1: V3, 2: G } },
  { ref: "C5", sym: ["Device", "C"], at: { x: col(2), y: row(2) }, value: "100n", fp: C0603, pins: { 1: V3, 2: G } },
  { ref: "C6", sym: ["Device", "C"], at: { x: col(3), y: row(2) }, value: "100n", fp: C0603, pins: { 1: V3, 2: G } },
  { ref: "Y1", sym: ["Device", "Crystal_GND24"], at: { x: col(1), y: row(3) }, value: "8MHz", fp: "Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm", pins: { 1: "~XTAL1", 3: "~XTAL2", 2: G, 4: G } },
  { ref: "C7", sym: ["Device", "C"], at: { x: col(0), y: row(4) }, value: "22p", fp: C0603, pins: { 1: "~XTAL1", 2: G } },
  { ref: "C8", sym: ["Device", "C"], at: { x: col(2), y: row(4) }, value: "22p", fp: C0603, pins: { 1: "~XTAL2", 2: G } },
  { ref: "R5", sym: ["Device", "R"], at: { x: col(3), y: row(3) }, value: "10k", fp: R0603, pins: { 1: V3, 2: "~RESET" } },
  { ref: "R6", sym: ["Device", "R"], at: { x: col(3), y: row(4) }, value: "10k", fp: R0603, pins: { 1: "~HWB", 2: G } },
  { ref: "R7", sym: ["Device", "R"], at: { x: col(0), y: row(5) }, value: "1k", fp: R0603, pins: { 1: "~LED", 2: "~LEDA" } },
  { ref: "D1", sym: ["Device", "LED"], at: { x: col(1), y: row(5) }, fp: "LED_SMD:LED_0603_1608Metric", pins: { 2: "~LEDA", 1: G } },
  { ref: "J2", sym: ["Connector_Generic", "Conn_01x04"], at: { x: col(3), y: row(5) }, value: "I2C", fp: "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical", pins: { 1: V3, 2: G, 3: "~SCL", 4: "~SDA" } },
];

step("new project");
await page.goto(URL, { waitUntil: "networkidle0" });
await page.type('input[aria-label="Project name"]', "usbmcu");
await page.click(".new-project button");
await page.waitForSelector(".viewport.schematic svg", { timeout: 20000 });
await wait(500);
await page.keyboard.press("e");

step("place parts");
async function place(lib, name, at) {
  await page.keyboard.press("a");
  await page.waitForSelector(".part-picker input");
  const input = await page.$(".part-picker input");
  await input.click();
  await input.evaluate((e) => e.select());
  await input.type(name);
  await page
    .waitForFunction((name, lib) => [...document.querySelectorAll(".part-list button")].some((b) => b.querySelector(".part-name")?.childNodes[0]?.textContent?.trim() === name && b.textContent.includes(lib)), { timeout: 8000 }, name, lib)
    .catch(() => {});
  const ok = await page.evaluate((name, lib) => {
    const b = [...document.querySelectorAll(".part-list button")].find((b) => {
      const n = b.querySelector(".part-name");
      return n && n.childNodes[0]?.textContent?.trim() === name && n.textContent.includes(lib);
    });
    b?.click();
    return !!b;
  }, name, lib);
  if (!ok) return expect(false, `part ${lib}:${name} in the picker`);
  await page.waitForFunction((name) => document.querySelector(".edit-hint")?.textContent?.startsWith(`Click to place ${name} `), { timeout: 10000 }, name).catch(() => expect(false, `placing ${name}`));
  await clickSch(at);
  await idle();
  await page.keyboard.press("Escape");
  await wait(150);
}
for (const part of PARTS) await place(part.sym[0], part.sym[1], part.at);
let p = await proj();
const refs = p.components.map((c) => c.reference).sort();
expect(PARTS.every((x) => refs.includes(x.ref)), `components: ${refs.join(", ")}`);
await page.evaluate(() => document.querySelector('.view-tools button')?.click());
await wait(300);
await shot("1-placed");

step("power symbols and net labels on the pins");
const items = await sheetItems();
const tip = (ref, pin) => items.find((i) => i.kind === "pin" && i.ref === ref && i.pin === String(pin))?.points[0];
async function power(name, at) {
  await page.keyboard.press("p");
  await page.waitForSelector(".power-quick button");
  await page.evaluate((name) => [...document.querySelectorAll(".power-quick button")].find((b) => b.textContent === name)?.click(), name);
  await page.waitForFunction((name) => document.querySelector(".edit-hint")?.textContent?.startsWith(`Click to place ${name} `), { timeout: 10000 }, name).catch(() => expect(false, `placing ${name}`));
  await clickSch(at);
  await idle();
  await page.keyboard.press("Escape");
  await wait(100);
}
const done = new Set();
const labels = [];
for (const part of PARTS) {
  for (const [pin, net] of Object.entries(part.pins)) {
    const at = tip(part.ref, pin);
    if (!at) continue; // hidden pins stacked on a visible one (the ATmega's extra GND / VCC, the crystal's second G)
    const key = `${at.x},${at.y}`;
    if (done.has(key)) continue; // stacked pins (USB-C VBUS / GND)
    done.add(key);
    if (net.startsWith("~")) labels.push([net.slice(1), at]);
    else await power(net, at);
  }
}
// The connector powers the board: PWR_FLAG on VBUS and GND, as ERC asks.
await power("PWR_FLAG", tip("J1", "A4"));
await power("PWR_FLAG", tip("J1", "A1"));
await page.keyboard.press("l");
for (const [name, at] of labels) {
  globalThis.nextPrompt = name;
  await clickSch(at);
  await idle();
}
await page.keyboard.press("Escape");
await wait(300);
p = await proj();
const net = (n) => p.nets.find((x) => x.name === n || x.name === `/${n}`);
for (const [n, count] of [["GND", 26], ["+3V3", 12], ["VBUS", 7], ["USB_D+", 3], ["USB_D-", 3], ["MCU_D+", 2], ["XTAL1", 3]])
  expect(net(n)?.nodes.length === count, `${n}: ${net(n)?.nodes.length} pins (want ${count})`);

step("ERC: no-connect the unused pins");
await tab("Issues");
await wait(300);
const unconnected = p.erc.filter((v) => v.type === "pin_not_connected").length;
const clicked = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".issue-group .group-fix")].find((b) => b.textContent === "No-connect all");
  b?.click();
  return !!b;
});
expect(clicked, `No-connect all (${unconnected} pins)`);
await idle();
await wait(500);
p = await proj();
console.log("  ERC:", p.erc.map((v) => `${v.severity} ${v.type}: ${v.message}`));
expect(!p.erc.some((v) => v.severity === "error"), `ERC errors: ${p.erc.filter((v) => v.severity === "error").length}`);
await page.evaluate(() => document.querySelector('.view-tools button')?.click());
await wait(300);
await shot("2-schematic");

step("values");
await tab("Parts");
await wait(300);
for (const part of PARTS.filter((x) => x.value)) {
  await page.evaluate((ref) => [...document.querySelectorAll(".inspector .item, .inspector button")].find((b) => b.querySelector(".ref")?.textContent === ref)?.click(), part.ref);
  await wait(250);
  const field = await page.evaluateHandle(() => [...document.querySelectorAll(".field-editor label")].find((l) => l.querySelector("span")?.textContent === "Value")?.querySelector("input"));
  if (!field.asElement()) {
    expect(false, `${part.ref} value field`);
    continue;
  }
  await field.asElement().click();
  await field.asElement().evaluate((e) => e.select());
  await field.asElement().type(part.value);
  await page.keyboard.press("Enter");
  await idle();
  await page.keyboard.press("Escape");
  await wait(150);
  await tab("Parts");
}
p = await proj();
const wrong = PARTS.filter((x) => x.value && p.components.find((c) => c.reference === x.ref)?.value !== x.value);
expect(!wrong.length, `values: ${wrong.map((x) => `${x.ref}=${p.components.find((c) => c.reference === x.ref)?.value}`).join(" ") || "all set"}`);

step("footprints");
await page.evaluate(() => document.querySelector('button[title^="Assign footprints"]')?.click());
await page.waitForSelector(".fp-assign");
for (const part of PARTS.filter((x) => x.fp)) {
  const fp = part.fp;
  if (!(await page.$(".fp-chooser")) || !(await page.evaluate(() => document.querySelector(".fp-chooser strong")?.textContent ?? "")).includes(part.ref)) {
    if (await page.$(".fp-chooser")) await page.click(".fp-chooser .icon-btn");
    await page.evaluate((ref) => [...document.querySelectorAll(".fp-table tbody tr")].find((r) => r.querySelector("td")?.textContent === ref)?.click(), part.ref);
  }
  await page.waitForSelector(".fp-chooser");
  const name = fp.slice(fp.indexOf(":") + 1);
  await page.type(".fp-chooser .fp-filters input", name);
  await page.waitForFunction((name) => [...document.querySelectorAll(".fp-list button")].some((b) => b.querySelector(".part-name")?.textContent === name), { timeout: 5000 }, name).catch(() => {});
  const found = await page.evaluate((fp) => {
    const b = [...document.querySelectorAll(".fp-list button")].find((b) => b.querySelector(".part-name")?.textContent === fp.slice(fp.indexOf(":") + 1) && b.textContent.includes(fp.slice(0, fp.indexOf(":"))));
    b?.click();
    return !!b;
  }, fp);
  const filters = await page.evaluate(() => document.querySelector(".fp-filters")?.textContent);
  expect(found, `${part.ref}: ${fp} offered by the chooser (filters: ${filters})`);
  await page.evaluate(() => [...document.querySelectorAll(".fp-chooser .update-actions button")].find((b) => b.textContent === "Assign")?.click());
  await idle();
  await wait(200);
}
if (await page.$(".fp-chooser")) await page.click(".fp-chooser .icon-btn");
await page.click(".fp-assign .icon-btn");
p = await proj();
const noFp = p.components.filter((c) => !c.reference.startsWith("#") && !c.footprint);
expect(!noFp.length, `footprints: ${noFp.map((c) => c.reference).join(", ") || "all assigned"}`);
for (const part of PARTS.filter((x) => x.fp)) {
  const c = p.components.find((c) => c.reference === part.ref);
  if (c?.footprint !== part.fp) expect(false, `${part.ref} footprint ${c?.footprint}`);
}
expect(!p.erc.some((v) => v.severity === "error"), "ERC still clean");
if (STOP === "schematic") await finish();

step("board: update from schematic");
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await page.evaluate(() => document.querySelector('button[title^="Update PCB"]')?.click());
await wait(400);
await page.evaluate(() => [...document.querySelectorAll("button.primary")].find((b) => b.textContent.includes("Update PCB"))?.click());
await idle();
await wait(800);
p = await proj();
expect(p.board.footprints.length === PARTS.length, `board footprints: ${p.board.footprints.length}`);
await shot("3-updated");

step("board: place the parts by hand");
// Where each part goes, relative to the board's top-left corner (mm). USB-C on the left edge,
// facing out; the MCU in the middle; its decoupling, crystal and USB resistors beside the pins.
const PLACE = {
  // R4 (D-) above R3 (D+): the ATmega has D- above D+, so the pair arrives in that order without crossing.
  J1: [4, 15, 270], R1: [5, 6], R2: [5, 24], R4: [11.5, 14.25], R3: [11.5, 15.75], C3: [12, 21],
  U2: [21, 15], C4: [26, 6.5], C5: [25, 23.5], C6: [29.5, 19.5], Y1: [17, 26.5], C7: [12.5, 26.5], C8: [21.5, 27],
  R5: [12, 9], R6: [29.5, 10.5], U1: [36, 7], C1: [29, 3.5], C2: [42, 13], R7: [33.5, 18], D1: [37.5, 18], J2: [42, 20],
};
const W = 46;
const H = 31;
const before0 = p.board.footprints;
const fpBox = before0.flatMap((f) => f.pads.map((x) => x.at));
// Build the layout clear of where Update PCB packed the new parts.
const O = { x: Math.round(Math.min(...fpBox.map((q) => q.x)) - W - 15), y: Math.round(Math.min(...fpBox.map((q) => q.y))) };
const fpOf = async (ref) => (await proj()).board.footprints.find((f) => f.reference === ref);
const grab = (fp) => fp.pads.find((x) => x.number && x.number !== "SH") ?? fp.pads[0];
{
  // Frame both areas before dragging.
  const c = await brd({ x: O.x + W / 2 + 20, y: O.y + H / 2 });
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel({ deltaY: 500 });
  await wait(300);
}
for (const [ref, [dx, dy, rot]] of Object.entries(PLACE)) {
  let fp = await fpOf(ref);
  if (rot) {
    await clickBrd(grab(fp).at);
    for (let k = 0; k < rot / 90; k++) {
      await page.keyboard.press("r");
      await idle();
      await wait(150);
    }
    await page.keyboard.press("Escape");
    fp = await fpOf(ref);
    expect((((Math.round(fp.rotation) % 360) + 360) % 360) === rot, `${ref} rotated to ${fp.rotation}`);
  }
  const target = { x: O.x + dx, y: O.y + dy };
  const g = grab(fp);
  const a = await brd(g.at);
  const b = await brd({ x: g.at.x + target.x - fp.at.x, y: g.at.y + target.y - fp.at.y });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
  await idle();
  await wait(250);
  await page.keyboard.press("Escape");
  const after = await fpOf(ref);
  if (Math.hypot(after.at.x - target.x, after.at.y - target.y) > 0.6) expect(false, `${ref} placed at ${(after.at.x - O.x).toFixed(2)},${(after.at.y - O.y).toFixed(2)} (want ${dx},${dy})`);
}
p = await proj();
const j1 = p.board.footprints.find((f) => f.reference === "J1");
expect(j1.pads.filter((x) => /^[AB]\d/.test(x.number)).every((x) => x.at.x > j1.at.x), "USB-C pads face into the board (mouth at the edge)");

step("board: tidy the silkscreen (drag R3's reference below it)");
{
  await page.evaluate(() => document.querySelector(".view-tools button")?.click());
  await wait(300);
  const r3 = await fpOf("R3");
  const t = r3.texts.find((x) => x.text === "R3" && x.layer === "F.SilkS");
  const a = await brd(t.at);
  const b = await brd({ x: t.at.x, y: t.at.y + 2.75 });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await idle();
  await wait(300);
  await page.keyboard.press("Escape");
  const after = await fpOf("R3");
  const t1 = after.texts.find((x) => x.text === "R3" && x.layer === "F.SilkS");
  expect(Math.abs(t1.at.y - t.at.y - 2.75) < 0.01 && after.at.x === r3.at.x && after.at.y === r3.at.y, `R3's reference moved ${(t1.at.y - t.at.y).toFixed(2)} mm, the part stayed`);
}

step("board: outline");
await page.evaluate(() => document.querySelector('button[title^="Board outline"]')?.click());
await wait(200);
await page.select('select[title="Outline shape"]', "1");
await page.evaluate(() => document.querySelector(".view-tools button")?.click());
await wait(400);
// The connector's shell overhangs the edge by a little, as USB-C receptacles do.
await clickBrd({ x: O.x + 0.5, y: O.y });
await clickBrd({ x: O.x + W, y: O.y + H });
await idle();
await page.keyboard.press("Escape");
p = await proj();
expect(p.board.outline.length === 8, `rounded outline: ${p.board.outline.length} pieces`);
expect(!p.boardChecks.length, "placement issues:", p.boardChecks.map((v) => `${v.type}: ${v.items.map((i) => i.description).join(" / ")}`).join("; ") || "none");
await shot("4-placed");
if (STOP === "placed") await finish();

step("board setup: copper to hole for this fab");
// The USB-C receptacle's own GND contacts sit 0.18 mm from its locating pegs: the board takes the
// fab's copper-to-hole figure instead of KiCad's 0.25 mm default (use your fab's number).
await page.evaluate(() => document.querySelector('button[title^="Board setup"]')?.click());
await page.waitForSelector(".setup-presets");
if (LAYERS === 4) {
  // The fab's four-layer preset: its rules, four copper layers and its stackup.
  await page.evaluate(() => [...document.querySelectorAll(".setup-presets button")].find((b) => b.textContent.includes("JLCPCB 4-layer"))?.click());
  await idle();
  await wait(500);
  // The USB pairs in a class of their own, sized for 90 Ω on that stackup.
  globalThis.nextPrompt = "USB";
  await page.evaluate(() => [...document.querySelectorAll(".board-setup button")].find((b) => b.textContent.includes("Add net class"))?.click());
  await idle();
  await wait(400);
  const nets = await page.evaluateHandle(() => {
    const block = [...document.querySelectorAll(".net-class")].find((b) => b.querySelector("strong")?.textContent === "USB");
    return [...(block?.querySelectorAll("label.prop") ?? [])].find((l) => l.querySelector("span")?.textContent === "Nets")?.querySelector("input");
  });
  await nets.asElement().click();
  await nets.asElement().evaluate((e) => e.select());
  await nets.asElement().type("USB_D*, MCU_D*");
  await page.keyboard.press("Enter");
  await idle();
  await wait(300);
  const before = await page.evaluate(() => [...document.querySelectorAll(".net-class")].find((b) => b.querySelector("strong")?.textContent === "USB")?.textContent.match(/≈ (\d+) Ω/)?.[1]);
  await page.evaluate(() => [...[...document.querySelectorAll(".net-class")].find((b) => b.querySelector("strong")?.textContent === "USB").querySelectorAll("button")].find((b) => b.textContent.includes("Size for 90"))?.click());
  await idle();
  await wait(400);
  const after = await page.evaluate(() => [...document.querySelectorAll(".net-class")].find((b) => b.querySelector("strong")?.textContent === "USB")?.textContent.match(/≈ (\d+) Ω/)?.[1]);
  p = await proj();
  const usb = p.designRules.classes.find((c) => c.name === "USB");
  console.log(`  USB pair: ${before} Ω → ${after} Ω, width ${usb?.diffPairWidth} mm, gap ${usb?.diffPairGap} mm`);
  expect(Math.abs(Number(after) - 90) <= 1, `USB pair sized for 90 Ω: ${after}`);
}
{
  const field = await page.evaluateHandle(() => [...document.querySelectorAll("label.prop")].find((l) => l.querySelector("span")?.textContent === "Copper to hole")?.querySelector("input"));
  expect(!!field.asElement(), "Copper to hole field");
  await field.asElement().click();
  await field.asElement().evaluate((e) => e.select());
  await field.asElement().type("0.18");
  await page.keyboard.press("Enter");
  await idle();
  await wait(300);
}
if (LAYERS !== 2 && LAYERS !== 4) {
  await page.evaluate((n) => {
    const sel = [...document.querySelectorAll("label.prop")].find((l) => l.querySelector("span")?.textContent === "Copper layers")?.querySelector("select");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, String(n));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, LAYERS);
  await idle();
  await wait(500);
}
if (LAYERS !== 2) {
  p = await proj();
  expect(p.board.copperLayers.length === LAYERS, `copper layers: ${p.board.copperLayers.join(", ")}`);
  if (LAYERS === 4) expect(p.board.copperThickness?.["In1.Cu"] === 0.0152, `stackup: ${JSON.stringify(p.board.copperThickness)}`);
  const shown = await page.evaluate(() => [...document.querySelectorAll("label.layer")].filter((l) => /In\d\.Cu/.test(l.textContent) && l.querySelector("input")?.checked).length);
  expect(shown === LAYERS - 2, `inner layers shown: ${shown}`);
}
await page.evaluate(() => document.querySelector('button[title^="Board setup"]')?.click());

step("board: the USB pairs as differential pairs");
const padOf = (ref, num) => p.board.footprints.find((f) => f.reference === ref).pads.find((x) => x.number === num);
await page.keyboard.press("x");
await page.keyboard.press("6");
await wait(200);
for (const [a, b, nets] of [[["J1", "A6"], ["R3", "1"], ["USB_D+", "USB_D-"]], [["R3", "2"], ["U2", "4"], ["MCU_D+", "MCU_D-"]]]) {
  p = await proj();
  await clickBrd(padOf(...a).at);
  const hint = await page.evaluate(() => document.querySelector(".edit-hint")?.textContent ?? "");
  await clickBrd(padOf(...b).at);
  await idle();
  await wait(400);
  const hint2 = await page.evaluate(() => document.querySelector(".edit-hint")?.textContent ?? "");
  if (hint2.startsWith("Routing pair") || hint2.includes("·")) console.log("  after the end click:", hint2.slice(0, 160));
  p = await proj();
  const left = p.unconnected.filter((u) => nets.some((n) => u.net.endsWith(n)));
  // J1's second D+ / D- pads (B6 / B7) still need their own short link.
  const wantLeft = nets[0] === "USB_D+" ? 2 : 0;
  expect(left.length <= wantLeft, `${nets.join(" / ")} routed as a pair (left: ${left.map((u) => `${u.net} ${u.a.ref ?? ""}`).join(", ") || "none"}; hint: ${hint.slice(0, 90)})`);
  expect(p.clearance.length === 0, `clearance after ${nets[0]}: ${p.clearance.map((c) => c.items?.map((i) => i.description).join(" / ") ?? c.message).join(", ") || "none"}`);
}
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await shotBrd("5-pairs", { x: O.x, y: O.y + 8, w: 18, h: 14 });

step(LAYERS === 2 ? "board: GND pours on both sides" : "board: GND and +3V3 planes inside");
await page.evaluate(() => document.querySelector('button[title="Copper zone (pour)"]')?.click());
await wait(200);
const POURS = LAYERS === 2 ? [["F.Cu", "GND"], ["B.Cu", "GND"]] : [["In1.Cu", "GND"], ["In2.Cu", "+3V3"]];
for (const [layer, netName] of POURS) {
  await page.select('select[title="Routing layer"]', layer);
  const value = await page.evaluate((n) => [...document.querySelectorAll('select[title="Net for new zones"] option')].find((o) => o.value === n || o.value === `/${n}`)?.value, netName);
  await page.select('select[title="Net for new zones"]', value);
  await page.evaluate(() => document.querySelector('button[title^="A zone covering"]')?.click());
  await idle();
  await wait(400);
}
await page.keyboard.press("Escape");
p = await proj();
const zoneNets = p.board.zones.map((z) => `${z.net} ${z.layers}`);
expect(p.board.zones.length === 2 && p.board.zones.every((z, k) => z.net.endsWith(POURS[k][1]) && z.layers.includes(POURS[k][0])), `zones: ${zoneNets.join(", ")}`);

// Fine-pitch pins can't take two thermal spokes each: the front pour joins its pads solidly.
if (LAYERS === 2) {
  const z = p.board.zones.find((x) => x.layers.includes("F.Cu"));
  const a = z.outline[0];
  const b = z.outline[1];
  await page.evaluate(() => document.querySelector(".view-tools button")?.click());
  await wait(300);
  await clickBrd({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const hasPads = await page.evaluate(() => !![...document.querySelectorAll("label.prop span")].find((x) => x.textContent === "Pads"));
  expect(hasPads, "zone pad connection setting");
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll("label.prop")].find((l) => l.querySelector("span")?.textContent === "Pads")?.querySelector("select");
    if (sel) {
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      set.call(sel, "solid");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await idle();
  await wait(400);
  await page.keyboard.press("Escape");
  p = await proj();
  expect(p.board.zones.find((x) => x.layers.includes("F.Cu"))?.connect === "solid", `F.Cu zone pads: ${p.board.zones.map((x) => x.layers + " " + x.connect).join(", ")}`);
}
if (STOP === "poured") await finish();

step("board: route the rest");
const todo = p.unconnected.filter((u) => !/GND$/.test(u.net)).length;
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Route all"))?.click());
await idle();
await wait(800);
await page.keyboard.press("b");
await idle();
await wait(500);
p = await proj();
console.log(`  ${todo} connections to route; unrouted now: ${p.unconnected.map((u) => `${u.net} ${u.a.description} → ${u.b.description}`).join("; ") || "none"}`);
expect(p.unconnected.length === 0, `unrouted: ${p.unconnected.length}`);
expect(p.clearance.length === 0, `clearance: ${p.clearance.length}`);
if (LAYERS === 4) expect(!p.board.tracks.some((t) => /^In\d/.test(t.layer)), `tracks on the planes: ${p.board.tracks.filter((t) => /^In\d/.test(t.layer)).length}`);
expect(!p.boardChecks.length, `DRC after Route all: ${p.boardChecks.map((v) => v.type).join(", ") || "clean"}`);
console.log("  DRC:", p.boardChecks.map((v) => `${v.severity} ${v.type}: ${v.items.map((i) => i.description).join(" / ")}`));
await page.evaluate(() => document.querySelector(".view-tools button")?.click());
await wait(300);
await shot("6-routed");
for (const [k, u] of p.unconnected.entries()) await shotBrd(`6-unrouted-${k}`, { x: Math.min(u.a.at.x, u.b.at.x) - 4, y: Math.min(u.a.at.y, u.b.at.y) - 4, w: Math.abs(u.a.at.x - u.b.at.x) + 8, h: Math.abs(u.a.at.y - u.b.at.y) + 8 });
if (STOP === "routed") await finish();

step("board: match the lengths of the MCU-side USB pair");
{
  p = await proj();
  const lenOf = (n) => p.netLengths?.[n];
  const t = p.board.tracks.filter((x) => x.net.endsWith("MCU_D+")).sort((a, b) => Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y) - Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y))[0];
  await page.evaluate(() => document.querySelector(".view-tools button")?.click());
  await wait(300);
  await clickBrd({ x: (t.start.x + t.end.x) / 2, y: (t.start.y + t.end.y) / 2 });
  await wait(300);
  const skew = () => page.evaluate(() => /Pair skew (-?[\d.]+)/.exec(document.querySelector(".length-tuning")?.textContent ?? "")?.[1]);
  const s0 = await skew();
  await page.evaluate(() => [...document.querySelectorAll(".length-tuning button")].find((b) => b.textContent.includes("Match pair"))?.click());
  await idle();
  await wait(800);
  const s1 = await skew();
  console.log(`  pair skew ${s0} → ${s1} mm`);
  expect(s0 !== undefined && s1 !== undefined && Math.abs(Number(s1)) < 0.05, `MCU pair skew matched: ${s0} → ${s1}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("b");
  await idle();
  p = await proj();
  expect(!p.clearance.length && !p.boardChecks.length, `DRC after matching: ${[...p.clearance, ...p.boardChecks].map((v) => v.type).join(", ") || "clean"}`);
  void lenOf;
}

step("silkscreen: name and version");
await page.evaluate(() => document.querySelector('button[title="Silkscreen text"]')?.click());
await wait(200);
globalThis.nextPrompt = "usbmcu v1";
await clickBrd({ x: O.x + 36, y: O.y + 27.5 });
await idle();
await page.keyboard.press("Escape");
p = await proj();
expect(p.board.texts.some((t) => t.text === "usbmcu v1"), "board name on the silkscreen");
expect(!p.boardChecks.length && !p.clearance.length, `DRC after the text: ${[...p.boardChecks, ...p.clearance].map((v) => v.type).join(", ") || "clean"}`);

step("fab outputs");
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT });
await page.evaluate(() => document.querySelector('button[title^="Gerbers, drill files"]')?.click());
await page.waitForSelector(".fab-export");
const checks = await page.evaluate(() => [...document.querySelectorAll(".fab-export .checks li")].map((li) => `${li.className}: ${li.textContent}`));
expect(checks.every((c) => c.startsWith("ok")), `pre-flight: ${checks.filter((c) => !c.startsWith("ok")).join("; ") || "all green"}`);
await page.evaluate(() => [...document.querySelectorAll(".fab-export .update-actions button")].find((b) => b.textContent.includes("Download"))?.click());
await wait(2000);
expect(existsSync(`${OUT}/usbmcu-fab.zip`) && statSync(`${OUT}/usbmcu-fab.zip`).size > 1000, "usbmcu-fab.zip downloaded");
await page.click(".fab-export .icon-btn");
await page.evaluate(() => document.querySelector(".view-tools button")?.click());
await wait(300);
await shot("7-done");
await save();

step("KiCad's own checks on the saved project");
try {
  execFileSync("kicad-cli", ["sch", "erc", "--severity-error", "--format", "json", "-o", `${OUT}/erc.json`, `${OUT}/usbmcu.kicad_sch`], { stdio: "ignore" });
  execFileSync("kicad-cli", ["pcb", "drc", "--schematic-parity", "--severity-all", "--format", "json", "-o", `${OUT}/drc.json`, `${OUT}/usbmcu.kicad_pcb`], { stdio: "ignore" });
  const erc = JSON.parse(readFileSync(`${OUT}/erc.json`, "utf8"));
  const drc = JSON.parse(readFileSync(`${OUT}/drc.json`, "utf8"));
  const ercN = erc.sheets.reduce((n, sh) => n + sh.violations.length, 0);
  expect(ercN === 0, `KiCad ERC errors: ${ercN}`);
  expect(drc.violations.length === 0, `KiCad DRC: ${drc.violations.map((v) => v.type).join(", ") || "clean"}`);
  expect(drc.unconnected_items.length === 0, `KiCad unconnected: ${drc.unconnected_items.length}`);
  expect(drc.schematic_parity.length === 0, `KiCad parity: ${drc.schematic_parity.length}`);
} catch (e) {
  console.log("  (kicad-cli not available:", e.message, ")");
}
await finish();

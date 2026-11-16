// End-to-end, fourth board: a through-hole 5 V supply (barrel jack, polyfuse, reverse-polarity
// diode, 7805 in TO-220, electrolytics, screw terminal, power LED) with a Power net class for wide
// tracks, mounting holes in the corners and a GND pour, built in the UI from a new project.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-power.mjs <out-dir>
// BROWSER = a Chromium-based browser executable; APP_URL = the app (default http://localhost:5173/);
// STOP = schematic | placed: stop after that stage (and save what there is).
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

// The design, as in e2e-usb.mjs: each pin's power symbol or ~label.
const G = "GND";
const P5 = "+5V";
const PARTS = [
  { ref: "J1", sym: ["Connector", "Barrel_Jack_Switch"], at: { x: 63.5, y: 101.6 }, value: "12V in", fp: "Connector_BarrelJack:BarrelJack_Horizontal", pins: { 1: "~VIN_RAW", 2: G } },
  { ref: "F1", sym: ["Device", "Polyfuse"], at: { x: 88.9, y: 88.9 }, value: "0.5A", fp: "Fuse:Fuse_Bourns_MF-RG300", pins: { 1: "~VIN_RAW", 2: "~VIN_F" } },
  { ref: "D1", sym: ["Diode", "1N4007"], at: { x: 109.22, y: 88.9 }, pins: { 2: "~VIN_F", 1: "~VIN" } },
  { ref: "C1", sym: ["Device", "C_Polarized"], at: { x: 127, y: 109.22 }, value: "470u", fp: "Capacitor_THT:CP_Radial_D10.0mm_P5.00mm", pins: { 1: "~VIN", 2: G } },
  { ref: "C2", sym: ["Device", "C"], at: { x: 139.7, y: 109.22 }, value: "330n", fp: "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm", pins: { 1: "~VIN", 2: G } },
  { ref: "U1", sym: ["Regulator_Linear", "L7805"], at: { x: 160.02, y: 88.9 }, fp: "Package_TO_SOT_THT:TO-220-3_Vertical", pins: { 1: "~VIN", 2: G, 3: P5 } },
  { ref: "C3", sym: ["Device", "C_Polarized"], at: { x: 182.88, y: 109.22 }, value: "100u", fp: "Capacitor_THT:CP_Radial_D6.3mm_P2.50mm", pins: { 1: P5, 2: G } },
  { ref: "J2", sym: ["Connector", "Screw_Terminal_01x02"], at: { x: 213.36, y: 101.6 }, value: "5V out", fp: "TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-2_1x02_P5.00mm_Horizontal", pins: { 1: P5, 2: G } },
  { ref: "R1", sym: ["Device", "R"], at: { x: 195.58, y: 109.22 }, value: "1k", fp: "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal", pins: { 1: P5, 2: "~LED_A" } },
  { ref: "D2", sym: ["Device", "LED"], at: { x: 195.58, y: 132.08 }, value: "green", fp: "LED_THT:LED_D5.0mm", pins: { 2: "~LED_A", 1: G } },
];
step("new project");
await page.goto(URL, { waitUntil: "networkidle0" });
await page.type('input[aria-label="Project name"]', "powersupply");
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
// The jack powers the board: PWR_FLAG on its input and GND (the regulator's input is a power input).
await power("PWR_FLAG", tip("C1", "1"));
await power("PWR_FLAG", tip("J1", "2"));
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
for (const [n, count] of [["GND", 7], ["+5V", 4], ["VIN", 4], ["VIN_RAW", 2], ["LED_A", 2]])
  expect(net(n)?.nodes.length === count, `${n}: ${net(n)?.nodes.length} pins (want ${count})`);

step("ERC: no-connect the unused pins");
await tab("Issues");
await wait(300);
const unconnected = p.erc.filter((v) => v.type === "pin_not_connected").length;
// One spare pin (the jack's switch): its own No-connect fix.
const clicked = await page.evaluate(() => {
  document.querySelectorAll("details.issue-group").forEach((d) => (d.open = true));
  const b = [...document.querySelectorAll(".issue-row .quick-fix")].find((b) => b.textContent === "No-connect");
  b?.click();
  return !!b;
});
expect(clicked && unconnected === 1, `No-connect on the spare pin (${unconnected} unconnected)`);
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
  // The symbol's own filters may not cover the part chosen (KiCad's Polyfuse filters miss PTC footprints): untick them.
  if (!(await page.evaluate((name) => [...document.querySelectorAll(".fp-list button")].some((b) => b.querySelector(".part-name")?.textContent === name), name))) {
    await page.evaluate(() => [...document.querySelectorAll(".fp-filters input[type=checkbox]")].find((c) => c.checked)?.click());
    await page.waitForFunction((name) => [...document.querySelectorAll(".fp-list button")].some((b) => b.querySelector(".part-name")?.textContent === name), { timeout: 8000 }, name).catch(() => {});
  }
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

step("board setup: a Power net class for the supply nets");
await page.evaluate(() => document.querySelector('button[title^="Board setup"]')?.click());
await page.waitForSelector(".setup-presets");
globalThis.nextPrompt = "Power";
await page.evaluate(() => [...document.querySelectorAll(".board-setup button")].find((b) => b.textContent.includes("Add net class"))?.click());
await idle();
await wait(500);
async function classField(cls, label, value) {
  const el = await page.evaluateHandle((cls, label) => {
    const block = [...document.querySelectorAll(".net-class")].find((b) => b.querySelector("strong")?.textContent === cls);
    return [...(block?.querySelectorAll("label.prop") ?? [])].find((l) => l.querySelector("span")?.textContent === label)?.querySelector("input");
  }, cls, label);
  if (!el.asElement()) return expect(false, `${cls} ${label} field`);
  await el.asElement().click();
  await el.asElement().evaluate((e) => e.select());
  await el.asElement().type(value);
  await page.keyboard.press("Enter");
  await idle();
  await wait(300);
}
await classField("Power", "Track width", "1");
await classField("Power", "Clearance", "0.3");
await classField("Power", "Nets", "VIN*, GND, +5V");
await page.evaluate(() => document.querySelector('button[title^="Board setup"]')?.click());
p = await proj();
const powerClass = p.designRules.classes.find((c) => c.name === "Power");
expect(powerClass?.trackWidth === 1 && powerClass?.clearance === 0.3, `Power class: ${JSON.stringify(powerClass)}`);
const classOf = (n) => p.netClasses[p.board.nets.find((x) => x === n || x === `/${n}`)]?.name;
expect(["VIN", "VIN_RAW", "GND", "+5V"].every((n) => classOf(n) === "Power") && classOf("LED_A") === "Default", `net classes: ${p.board.nets.map((n) => `${n}=${p.netClasses[n]?.name}`).join(" ")}`);

step("board: place the parts by hand");
// The jack's mouth at the left edge (its body runs 13.8 mm behind pad 1); corners kept free for the holes.
const PLACE = { J1: [14.5, 22], F1: [20, 8], D1: [22, 36], C1: [34, 12], C2: [34, 30], U1: [46, 22], C3: [56, 10], J2: [57, 27], R1: [38, 39], D2: [55, 39] };
const W = 70;
const H = 46;
const fpBox = p.board.footprints.flatMap((f) => f.pads.map((x) => x.at));
const O = { x: Math.round(Math.min(...fpBox.map((q) => q.x)) - W - 15), y: Math.round(Math.min(...fpBox.map((q) => q.y))) };
const fpOf = async (ref) => (await proj()).board.footprints.find((f) => f.reference === ref);
{
  const c = await brd({ x: O.x + W / 2 + 20, y: O.y + H / 2 });
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel({ deltaY: 500 });
  await wait(300);
}
for (const [ref, [dx, dy]] of Object.entries(PLACE)) {
  const fp = await fpOf(ref);
  const target = { x: O.x + dx, y: O.y + dy };
  const g = fp.pads[0];
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
  if (Math.hypot(after.at.x - target.x, after.at.y - target.y) > 0.6) expect(false, `${ref} placed at ${(after.at.x - O.x).toFixed(2)},${(after.at.y - O.y).toFixed(2)}`);
}

step("board: outline and mounting holes");
await page.evaluate(() => document.querySelector(".view-tools button")?.click());
await wait(400);
await page.evaluate(() => document.querySelector('button[title^="Board outline"]')?.click());
await wait(200);
await page.select('select[title="Outline shape"]', "1");
await clickBrd({ x: O.x, y: O.y });
await clickBrd({ x: O.x + W, y: O.y + H });
await idle();
await page.evaluate(() => document.querySelector('button[title^="Four M3 mounting holes"]')?.click());
await idle();
await wait(500);
p = await proj();
expect(p.board.footprints.filter((f) => f.reference.startsWith("H")).length === 4, "four mounting holes");
await page.keyboard.press("Escape");
expect(!p.boardChecks.length, `placement issues: ${p.boardChecks.map((v) => `${v.type}: ${v.items.map((i) => i.description).join(" / ")}`).join("; ") || "none"}`);
await page.evaluate(() => document.querySelector(".view-tools button")?.click());
await wait(400);
await shot("4-placed");
if (STOP === "placed") await finish();

step("board: GND pour on the back, route the rest");
await page.evaluate(() => document.querySelector('button[title="Copper zone (pour)"]')?.click());
await wait(200);
await page.select('select[title="Routing layer"]', "B.Cu");
await page.select('select[title="Net for new zones"]', await page.evaluate(() => [...document.querySelectorAll('select[title="Net for new zones"] option')].find((o) => o.value === "GND")?.value));
await page.evaluate(() => document.querySelector('button[title^="A zone covering"]')?.click());
await idle();
await wait(400);
await page.keyboard.press("Escape");
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Route all"))?.click());
await idle();
await wait(800);
await page.keyboard.press("b");
await idle();
await wait(500);
p = await proj();
console.log(`  unrouted: ${p.unconnected.map((u) => `${u.net} ${u.a.description} → ${u.b.description}`).join("; ") || "none"}`);
expect(p.unconnected.length === 0, `unrouted: ${p.unconnected.length}`);
expect(p.clearance.length === 0, `clearance: ${p.clearance.length}`);
console.log("  DRC:", p.boardChecks.map((v) => `${v.severity} ${v.type}: ${v.items.map((i) => i.description).join(" / ")}`));
const widths = new Map();
for (const t of p.board.tracks) widths.set(t.net, [...new Set([...(widths.get(t.net) ?? []), t.width])]);
console.log("  track widths:", [...widths].map(([n, w]) => `${n} ${w.join("/")}`).join(", "));
expect(p.board.tracks.filter((t) => /VIN|\+5V/.test(t.net)).every((t) => t.width === 1), "supply tracks are 1 mm");
await page.evaluate(() => document.querySelector(".view-tools button")?.click());
await wait(300);
await shot("5-routed");

step("fab outputs");
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT });
await page.evaluate(() => document.querySelector('button[title^="Gerbers, drill files"]')?.click());
await page.waitForSelector(".fab-export");
const checks = await page.evaluate(() => [...document.querySelectorAll(".fab-export .checks li")].map((li) => `${li.className}: ${li.textContent}`));
expect(checks.every((c) => c.startsWith("ok")), `pre-flight: ${checks.filter((c) => !c.startsWith("ok")).join("; ") || "all green"}`);
await page.click(".fab-export .icon-btn");
await save();

step("KiCad's own checks on the saved project");
try {
  execFileSync("kicad-cli", ["sch", "erc", "--severity-error", "--format", "json", "-o", `${OUT}/erc.json`, `${OUT}/powersupply.kicad_sch`], { stdio: "ignore" });
  execFileSync("kicad-cli", ["pcb", "drc", "--schematic-parity", "--severity-all", "--format", "json", "-o", `${OUT}/drc.json`, `${OUT}/powersupply.kicad_pcb`], { stdio: "ignore" });
  const erc = JSON.parse(readFileSync(`${OUT}/erc.json`, "utf8"));
  const drc = JSON.parse(readFileSync(`${OUT}/drc.json`, "utf8"));
  const ercN = erc.sheets.reduce((n, sh) => n + sh.violations.length, 0);
  expect(ercN === 0, `KiCad ERC errors: ${ercN}`);
  expect(drc.violations.length === 0, `KiCad DRC: ${drc.violations.map((v) => `${v.type} (${v.items.map((i) => i.description).join(" / ")})`).join("; ") || "clean"}`);
  expect(drc.unconnected_items.length === 0, `KiCad unconnected: ${drc.unconnected_items.length}`);
  expect(drc.schematic_parity.length === 0, `KiCad parity: ${drc.schematic_parity.length}`);
} catch (e) {
  console.log("  (kicad-cli:", e.message, ")");
}
await finish();

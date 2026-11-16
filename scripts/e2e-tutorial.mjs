// End-to-end: KiCad's getting-started board (battery, resistor, LED) built in the UI from a new project.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-tutorial.mjs <out-dir>
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
await page.type('input[aria-label="Project name"]', "blinky");
await page.click(".new-project button");
await page.waitForSelector(".canvas svg, .viewport.schematic svg", { timeout: 20000 });
await wait(500);
expect((await proj()).name, `project opened: ${(await proj()).name}`);

step("place parts");
await page.keyboard.press("e");
await wait(200);
async function place(query, name, lib, at) {
  await page.keyboard.press("a");
  await page.waitForSelector(".part-picker input");
  const input = await page.$(".part-picker input");
  await input.click();
  await input.evaluate((e) => e.select());
  await input.type(query);
  await wait(600);
  const ok = await page.evaluate(
    (name, lib) => {
      const b = [...document.querySelectorAll(".part-list button")].find((b) => {
        const n = b.querySelector(".part-name");
        return n && n.childNodes[0]?.textContent?.trim() === name && n.textContent.includes(lib);
      });
      b?.click();
      return !!b;
    },
    name,
    lib,
  );
  if (!ok) return expect(false, `part ${lib}:${name} in picker`);
  await page.waitForFunction((name) => document.querySelector(".edit-hint")?.textContent?.startsWith(`Click to place ${name} `), { timeout: 10000 }, name).catch(() => expect(false, `placing ${name}`));
  await clickSch(at);
  await idle();
  await page.keyboard.press("Escape");
  await wait(200);
}
await place("Battery_Cell", "Battery_Cell", "Device", { x: 80.01, y: 100.33 });
await place("R", "R", "Device", { x: 100.33, y: 90.17 });
await place("LED", "LED", "Device", { x: 115.57, y: 100.33 });
// Power symbols through the Power tool (P) and its quick picks.
async function placePower(name, at) {
  await page.keyboard.press("p");
  await page.waitForSelector(".power-quick button");
  const ok = await page.evaluate((name) => {
    const b = [...document.querySelectorAll(".power-quick button")].find((b) => b.textContent === name);
    b?.click();
    return !!b;
  }, name);
  expect(ok, `power quick pick ${name}`);
  await page.waitForFunction((name) => document.querySelector(".edit-hint")?.textContent?.startsWith(`Click to place ${name} `), { timeout: 10000 }, name).catch(() => expect(false, `placing ${name}`));
  await clickSch(at);
  await idle();
  await page.keyboard.press("Escape");
  await wait(200);
}
await placePower("GND", { x: 90.17, y: 113.03 });
await placePower("PWR_FLAG", { x: 72.39, y: 104.14 });
let p = await proj();
expect(p.components.length >= 3, `components: ${p.components.map((c) => c.reference).join(", ")}`);
await shot("1-placed");

step("wire");
const pins = (await sheetItems()).filter((i) => i.kind === "pin");
const pinsOf = (ref) => pins.filter((i) => i.ref === ref).map((i) => i.points[0]);
console.log(Object.fromEntries(["BT1", "R1", "D1", "#PWR01", "#FLG01"].map((r) => [r, pinsOf(r)])));
const byY = (ref) => pinsOf(ref).sort((a, b) => a.y - b.y);
const byX = (ref) => pinsOf(ref).sort((a, b) => a.x - b.x);
await page.keyboard.press("w");
async function wire(...pts) {
  for (const q of pts) await clickSch(q);
  await idle();
}
const [btTop, btBot] = byY("BT1");
const [rTop, rBot] = byY("R1");
const [dL, dR] = byX("D1");
await wire(btTop, { x: btTop.x, y: 82.55 }, { x: rTop.x, y: 82.55 }, rTop);
await wire(rBot, { x: rBot.x, y: dL.y }, dL);
await wire(dR, { x: dR.x + 6.35, y: dR.y }, { x: dR.x + 6.35, y: 107.95 }, { x: btBot.x, y: 107.95 }, btBot);
const powerPins = (await sheetItems()).filter((i) => i.kind === "pin" && !i.ref).map((i) => i.points[0]);
const gnd = powerPins.find((q) => q.x === 90.17);
const flg = powerPins.find((q) => q.x === 72.39);
if (gnd) await wire(gnd, { x: gnd.x, y: 107.95 });
if (flg) await wire(flg, { x: flg.x, y: 107.95 }, { x: btBot.x, y: 107.95 });
await page.keyboard.press("Escape");
await wait(300);
p = await proj();
expect(p.nets.filter((n) => n.nodes.length >= 2).length >= 3, `nets: ${p.nets.map((n) => `${n.name}(${n.nodes.length})`).join(" ")}`);
await shot("2-wired");
await shotSch("2-wired-zoom", { x: 65, y: 78 }, { x: 132, y: 118 });

step("footprints");
const fps = { BT1: "Battery:BatteryHolder_Keystone_1058_1x2032", D1: "LED_THT:LED_D5.0mm", R1: "Resistor_THT:R_Axial_DIN0309_L9.0mm_D3.2mm_P12.70mm_Horizontal" };
await page.keyboard.press("Escape");
await page.evaluate(() => document.querySelector('button[title^="Assign footprints"]')?.click());
await page.waitForSelector(".fp-assign");
for (const [ref, fp] of Object.entries(fps)) {
  // The table opens the chooser for the next missing part on its own after an assignment.
  if (!(await page.$(".fp-chooser"))) {
    await page.evaluate((ref) => [...document.querySelectorAll(".fp-table tbody tr")].find((r) => r.querySelector("td")?.textContent === ref)?.click(), ref);
  }
  await page.waitForSelector(".fp-chooser");
  const title = await page.evaluate(() => document.querySelector(".fp-chooser strong")?.textContent ?? "");
  if (!title.includes(ref)) {
    await page.click(".fp-chooser .icon-btn");
    await page.evaluate((ref) => [...document.querySelectorAll(".fp-table tbody tr")].find((r) => r.querySelector("td")?.textContent === ref)?.click(), ref);
    await page.waitForSelector(".fp-chooser");
  }
  const filters = await page.evaluate(() => document.querySelector(".fp-filters")?.textContent);
  await page.type(".fp-chooser .fp-filters input", fp.slice(fp.indexOf(":") + 1));
  // The list filters as it loads: wait for the footprint to show up (up to 5 s).
  await page
    .waitForFunction((fp) => [...document.querySelectorAll(".fp-list button")].some((b) => b.querySelector(".part-name")?.textContent === fp.slice(fp.indexOf(":") + 1)), { timeout: 5000 }, fp)
    .catch(() => {});
  const found = await page.evaluate((fp) => {
    const b = [...document.querySelectorAll(".fp-list button")].find((b) => b.querySelector(".part-name")?.textContent === fp.slice(fp.indexOf(":") + 1) && b.textContent.includes(fp.slice(0, fp.indexOf(":"))));
    b?.click();
    return !!b;
  }, fp);
  expect(found, `${ref}: ${fp} offered (filters: ${filters})`);
  await page.waitForSelector(".fp-preview", { timeout: 5000 }).catch(() => expect(false, `${ref} preview`));
  await shot(`3-chooser-${ref}`);
  await page.evaluate(() => [...document.querySelectorAll(".fp-chooser .update-actions button")].find((b) => b.textContent === "Assign")?.click());
  await idle();
  await wait(300);
}
if (await page.$(".fp-chooser")) await page.click(".fp-chooser .icon-btn");
await shot("3-assigned");
await page.click(".fp-assign .icon-btn");
p = await proj();
expect(p.components.every((c) => c.reference.startsWith("#") || c.footprint), `footprints: ${p.components.map((c) => `${c.reference}=${c.footprint}`).join(" ")}`);
console.log("ERC:", p.erc.map((v) => `${v.code}: ${v.message}`));
expect(p.erc.filter((v) => v.severity === "error").length === 0, `ERC errors: ${p.erc.length}`);

step("board: update from schematic");
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("PCB")).click());
await wait(800);
if (!(await page.evaluate(() => !!document.querySelector('button[title="Edit mode (E)"].on')))) await page.keyboard.press("e");
await wait(200);
await page.evaluate(() => document.querySelector('button[title^="Update PCB"]')?.click());
await wait(500);
await page.evaluate(() => [...document.querySelectorAll("button.primary")].find((b) => b.textContent.includes("Update PCB"))?.click());
await idle();
await wait(800);
p = await proj();
expect(p.board.footprints.length === 3, `board footprints: ${p.board.footprints.map((f) => f.reference).join(", ")}`);
await shot("3-updated");

step("board: flip BT1 to the back (as the tutorial does)");
{
  const bt = (await proj()).board.footprints.find((f) => f.reference === "BT1");
  await page.keyboard.press("Escape");
  await clickBrd(bt.pads[0].at);
  await page.keyboard.press("f");
  await idle();
  await wait(300);
  const after = (await proj()).board.footprints.find((f) => f.reference === "BT1");
  expect(after.layer === "B.Cu", `BT1 on ${after.layer}`);
  await page.keyboard.press("Escape");
}
p = await proj();

step("board: outline");
const fpPts = p.board.footprints.flatMap((f) => f.pads.map((x) => x.at));
// Room for mounting holes in the corners.
const x0 = Math.floor(Math.min(...fpPts.map((q) => q.x)) - 12);
const y0 = Math.floor(Math.min(...fpPts.map((q) => q.y)) - 14);
const x1 = Math.ceil(Math.max(...fpPts.map((q) => q.x)) + 12);
const y1 = Math.ceil(Math.max(...fpPts.map((q) => q.y)) + 14);
await page.evaluate(() => document.querySelector('button[title^="Board outline"]')?.click());
await wait(200);
await page.select('select[title="Outline shape"]', "2");
{
  // Zoom out a little so the outline corners are on screen.
  const c = await brd({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel({ deltaY: 400 });
  await wait(300);
  console.log("corners on screen:", await brd({ x: x0, y: y0 }), await brd({ x: x1, y: y1 }));
}
await clickBrd({ x: x0, y: y0 });
await clickBrd({ x: x1, y: y1 });
await idle();
p = await proj();
expect(p.board.outline.length === 8, `rounded outline: ${p.board.outline.map((o) => o.kind).join(",")}`);
await page.evaluate(() => document.querySelector('button[title^="Four M3 mounting holes"]')?.click());
await idle();
await wait(500);
p = await proj();
expect(p.board.footprints.filter((f) => f.reference.startsWith("H")).length === 4, `mounting holes: ${p.board.footprints.map((f) => f.reference).join(",")}`);
step("board: silkscreen text");
await page.keyboard.press("Escape");
await page.evaluate(() => document.querySelector('button[title="Silkscreen text"]')?.click());
await wait(200);
globalThis.nextPrompt = "blinky v1";
await clickBrd({ x: (x0 + x1) / 2, y: y1 - 7 });
await idle();
await wait(300);
p = await proj();
expect(p.board.texts.some((t) => t.text === "blinky v1" && t.layer === "F.SilkS"), `board text: ${p.board.texts.map((t) => t.text).join(",")}`);
await page.keyboard.press("Escape");
await shot("4-outline");

step("board: route");
await page.keyboard.press("x");
p = await proj();
const pad = (ref, num) => p.board.footprints.find((f) => f.reference === ref).pads.find((x) => x.number === num);
// Like a user would: try an L one way, then the other, then on B.Cu; undo what conflicts.
for (const u of p.unconnected) {
  let done = false;
  for (const layer of ["F.Cu", "B.Cu"]) {
    await page.select('select[title="Routing layer"]', layer);
    for (const corner of [{ x: u.b.at.x, y: u.a.at.y }, { x: u.a.at.x, y: u.b.at.y }]) {
      const start = await proj();
      const before = start.clearance.length;
      const tracksBefore = start.board.tracks.length;
      await clickBrd(u.a.at);
      await clickBrd(corner);
      await clickBrd(u.b.at);
      await idle();
      await wait(300);
      const q = await proj();
      if (q.clearance.length === before && !q.unconnected.some((x) => x.net === u.net)) {
        done = true;
        break;
      }
      await page.keyboard.press("Escape");
      await wait(300);
      await idle();
      while ((await proj()).board.tracks.length > tracksBefore) {
        await page.keyboard.down("Meta");
        await page.keyboard.press("z");
        await page.keyboard.up("Meta");
        await wait(300);
        await idle();
      }
      await page.keyboard.press("x");
    }
    if (done) break;
  }
  console.log("  routed", u.net, done);
}
await page.keyboard.press("Escape");
await wait(300);
p = await proj();
// As in KiCad's tutorial, GND may be left to the copper pour.
expect(p.unconnected.every((u) => u.net === "GND"), `unrouted (besides GND): ${p.unconnected.filter((u) => u.net !== "GND").length}`);
expect(p.clearance.length === 0, `clearance violations after routing: ${JSON.stringify(p.clearance)}`);
await shot("5-routed");

step("board: GND zone on B.Cu");
await page.evaluate(() => document.querySelector('button[title="Copper zone (pour)"]')?.click());
await wait(200);
await page.select('select[title="Routing layer"]', "B.Cu");
await page.evaluate(() => document.querySelector('button[title^="A zone covering"]')?.click());
await idle();
await wait(500);
p = await proj();
expect(p.board.zones.length === 1 && p.board.zones[0].fills.length > 0, `zone: ${p.board.zones.map((z) => `${z.net} ${z.layers} fills=${z.fills.length}`)}`);
expect(p.clearance.length === 0, `clearance after zone: ${p.clearance.length}`);
expect(p.unconnected.length === 0, `unrouted after the GND pour: ${p.unconnected.length}`);
expect(p.boardChecks.every((v) => v.severity !== "error"), `DRC errors: ${p.boardChecks.map((v) => v.message).join("; ")}`);
await page.keyboard.press("Escape");
await shot("6-zone");

step("fabrication outputs");
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT });
await page.evaluate(() => document.querySelector('button[title^="Gerbers, drill files"]')?.click());
await page.waitForSelector(".fab-export");
const checks = await page.evaluate(() => [...document.querySelectorAll(".fab-export .checks li")].map((li) => `${li.className}: ${li.textContent}`));
console.log(checks.join("\n"));
expect(checks.every((c) => c.startsWith("ok")), "fab pre-flight all green");
await shot("7-fab");
await page.evaluate(() => [...document.querySelectorAll(".fab-export .update-actions button")].find((b) => b.textContent.includes("Download"))?.click());
await wait(1500);
const { existsSync, statSync } = await import("node:fs");
expect(existsSync(`${OUT}/blinky-fab.zip`) && statSync(`${OUT}/blinky-fab.zip`).size > 1000, "blinky-fab.zip downloaded");
await page.click(".fab-export .icon-btn");

step("save files");
const files = await page.evaluate(() => window.__crossprobe.files());
for (const [k, v] of Object.entries(files)) writeFileSync(`${OUT}/${k}`, v);
console.log("files:", Object.keys(files));
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close().catch(() => {});
process.exit(0);

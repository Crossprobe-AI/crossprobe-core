// End-to-end, buses: in a new project two resistors' pins are wired to bus entries on a bus
// drawn with the Bus tool (B) and the Bus entry tool (Z), the bus labelled D[0..1] and the member
// wires D0 and D1. KiCad's netlist of the saved schematic puts R1 pin 1 on D0 and R2 pin 1 on
// D1, and its ERC finds nothing wrong with the bus.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-bus.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/bus");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
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
const sch = (p) => page.evaluate((p) => window.__schematicView.toClient(p), p);
const clickSch = async (p, count = 1) => {
  const c = await sch(p);
  await page.mouse.move(c.x, c.y);
  await page.mouse.click(c.x, c.y, { count });
  await wait(200);
};
async function place(name, at) {
  await page.keyboard.press("a");
  await page.waitForSelector(".part-picker input");
  const input = await page.$(".part-picker input");
  await input.click();
  await input.evaluate((e) => e.select());
  await input.type(name);
  await wait(600);
  await page.evaluate((name) => [...document.querySelectorAll(".part-list button")].find((b) => b.querySelector(".part-name")?.childNodes[0]?.textContent?.trim() === name && b.textContent.includes("Device"))?.click(), name);
  await page.waitForFunction((n) => document.querySelector(".edit-hint")?.textContent?.startsWith(`Click to place ${n}`), { timeout: 10000 }, name);
  await clickSch(at);
  await idle();
  await page.keyboard.press("Escape");
  await wait(200);
}

await page.goto(URL, { waitUntil: "networkidle0" });
await page.type('input[aria-label="Project name"]', "bus");
await page.click(".new-project button");
await page.waitForSelector(".viewport.schematic svg", { timeout: 20000 });
await wait(500);
await page.keyboard.press("e");
await place("R", { x: 101.6, y: 88.9 });
await place("R", { x: 127, y: 88.9 });
const pin1 = await page.evaluate(() => Object.fromEntries(window.__crossprobe.sheet.items.filter((i) => i.kind === "pin" && i.pin === "1").map((i) => [i.ref, i.points[0]])));
console.log("  pin 1s:", JSON.stringify(pin1));

console.log("-- the bus, two entries, member wires and labels");
const busY = Math.min(pin1.R1.y, pin1.R2.y) - 10.16;
await page.keyboard.press("b");
await clickSch({ x: 88.9, y: busY });
await clickSch({ x: 139.7, y: busY }, 2);
await idle();
await page.keyboard.press("Escape");
// Entries: from the bus down-right to a point above each pin; then a wire down to the pin.
await page.keyboard.press("z");
for (const ref of ["R1", "R2"]) {
  await clickSch({ x: pin1[ref].x - 2.54, y: busY });
  await idle();
}
await page.keyboard.press("Escape");
await page.keyboard.press("w");
for (const ref of ["R1", "R2"]) {
  await clickSch({ x: pin1[ref].x, y: busY + 2.54 });
  await clickSch(pin1[ref]);
  await idle();
}
await page.keyboard.press("Escape");
await page.keyboard.press("l");
globalThis.nextPrompt = "D[0..1]";
await clickSch({ x: 93.98, y: busY });
await idle();
for (const [ref, name] of [["R1", "D0"], ["R2", "D1"]]) {
  globalThis.nextPrompt = name;
  await clickSch({ x: pin1[ref].x, y: busY + 5.08 });
  await idle();
}
await page.keyboard.press("Escape");
await page.screenshot({ path: `${OUT}/bus.png` });
const items = await page.evaluate(() => window.__crossprobe.sheet.items.reduce((m, i) => ((m[i.kind] = (m[i.kind] ?? 0) + 1), m), {}));
expect(items.bus >= 1, `items: ${JSON.stringify(items)}`);

const files = await page.evaluate(() => window.__crossprobe.files());
for (const [k, v] of Object.entries(files)) writeFileSync(`${OUT}/${k.split("/").pop()}`, v);
const schFile = Object.keys(files).find((f) => f.endsWith(".kicad_sch")).split("/").pop();
expect(readFileSync(`${OUT}/${schFile}`, "utf8").includes("(bus_entry"), "bus entries in the file");
execFileSync("kicad-cli", ["sch", "export", "netlist", "-o", `${OUT}/bus.net`, `${OUT}/${schFile}`], { stdio: "ignore" });
const net = readFileSync(`${OUT}/bus.net`, "utf8");
const netOf = (ref, pin) => {
  for (const m of net.matchAll(/\(net\s+\(code "\d+"\)\s+\(name "([^"]+)"\)([\s\S]*?)\n\t\t\)/g)) if (new RegExp(`\\(ref "${ref}"\\)\\s+\\(pin "${pin}"\\)`).test(m[2])) return m[1];
};
expect(netOf("R1", "1") === "/D0" && netOf("R2", "1") === "/D1", `KiCad's netlist: R1.1 on ${netOf("R1", "1")}, R2.1 on ${netOf("R2", "1")}`);
try { execFileSync("kicad-cli", ["sch", "erc", "--format", "json", "--severity-all", "-o", `${OUT}/erc.json`, `${OUT}/${schFile}`], { stdio: "ignore" }); } catch {}
const erc = JSON.parse(readFileSync(`${OUT}/erc.json`, "utf8")).sheets.flatMap((s) => s.violations.map((v) => v.type));
const busIssues = erc.filter((t) => /bus/.test(t));
expect(busIssues.length === 0, `KiCad ERC bus findings: ${busIssues.join(", ") || "none"} (all: ${[...new Set(erc)].join(", ")})`);
const ours = await page.evaluate(() => window.__crossprobe.project.nets.filter((n) => n.nodes.some((x) => x.pin === "1")).map((n) => `${n.name}:${n.nodes.map((x) => x.reference + "." + x.pin).join("+")}`));
expect(ours.some((n) => n.startsWith("/D0:") && n.includes("R1.1")) && ours.some((n) => n.startsWith("/D1:") && n.includes("R2.1")), `our nets: ${ours.join(" ")}`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

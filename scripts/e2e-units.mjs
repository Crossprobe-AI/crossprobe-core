// End-to-end, multi-unit parts: an LM324 (four amplifiers and a power unit) placed from the part
// picker comes in as U1A, and "Place B–E" on the part places the rest under the same reference,
// one click each. KiCad's ERC on the saved schematic reports the missing units before, and none
// after; its netlist has one U1 with all 14 pins.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-units.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "scripts/e2e-out/units";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
const sch = (p) => page.evaluate((p) => window.__schematicView.toClient(p), p);
const clickSch = async (p) => {
  const c = await sch(p);
  await page.mouse.move(c.x, c.y);
  await page.mouse.click(c.x, c.y);
  await wait(200);
};
const idle = () => page.waitForFunction(() => !document.body.textContent.includes("Updating…"), { timeout: 60000 });
const hint = () => page.evaluate(() => document.querySelector(".edit-hint")?.textContent ?? "");
async function erc(tag) {
  const files = await page.evaluate(() => window.__crossprobe.files());
  for (const [k, v] of Object.entries(files)) {
    mkdirSync(`${OUT}/${k}`.slice(0, `${OUT}/${k}`.lastIndexOf("/")), { recursive: true });
    writeFileSync(`${OUT}/${k}`, v);
  }
  const sch = Object.keys(files).find((f) => f.endsWith(".kicad_sch"));
  try {
    execFileSync("kicad-cli", ["sch", "erc", "--format", "json", "--severity-all", "-o", `${OUT}/erc-${tag}.json`, `${OUT}/${sch}`], { stdio: "pipe" });
  } catch {}
  const r = JSON.parse(readFileSync(`${OUT}/erc-${tag}.json`, "utf8"));
  return { sch, types: r.sheets.flatMap((s) => s.violations.map((v) => v.type)) };
}

console.log("-- an LM324 from the part picker");
await page.goto(URL, { waitUntil: "networkidle0" });
await page.type('input[aria-label="Project name"]', "units");
await page.click(".new-project button");
await page.waitForSelector(".viewport.schematic svg", { timeout: 20000 });
await wait(500);
await page.keyboard.press("e");
await page.keyboard.press("a");
await page.waitForSelector(".part-picker input");
await page.type(".part-picker input", "LM324");
await wait(800);
const picked = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".part-list button")].find((b) => b.querySelector(".part-name")?.childNodes[0]?.textContent?.trim() === "LM324");
  b?.click();
  return !!b;
});
expect(picked, "LM324 in the picker");
await page.waitForFunction(() => document.querySelector(".edit-hint")?.textContent?.startsWith("Click to place LM324"), { timeout: 10000 });
await clickSch({ x: 101.6, y: 76.2 });
await idle();
await page.keyboard.press("Escape");
await wait(300);
let p = await page.evaluate(() => window.__crossprobe.project.components.find((c) => c.reference.startsWith("U")));
expect(p?.unitCount === 5 && p.units.length === 1 && p.units[0].unit === 1, `${p?.reference}: unit ${p?.units.map((u) => u.unit)} of ${p?.unitCount}`);
let r = await erc("before");
expect(r.types.includes("missing_unit") || r.types.includes("missing_power_pin"), `KiCad ERC before: ${[...new Set(r.types)].join(", ")}`);

console.log("-- Place B–E from the part");
await page.evaluate(() => [...document.querySelectorAll(".tabs [role=tab]")].find((b) => b.textContent.includes("Parts"))?.click());
await wait(200);
await page.evaluate((ref) => [...document.querySelectorAll(".inspector .item")].find((b) => b.textContent.trim().startsWith(ref))?.click(), p.reference);
await wait(300);
const button = await page.evaluate(() => [...document.querySelectorAll(".inspector button.link")].find((b) => b.textContent.startsWith("Place "))?.textContent);
expect(button === "Place B–E", `button "${button}"`);
await page.evaluate(() => [...document.querySelectorAll(".inspector button.link")].find((b) => b.textContent.startsWith("Place "))?.click());
await wait(300);
const spots = [{ x: 127, y: 76.2 }, { x: 101.6, y: 101.6 }, { x: 127, y: 101.6 }, { x: 76.2, y: 88.9 }];
for (const [i, at] of spots.entries()) {
  const h = await hint();
  expect(h.startsWith(`Click to place ${p.reference}${"BCDE"[i]}`), `hint "${h.slice(0, 40)}"`);
  const c = await sch(at);
  const inView = await page.evaluate((c) => document.elementFromPoint(c.x, c.y)?.closest(".viewport.schematic") != null, c);
  if (!inView) console.log(`  (spot ${JSON.stringify(at)} is covered by ${await page.evaluate((c) => document.elementFromPoint(c.x, c.y)?.closest("[class]")?.className, c)})`);
  await clickSch(at);
  await idle();
  await wait(200);
}
expect((await page.evaluate(() => document.querySelector(".edit-hint")?.textContent ?? "")).startsWith("Click to place") === false, "back to select after the last unit");
p = await page.evaluate((ref) => window.__crossprobe.project.components.find((c) => c.reference === ref), p.reference);
expect(p.units.map((u) => u.unit).sort().join() === "1,2,3,4,5", `units placed: ${p.units.map((u) => u.unit).join(",")}`);
await page.screenshot({ path: `${OUT}/units.png` });
r = await erc("after");
expect(!r.types.includes("missing_unit") && !r.types.includes("missing_power_pin"), `KiCad ERC after: ${[...new Set(r.types)].join(", ")}`);
execFileSync("kicad-cli", ["sch", "export", "netlist", "-o", `${OUT}/units.net`, `${OUT}/${r.sch}`], { stdio: "pipe" });
const net = readFileSync(`${OUT}/units.net`, "utf8");
const comps = [...net.matchAll(/\(comp\s+\(ref\s+"([^"]+)"/g)].map((m) => m[1]);
const pins = new Set([...net.matchAll(/\(node\s+\(ref\s+"U1"\)\s+\(pin\s+"(\d+)"/g)].map((m) => m[1]));
expect(comps.filter((c) => c === "U1").length === 1, `netlist components: ${comps.join(" ")}`);
expect(pins.size === 14, `netlist: U1 has ${pins.size} of the LM324's 14 pins`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

// End-to-end, symbol units: a new symbol in the symbol editor gets two units, and each unit gets
// its own pins (A: 1, 2 and a box; B: 3, 4 and an arc). Unit B gets a name, the units are locked,
// a De Morgan body style is added and pins 1 and 2 become a jumper group. In the pin table, a pin
// is renamed and one retyped. Then a second symbol becomes a supply power symbol. KiCad reads the library back with the same units,
// body styles, pins and graphics, and plots both units in both body styles.
// Run the dev server (npm run dev -w @crossprobe/web) and `npm run build`, then: node scripts/e2e-symbol-units.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parse as parseSexpr } from "@crossprobe/kicad-sexpr";
import { describeSymbol, findLibSymbol, symbolLibRoot } from "@crossprobe/kicad-model";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/symbol-units");
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
const clickAt = async (c) => {
  await page.mouse.move(c.x, c.y);
  await page.mouse.click(c.x, c.y);
  await wait(150);
};
// Library mm (y up) → client pixels, from the editor's SVG transform.
const lib2client = (p) =>
  page.evaluate((p) => {
    const g = document.querySelector(".sym-canvas svg > g");
    const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(g.getAttribute("transform"));
    const r = document.querySelector(".sym-canvas").getBoundingClientRect();
    return { x: r.left + Number(m[1]) + p.x * Number(m[3]), y: r.top + Number(m[2]) - p.y * Number(m[3]) };
  }, p);
const clickLib = async (p) => clickAt(await lib2client(p));
const button = (text, scope = ".sym-editor") => page.evaluate((t, s) => [...document.querySelectorAll(`${s} button`)].find((b) => b.textContent.trim() === t)?.click(), text, scope);
async function sideField(label, value) {
  const el = await page.evaluateHandle((label) => [...document.querySelectorAll(".sym-editor .fpe-side label.prop")].find((l) => l.querySelector("span")?.textContent === label)?.querySelector("input"), label);
  if (!el.asElement()) return expect(false, `field ${label}`);
  await el.asElement().click();
  await el.evaluate((e) => e.select());
  await el.asElement().type(value);
  await page.keyboard.press("Enter");
  await idle();
  await wait(150);
}
const check = (text) => page.evaluate((t) => [...document.querySelectorAll(".sym-editor .fpe-side label.prop")].find((l) => l.textContent.includes(t))?.querySelector("input")?.click(), text);
let symFile;
const symbol = async (name) => {
  const libs = await page.evaluate(() => window.__crossprobe.project.projectSymbolLibraries);
  return findLibSymbol(symbolLibRoot(parseSexpr(libs[symFile].text)), name);
};
async function newSymbol(name) {
  await page.keyboard.press("a");
  await page.waitForSelector(".part-picker input");
  globalThis.nextPrompt = name;
  await page.evaluate(() => [...document.querySelectorAll(".part-picker button")].find((b) => b.textContent.includes("New symbol"))?.click());
  await page.waitForSelector(".sym-editor", { timeout: 10000 });
  await idle();
  await wait(300);
  symFile = await page.evaluate(() => document.querySelector(".sym-editor .update-head .muted")?.textContent);
}

await page.goto(URL, { waitUntil: "networkidle0" });
await page.type('input[aria-label="Project name"]', "units");
await page.click(".new-project button");
await page.waitForSelector(".viewport.schematic svg", { timeout: 20000 });
await wait(500);
await page.keyboard.press("e");

console.log("-- two units, each with its pins");
await newSymbol("DUAL");
await sideField("Units", "2");
await page.waitForSelector(".sym-units");
for (const [unit, shape] of [["A", "rectangle"], ["B", "arc"]]) {
  await button(unit, ".sym-units");
  await wait(200);
  await page.keyboard.press("p");
  await clickLib({ x: -7.62, y: 0 });
  await idle();
  await clickLib({ x: 7.62, y: 0 });
  await idle();
  if (shape === "rectangle") {
    await page.keyboard.press("b");
    await clickLib({ x: -2.54, y: 2.54 });
    await clickLib({ x: 2.54, y: -2.54 });
  } else {
    await page.keyboard.press("a");
    await clickLib({ x: -2.54, y: 2.54 });
    await clickLib({ x: 0, y: 0 });
    await clickLib({ x: -2.54, y: -2.54 });
  }
  await idle();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await wait(150);
}
await sideField("Unit B name", "OUT");
await check("Units not interchangeable");
await idle();
await page.evaluate(() => {
  const e = [...document.querySelectorAll(".sym-editor .fpe-side label.prop")].find((l) => l.querySelector("span")?.textContent === "Body styles").querySelector("select");
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(e, "demorgan");
  e.dispatchEvent(new Event("change", { bubbles: true }));
});
await idle();
await sideField("Jumper groups", "1 2");
await wait(300);
await page.screenshot({ path: `${OUT}/units.png` });

console.log("-- the pin table");
await button("Pin table");
await page.waitForSelector(".sym-pin-table");
const name1 = await page.$('.sym-pin-table input[aria-label="Pin 1 name"]');
await name1.click();
await name1.evaluate((e) => e.select());
await name1.type("IN1");
await page.keyboard.press("Enter");
await idle();
await page.evaluate(() => {
  const e = document.querySelector('.sym-pin-table select[aria-label="Pin 4 type"]');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(e, "output");
  e.dispatchEvent(new Event("change", { bubbles: true }));
});
await idle();
await wait(300);
await page.screenshot({ path: `${OUT}/pin-table.png` });

const v = describeSymbol(await symbol("DUAL"));
expect(v.units.count === 2 && v.units.demorgan && v.units.names[2] === "OUT" && v.units.locked && JSON.stringify(v.units.jumperGroups) === '[["1","2"]]', `units ${JSON.stringify(v.units)}`);
const where = (n) => v.pins.filter((p) => p.number === n).map((p) => `${p.unit}/${p.style}`).sort().join(" ");
expect(where("1") === "1/1 1/2" && where("2") === "1/1 1/2" && where("3") === "2/1 2/2" && where("4") === "2/1 2/2", `pins by unit/style: 1 ${where("1")}, 2 ${where("2")}, 3 ${where("3")}, 4 ${where("4")}`);
expect(v.pins.find((p) => p.number === "1").name === "IN1" && v.pins.filter((p) => p.number === "4").every((p) => p.type === "output"), "the pin table's edits, in both body styles");
expect(v.graphics.some((g) => g.kind === "rectangle" && g.unit === 1) && v.graphics.some((g) => g.kind === "arc" && g.unit === 2), `graphics: ${v.graphics.map((g) => `${g.kind}@${g.unit}/${g.style}`).join(" ")}`);
await page.click(".sym-editor .update-head .icon-btn");
await wait(200);

console.log("-- a power symbol");
await page.keyboard.press("Escape");
await newSymbol("+12V");
await button("Supply");
await idle();
await wait(200);
const pw = describeSymbol(await symbol("+12V"));
expect(pw.power && pw.fields.Reference === "#PWR" && pw.pins.length === 1 && pw.pins[0].type === "power_in", `power symbol: ${pw.fields.Reference}, ${pw.pins.length} pin`);
await page.click(".sym-editor .update-head .icon-btn");

const files = await page.evaluate(() => window.__crossprobe.files());
const libName = symFile.split("/").pop();
writeFileSync(`${OUT}/${libName}`, files[symFile]);
writeFileSync(`${OUT}/kicad.kicad_sym`, files[symFile]);
execFileSync("kicad-cli", ["sym", "upgrade", "--force", `${OUT}/kicad.kicad_sym`], { stdio: "ignore" });
const back = symbolLibRoot(parseSexpr(readFileSync(`${OUT}/kicad.kicad_sym`, "utf8")));
const mine = symbolLibRoot(parseSexpr(files[symFile]));
const shape = (s) => {
  const d = describeSymbol(s);
  return JSON.stringify({ units: d.units, power: d.power, pins: d.pins.map((p) => `${p.unit}/${p.style} ${p.number} ${p.name} ${p.type} ${p.at.x},${p.at.y},${p.angle}`).sort(), graphics: d.graphics.map((g) => `${g.unit}/${g.style} ${g.kind} ${g.points.map((q) => `${q.x},${q.y}`).join(" ")}`).sort() });
};
for (const n of ["DUAL", "+12V"]) expect(shape(findLibSymbol(back, n)) === shape(findLibSymbol(mine, n)), `KiCad reads ${n} back the same`);
mkdirSync(`${OUT}/svg`);
execFileSync("kicad-cli", ["sym", "export", "svg", "-s", "DUAL", "-o", `${OUT}/svg`, `${OUT}/${libName}`], { stdio: "ignore" });
const svgs = readdirSync(`${OUT}/svg`).sort();
expect(svgs.join() === "DUAL_unit1.svg,DUAL_unit1_demorgan.svg,DUAL_unit2.svg,DUAL_unit2_demorgan.svg", `KiCad plots ${svgs.join(", ")}`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

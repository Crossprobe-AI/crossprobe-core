// End-to-end, a placed symbol's properties and global labels. On KiCad's cm5_minima demo, U1's
// SDI pin is switched to its SDA function, the part is marked do-not-populate and its Value is
// hidden, all in the inspector; a global label is placed with the Global label tool and its shape
// changed. On pic_programmer, U5 is switched to its De Morgan body. KiCad reads the saved sheets
// (`sch upgrade`) and its netlist names the pin SDA.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-symbol-props.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/symbol-props");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const DEMOS = process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos";
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
const clickSch = async (p) => {
  const c = await sch(p);
  await page.mouse.move(c.x, c.y);
  await page.mouse.click(c.x, c.y);
  await wait(200);
};
const tool = (label) => page.evaluate((l) => [...document.querySelectorAll(".edit-toolbar button")].find((b) => b.querySelector(".tl")?.textContent === l).click(), label);
const component = (ref) => page.evaluate((r) => window.__crossprobe.project.components.find((c) => c.reference === r), ref);
/** Open a demo, go to the sheet a part is on, start editing and select the part. */
const open = async (demo, ref) => {
  await page.goto(`${URL}?demo=${demo}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
  await wait(800);
  const file = (await component(ref)).units[0].file.split("/").pop();
  await page.evaluate((f) => [...document.querySelectorAll(".tree button")].find((n) => n.textContent.includes(f))?.click(), file);
  await page.waitForFunction((r) => !!document.querySelector(`.viewport.schematic g.i-symbol[data-ref="${r}"]`), { timeout: 20000 }, ref);
  await page.keyboard.press("e");
  await wait(300);
  const at = await page.evaluate((r) => {
    const b = document.querySelector(`.viewport.schematic g.i-symbol[data-ref="${r}"]`).getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, ref);
  await page.mouse.click(at.x, at.y);
  await page.waitForSelector(".field-editor", { timeout: 5000 });
};
/** The demo with the project's changed files written over it, for KiCad to read. */
const save = async (name) => {
  const dir = `${OUT}/${name}`;
  cpSync(`${DEMOS}/${name}`, dir, { recursive: true });
  const files = await page.evaluate(() => window.__crossprobe.files());
  for (const [k, v] of Object.entries(files)) writeFileSync(`${dir}/${k.split("/").pop()}`, v);
  return dir;
};

console.log("-- cm5_minima: U1's pin function, flags and a hidden field");
await open("cm5_minima/CM5_MINIMA_3.kicad_pro", "U1");
let u1 = await component("U1");
const alt = u1.pinAlternates.find((a) => a.alternates.includes("SDA"));
expect(!!alt && !alt.current, `pin ${alt?.pin} (${alt?.name}) can be ${alt?.alternates.join(", ")}`);
await page.evaluate((pin) => {
  const li = [...document.querySelectorAll("ul.pins li")].find((l) => l.querySelector(".pin")?.textContent === pin);
  const sel = li.querySelector("select.pin-alternate");
  sel.value = "SDA";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}, alt.pin);
await idle();
const check = (title) => page.evaluate((t) => [...document.querySelectorAll(".field-editor label")].find((l) => l.textContent.trim() === t || l.querySelector(`input[title="${t}"]`))?.querySelector('input[type="checkbox"]').click(), title);
await check("Do not populate");
await idle();
await check("Show Value on the sheet");
await idle();
await wait(300);
u1 = await component("U1");
expect(u1.pinAlternates.find((a) => a.pin === alt.pin).current === "SDA", "the pin is switched to SDA");
expect(u1.dnp && u1.hiddenFields.includes("Value"), "do not populate, Value hidden");
expect(await page.evaluate(() => !!document.querySelector('.viewport.schematic g.i-symbol[data-ref="U1"] path.r-dnp')), "the part is crossed out");
expect(await page.evaluate(() => [...document.querySelectorAll('.viewport.schematic g.i-pin[data-ref="U1"] text, .viewport.schematic g[data-ref="U1"] text')].some((t) => t.textContent === "SDA")), "the sheet draws the pin as SDA");

console.log("-- a global label, and its shape");
await tool("Global label");
globalThis.nextPrompt = "ACCEL_INT";
await clickSch({ x: 25.4, y: 25.4 });
await idle();
await page.keyboard.press("Escape");
await wait(200);
const lab = await page.evaluate(() => {
  const g = [...document.querySelectorAll(".viewport.schematic g.i-label")].find((g) => g.textContent === "ACCEL_INT");
  const r = g.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(lab.x, lab.y);
await page.waitForSelector(".edit-hint select", { timeout: 5000 });
await page.select(".edit-hint select", "output");
await idle();
await page.screenshot({ path: `${OUT}/cm5.png` });
let dir = await save("cm5_minima");
const sheet = u1.units[0].file.split("/").pop();
const ours = readFileSync(`${dir}/${sheet}`, "utf8");
expect(/\(global_label "ACCEL_INT"\s+\(shape output\)/.test(ours) && ours.includes('(property "Intersheetrefs"'), "the file has the global label, shape output, with KiCad's sheet-references field");
expect(ours.includes('(alternate "SDA")') && /\(dnp yes\)/.test(ours), "the file has the alternate and the flag");
execFileSync("kicad-cli", ["sch", "upgrade", "--force", `${dir}/${sheet}`], { stdio: "ignore" });
const theirs = readFileSync(`${dir}/${sheet}`, "utf8");
expect(/\(global_label "ACCEL_INT"\s+\(shape output\)/.test(theirs) && theirs.includes('(alternate "SDA")'), "KiCad reads and writes them back");
execFileSync("kicad-cli", ["sch", "export", "netlist", "--format", "kicadxml", "-o", `${dir}/netlist.xml`, `${dir}/CM5_MINIMA_3.kicad_sch`], { stdio: "ignore" });
const xml = readFileSync(`${dir}/netlist.xml`, "utf8");
expect(new RegExp(`<node ref="U1" pin="${alt.pin}" pinfunction="SDA_${alt.pin}"`).test(xml), "KiCad's netlist names the pin SDA");
expect(/<comp ref="U1">[\s\S]*?<property name="dnp"/.test(xml), "KiCad's netlist marks U1 do-not-populate");

console.log("-- pic_programmer: U5 in its De Morgan body");
await open("pic_programmer/pic_programmer.kicad_pro", "U5");
const shapes = () => page.evaluate(() => document.querySelector('.viewport.schematic g.i-symbol[data-ref="U5"]').innerHTML.length);
const before = await shapes();
await page.evaluate(() => {
  const sel = [...document.querySelectorAll(".field-editor label")].find((l) => l.textContent.startsWith("Body style")).querySelector("select");
  sel.value = "2";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await idle();
await wait(300);
expect((await component("U5")).bodyStyle === 2, "U5 is in body style 2");
expect((await shapes()) !== before, "and drawn differently");
await page.screenshot({ path: `${OUT}/pic.png` });
dir = await save("pic_programmer");
const picSheet = (await component("U5")).units[0].file.split("/").pop();
execFileSync("kicad-cli", ["sch", "upgrade", "--force", `${dir}/${picSheet}`], { stdio: "ignore" });
expect(readFileSync(`${dir}/${picSheet}`, "utf8").includes("(body_style 2)"), "KiCad reads and writes the body style back");
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

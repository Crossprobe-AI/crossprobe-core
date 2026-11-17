// End-to-end, net classes in the schematic. On KiCad's pic_programmer demo a "Fast" class is
// added to the project, then: the Net class tool puts a directive for it on a wire; the Rule area
// tool draws an area across another wire, for "Fast" too; a double-click changes the directive's
// class to "Slow" (not in the project: ERC says so). The project file keeps each net's classes as
// KiCad does, and KiCad's netlist of the saved project gives those nets the same classes.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-netclass.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/netclass");
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
const clickSch = async (p, count = 1) => {
  const c = await page.evaluate((p) => window.__schematicView.toClient(p), p);
  await page.mouse.click(c.x, c.y, { count });
  await wait(250);
};
const tool = (label) => page.evaluate((l) => [...document.querySelectorAll(".edit-toolbar button")].find((b) => b.querySelector(".tl")?.textContent === l).click(), label);
const files = () => page.evaluate(() => window.__crossprobe.files());
const assignments = async () => {
  const f = await files();
  const pro = Object.entries(f).find(([k]) => k.endsWith(".kicad_pro"))?.[1];
  return pro ? JSON.parse(pro).net_settings.netclass_assignments ?? {} : {};
};

await page.goto(`${URL}?demo=pic_programmer/pic_programmer.kicad_pro`, { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await wait(800);
// The project gets a "Fast" class (Board setup's job; done here through the app's edit hook).
await page.evaluate(() => {
  const pro = window.__crossprobe.project.projectFile;
  return window.__crossprobe.edit([{ op: "setProjectRules", file: pro, netClass: { name: "Fast", fields: { clearance: 0.3 } } }]);
});
await idle();
await page.keyboard.press("e");
await wait(300);
const wires = await page.evaluate(() => window.__crossprobe.sheet.items.filter((i) => i.kind === "wire").map((i) => ({ a: i.points[0], b: i.points[1], net: i.net })));
const w1 = wires.find((w) => w.a.y === w.b.y && Math.abs(w.b.x - w.a.x) > 5 && w.net);
const w2 = wires.find((w) => w !== w1 && w.a.x === w.b.x && Math.abs(w.b.y - w.a.y) > 5 && w.net && w.net !== w1.net);
console.log(`  wires: ${w1.net} and ${w2.net}`);

console.log("-- a directive on a wire");
await tool("Net class");
globalThis.nextPrompt = "Fast";
await clickSch({ x: (w1.a.x + w1.b.x) / 2, y: w1.a.y });
await idle();
await wait(500);
expect(JSON.stringify((await assignments())[w1.net]) === '["Fast"]', `the project file gives ${w1.net} the class Fast`);

console.log("-- a rule area across another wire");
await tool("Rule area");
const mid = { x: w2.a.x, y: (w2.a.y + w2.b.y) / 2 };
const r = 2.54;
await clickSch({ x: mid.x - r, y: mid.y - r });
await clickSch({ x: mid.x + r, y: mid.y - r });
await clickSch({ x: mid.x + r, y: mid.y + r });
globalThis.nextPrompt = "Fast";
await clickSch({ x: mid.x - r, y: mid.y + r });
await page.keyboard.press("Enter");
await idle();
await wait(500);
expect(JSON.stringify((await assignments())[w2.net]) === '["Fast"]', `everything inside the area is Fast: ${w2.net}`);
await page.keyboard.press("Escape");
await page.screenshot({ path: `${OUT}/drawn.png` });

console.log("-- the directive's class changed by a double-click");
const flag = await page.evaluate(() => {
  const g = [...document.querySelectorAll(".viewport.schematic g.i-directive")][0];
  const c = g.querySelector("circle").getBoundingClientRect();
  return { x: c.x + c.width / 2, y: c.y + c.height / 2 };
});
globalThis.nextPrompt = "Slow";
await page.mouse.click(flag.x, flag.y, { count: 2 });
await idle();
await wait(500);
expect(JSON.stringify((await assignments())[w1.net]) === '["Slow"]', `now ${w1.net} is Slow`);
const erc = await page.evaluate(() => window.__crossprobe.project.erc.filter((v) => v.type === "undefined_netclass").map((v) => v.message));
expect(JSON.stringify(erc) === '["Netclass Slow is not defined"]', `ERC: ${erc}`);

const dir = `${OUT}/pic_programmer`;
cpSync(`${DEMOS}/pic_programmer`, dir, { recursive: true });
for (const [k, t] of Object.entries(await files())) writeFileSync(`${dir}/${k.split("/").pop()}`, t);
execFileSync("kicad-cli", ["sch", "export", "netlist", "--format", "kicadxml", "-o", `${dir}/n.xml`, `${dir}/pic_programmer.kicad_sch`], { stdio: "ignore" });
const xml = readFileSync(`${dir}/n.xml`, "utf8");
const cls = (n) => new RegExp(`<net code="\\d+" name="${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" class="([^"]*)"`).exec(xml)?.[1];
expect(cls(w1.net) === "Slow,Default" && cls(w2.net) === "Fast", `KiCad's netlist: ${w1.net} ${cls(w1.net)}, ${w2.net} ${cls(w2.net)}`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

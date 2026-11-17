// End-to-end, Find and Replace in the schematic. On KiCad's pic_programmer demo, Ctrl+F finds "RB7"
// in labels on both sheets and in the sheet pin between them; Enter goes from match to match,
// opening the sheet each is on. While editing, Replace all makes it "SDATA" everywhere in one
// step: undo brings every one back, redo makes them SDATA again. KiCad's netlist of the saved
// project names the nets SDATA, with the same pins as before.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-find.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/find");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const DEMOS = process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = () => page.waitForFunction(() => !document.body.textContent.includes("Updating…"), { timeout: 60000 });
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
const status = () => page.evaluate(() => document.querySelector(".find-panel p.muted")?.textContent ?? "");
const labels = () => page.evaluate(() => window.__crossprobe.project.sheets.flatMap((s) => s.items.filter((i) => i.kind === "label").map((i) => i.text)));
const pins = () => page.evaluate(() => window.__crossprobe.project.sheets.flatMap((s) => s.items.filter((i) => i.kind === "sheet").flatMap((i) => i.pinNames)));

await page.goto(`${URL}?demo=pic_programmer/pic_programmer.kicad_pro`, { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await wait(800);

console.log("-- find");
await page.keyboard.down("Control");
await page.keyboard.press("f");
await page.keyboard.up("Control");
await page.waitForSelector(".find-panel input", { timeout: 5000 });
await page.keyboard.type("RB7");
await page.waitForFunction(() => /match/.test(document.querySelector(".find-panel p.muted")?.textContent ?? ""), { timeout: 10000 });
await wait(300);
const found = await page.evaluate(() => [...document.querySelectorAll(".find-list li")].map((li) => li.textContent));
console.log("  ", found.join(" | "));
expect(found.some((f) => f.includes("Sheet pin")) && found.some((f) => f.includes("/pic_sockets/")) && found.some((f) => f.includes("Root")), `labels on both sheets and the sheet pin (${found.length})`);
const sheets = new Set();
for (let i = 0; i < found.length; i++) {
  await page.keyboard.press("Enter");
  await wait(400);
  sheets.add(await page.evaluate(() => window.__crossprobe.sheet.path));
}
expect(sheets.size === 2, `Enter visits matches on both sheets (${sheets.size})`);
expect((await status()).startsWith(`${found.length} of ${found.length}`), `the panel says where it is (${await status()})`);

console.log("-- replace all, undo, redo");
await page.keyboard.press("Escape");
await page.keyboard.press("e");
await wait(300);
await page.keyboard.down("Control");
await page.keyboard.press("f");
await page.keyboard.up("Control");
await page.waitForSelector(".find-panel input", { timeout: 5000 });
await page.type(".find-panel .prop:nth-of-type(1) input", "RB7");
await page.type(".find-panel .prop:nth-of-type(2) input", "SDATA");
await page.waitForFunction(() => /match/.test(document.querySelector(".find-panel p.muted")?.textContent ?? ""), { timeout: 10000 });
await page.evaluate(() => [...document.querySelectorAll(".find-panel button")].find((b) => b.textContent === "Replace all").click());
await idle();
await wait(800);
const renamed = (await labels()).filter((l) => l.includes("SDATA")).length;
expect(!(await labels()).some((l) => l.includes("RB7")) && renamed > 0 && (await pins()).some((p) => p.includes("SDATA")), `every RB7 is SDATA (${renamed} labels and the pin)`);
expect((await status()) === "No matches", "nothing left to find");
await page.screenshot({ path: `${OUT}/replaced.png` });
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.down("Control");
await page.keyboard.press("z");
await page.keyboard.up("Control");
await idle();
await wait(800);
expect((await labels()).some((l) => l.includes("RB7")) && !(await labels()).some((l) => l.includes("SDATA")), "one undo brings every one back");
await page.keyboard.down("Control");
await page.keyboard.down("Shift");
await page.keyboard.press("z");
await page.keyboard.up("Shift");
await page.keyboard.up("Control");
await idle();
await wait(800);
expect(!(await labels()).some((l) => l.includes("RB7")), "redo makes them SDATA again");

const dir = `${OUT}/pic_programmer`;
cpSync(`${DEMOS}/pic_programmer`, dir, { recursive: true });
const files = await page.evaluate(() => window.__crossprobe.files());
for (const [k, t] of Object.entries(files)) writeFileSync(`${dir}/${k.split("/").pop()}`, t);
const netlist = (sch) => {
  execFileSync("kicad-cli", ["sch", "export", "netlist", "--format", "kicadxml", "-o", `${OUT}/n.xml`, sch], { stdio: "ignore" });
  const xml = readFileSync(`${OUT}/n.xml`, "utf8");
  return [...xml.matchAll(/<net code="\d+" name="([^"]*)"[^>]*>([\s\S]*?)<\/net>/g)].map((m) => [m[1], [...m[2].matchAll(/ref="([^"]+)" pin="([^"]+)"/g)].map((x) => `${x[1]}.${x[2]}`).sort().join(" ")]);
};
const before = netlist(`${DEMOS}/pic_programmer/pic_programmer.kicad_sch`);
const after = netlist(`${dir}/pic_programmer.kicad_sch`);
const pinsOf = (list) => list.map(([, p]) => p).sort().join("\n");
expect(pinsOf(before) === pinsOf(after), `KiCad sees the same connections (${after.length} nets)`);
expect(after.some(([n]) => n.includes("SDATA")) && !after.some(([n]) => n.includes("RB7")), `and names them SDATA (${after.filter(([n]) => n.includes("SDATA")).map(([n]) => n).join(", ")})`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

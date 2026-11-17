// End-to-end, ERC exclusions. On KiCad's pic_programmer demo a lone global label is placed: ERC
// reports it. "Exclude" (with a reason) moves it to Excluded and saves it in the project file;
// KiCad's ERC of the saved project reports it excluded too. "Include" brings it back.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-erc-exclude.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/erc-exclude");
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
const lonely = () => page.evaluate(() => ({
  open: window.__crossprobe.project.erc.filter((v) => v.type === "single_global_label").length,
  excluded: window.__crossprobe.project.ercExcluded.filter((v) => v.type === "single_global_label").map((v) => v.comment),
}));

await page.goto(`${URL}?demo=pic_programmer/pic_programmer.kicad_pro`, { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await wait(800);
await page.keyboard.press("e");
await wait(300);
await page.evaluate(() => [...document.querySelectorAll(".edit-toolbar button")].find((b) => b.querySelector(".tl")?.textContent === "Global label").click());
globalThis.nextPrompt = "LONELY";
const c = await page.evaluate(() => window.__schematicView.toClient({ x: 30.48, y: 30.48 }));
await page.mouse.click(c.x, c.y);
await idle();
await page.keyboard.press("Escape");
await wait(300);
expect((await lonely()).open === 1, "ERC reports the lone global label");

console.log("-- exclude it");
await page.evaluate(() => [...document.querySelectorAll(".tabs [role=tab], .tabs button")].find((b) => b.textContent.includes("Issues"))?.click());
await wait(300);
globalThis.nextPrompt = "test point, on purpose";
await page.evaluate(() => {
  const group = [...document.querySelectorAll(".issue-group")].find((g) => g.querySelector("summary")?.textContent.includes("appears only once"));
  group.open = true;
  [...group.querySelectorAll("button.quick-fix")].find((b) => b.textContent === "Exclude").click();
});
await idle();
await wait(500);
let l = await lonely();
expect(l.open === 0 && JSON.stringify(l.excluded) === JSON.stringify(["test point, on purpose"]), `moved to Excluded, with the reason: ${JSON.stringify(l)}`);
await page.screenshot({ path: `${OUT}/excluded.png` });

const dir = `${OUT}/pic_programmer`;
cpSync(`${DEMOS}/pic_programmer`, dir, { recursive: true });
for (const [k, t] of Object.entries(await page.evaluate(() => window.__crossprobe.files()))) writeFileSync(`${dir}/${k.split("/").pop()}`, t);
try {
  execFileSync("kicad-cli", ["sch", "erc", "--format", "json", "--severity-all", "-o", `${dir}/erc.json`, `${dir}/pic_programmer.kicad_sch`], { stdio: "ignore" });
} catch {}
const kicad = JSON.parse(readFileSync(`${dir}/erc.json`, "utf8")).sheets.flatMap((s) => s.violations).filter((v) => v.type === "single_global_label");
expect(kicad.length === 1 && kicad[0].excluded === true, `KiCad's ERC reports it excluded (${JSON.stringify(kicad.map((v) => v.excluded))})`);

console.log("-- include it again");
await page.evaluate(() => {
  const group = [...document.querySelectorAll(".issue-group")].find((g) => g.querySelector("summary")?.textContent.includes("Excluded (ERC)"));
  group.open = true;
  [...group.querySelectorAll("button.quick-fix")].find((b) => b.textContent === "Include").click();
});
await idle();
await wait(500);
l = await lonely();
expect(l.open === 1 && l.excluded.length === 0, `back in the list: ${JSON.stringify(l)}`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

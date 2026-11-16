// End-to-end, the symbol fields table: on KiCad's pic_programmer demo, a new MPN field is set on a
// grouped row (every part of the BOM line gets it) and a value is changed on an ungrouped row.
// KiCad's own BOM export of the saved schematic must show both.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-fields.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const OUT = process.argv[2] ?? "e2e-out/fields";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const DEMO = `${process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos"}/pic_programmer`;
mkdirSync(OUT, { recursive: true });
cpSync(DEMO, OUT, { recursive: true });
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
const proj = () => page.evaluate(() => window.__crossprobe.project);
/** The table's column index by header, and the row whose Reference cell matches. */
async function cell(refMatch, col) {
  return page.evaluateHandle(
    (refMatch, col) => {
      const heads = [...document.querySelectorAll(".fields-table th")].map((th) => th.textContent.replace(/ [▲▼]$/, ""));
      const ci = heads.indexOf(col);
      const ri = heads.indexOf("Reference");
      const row = [...document.querySelectorAll(".fields-table tbody tr")].find((tr) => {
        const td = tr.children[ri];
        const text = td.querySelector("input")?.value ?? td.textContent;
        return text.split(", ").includes(refMatch);
      });
      return row?.children[ci]?.querySelector("input");
    },
    refMatch,
    col,
  );
}
async function type(refMatch, col, value) {
  const el = (await cell(refMatch, col)).asElement();
  if (!el) return expect(false, `cell ${refMatch}/${col}`);
  await el.click();
  await el.evaluate((e) => e.select());
  await el.type(value);
  await page.keyboard.press("Enter");
  await idle();
  await wait(300);
}

console.log("-- open, fields table");
await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await wait(800);
await page.keyboard.press("e");
await page.evaluate(() => document.querySelector('button[title^="Symbol fields table"]')?.click());
await page.waitForSelector(".fields-table", { timeout: 5000 });
const before = await proj();
const r = before.components.find((c) => c.reference === "R1");
const group = before.components.filter((c) => c.value === r.value && c.footprint === r.footprint && c.libId === r.libId).map((c) => c.reference);
console.log(`  R1's line: ${group.join(" ")}`);
globalThis.nextPrompt = "MPN";
await page.evaluate(() => [...document.querySelectorAll(".fields-table button")].find((b) => b.textContent.includes("+ Field"))?.click());
await wait(200);
await type("R1", "MPN", "RC0603FR-07TEST");
await page.screenshot({ path: `${OUT}/fields.png` });
let p = await proj();
expect(group.every((ref) => p.components.find((c) => c.reference === ref).properties.MPN === "RC0603FR-07TEST"), `MPN on all of ${group.join(",")}`);

console.log("-- one part, ungrouped");
await page.evaluate(() => [...document.querySelectorAll(".fields-table label")].find((l) => l.textContent.includes("Group like"))?.querySelector("input").click());
await wait(200);
await type("C1", "Value", "4.7uF");
p = await proj();
expect(p.components.find((c) => c.reference === "C1").value === "4.7uF", "C1 value");

const files = await page.evaluate(() => window.__crossprobe.files());
for (const [k, v] of Object.entries(files)) if (k.endsWith(".kicad_sch")) writeFileSync(`${OUT}/${k}`, v);
execFileSync("kicad-cli", ["sch", "export", "bom", "--fields", "Reference,Value,MPN", "--group-by", "", "-o", `${OUT}/bom.csv`, `${OUT}/pic_programmer.kicad_sch`], { stdio: "pipe" });
const bom = readFileSync(`${OUT}/bom.csv`, "utf8").split("\n").map((l) => [...l.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')));
const row = (ref) => bom.find((l) => l[0] === ref);
expect(group.every((ref) => row(ref)?.[2] === "RC0603FR-07TEST"), "KiCad's BOM: MPN on the line");
expect(row("C1")?.[1] === "4.7uF", "KiCad's BOM: C1 value");
const others = bom.filter((l) => l[0] && l[0] !== "Reference" && !group.includes(l[0]) && l[2]);
expect(others.length === 0, `no MPN elsewhere (${others.map((l) => l[0]).join(" ")})`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

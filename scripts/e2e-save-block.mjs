// End-to-end, saving a selection as a design block. On KiCad's pic_programmer demo the input supply
// (bottom left) is box-selected and saved with "Save as block": the project gets the block's
// schematic and description in <project>.kicad_blocks/, and design-block-lib-table lists that
// library, as KiCad lays them out. The Add block tool lists it under "This project's blocks", and
// inserting it adds a copy of its parts. KiCad reads the saved block on its own.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-save-block.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/save-block");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const answers = [];
page.on("dialog", (d) => d.accept(answers.shift() ?? ""));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = () => page.waitForFunction(() => !document.body.textContent.includes("Updating…"), { timeout: 60000 });
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
const sch = (p) => page.evaluate((p) => window.__schematicView.toClient(p), p);
const refs = () => page.evaluate(() => window.__crossprobe.project.components.map((c) => c.reference));

await page.goto(`${URL}?demo=pic_programmer/pic_programmer.kicad_pro`, { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await wait(800);
await page.keyboard.press("e");
await wait(300);
const before = await refs();

console.log("-- box-select the input supply and save it");
const a = await sch({ x: 15, y: 160 });
const b = await sch({ x: 115, y: 190 });
await page.keyboard.down("Shift");
await page.mouse.move(a.x, a.y);
await page.mouse.down();
await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
await page.mouse.move(b.x, b.y, { steps: 5 });
await page.mouse.up();
await page.keyboard.up("Shift");
await wait(300);
const selected = await page.evaluate(() => document.querySelector(".edit-hint").textContent.match(/(\d+) selected/)?.[1]);
expect(Number(selected) > 10, `${selected} items selected`);
answers.push("input_supply", "8–15 V in, 5 V out with a 7805");
await page.evaluate(() => [...document.querySelectorAll(".edit-hint button")].find((x) => x.textContent === "Save as block").click());
await idle();
await wait(500);
const files = await page.evaluate(() => window.__crossprobe.files());
const blockSch = Object.keys(files).find((k) => k.endsWith("input_supply.kicad_block/input_supply.kicad_sch"));
const blockJson = Object.keys(files).find((k) => k.endsWith("input_supply.kicad_block/input_supply.json"));
const table = Object.keys(files).find((k) => k.endsWith("design-block-lib-table"));
expect(!!blockSch && blockSch.includes("pic_programmer.kicad_blocks/"), `the block's schematic: ${blockSch}`);
expect(!!blockJson && JSON.parse(files[blockJson]).description === "8–15 V in, 5 V out with a 7805", "its description");
expect(!!table && files[table].includes('(uri "${KIPRJMOD}/pic_programmer.kicad_blocks")'), "the library table lists the project's block library");

console.log("-- insert it again from the Add block tool");
await page.keyboard.press("Escape");
await page.evaluate(() => [...document.querySelectorAll(".tool-rail button")].find((x) => x.querySelector(".tl")?.textContent === "Add block").click());
await page.waitForSelector(".block-picker", { timeout: 5000 });
await wait(300);
const listed = await page.evaluate(() => [...document.querySelectorAll(".block-picker .part-list button .part-name")].map((x) => x.textContent));
expect(listed[0] === "input_supply", `listed first, as the project's own: ${listed.slice(0, 3).join(", ")}`);
await page.evaluate(() => [...document.querySelectorAll(".block-picker .part-list button")].find((x) => x.querySelector(".part-name")?.textContent === "input_supply").click());
await wait(200);
await page.evaluate(() => [...document.querySelectorAll(".block-picker button")].find((x) => x.textContent.startsWith("Insert in free space")).click());
await idle();
await wait(800);
const after = await refs();
expect(after.length - before.length >= 4, `the copy's parts were added (${after.length - before.length} new)`);
await page.screenshot({ path: `${OUT}/inserted.png` });

// KiCad reads the saved block on its own.
const path = `${OUT}/${blockSch.split("/").slice(-1)[0]}`;
writeFileSync(path, files[blockSch]);
execFileSync("kicad-cli", ["sch", "export", "netlist", "--format", "kicadxml", "-o", `${OUT}/block.xml`, path], { stdio: "ignore" });
const comps = [...readFileSync(`${OUT}/block.xml`, "utf8").matchAll(/<comp ref="([^"]+)"/g)].map((m) => m[1]);
expect(comps.includes("U3") && comps.includes("C1") && comps.includes("P1"), `KiCad's netlist of the block has its parts: ${comps.join(" ")}`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

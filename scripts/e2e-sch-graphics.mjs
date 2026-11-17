// End-to-end, schematic text and graphics: in a new project a text (T), a text box, lines, a
// rectangle, a circle, an image (then halved), a table (a cell filled in) and an arc are drawn with the schematic tools, then the text is double-clicked and
// renamed. KiCad reads the saved schematic and writes the same items back (`sch upgrade`), and its SVG
// plot shows both texts.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-sch-graphics.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/sch-graphics");
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
const tool = (label) => page.evaluate((l) => [...document.querySelectorAll(".edit-toolbar button")].find((b) => b.querySelector(".tl")?.textContent === l).click(), label);
const kinds = () => page.evaluate(() => window.__crossprobe.sheet.items.reduce((m, i) => ((m[i.kind] = (m[i.kind] ?? 0) + 1), m), {}));

await page.goto(URL, { waitUntil: "networkidle0" });
await page.type('input[aria-label="Project name"]', "graphics");
await page.click(".new-project button");
await page.waitForSelector(".viewport.schematic svg", { timeout: 20000 });
await wait(500);
await page.keyboard.press("e");

console.log("-- text, text box, lines, rectangle, circle");
await page.keyboard.press("t");
globalThis.nextPrompt = "Power stage";
await clickSch({ x: 101.6, y: 76.2 });
await idle();
await tool("Text box");
await clickSch({ x: 101.6, y: 88.9 });
globalThis.nextPrompt = "Keep C1 close to U1";
await clickSch({ x: 139.7, y: 99.06 });
await idle();
await tool("Lines");
await clickSch({ x: 101.6, y: 114.3 });
await clickSch({ x: 127, y: 114.3 });
await clickSch({ x: 127, y: 127 });
await page.keyboard.press("Enter");
await idle();
await tool("Rectangle");
await clickSch({ x: 152.4, y: 76.2 });
await clickSch({ x: 177.8, y: 101.6 });
await idle();
await tool("Circle");
await clickSch({ x: 165.1, y: 120.65 });
await clickSch({ x: 172.72, y: 120.65 });
await idle();
console.log("-- an image, then half its size");
{
  // A small PNG to place.
  const chunk = (type, data) => {
    const t = Buffer.from(type, "latin1");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const [w, h] = [300, 150];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), ...Array.from({ length: w }, (_, x) => Buffer.from(((x >> 4) + (y >> 4)) % 2 ? [220, 30, 30] : [30, 60, 220]))])));
  writeFileSync(`${OUT}/picture.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
}
await tool("Image");
{
  const c = await sch({ x: 228.6, y: 76.2 });
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.mouse.click(c.x, c.y)]);
  await chooser.accept([`${OUT}/picture.png`]);
}
await idle();
await wait(500);
await page.keyboard.press("Escape");
{
  const box = await page.evaluate(() => {
    const r = document.querySelector(".viewport.schematic image").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await wait(300);
  await page.select(".edit-hint select", "0.5");
  await idle();
  await wait(300);
}
console.log("-- a table, a cell filled in by double-click");
await tool("Table");
globalThis.nextPrompt = "2 x 3";
await clickSch({ x: 101.6, y: 152.4 });
await idle();
await page.keyboard.press("Escape");
{
  const cell = await page.evaluate(() => {
    const g = [...document.querySelectorAll(".viewport.schematic g.i-cell")][4];
    const r = g.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  globalThis.nextPrompt = "3.3 V";
  await page.mouse.click(cell.x, cell.y, { count: 2 });
  await idle();
  await wait(300);
}
{
  // Dragging a cell moves the whole table.
  const g = await page.evaluate(() => {
    const r = [...document.querySelectorAll(".viewport.schematic g.i-cell")][0].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const before = await page.evaluate(() => window.__crossprobe.sheet.items.filter((i) => i.kind === "cell").map((i) => i.prims[0].d).join());
  const scale = await page.evaluate(() => window.__schematicView.toClient({ x: 10, y: 0 }).x - window.__schematicView.toClient({ x: 0, y: 0 }).x);
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await page.mouse.move(g.x, g.y + 0.635 * scale, { steps: 3 });
  await page.mouse.move(g.x, g.y + 1.27 * scale, { steps: 3 });
  await page.mouse.up();
  await idle();
  await wait(300);
  const after = await page.evaluate(() => window.__crossprobe.sheet.items.filter((i) => i.kind === "cell").map((i) => i.prims[0].d).join());
  expect(after !== before && (await page.evaluate(() => window.__crossprobe.sheet.items.filter((i) => i.kind === "cell").length)) === 6, "dragging a cell moves the whole table");
}
await tool("Arc");
await clickSch({ x: 190.5, y: 101.6 });
await clickSch({ x: 215.9, y: 101.6 });
await clickSch({ x: 198.12, y: 91.44 });
await idle();
await page.keyboard.press("Escape");
await page.screenshot({ path: `${OUT}/drawn.png` });

console.log("-- double-click the text to rename it");
const at = await page.evaluate(() => {
  const g = [...document.querySelectorAll(".viewport.schematic g.i-text")].find((g) => g.textContent === "Power stage");
  const r = g.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
globalThis.nextPrompt = "Power input";
await page.mouse.click(at.x, at.y, { count: 2 });
await wait(200);
await idle();

const files = await page.evaluate(() => window.__crossprobe.files());
for (const [k, v] of Object.entries(files)) writeFileSync(`${OUT}/${k.split("/").pop()}`, v);
const schFile = Object.keys(files).find((f) => f.endsWith(".kicad_sch")).split("/").pop();
const ours = readFileSync(`${OUT}/${schFile}`, "utf8");
const count = (re) => (ours.match(re) ?? []).length;
expect(count(/\(text "Power input"/g) === 1 && !ours.includes("Power stage"), "the text was renamed");
expect(count(/\(text_box "Keep C1 close to U1"/g) === 1, "a text box");
expect(count(/\(polyline/g) === 1 && count(/\(rectangle/g) === 1 && count(/\(circle/g) === 1 && count(/\(arc/g) === 1, `lines, rectangle, circle and arc (polyline ${count(/\(polyline/g)}, rectangle ${count(/\(rectangle/g)}, circle ${count(/\(circle/g)}, arc ${count(/\(arc/g)})`);
const k = await kinds();
expect(count(/\(table\b/g) === 1 && count(/\(table_cell\b/g) === 6 && /\(table_cell "3\.3 V"/.test(ours), "a 2 × 3 table, one cell filled in");
expect(count(/\(image\b/g) === 1 && /\(scale 0\.5\)/.test(ours), "an image, at half size");
expect(k.text >= 2 && k.graphic >= 4, `drawn items: ${JSON.stringify(k)}`);

// KiCad reads the file and writes it back the same.
mkdirSync(`${OUT}/kicad`, { recursive: true });
copyFileSync(`${OUT}/${schFile}`, `${OUT}/kicad/${schFile}`);
execFileSync("kicad-cli", ["sch", "upgrade", "--force", `${OUT}/kicad/${schFile}`], { stdio: "ignore" });
// KiCad sorts top-level items by type and stamps its own file version: compare them as a set.
// (The new-project template's embedded_fonts line KiCad leaves out.)
const blocks = (t) => t.replace(/\n\)\s*$/, "").split(/\n\t(?=\()/).slice(1).filter((b) => !/^\((version|embedded_fonts)/.test(b)).sort();
const theirs = readFileSync(`${OUT}/kicad/${schFile}`, "utf8");
expect(JSON.stringify(blocks(theirs)) === JSON.stringify(blocks(ours)), "KiCad writes the same items back");
execFileSync("kicad-cli", ["sch", "export", "svg", "-o", `${OUT}/svg`, `${OUT}/${schFile}`], { stdio: "ignore" });
const svg = readdirSync(`${OUT}/svg`).map((f) => readFileSync(`${OUT}/svg/${f}`, "utf8")).join("");
expect(svg.includes("Power input") && svg.includes("Keep C1 close to U1"), "KiCad's plot shows both texts");
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

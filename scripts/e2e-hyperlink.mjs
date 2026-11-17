// End-to-end, links on texts. On KiCad's pic_programmer demo a text gets the link "#2" with the
// Link control; out of editing, clicking the text opens page 2 (the PIC sockets sheet). With a web
// address instead, the click opens that address.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-hyperlink.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/hyperlink");
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
const textAt = () => page.evaluate(() => {
  const g = [...document.querySelectorAll(".viewport.schematic g.i-text")].find((x) => x.textContent.includes("8 to 15V"));
  const r = g.querySelector("text").getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
const linkTo = async (href) => {
  await page.keyboard.press("e");
  await wait(300);
  const t = await textAt();
  await page.mouse.click(t.x, t.y);
  await wait(300);
  globalThis.nextPrompt = href;
  await page.evaluate(() => [...document.querySelectorAll(".edit-hint button")].find((b) => b.textContent.startsWith("Link")).click());
  await idle();
  await wait(400);
  await page.keyboard.press("Escape");
  await page.keyboard.press("e");
  await wait(300);
};

await page.goto(`${URL}?demo=pic_programmer/pic_programmer.kicad_pro`, { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await wait(800);
await page.evaluate(() => {
  window.__opened = [];
  window.open = (u) => (window.__opened.push(u), null);
});

console.log("-- a page link");
await linkTo("#2");
expect(await page.evaluate(() => !!document.querySelector(".viewport.schematic g.i-text.has-link")), "the text shows as a link");
let t = await textAt();
await page.mouse.click(t.x, t.y);
await wait(800);
expect((await page.evaluate(() => window.__crossprobe.sheet.namePath)) === "/pic_sockets/", "clicking it opens page 2");

console.log("-- a web link");
await page.evaluate(() => [...document.querySelectorAll(".tree button")][0].click());
await wait(800);
await linkTo("https://example.com/psu");
t = await textAt();
await page.mouse.click(t.x, t.y);
await wait(300);
expect(JSON.stringify(await page.evaluate(() => window.__opened)) === '["https://example.com/psu"]', "clicking it opens the address");
const file = await page.evaluate(() => window.__crossprobe.files());
expect(Object.values(file).some((x) => x.includes('(href "https://example.com/psu")')), "the file has the link");
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");
await browser.close();

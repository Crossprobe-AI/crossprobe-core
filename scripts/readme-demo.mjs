// The README's demo GIF (docs/media/demo.gif): a board in progress, driven in the real app.
// It opens a half-finished project from the start screen, selects a part in the schematic, shows it on the board among
// the unrouted connections, routes one by hand, lets "Route all" do the rest and turns the 3D view.
//
// The project is the USB-C microcontroller board of scripts/e2e-usb.mjs, stopped once its parts
// are placed, its USB pairs routed and GND poured. With the dev server running (npm run dev):
//
//   STOP=poured node scripts/e2e-usb.mjs /tmp/usbmcu     # the project in progress
//   node scripts/readme-demo.mjs /tmp/usbmcu             # writes docs/media/demo.gif
//
// BROWSER = a Chromium-based browser executable; APP_URL = the app (default http://localhost:5173/);
// OUT = the GIF to write; WIDTH = its width in pixels (default 1280; the app is captured at 1680).
// No ffmpeg is needed: the frames are screenshots, decoded on a canvas in a blank page, and
// encoded by scripts/lib/gif.mjs.
// Each step carries a short caption, drawn over the page while it is recorded.
// Look at the result after UI changes: a step that no longer finds its button fails with its name.
import puppeteer from "puppeteer-core";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeGif } from "./lib/gif.mjs";

const SRC = process.argv[2];
if (!SRC) {
  console.error("usage: node scripts/readme-demo.mjs <project folder>   (see the top of this file)");
  process.exit(1);
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.env.OUT ?? join(ROOT, "docs/media/demo.gif"));
const URL = process.env.APP_URL ?? "http://localhost:5173/";
// Wide enough for the board toolbar to fit beside the side panels.
const VIEW = { width: 1680, height: 1050 };
const WIDTH = Number(process.env.WIDTH ?? 1280);
const HEIGHT = Math.round((WIDTH * VIEW.height) / VIEW.width);

const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ ...VIEW, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log("--", s);
// Frames: a screenshot and how long it stays up.
const frames = [];
// FRAMES=<dir>: also write the frames as PNG files (to see where a run went wrong).
const dump = () => {
  if (!process.env.FRAMES) return;
  mkdirSync(process.env.FRAMES, { recursive: true });
  for (const [k, f] of frames.entries()) writeFileSync(join(process.env.FRAMES, `${String(k).padStart(3, "0")}.png`), f.png);
};
const fail = async (msg) => {
  console.error("FAILED:", msg);
  dump();
  await browser.close();
  process.exit(1);
};
const proj = () => page.evaluate(() => window.__crossprobe.project);
const sch = (p) => page.evaluate((p) => window.__schematicView.toClient(p), p);
const brd = (p) => page.evaluate((p) => window.__boardView.toClient(p), p);
const idle = () => page.waitForFunction(() => !document.body.textContent.includes("Updating…"), { timeout: 60000 });
const press = async (sel, what) => {
  const ok = await page.evaluate((sel) => {
    const b = typeof sel === "string" && !sel.startsWith("text=") ? document.querySelector(sel) : [...document.querySelectorAll("button")].find((x) => x.textContent.includes(sel.slice(5)));
    b?.click();
    return !!b;
  }, sel);
  if (!ok) await fail(`${what}: no button for ${sel}`);
};

const frame = async (ms = 80) => frames.push({ png: await page.screenshot({ type: "png" }), ms });
const hold = (ms) => frame(ms);
// Headless Chromium draws no pointer: an arrow that follows the mouse stands in for it.
/** The view's box on the page, once a project is open. */
let area;
let mouse = { x: VIEW.width / 2, y: VIEW.height / 2 };
const addPointer = () =>
  page.evaluate(() => {
    const el = document.createElement("div");
    el.innerHTML = '<svg width="20" height="24" viewBox="0 0 20 24"><path d="M2 1v18l5-4.5 3.2 7.5 3-1.3-3.2-7.4H17z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    el.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform";
    document.body.appendChild(el);
    const at = (e) => (el.style.transform = `translate(${e.clientX - 2}px,${e.clientY - 1}px)`);
    for (const t of ["mousemove", "pointermove", "mousedown"]) document.addEventListener(t, at, true);
  });
/** A caption over the view, saying what the step shows ("" takes it away). */
const caption = (text) =>
  page.evaluate(
    (text, cx) => {
      let el = document.getElementById("demo-caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "demo-caption";
        el.style.cssText = "position:fixed;bottom:132px;transform:translateX(-50%);z-index:2147483646;pointer-events:none;padding:12px 22px;border-radius:999px;background:#10231c;color:#fff;font:600 24px/1.2 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);white-space:nowrap";
        document.body.appendChild(el);
      }
      el.style.left = `${cx}px`;
      el.textContent = text;
      el.style.display = text ? "" : "none";
    },
    text,
    area ? area.x + area.w / 2 : VIEW.width / 2,
  );
/** Move the pointer there in a few frames, slowing at the end. */
async function glide(to, n = 8, ms = 60) {
  const from = mouse;
  for (let k = 1; k <= n; k++) {
    const t = 1 - (1 - k / n) ** 2;
    mouse = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    await page.mouse.move(mouse.x, mouse.y);
    await wait(40);
    await frame(ms);
  }
}
async function click() {
  await page.mouse.click(mouse.x, mouse.y);
  await wait(250);
}

step("open the project folder");
// An in-browser (OPFS) copy of the folder stands in for the folder picker.
const files = {};
for (const name of readdirSync(SRC)) if (/\.kicad_\w+$|-lib-table$/.test(name) && statSync(join(SRC, name)).isFile()) files[name] = readFileSync(join(SRC, name), "utf8");
if (!Object.keys(files).some((n) => n.endsWith(".kicad_pcb"))) await fail(`no board in ${SRC}`);
await page.goto(URL + "?home", { waitUntil: "networkidle0" });
await page.waitForSelector(".welcome", { timeout: 30000 });
await page.evaluate(async (files) => {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry("demo", { recursive: true }).catch(() => undefined);
  const dir = await root.getDirectoryHandle("demo", { create: true });
  for (const [path, text] of Object.entries(files)) {
    const w = await (await dir.getFileHandle(path, { create: true })).createWritable();
    await w.write(text);
    await w.close();
  }
  window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("demo");
}, files);
await addPointer();
await page.mouse.move(mouse.x, mouse.y);
await caption("1 · Open a KiCad project folder");
await hold(1500);
const choose = await page.evaluate(() => {
  const r = [...document.querySelectorAll(".welcome button")].find((b) => b.textContent.includes("Choose folder"))?.getBoundingClientRect();
  return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
if (!choose) await fail("no Choose folder button on the start screen");
await glide(choose);
await hold(500);
await click();
await page.waitForFunction(() => window.__crossprobe?.project, { timeout: 60000 });
await page.waitForSelector(".viewport.schematic svg", { timeout: 60000 });
await idle();
await wait(500);
await hold(1300);

step("schematic: zoom to the circuit, select the microcontroller");
const items = await page.evaluate(() => window.__crossprobe.sheet.items.map((i) => ({ kind: i.kind, ref: i.ref, bbox: i.bbox })));
const parts = items.filter((i) => i.ref && i.bbox);
const mcu = parts.reduce((a, b) => (b.bbox.w * b.bbox.h > a.bbox.w * a.bbox.h ? b : a));
const x0 = Math.min(...parts.map((i) => i.bbox.x));
const x1 = Math.max(...parts.map((i) => i.bbox.x + i.bbox.w));
const y0 = Math.min(...parts.map((i) => i.bbox.y));
const y1 = Math.max(...parts.map((i) => i.bbox.y + i.bbox.h));
area = await page.evaluate(() => {
  const r = document.querySelector(".viewport.schematic").getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
await caption("2 · Select a part in the schematic");
await hold(900);
// Wheel in on the circuit's middle until it fills most of the view.
for (let k = 0; k < 12; k++) {
  const a = await sch({ x: x0, y: y0 });
  const b = await sch({ x: x1, y: y1 });
  if (b.x - a.x > area.w * 0.78 || b.y - a.y > area.h * 0.7) break;
  mouse = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  await page.mouse.move(mouse.x, mouse.y);
  await page.mouse.wheel({ deltaY: -120 });
  await wait(120);
  await frame(70);
}
await hold(700);
await glide(await sch({ x: mcu.bbox.x + mcu.bbox.w / 2, y: mcu.bbox.y + mcu.bbox.h / 2 }));
await click();
await hold(1400);

step("board: the same part, among the connections still to route");
await page.keyboard.press("b");
await page.waitForSelector(".viewport.board", { timeout: 20000 });
await idle();
await wait(600);
await caption("3 · The same part on the board, among what is left to route");
await hold(1800);

step("board: route one connection by hand");
// A project opened from a folder is read-only until Edit is on.
await page.keyboard.press("e");
await wait(300);
let p = await proj();
const dist = (u) => Math.hypot(u.a.at.x - u.b.at.x, u.a.at.y - u.b.at.y);
// A signal with some length to it, so the track is seen following the pointer.
// (not from the USB-C receptacle: its 0.5 mm contacts are the autorouter's to fan out)
const todo = p.unconnected.filter((u) => !/GND$|\+3V3$|VBUS$/.test(u.net) && dist(u) > 4 && ![u.a, u.b].some((e) => /of J1$/.test(e.description))).sort((a, b) => dist(a) - dist(b));
const link = todo[Math.floor(todo.length / 3)] ?? p.unconnected[0];
if (!link) await fail("the project has nothing left to route");
console.log(`   ${link.net}: ${link.a.description} → ${link.b.description}, ${dist(link).toFixed(1)} mm`);
const m = 9;
await page.evaluate((b) => window.__boardView.frame(b), { x: Math.min(link.a.at.x, link.b.at.x) - m * 1.6, y: Math.min(link.a.at.y, link.b.at.y) - m, w: Math.abs(link.a.at.x - link.b.at.x) + m * 3.2, h: Math.abs(link.a.at.y - link.b.at.y) + m * 2 });
await wait(400);
await caption("4 · Route a track by hand");
await hold(900);
await page.keyboard.press("x");
await glide(await brd(link.a.at));
await click();
await hold(300);
await glide(await brd(link.b.at), 14, 70);
await click();
await idle();
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
// Refill the pours around the new track.
await page.keyboard.press("b");
await idle();
await wait(400);
await hold(1100);
const left = (await proj()).unconnected.length;
if (left >= p.unconnected.length) await fail(`${link.net} was not routed (${left} connections left)`);

step("board: Route all");
await press(".view-tools button", "Fit");
await wait(400);
await caption("5 · Route all does the rest");
await hold(900);
// Route all is in the toolbar's Tools menu: open it, then choose it, as a user does.
const at = (selector) =>
  page.evaluate((selector) => {
    const r = document.querySelector(selector)?.getBoundingClientRect();
    return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined;
  }, selector);
const tools = await at(".edit-toolbar .tools-menu > summary");
if (!tools) await fail("no Tools menu");
await glide(tools);
await click();
await frame(300);
const routeAll = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".tools-menu .menu-items button")].find((x) => x.title?.startsWith("Route every unrouted"));
  const r = b?.getBoundingClientRect();
  return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined;
});
if (!routeAll) await fail("no Route all in the Tools menu");
await glide(routeAll);
await click();
await frame(400);
await idle();
await wait(800);
await page.keyboard.press("Escape");
p = await proj();
console.log(`   unrouted after Route all: ${p.unconnected.length}`);
await glide({ x: area.x + area.w * 0.75, y: area.y + area.h * 0.8 }, 5);
await hold(2200);

step("3D");
await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.includes("3D"))?.click());
await page.waitForSelector(".viewport.board3d canvas", { timeout: 30000 }).catch(() => fail("the 3D view did not open"));
await page.waitForFunction(() => !document.body.textContent.includes("Loading 3D models"), { timeout: 120000 }).catch(() => fail("the 3D models did not load"));
await wait(1200);
await caption("6 · See the board in 3D");
await hold(900);
const c = { x: area.x + area.w / 2, y: area.y + area.h / 2 };
await glide(c, 4);
await page.mouse.down();
await glide({ x: c.x - 200, y: c.y + 25 }, 22, 70);
await page.mouse.up();
await hold(2500);

step(`encode ${frames.length} frames`);
dump();
// Decode each screenshot to RGBA on a canvas in a blank page (and scale it, when WIDTH is set).
const tab = await browser.newPage();
await tab.goto("about:blank");
const rgba = [];
for (const f of frames) {
  const b64 = await tab.evaluate(
    async (png, w, h) => {
      const im = await createImageBitmap(await (await fetch("data:image/png;base64," + png)).blob());
      const cv = new OffscreenCanvas(w, h);
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(im, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let s = "";
      for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
      return btoa(s);
    },
    Buffer.from(f.png).toString("base64"),
    WIDTH,
    HEIGHT,
  );
  rgba.push(new Uint8Array(Buffer.from(b64, "base64")));
}
await browser.close();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, encodeGif(rgba.map((d, k) => ({ rgba: d, ms: frames[k].ms })), WIDTH, HEIGHT));
const secs = frames.reduce((t, f) => t + f.ms, 0) / 1000;
console.log(`${OUT}: ${frames.length} frames, ${secs.toFixed(1)} s, ${WIDTH}×${HEIGHT}, ${(statSync(OUT).size / 1e6).toFixed(2)} MB`);

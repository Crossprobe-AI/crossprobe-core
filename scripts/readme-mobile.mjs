// The README's phone picture (docs/media/mobile.png): the viewer the editor becomes on a phone
// (apps/web/src/ui/Compact.tsx), three screens side by side. The RP2040 example (a design block)
// is opened on an emulated iPhone: the schematic with a part tapped, the board, and the 3D view.
//
// With the dev server running (npm run dev):
//
//   node scripts/readme-mobile.mjs                       # writes docs/media/mobile.png
//
// BROWSER = a Chromium-based browser executable; APP_URL = the app (default http://localhost:5173/);
// OUT = the PNG to write; WIDTH = its width in pixels (default 1200).
// ASSETS_URL = where the design blocks (/__blocks) and the 3D models (/__demos) come from, when the
// app at APP_URL has none (a build served without KiCad's libraries), e.g. https://core.crossprobe.ai.
import puppeteer, { KnownDevices } from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.env.OUT ?? join(ROOT, "docs/media/mobile.png"));
const URL_ = process.env.APP_URL ?? "http://localhost:5173/";
const ASSETS = process.env.ASSETS_URL?.replace(/\/$/, "");
const WIDTH = Number(process.env.WIDTH ?? 1200);
const BLOCK = "rp2040-minimal";
const PART = "U1";

const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.emulate(KnownDevices["iPhone 14"]);
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = async (msg) => {
  console.error("FAILED:", msg);
  await browser.close();
  process.exit(1);
};

if (ASSETS) {
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    const u = new URL(req.url());
    if (!/^\/__(blocks|demos)\b/.test(u.pathname)) return req.continue();
    try {
      const r = await fetch(ASSETS + u.pathname + u.search);
      await req.respond({ status: r.status, contentType: r.headers.get("content-type") ?? undefined, body: Buffer.from(await r.arrayBuffer()) });
    } catch {
      await req.respond({ status: 502, body: "" });
    }
  });
}

const tap = async (selector, what) => {
  const el = await page.$(selector);
  if (!el) await fail(`no ${what} (${selector})`);
  const b = await el.boundingBox();
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
};
const tabByText = async (name) => {
  const handle = await page.evaluateHandle((name) => [...document.querySelectorAll(".compact-tabs button")].find((b) => b.textContent.trim() === name), name);
  const el = handle.asElement();
  if (!el) await fail(`no ${name} tab`);
  const b = await el.boundingBox();
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
};
await page.goto(`${URL_}?block=${BLOCK}`, { waitUntil: "networkidle0" });
await page.waitForSelector(".app.compact .compact-tabs", { timeout: 30000 }).catch(() => fail("the phone viewer did not appear"));
// The "new project from a block" line goes after 12 s; the pictures are of the views alone.
await page.waitForFunction(() => !document.querySelector(".status"), { timeout: 20000 }).catch(() => {});
await wait(500);

const shots = [];
const shot = async () => shots.push(Buffer.from(await page.screenshot({ type: "png" })).toString("base64"));

// 1. The schematic, with a part tapped.
await tap(`g[data-ref="${PART}"]`, `${PART} in the schematic`);
await page.waitForSelector(".compact-part", { timeout: 5000 }).catch(() => fail("no part sheet"));
await wait(300);
await shot();
await tap('.compact-part button[aria-label="Close"]', "Close");

// 2. The board.
await tabByText("Board");
await wait(1500);
await tap(".view-tools button", "Fit");
await wait(500);
await shot();

// 3. The 3D view, once its models are in.
await tabByText("3D");
await page.waitForFunction(() => document.querySelector(".board3d canvas"), { timeout: 30000 }).catch(() => fail("no 3D view"));
await page.waitForFunction(() => !/Loading/i.test(document.querySelector(".board3d .progress")?.textContent ?? ""), { timeout: 60000 }).catch(() => {});
await wait(2500);
await shot();

// Side by side, each screen in a rounded frame, drawn on a canvas in a blank page.
const png = await page.evaluate(
  async (shots, width) => {
    const imgs = await Promise.all(
      shots.map(
        (b64) =>
          new Promise((res) => {
            const i = new Image();
            i.onload = () => res(i);
            i.src = `data:image/png;base64,${b64}`;
          }),
      ),
    );
    const w = imgs[0].width;
    const h = imgs[0].height;
    const gap = Math.round(w * 0.1);
    const pad = gap;
    const bezel = Math.round(w * 0.03);
    const radius = Math.round(w * 0.12);
    const c = document.createElement("canvas");
    c.width = pad * 2 + imgs.length * (w + bezel * 2) + (imgs.length - 1) * gap;
    c.height = pad * 2 + h + bezel * 2;
    const g = c.getContext("2d");
    const round = (x, y, ww, hh, r) => {
      g.beginPath();
      g.roundRect(x, y, ww, hh, r);
    };
    imgs.forEach((img, k) => {
      const x = pad + k * (w + bezel * 2 + gap);
      const y = pad;
      g.save();
      g.shadowColor = "rgba(0,0,0,0.25)";
      g.shadowBlur = bezel * 2;
      g.shadowOffsetY = bezel / 2;
      round(x, y, w + bezel * 2, h + bezel * 2, radius + bezel);
      g.fillStyle = "#1b1f23";
      g.fill();
      g.restore();
      g.save();
      round(x + bezel, y + bezel, w, h, radius);
      g.clip();
      g.drawImage(img, x + bezel, y + bezel);
      g.restore();
    });
    const out = document.createElement("canvas");
    out.width = width;
    out.height = Math.round((c.height * width) / c.width);
    out.getContext("2d").drawImage(c, 0, 0, out.width, out.height);
    return out.toDataURL("image/png").split(",")[1];
  },
  shots,
  WIDTH,
);
writeFileSync(OUT, Buffer.from(png, "base64"));
console.log(`wrote ${OUT}`);
await browser.close();

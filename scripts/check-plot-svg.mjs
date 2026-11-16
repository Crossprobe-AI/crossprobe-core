// Our SVG board plots against kicad-cli's (pcb export svg, board area, black and white): both
// rasterized in the browser at 20 px/mm and compared pixel by pixel (a pixel counts only if the other plot has no ink within a pixel of it, and after
// the best shift of up to 2 px); under 0.5% of the ink may differ. Run `npm run build` first, then:
// node scripts/check-plot-svg.mjs [out-dir]
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseBoard, plotSvg } from "@crossprobe/kicad-model";
const OUT = process.argv[2] ?? "scripts/e2e-out/plot";
const DEMOS = process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos";
const BOARDS = ["pic_programmer/pic_programmer.kicad_pcb", "stickhub/StickHub.kicad_pcb", "video/video.kicad_pcb"];
const LAYERS = ["F.Cu", "B.Cu", "F.SilkS", "F.Mask", "B.Paste", "Edge.Cuts"];
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setContent("<html><body></body></html>");
let bad = 0;
for (const file of BOARDS) {
  const board = parseBoard(readFileSync(`${DEMOS}/${file}`, "utf8"));
  const name = file.split("/").pop().replace(".kicad_pcb", "");
  for (const layer of LAYERS) {
    const ours = plotSvg(board, [layer], { margin: 0 });
    const kpath = `${OUT}/${name}-${layer}-kicad.svg`;
    execFileSync("kicad-cli", ["pcb", "export", "svg", "--mode-single", "--layers", layer, "--page-size-mode", "2", "--exclude-drawing-sheet", "--black-and-white", "-o", kpath, `${DEMOS}/${file}`], { stdio: "pipe" });
    writeFileSync(`${OUT}/${name}-${layer}-ours.svg`, ours);
    const r = await page.evaluate(
      async (a, b) => {
        const PX = 20;
        const raster = async (svg) => {
          const vb = /viewBox="([^"]+)"/.exec(svg)[1].split(/\s+/).map(Number);
          const img = new Image();
          img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
          await img.decode();
          const c = document.createElement("canvas");
          c.width = Math.round(vb[2] * PX);
          c.height = Math.round(vb[3] * PX);
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          const ink = new Uint8Array(c.width * c.height);
          for (let i = 0; i < ink.length; i++) ink[i] = d[i * 4] < 128 ? 1 : 0;
          return { w: c.width, h: c.height, ink };
        };
        const A = await raster(a);
        const B = await raster(b);
        // A pixel differs when the other image has no ink within one pixel of it (edges of thin
        // lines land a pixel apart with antialiasing).
        const near = (I, x, y) => {
          for (let j = -1; j <= 1; j++)
            for (let i = -1; i <= 1; i++) {
              const u = x + i, v = y + j;
              if (u >= 0 && v >= 0 && u < I.w && v < I.h && I.ink[v * I.w + u]) return true;
            }
          return false;
        };
        let best = { diff: Infinity, dx: 0, dy: 0 };
        let inkA = 0;
        for (const v of A.ink) inkA += v;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            let diff = 0;
            for (let y = 0; y < A.h; y++)
              for (let x = 0; x < A.w; x++) {
                const a = A.ink[y * A.w + x];
                const bx = x + dx, by = y + dy;
                const b = bx >= 0 && by >= 0 && bx < B.w && by < B.h ? B.ink[by * B.w + bx] : 0;
                if (a === b) continue;
                if (a ? !near(B, bx, by) : !near(A, x, y)) diff++;
              }
            if (diff < best.diff) best = { diff, dx, dy };
            if (!diff) break;
          }
        return { ...best, inkA, size: [A.w, A.h, B.w, B.h] };
      },
      ours,
      readFileSync(kpath, "utf8"),
    );
    const frac = r.inkA ? r.diff / r.inkA : r.diff ? 1 : 0;
    const ok = frac < 0.005;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name} ${layer}: ${(frac * 100).toFixed(2)}% of ink differs (shift ${r.dx},${r.dy}; ${r.size.join("x")})`);
  }
}
await browser.close();
console.log(bad ? `${bad} layers differ` : "ALL OK");

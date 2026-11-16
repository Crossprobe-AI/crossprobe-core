// End-to-end, IPC-2581 and ODB++ in the fab outputs: with both options on, pic_programmer's fab
// zip carries <board>-IPC-2581.xml and an <board>-odb/ tree; each equals kicad-cli's own export
// by what CAM tools read (the comparisons in packages/kicad-model/test). The zip's Gerber job file
// equals KiCad's (everything after its header), so the project's design rules reach it.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-fab-formats.mjs <out-dir>
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const OUT = resolve(process.argv[2] ?? "scripts/e2e-out/fab-formats");
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const PCB = `${process.env.KICAD_DEMOS ?? "/Library/Application Support/kicad/demos"}/pic_programmer/pic_programmer.kicad_pcb`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
await page.goto(URL + "?demo=pic_programmer/pic_programmer.kicad_pro", { waitUntil: "networkidle0" });
await page.waitForSelector(".viewport", { timeout: 60000 });
await page.evaluate(() => document.querySelector('button[title^="Gerbers, drill files"]')?.click());
await page.waitForSelector(".fab-export");
for (const label of ["Add IPC-2581", "Add ODB++"]) await page.evaluate((label) => { const l = [...document.querySelectorAll(".fab-export label")].find((x) => x.textContent.includes(label)); const i = l?.querySelector("input"); if (i && !i.checked) i.click(); }, label);
await wait(300);
await page.evaluate(() => [...document.querySelectorAll(".fab-export button.primary")][0].click());
let zip;
for (let i = 0; i < 60 && !zip; i++) {
  await wait(300);
  zip = readdirSync(OUT).find((f) => f.endsWith(".zip"));
}
await browser.close();
expect(!!zip, `zip ${zip}`);
execFileSync("unzip", ["-q", "-o", "-d", `${OUT}/z`, `${OUT}/${zip}`]);
const names = readdirSync(`${OUT}/z`);
expect(names.some((n) => n.endsWith("-IPC-2581.xml")) && names.some((n) => n.endsWith("-odb")), `zip: ${names.filter((n) => /IPC|odb/.test(n)).join(", ")}`);
const D = `${OUT}/k`;
mkdirSync(D);
execFileSync("kicad-cli", ["pcb", "export", "ipc2581", "-o", `${D}/k.xml`, PCB], { stdio: "ignore" });
execFileSync("kicad-cli", ["pcb", "export", "odb", "--compression", "none", "-o", `${D}/odb`, PCB], { stdio: "ignore" });
const ipc = JSON.parse(execFileSync("python3", ["packages/kicad-model/test/ipc2581-compare.py", `${D}/k.xml`, `${OUT}/z/${names.find((n) => n.endsWith("-IPC-2581.xml"))}`]).toString());
expect(ipc.components.differ.length === 0 && ipc.nets.differ === 0 && ipc.holes.nOnly.join() === "0,0" && ipc.tracks.differ === 0, `IPC-2581 as KiCad's: ${ipc.components.count[1]} parts, ${ipc.nets.count[1]} nets, ${ipc.holes.count[1]} holes`);
const odb = JSON.parse(execFileSync("python3", ["packages/kicad-model/test/odb-compare.py", `${D}/odb`, `${OUT}/z/${names.find((n) => n.endsWith("-odb"))}`]).toString());
expect(odb.components.differ.length === 0 && odb.nets.differ === 0 && odb.holes.nOnly.join() === "0,0", `ODB++ as KiCad's: ${odb.components.count[1]} parts, ${odb.nets.count[1]} nets, ${odb.holes.count[1]} holes`);
execFileSync("kicad-cli", ["pcb", "export", "gerbers", "--no-protel-ext", "-l", "F.Cu,B.Cu,F.Paste,B.Paste,F.SilkS,B.SilkS,F.Mask,B.Mask,Edge.Cuts", "-o", `${D}/gbr/`, PCB], { stdio: "ignore" });
const body = (t) => t.slice(t.indexOf('  "GeneralSpecs"'));
const job = names.find((n) => n.endsWith(".gbrjob"));
expect(!!job && body(readFileSync(`${OUT}/z/${job}`, "utf8")) === body(readFileSync(`${D}/gbr/pic_programmer-job.gbrjob`, "utf8")), `Gerber job file ${job} as KiCad's`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "ALL OK");

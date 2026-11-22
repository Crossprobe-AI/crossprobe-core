// Unsaved changes survive a reload: a new project, a project from a block link, and a folder
// project (an in-browser OPFS folder stands in for the folder picker). Also: Discard, and the
// start-screen link dropping the kept changes.
// Run the dev server (npm run dev -w @crossprobe/web), then: node scripts/e2e-persist.mjs
// BROWSER = a Chromium-based browser executable; APP_URL = the app (default http://localhost:5173/).
import puppeteer from "puppeteer-core";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
page.on("dialog", (d) => d.accept()); // the "leave site?" prompt for unsaved changes
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log("--", s);
const problems = [];
const expect = (ok, msg) => {
  console.log(ok ? "  ok:" : "  FAIL:", msg);
  if (!ok) problems.push(msg);
};
const opened = () => page.waitForFunction(() => window.__crossprobe?.project, { timeout: 60000 });
const welcome = () => page.waitForSelector(".welcome", { timeout: 30000 });
const banner = () => page.$eval(".status.restored", (e) => e.textContent).catch(() => undefined);
const files = () => page.evaluate(() => window.__crossprobe.files());
const dirty = () => page.evaluate(() => window.__crossprobe.dirty);
/** A no-connect flag on the root sheet: an edit to keep. */
const addNoConnect = (x) => page.evaluate((x) => window.__crossprobe.edit([{ op: "addNoConnect", file: window.__crossprobe.sheet.file, at: { x, y: 20 } }]), x);
const reload = async () => {
  await wait(800); // the worker writes changes shortly after each edit
  await page.reload({ waitUntil: "networkidle0" });
};
const noConnects = (text) => (text.match(/\(no_connect/g) ?? []).length;

step("a new project survives a reload");
await page.goto(URL + "?home", { waitUntil: "networkidle0" });
await welcome();
await page.type('input[aria-label="Project name"]', "keepme");
await page.keyboard.press("Enter");
await opened();
if (!(await page.evaluate(() => window.__crossprobe.project.name === "keepme"))) {
  // The form may want its button rather than Enter.
  await page.evaluate(() => [...document.querySelectorAll(".welcome button")].find((b) => /create|new/i.test(b.textContent))?.click());
  await opened();
}
const before = await dirty();
await reload();
await opened();
expect((await page.evaluate(() => window.__crossprobe.project.name)) === "keepme", "the project is back after the reload");
expect(JSON.stringify(await dirty()) === JSON.stringify(before), "the same files are unsaved");
expect(!!(await banner()), "the restored banner is shown");

step("Discard on a never-saved project goes back to the start screen, and stays there on reload");
await page.evaluate(() => [...document.querySelectorAll(".status.restored button")].find((b) => b.textContent.includes("Discard")).click());
await welcome();
await reload();
await welcome();
expect(!(await page.evaluate(() => window.__crossprobe?.project)), "nothing is restored after discarding");

step("an edit to a project opened from a block link survives a reload");
await page.goto(URL + "?block=ap2112k-3v3-ldo", { waitUntil: "networkidle0" });
await opened();
await addNoConnect(5);
const edited = await files();
const root = Object.keys(edited).find((f) => edited[f].includes("(no_connect"));
expect(!!root, "the edit is made");
await reload();
await opened();
const back = await files();
expect(back[root] === edited[root], "the edited schematic is back after the reload, text for text");
expect(!!(await banner()), "the restored banner is shown");

step("an edit made right before a reload is kept, without waiting for the writer's delay");
await addNoConnect(15);
const justEdited = await files();
// No wait: the tab being hidden and unloaded stores the waiting changes at once (persist.ts keepChangesNow).
await page.reload({ waitUntil: "networkidle0" });
await opened();
expect(noConnects((await files())[root]) === noConnects(justEdited[root]), "the last edit is back after an immediate reload");

step("the start-screen link drops the kept changes");
await page.click("a.brand");
await page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => undefined);
await welcome();
expect(!new URLSearchParams(await page.evaluate(() => location.search)).has("home"), "?home is taken off the address");
await reload();
await welcome();
expect(!(await page.evaluate(() => window.__crossprobe?.project)), "nothing is restored after going to the start screen");

step("a folder project: restored after a reload, and Save writes into the folder");
// Make a project folder in OPFS from a new project's files, and have the folder picker return it.
await page.type('input[aria-label="Project name"]', "folderproj");
await page.keyboard.press("Enter");
await opened();
const seed = await files();
await page.evaluate(async (seed) => {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry("folderproj", { recursive: true }).catch(() => undefined);
  const dir = await root.getDirectoryHandle("folderproj", { create: true });
  for (const [path, text] of Object.entries(seed)) {
    const w = await (await dir.getFileHandle(path, { create: true })).createWritable();
    await w.write(text);
    await w.close();
  }
}, seed);
const pickFolder = () =>
  page.evaluate(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("folderproj");
  });
await page.goto(URL + "?home", { waitUntil: "networkidle0" });
await welcome();
await pickFolder();
await page.evaluate(() => [...document.querySelectorAll(".welcome button")].find((b) => b.textContent.includes("Choose folder")).click());
await opened();
expect((await dirty()).length === 0, "the folder opens with nothing unsaved");
await addNoConnect(5);
await addNoConnect(10);
const sch = (await dirty())[0];
expect(!!sch, "two edits are unsaved");
await reload();
await opened();
expect(JSON.stringify(await dirty()) === JSON.stringify([sch]), "the edits are back after the reload");
expect(noConnects((await files())[sch]) === 2, "both no-connects are there");
await page.click("button.save");
await page.waitForFunction(() => window.__crossprobe.dirty.length === 0, { timeout: 15000 });
const onDisk = await page.evaluate(async (sch) => (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle("folderproj")).getFileHandle(sch)).getFile()).text(), sch);
expect(noConnects(onDisk) === 2, "Save wrote the restored edits into the folder");
await reload();
await welcome();
expect(!(await page.evaluate(() => window.__crossprobe?.project)), "after saving, a reload has nothing to restore");

step("Discard on a folder project goes back to the files as saved");
await pickFolder();
await page.evaluate(() => [...document.querySelectorAll(".welcome button")].find((b) => b.textContent.includes("Choose folder")).click());
await opened();
await addNoConnect(15);
await reload();
await opened();
expect(noConnects((await files())[sch]) === 3, "the third no-connect is back after the reload");
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await page.evaluate(() => [...document.querySelectorAll(".status.restored button")].find((b) => b.textContent.includes("Discard")).click());
await page.waitForFunction(() => window.__crossprobe.dirty.length === 0, { timeout: 15000 });
expect((await dirty()).length === 0, "nothing is unsaved after discarding");
expect(await page.evaluate(() => window.__crossprobe.project.name === "folderproj"), "the project stays open, as saved");
await reload();
await welcome();
expect(!(await page.evaluate(() => window.__crossprobe?.project)), "nothing is restored after discarding");

await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s)` : "\nall ok");
process.exit(problems.length ? 1 : 0);

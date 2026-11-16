// Video of a scripted run without ffmpeg: Chrome DevTools' screencast collects frames while the
// script works, then a blank page draws them onto a canvas at their own timing (sped up) and the
// browser's MediaRecorder encodes WebM, which is written to `path`.
import { writeFileSync } from "node:fs";

export async function startRecording(page, path, { speed = 2, maxWidth = 1600 } = {}) {
  const cdp = await page.createCDPSession();
  const frames = [];
  cdp.on("Page.screencastFrame", async (f) => {
    frames.push({ data: f.data, t: f.metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  // The screencast captures the browser window: give it the page's size (headless starts at 4:3).
  const vp = page.viewport() ?? { width: 1600, height: 1000 };
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: vp.width, height: vp.height } });
  } catch {
    // not supported: frames keep the window's shape
  }
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth, maxHeight: Math.round((maxWidth * vp.height) / vp.width), everyNthFrame: 1 });
  return async function stop() {
    await cdp.send("Page.stopScreencast").catch(() => {});
    if (frames.length < 2) return 0;
    const browser = page.browser();
    const tab = await browser.newPage();
    await tab.goto("about:blank");
    // Frames go over in batches; the page decodes them, then plays and records.
    await tab.evaluate(() => (window.__frames = []));
    for (let i = 0; i < frames.length; i += 50) await tab.evaluate((batch) => window.__frames.push(...batch), frames.slice(i, i + 50));
    const b64 = await tab.evaluate(async (speed) => {
      const fr = window.__frames;
      const imgs = await Promise.all(fr.map((f) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = "data:image/jpeg;base64," + f.data; })));
      const canvas = document.createElement("canvas");
      canvas.width = imgs[0].naturalWidth;
      canvas.height = imgs[0].naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(imgs[0], 0, 0);
      const type = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
      const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 6e6 });
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise((res) => (rec.onstop = res));
      rec.start(1000);
      const t0 = fr[0].t;
      const start = performance.now();
      for (let k = 0; k < imgs.length; k++) {
        const due = ((fr[k].t - t0) * 1000) / speed;
        const wait = due - (performance.now() - start);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        ctx.drawImage(imgs[k], 0, 0);
      }
      await new Promise((r) => setTimeout(r, 500));
      rec.stop();
      await done;
      const blob = new Blob(chunks, { type: "video/webm" });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    }, speed);
    await tab.close();
    writeFileSync(path, Buffer.from(b64, "base64"));
    return frames.length;
  };
}

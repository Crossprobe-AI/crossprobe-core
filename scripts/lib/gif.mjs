// An animated GIF from RGBA frames, with no dependency: one 255-colour palette for the whole
// clip (median cut), and for every frame after the first only the box of pixels that changed,
// with unchanged pixels inside it left transparent.

/** frames: [{ rgba: Uint8Array (width × height × 4), ms }] → the GIF's bytes. */
export function encodeGif(frames, width, height) {
  const n = width * height;
  // Colours are binned at 5 bits a channel; a bin's colour is the average of what fell in it.
  const count = new Float64Array(32768);
  const sum = new Float64Array(32768 * 3);
  const stride = Math.max(1, Math.floor((frames.length * n) / 3e6));
  const bin = (d, i) => ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
  for (const f of frames)
    for (let p = 0; p < n; p += stride) {
      const b = bin(f.rgba, p * 4);
      count[b]++;
      for (let c = 0; c < 3; c++) sum[b * 3 + c] += f.rgba[p * 4 + c];
    }
  const used = [];
  for (let b = 0; b < 32768; b++) if (count[b]) used.push({ c: [0, 1, 2].map((k) => sum[b * 3 + k] / count[b]), n: count[b] });
  const palette = medianCut(used, 255);
  const SAME = 255; // the transparent index: "as in the frame before"
  // Nearest palette entry per bin, found on first use.
  const nearest = new Int16Array(32768).fill(-1);
  const indexOf = (d, i) => {
    const b = bin(d, i);
    if (nearest[b] >= 0) return nearest[b];
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const q = palette[k];
      const dist = (q[0] - d[i]) ** 2 + (q[1] - d[i + 1]) ** 2 + (q[2] - d[i + 2]) ** 2;
      if (dist < bestD) [best, bestD] = [k, dist];
    }
    return (nearest[b] = best);
  };

  const out = [];
  const u16 = (v) => [v & 255, v >> 8];
  out.push(...Buffer.from("GIF89a"), ...u16(width), ...u16(height), 0xf7, 0, 0);
  for (let k = 0; k < 256; k++) out.push(...(palette[k] ?? [0, 0, 0]).map(Math.round));
  out.push(0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0); // loop forever
  let prev;
  const chunks = [Buffer.from(out)];
  for (const f of frames) {
    const index = new Uint8Array(n);
    for (let p = 0; p < n; p++) index[p] = indexOf(f.rgba, p * 4);
    let box = { x: 0, y: 0, w: width, h: height };
    let pixels = index;
    if (prev) {
      let x0 = width, y0 = height, x1 = -1, y1 = -1;
      for (let p = 0; p < n; p++)
        if (index[p] !== prev[p]) {
          const x = p % width;
          const y = (p - x) / width;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      if (x1 < 0) [x0, y0, x1, y1] = [0, 0, 0, 0]; // nothing changed: one transparent pixel
      box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
      pixels = new Uint8Array(box.w * box.h);
      for (let y = 0; y < box.h; y++)
        for (let x = 0; x < box.w; x++) {
          const p = (y + box.y) * width + x + box.x;
          pixels[y * box.w + x] = index[p] === prev[p] ? SAME : index[p];
        }
    }
    const head = [0x21, 0xf9, 4, (1 << 2) | (prev ? 1 : 0), ...u16(Math.round(f.ms / 10)), SAME, 0];
    head.push(0x2c, ...u16(box.x), ...u16(box.y), ...u16(box.w), ...u16(box.h), 0, 8);
    chunks.push(Buffer.from(head), lzw(pixels), Buffer.from([0]));
    prev = index;
  }
  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}

/** Median cut: split the box with the widest spread at its weighted median until there are `want`. */
function medianCut(colors, want) {
  const boxes = [colors];
  const spread = (box) => {
    let best = { axis: 0, range: -1 };
    for (let a = 0; a < 3; a++) {
      let lo = 255, hi = 0;
      for (const q of box) {
        if (q.c[a] < lo) lo = q.c[a];
        if (q.c[a] > hi) hi = q.c[a];
      }
      if (hi - lo > best.range) best = { axis: a, range: hi - lo };
    }
    return best;
  };
  while (boxes.length < want) {
    // The box to split: the widest one that holds more than one colour.
    let pick = -1, pickS;
    for (const [k, box] of boxes.entries()) {
      if (box.length < 2) continue;
      const s = spread(box);
      if (!pickS || s.range > pickS.range) [pick, pickS] = [k, s];
    }
    if (pick < 0) break;
    const box = boxes[pick].sort((a, b) => a.c[pickS.axis] - b.c[pickS.axis]);
    const half = box.reduce((t, q) => t + q.n, 0) / 2;
    let cut = 0;
    for (let t = 0; cut < box.length - 1 && t + box[cut].n <= half; cut++) t += box[cut].n;
    cut = Math.max(1, cut);
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => {
    const total = box.reduce((t, q) => t + q.n, 0);
    return [0, 1, 2].map((a) => box.reduce((t, q) => t + q.c[a] * q.n, 0) / total);
  });
}

/** GIF's LZW for 8-bit indices, as data sub-blocks. */
function lzw(pixels) {
  const CLEAR = 256, END = 257;
  const bytes = [];
  let acc = 0, bits = 0, size = 9, next = 258;
  const emit = (code) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      bytes.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
    }
  };
  const dict = new Map();
  emit(CLEAR);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const c = pixels[i];
    const key = (prefix << 8) | c;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(CLEAR);
      dict.clear();
      next = 258;
      size = 9;
    }
    prefix = c;
  }
  emit(prefix);
  emit(END);
  if (bits) bytes.push(acc & 255);
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const part = bytes.slice(i, i + 255);
    out.push(part.length, ...part);
  }
  return Buffer.from(out);
}

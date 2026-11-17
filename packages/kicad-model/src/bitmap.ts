/**
 * The size of a picture as KiCad draws it (schematic images, drawing-sheet logos). KiCad takes the
 * picture's resolution as wxWidgets reads it: a PNG's pHYs chunk (pixels per metre, divided down to
 * whole pixels per cm, then to the nearest inch), a JPEG's JFIF density; without one, 300 pixels
 * per inch. `scale` then multiplies the size.
 */

export interface BitmapInfo {
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
  /** Pixels per inch: from the picture, or KiCad's 300. */
  ppi: number;
}

/** Bytes `n` from `offset` of the picture; fewer at its end. */
type Reader = (offset: number, n: number) => Uint8Array;

/** KiCad's pixels per inch from a resolution and its unit: 1 per metre (PNG), 2 per cm (JPEG), else as it is. */
function ppiOf(res: number, unit: "m" | "cm" | "none"): number | undefined {
  const r = unit === "m" ? Math.floor(res / 100) : res;
  if (r <= 1) return undefined;
  return unit === "none" ? r : Math.round(r * 2.54);
}

function infoFrom(read: Reader, length: number): BitmapInfo | undefined {
  const head = read(0, 24);
  const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  if (head.length >= 24 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    const info: BitmapInfo = { mime: "image/png", width: u32(head, 16), height: u32(head, 20), ppi: 300 };
    // The chunks before the image data, however long (a big text or colour profile may come first).
    for (let o = 8; o + 8 <= length; ) {
      const h = read(o, 8);
      if (h.length < 8) break;
      const len = u32(h, 0);
      const type = String.fromCharCode(h[4]!, h[5]!, h[6]!, h[7]!);
      if (type === "IDAT" || type === "IEND") break;
      if (type === "pHYs" && len >= 9) {
        const d = read(o + 8, 9);
        if (d.length === 9) {
          const ppi = d[8] === 1 ? ppiOf(u32(d, 0), "m") : ppiOf(u32(d, 0), "none");
          if (ppi) info.ppi = ppi;
        }
      }
      o += 12 + len;
    }
    return info.width && info.height ? info : undefined;
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    let ppi = 300;
    for (let o = 2; o + 4 <= length; ) {
      const m = read(o, 4);
      if (m.length < 4 || m[0] !== 0xff) return undefined;
      const marker = m[1]!;
      const len = (m[2]! << 8) | m[3]!;
      if (marker === 0xe0) {
        // JFIF: units (0 none, 1 per inch, 2 per cm), then the horizontal density.
        const d = read(o + 4, 10);
        if (d.length === 10 && String.fromCharCode(d[0]!, d[1]!, d[2]!, d[3]!) === "JFIF") {
          const p = ppiOf((d[8]! << 8) | d[9]!, d[7] === 2 ? "cm" : "none");
          if (p) ppi = p;
        }
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const f = read(o + 5, 4);
        return { mime: "image/jpeg", height: (f[0]! << 8) | f[1]!, width: (f[2]! << 8) | f[3]!, ppi };
      }
      o += 2 + len;
    }
  }
  return undefined;
}

/** Width, height and resolution of a PNG or JPEG; undefined for anything else. */
export function bitmapInfo(bytes: Uint8Array): BitmapInfo | undefined {
  return infoFrom((o, n) => bytes.subarray(o, o + n), bytes.length);
}

/**
 * The same, from base64 text, decoding only the pieces read (a picture's headers, however far in),
 * not the whole picture. Undefined for malformed text.
 */
export function bitmapInfoBase64(b64: string): BitmapInfo | undefined {
  const s = b64.replace(/\s+/g, "");
  const length = Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
  const read: Reader = (offset, n) => {
    if (offset >= length) return new Uint8Array(0);
    const from = Math.floor(offset / 3) * 4;
    const to = Math.min(s.length, Math.ceil((offset + n) / 3) * 4);
    const bin = atob(s.slice(from, to));
    const skip = offset - (from / 4) * 3;
    const out = new Uint8Array(Math.max(0, Math.min(n, bin.length - skip)));
    for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(skip + i);
    return out;
  };
  try {
    return infoFrom(read, length);
  } catch {
    return undefined;
  }
}

/** Size in mm, as KiCad draws the picture at `scale`. */
export function bitmapSizeMm(info: BitmapInfo, scale = 1): { w: number; h: number } {
  return { w: (info.width / info.ppi) * 25.4 * scale, h: (info.height / info.ppi) * 25.4 * scale };
}

/** Bytes of base64 text (whitespace ignored); only the first `limit` bytes when given. */
export function base64Bytes(b64: string, limit?: number): Uint8Array {
  let s = b64.replace(/\s+/g, "");
  if (limit !== undefined) s = s.slice(0, Math.ceil(limit / 3) * 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The size of a picture as KiCad draws it (schematic images, drawing-sheet logos). KiCad takes a
 * PNG's resolution from its pHYs chunk, as wxWidgets reads it (pixels per metre, divided down to
 * whole pixels per cm, then to the nearest inch); without one, 300 pixels per inch. `scale` then
 * multiplies the size.
 */

export interface BitmapInfo {
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
  /** Pixels per inch: from the PNG, or KiCad's 300. */
  ppi: number;
}

/** Width, height and resolution of a PNG (or a JPEG's MIME type, sized at 300 ppi); undefined for anything else. */
export function bitmapInfo(bytes: Uint8Array): BitmapInfo | undefined {
  const u32 = (o: number) => ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const info: BitmapInfo = { mime: "image/png", width: u32(16), height: u32(20), ppi: 300 };
    // Chunks after the header, up to the image data (pHYs must come before it).
    for (let o = 8; o + 8 <= bytes.length; ) {
      const len = u32(o);
      const type = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!);
      if (type === "IDAT" || type === "IEND") break;
      if (type === "pHYs" && len >= 9 && o + 17 <= bytes.length) {
        const x = u32(o + 8);
        const unit = bytes[o + 16];
        // KiCad: a resolution of 0 or 1 means none; per metre is read as whole pixels per cm.
        const res = unit === 1 ? Math.floor(x / 100) : x;
        if (res > 1) info.ppi = unit === 1 ? Math.round(res * 2.54) : res;
      }
      o += 12 + len;
    }
    return info.width && info.height ? info : undefined;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    // JPEG: the frame header's size.
    for (let o = 2; o + 9 < bytes.length; ) {
      if (bytes[o] !== 0xff) return undefined;
      const marker = bytes[o + 1]!;
      const len = (bytes[o + 2]! << 8) | bytes[o + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", height: (bytes[o + 5]! << 8) | bytes[o + 6]!, width: (bytes[o + 7]! << 8) | bytes[o + 8]!, ppi: 300 };
      }
      o += 2 + len;
    }
  }
  return undefined;
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

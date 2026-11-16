/**
 * Open a datasheet (a link, or a file the engineer chose), index it, and draw
 * regions of its pages. pdf.js loads on first use.
 */
import { fetchDatasheet } from "../extensions";
import { indexPdf } from "./extract";
import type { Box, DatasheetIndex } from "./types";

type PdfJs = typeof import("pdfjs-dist");
type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

let lib: Promise<PdfJs> | undefined;
function pdfjs(): Promise<PdfJs> {
  lib ??= (async () => {
    const [m, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
    m.GlobalWorkerOptions.workerSrc = worker.default;
    return m;
  })();
  return lib;
}

export interface OpenDatasheet {
  index: DatasheetIndex;
  /** Where it came from: the link, or the file name. */
  source: string;
  pdf: PdfDoc;
  bytes: Uint8Array;
}

const open = new Map<string, Promise<OpenDatasheet>>();

async function fromBytes(bytes: Uint8Array, source: string, title: string): Promise<OpenDatasheet> {
  const m = await pdfjs();
  const pdf = await m.getDocument({ data: bytes.slice() }).promise;
  const index = await indexPdf(pdf as never, bytes, title, m.OPS as never);
  return { index, source, pdf, bytes };
}

/** Fetch (through an extension's server when there is one: most sites don't allow it from a page), index, and keep the result for the session. */
export function openFromLink(link: string): Promise<OpenDatasheet> {
  let p = open.get(link);
  if (!p) {
    p = (async () => {
      const r = await fetchDatasheet(link).catch(() => {
        throw new Error("This site doesn't let the browser read its PDF from here. Download the datasheet and open the file instead.");
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `The datasheet could not be fetched (${r.status})`);
      return fromBytes(new Uint8Array(await r.arrayBuffer()), link, titleOf(link));
    })();
    open.set(link, p);
    p.catch(() => open.delete(link));
  }
  return p;
}

export async function openFromFile(file: File): Promise<OpenDatasheet> {
  return fromBytes(new Uint8Array(await file.arrayBuffer()), file.name, file.name.replace(/\.pdf$/i, ""));
}

const titleOf = (link: string) => decodeURIComponent(link.split(/[?#]/)[0]!.split("/").pop() ?? link).replace(/\.pdf$/i, "");

/**
 * Draw a region of a page, with some of its lines highlighted, onto a canvas
 * `width` CSS pixels wide. `pad` is extra margin around the region in points.
 */
export async function renderRegion(doc: OpenDatasheet, pageNumber: number, box: Box, highlights: Box[], width: number, pad = 10): Promise<HTMLCanvasElement> {
  const page = await doc.pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const padX = pad * 2.4; // tables and notes run wider than the text we measured
  const region: Box = {
    x: Math.max(0, box.x - padX),
    y: Math.max(0, box.y - pad),
    w: Math.min(base.width, box.x + box.w + padX) - Math.max(0, box.x - padX),
    h: Math.min(base.height, box.y + box.h + pad) - Math.max(0, box.y - pad),
  };
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const scale = (width * dpr) / region.w;
  const viewport = page.getViewport({ scale, offsetX: -region.x * scale, offsetY: -region.y * scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(region.w * scale);
  canvas.height = Math.round(region.h * scale);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${(canvas.height / dpr).toFixed(1)}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  ctx.fillStyle = "rgba(255, 214, 0, 0.38)";
  for (const h of highlights) ctx.fillRect((h.x - region.x - 1) * scale, (h.y - region.y - 1) * scale, (h.w + 2) * scale, (h.h + 2) * scale);
  return canvas;
}

/** Read the pages that have no text with OCR, and index again. Progress is "page k of n". */
export async function runOcr(doc: OpenDatasheet, onProgress: (done: number, total: number) => void): Promise<OpenDatasheet> {
  const todo = doc.index.scanned.length;
  let done = 0;
  const reader = await (await import("./ocr")).ocrReader(async (n, scale) => {
    const page = await doc.pdf.getPage(n);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    return canvas;
  });
  try {
    const m = await pdfjs();
    const index = await indexPdf(
      doc.pdf as never,
      doc.bytes,
      doc.index.title,
      m.OPS as never,
      async (n) => {
        onProgress(done++, todo);
        return reader.read(n);
      },
    );
    onProgress(todo, todo);
    return { ...doc, index };
  } finally {
    await reader.done();
  }
}

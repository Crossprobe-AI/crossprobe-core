/**
 * Scanned datasheets have no text layer. The engineer can ask for OCR: the
 * pages without text are drawn, read by tesseract.js (in the browser; the PDF
 * does not leave it), and the words go through the same index as real text.
 * The OCR engine and its English language data (~10 MB) download once, on
 * first use, from tesseract.js's default CDN (jsDelivr).
 */
import type { Run } from "./extract";

export interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

/** OCR words (image pixels) as text runs (PDF points, y down). Low-confidence words are dropped. */
export function runsFromWords(words: OcrWord[], scale: number): Run[] {
  return words
    .filter((w) => w.text.trim() && w.confidence >= 45)
    .map((w) => {
      const h = (w.bbox.y1 - w.bbox.y0) / scale;
      return { str: w.text, x: w.bbox.x0 / scale, base: w.bbox.y1 / scale - h * 0.15, w: (w.bbox.x1 - w.bbox.x0) / scale, size: Math.max(4, h * 0.85) };
    });
}

const SCALE = 2.5;

type Worker = { recognize(image: HTMLCanvasElement, options?: object, output?: { blocks: boolean }): Promise<{ data: { blocks: Array<{ paragraphs: Array<{ lines: Array<{ words: OcrWord[] }> }> }> | null } }>; terminate(): Promise<unknown> };

/** A function that reads one page's text with OCR, and one to release the worker. */
export async function ocrReader(render: (n: number, scale: number) => Promise<HTMLCanvasElement>): Promise<{ read: (n: number) => Promise<Run[]>; done: () => Promise<unknown> }> {
  const { createWorker } = await import("tesseract.js");
  const worker = (await createWorker("eng")) as unknown as Worker;
  return {
    read: async (n) => {
      const canvas = await render(n, SCALE);
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      const words = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
      return runsFromWords(words, SCALE);
    },
    done: () => worker.terminate(),
  };
}

/**
 * The board as a STEP assembly, as KiCad's STEP export makes it: the board body and every
 * footprint's own STEP model, placed (stepAssembly), scaled where the footprint scales it. Models
 * only available as VRML (KiCad leaves those out of STEP too; the GLB export has them), or with an
 * uneven scale on geometry that can't take it exactly (tori, spheres, cones), are left out and reported.
 */
import { stepAssembly, type Board } from "@crossprobe/kicad-model";
import type { ModelSource } from "../load";

export async function exportStep(board: Board, name: string, models?: ModelSource): Promise<{ bytes: Uint8Array; placed: number; skipped: Array<{ reference: string; path: string }> }> {
  const texts = new Map<string, string>();
  const paths = [...new Set(board.footprints.flatMap((f) => f.models.filter((m) => !m.hidden && m.path).map((m) => m.path)))];
  // STEP is ASCII; decode byte for byte so nothing is changed on the way through.
  const latin1 = new TextDecoder("latin1");
  await Promise.all(
    paths.map(async (p) => {
      const data = models ? await models(p).catch(() => undefined) : undefined;
      if (data?.format === "step") texts.set(p, latin1.decode(data.buffer));
    }),
  );
  const r = stepAssembly(name, board, texts);
  const bytes = new Uint8Array(new ArrayBuffer(r.text.length));
  for (let i = 0; i < r.text.length; i++) bytes[i] = r.text.charCodeAt(i) & 0xff;
  return { bytes, placed: r.placed.length, skipped: r.skipped };
}

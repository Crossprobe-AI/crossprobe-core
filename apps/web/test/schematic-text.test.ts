/**
 * Generated sheets read cleanly: no text over another. Power symbols read across, past their far end
 * or beside it; a part turned a quarter has its reference and value stacked beside its body; and the
 * renderer puts pin numbers where KiCad does (above a pin on the right, left of one on top).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { designBlockSpec, generateBlockSchematic, layoutDesignSheet, resolveLibrarySymbol, strokeAdvance, type DesignSpec } from "@crossprobe/kicad-model";
import { analyze } from "../src/analyze";
import type { SheetView } from "../src/render/types";

const SYMBOLS = process.env.KICAD_SYMBOLS!;
const CORE = join(import.meta.dirname, "../../..");
const libs = {
  symbol: (id: string) => {
    const [lib, name] = id.split(":");
    try {
      return resolveLibrarySymbol(readFileSync(join(SYMBOLS, `${lib}.kicad_sym`), "utf8"), lib!, name!);
    } catch {
      return undefined;
    }
  },
  footprint: () => undefined,
};

const sheetOf = (name: string, sch: string): SheetView => analyze({ project: name, files: { [`${name}.kicad_sch`]: sch, [`${name}.kicad_pro`]: "{}" } }).sheets[0]!;

type TextPrim = Extract<SheetView["items"][number]["prims"][number], { t: "text" }>;
/** The box a drawn text covers. Markup (V_{SS}, ~{RESET}) is drawn without its braces. */
function textBox(p: TextPrim) {
  const w = strokeAdvance(p.text.replace(/[_^~]\{([^}]*)\}/g, "$1")) * p.size, h = p.size;
  const along = p.anchor === "start" ? [0, w] : p.anchor === "end" ? [-w, 0] : [-w / 2, w / 2];
  const across = p.baseline === "bottom" ? [-h, 0] : p.baseline === "top" ? [0, h] : [-h / 2, h / 2];
  return p.angle === 90 ? { x0: p.x + across[0]!, x1: p.x + across[1]!, y0: p.y - along[1]!, y1: p.y - along[0]! } : { x0: p.x + along[0]!, x1: p.x + along[1]!, y0: p.y + across[0]!, y1: p.y + across[1]! };
}

/** Pairs of texts on a sheet whose boxes overlap (beyond a hair), as "a × b". The sheet's frame is left out. */
function overlaps(sheet: SheetView): string[] {
  const boxes: Array<{ x0: number; y0: number; x1: number; y1: number; what: string }> = [];
  for (const it of sheet.items)
    for (const p of it.prims) {
      if (p.t !== "text" || !p.text.trim() || p.role === "frame") continue;
      boxes.push({ ...textBox(p), what: `${it.ref ?? it.kind} ${p.role} "${p.text}"` });
    }
  const m = 0.05;
  const out: string[] = [];
  for (let a = 0; a < boxes.length; a++)
    for (let b = a + 1; b < boxes.length; b++) {
      const A = boxes[a]!, B = boxes[b]!;
      if (A.x1 - m > B.x0 && B.x1 - m > A.x0 && A.y1 - m > B.y0 && B.y1 - m > A.y0) out.push(`${A.what} × ${B.what}`);
    }
  return out;
}

const example = (name: string): DesignSpec => JSON.parse(readFileSync(join(CORE, "docs/examples", `${name}.json`), "utf8"));
const designSheet = (spec: DesignSpec) => generateBlockSchematic(designBlockSpec(spec, libs, layoutDesignSheet(spec, libs)), { resolve: (id: string) => libs.symbol(id)! });

describe.skipIf(!existsSync(SYMBOLS))("generated sheets", () => {
  it.each(["design-c3-sensor-node", "design-ldo-breakout"])("%s: no text over another", (name) => {
    expect(overlaps(sheetOf(name, designSheet(example(name))))).toEqual([]);
  });

  it("leaves room for a value the library draws beside the body: two ESD arrays side by side", () => {
    // TPD4E02B04's value sits right of its body, where the next part's labels would start.
    const esd = (ref: string, a: string, b: string) => ({ ref, symbol: "Power_Protection:TPD4E02B04DQA", value: "TPD4E02B04", footprint: "", group: "HDMI input", pins: { "1": `${a}_P`, "2": `${a}_N`, "3": "GND", "4": `${b}_P`, "5": `${b}_N`, "6": `${b}_N`, "7": `${b}_P`, "8": "GND", "9": `${a}_N`, "10": `${a}_P` } });
    const spec = { name: "esd", board: { width: 30, height: 20 }, parts: [esd("U2", "HDMI_D2", "HDMI_D1"), esd("U3", "HDMI_D0", "HDMI_CK")] } as DesignSpec;
    expect(overlaps(sheetOf("esd", designSheet(spec)))).toEqual([]);
  });

  const blocks = join(CORE, "blocks/library/crossprobe.kicad_blocks");
  it.each(readdirSync(blocks))("block %s: no text over another", (dir) => {
    const id = dir.replace(/\.kicad_block$/, "");
    expect(overlaps(sheetOf(id, readFileSync(join(blocks, dir, `${id}.kicad_sch`), "utf8")))).toEqual([]);
  });

  it("draws pin numbers where KiCad does: above a pin on the right, left of one on top", () => {
    const sheet = sheetOf("c3", designSheet(example("design-c3-sensor-node")));
    const pin = (n: string) => {
      const it = sheet.items.find((i) => i.kind === "pin" && i.ref === "U1" && i.pin === n)!;
      const line = it.prims.find((p) => p.t === "path" && p.role === "pin") as { d: string };
      const [x0, y0, x1, y1] = line.d.match(/-?[\d.]+/g)!.map(Number);
      const num = textBox(it.prims.find((p): p is TextPrim => p.t === "text" && p.role === "pinNumber")!);
      return { line: { x: x0!, y: y0! }, num };
    };
    // Pin 1 (3V3) is on top: its number is wholly left of it.
    const top = pin("1");
    expect(top.num.x1).toBeLessThanOrEqual(top.line.x);
    // Pin 11 (IO20/RXD) is on the right: its number is wholly above it.
    const right = pin("11");
    expect(right.num.y1).toBeLessThanOrEqual(right.line.y);
  });
});

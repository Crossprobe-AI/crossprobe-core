/**
 * Geographical reannotation of the board (KiCad's PCB "Geographical Reannotate"): references
 * renumbered by where parts sit, front and back each in a chosen direction, positions rounded
 * to a grid first so a row of parts counts as a row. Excluded parts (by prefix, `R1*`-style
 * pattern, locked, or the other side) keep their numbers, and nothing new takes them. Follows
 * KiCad 10's DIALOG_BOARD_REANNOTATE; the schematic follows with Update Schematic from PCB.
 */
import type { Board, Footprint } from "./board.js";

/** KiCad's eight directions, in its dialog's order. */
export const REANNOTATE_DIRECTIONS = [
  "Top to bottom, left to right",
  "Top to bottom, right to left",
  "Bottom to top, left to right",
  "Bottom to top, right to left",
  "Left to right, top to bottom",
  "Left to right, bottom to top",
  "Right to left, top to bottom",
  "Right to left, bottom to top",
] as const;

const SORT_Y_FIRST = 0b100, DESC_FIRST = 0b010, DESC_SECOND = 0b001;
// The back's left/right is mirrored (seen from the front).
const FRONT = [0b100, 0b101, 0b110, 0b111, 0b000, 0b001, 0b010, 0b011];
const BACK = [0b101, 0b100, 0b111, 0b110, 0b010, 0b011, 0b000, 0b001];

export interface ReannotateOptions {
  /** Index into REANNOTATE_DIRECTIONS. */
  direction?: number;
  /** Rounding grid for positions, mm (KiCad: the grid chosen, at least 1 µm). */
  grid?: number;
  /** "all" (default), or only one side. */
  sides?: "all" | "front" | "back";
  /** First number on the front (default 1), and on the back (0: carry on after the front). */
  frontStart?: number;
  backStart?: number;
  /** Prefixes added to (or, with remove, taken off) the references on each side. */
  frontPrefix?: string;
  backPrefix?: string;
  removeFrontPrefix?: boolean;
  removeBackPrefix?: boolean;
  /** Prefixes ("R", "TP") or patterns ending in * ("U1*") to leave alone. */
  exclude?: string[];
  excludeLocked?: boolean;
  /** Sort by the reference text's position instead of the footprint's. */
  byReferencePosition?: boolean;
  /** Only these footprints (UUIDs), as KiCad's "selection only". */
  only?: string[];
}

export interface ReannotateChange {
  uuid: string;
  from: string;
  to: string;
}

const prefixOf = (ref: string) => {
  const i = ref.search(/\d/);
  return i < 0 ? undefined : ref.slice(0, i);
};
const numberOf = (ref: string) => Number(/\d+/.exec(ref)?.[0] ?? 0);
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** KiCad's grid rounding: down to the grid, then up when the remainder is over half. */
const roundToGrid = (v: number, g: number) => {
  const iu = Math.round(v * 1e6), grid = Math.max(1000, Math.round(g * 1e6));
  const rem = iu % grid;
  let out = iu - rem;
  if (Math.abs(rem) > grid / 2) out += out < 0 ? -grid : grid;
  return out;
};

export function planBoardReannotate(board: Board, o: ReannotateOptions = {}): { changes: ReannotateChange[]; invalid: string[]; duplicates: string[] } {
  const dir = o.direction ?? 0;
  const grid = o.grid ?? 1.27;
  type Info = { fp: Footprint; ref: string; prefix: string; x: number; y: number; rx: number; ry: number; front: boolean; action: "update" | "empty" | "invalid" | "exclude" };
  const infos: Info[] = [];
  const excluded = (ref: string, prefix: string) =>
    (o.exclude ?? []).some((e) => (e.endsWith("*") ? new RegExp(`^${e.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$`).test(ref) : e === prefix));
  for (const fp of board.footprints) {
    if (fp.attributes.boardOnly && !fp.reference) continue;
    const ref = fp.reference;
    const p = o.byReferencePosition ? (fp.texts.find((t) => t.text === fp.reference)?.at ?? fp.at) : fp.at;
    const prefix = prefixOf(ref);
    let action: Info["action"] = !ref ? "empty" : prefix === undefined ? "invalid" : "update";
    const pre = prefix ?? ref;
    if (action === "update" && excluded(ref, pre)) action = "exclude";
    const front = fp.layer !== "B.Cu";
    if (fp.locked && o.excludeLocked) action = "exclude";
    else if (o.only) action = o.only.includes(fp.uuid) ? (action === "exclude" ? "exclude" : action) : "exclude";
    else if (o.sides === "front" && !front) action = "exclude";
    else if (o.sides === "back" && front) action = "exclude";
    infos.push({ fp, ref, prefix: pre, x: p.x, y: p.y, rx: roundToGrid(p.x, grid), ry: roundToGrid(p.y, grid), front, action });
  }
  const sorter = (code: number) => (a: Info, b: Info) => {
    let [x0, y0, x1, y1] = [a.rx, a.ry, b.rx, b.ry];
    if (code & SORT_Y_FIRST) [x0, y0, x1, y1] = [y0, x0, y1, x1];
    if (code & DESC_FIRST) [x0, x1] = [x1, x0];
    if (code & DESC_SECOND) [y0, y1] = [y1, y0];
    return x0 - x1 || y0 - y1;
  };
  const front = infos.filter((i) => i.front).sort(sorter(FRONT[dir] ?? 0));
  const back = infos.filter((i) => !i.front).sort(sorter(BACK[dir] ?? 0));

  // Numbers that excluded parts keep, per prefix: not handed out again.
  const prefixes = new Map<string, { last: number; taken: Set<number> }>();
  const info = (prefix: string, start = 0) => {
    let p = prefixes.get(prefix);
    if (!p) prefixes.set(prefix, (p = { last: Math.max(start - 1, 0), taken: new Set() }));
    return p;
  };
  for (const i of infos) if (i.action === "exclude") info(i.prefix).taken.add(numberOf(i.ref));

  const changes: Array<ReannotateChange & { action: Info["action"] }> = [];
  const invalid: string[] = [];
  const number = (list: Info[], start: number, prefix: string, remove: boolean) => {
    if (start !== 0) for (const p of prefixes.values()) p.last = start - 1;
    for (const i of list) {
      if (i.action === "empty" || i.action === "invalid") {
        invalid.push(i.ref || `(no reference) at ${i.x}, ${i.y}`);
        continue;
      }
      if (i.action !== "update") continue;
      let pre = i.prefix;
      const has = !!prefix && pre.startsWith(prefix);
      if (prefix && !remove && !has) pre = prefix + pre;
      if (prefix && remove && has) pre = pre.slice(prefix.length);
      const p = info(pre, start);
      let n = p.last + 1;
      while (p.taken.has(n)) n++;
      p.last = n;
      changes.push({ uuid: i.fp.uuid, from: i.ref, to: `${pre}${n}`, action: i.action });
    }
  };
  number(front, o.frontStart ?? 1, o.frontPrefix ?? "", !!o.removeFrontPrefix);
  number(back, o.backStart ?? 0, o.backPrefix ?? "", !!o.removeBackPrefix);
  changes.sort((a, b) => natural(a.from, b.from));
  // Two parts ending up with one reference: KiCad refuses, and so do we (the caller shows them).
  const seen = new Map<string, number>();
  for (const c of changes) seen.set(c.to, (seen.get(c.to) ?? 0) + 1);
  for (const i of infos) if (i.action === "exclude") seen.set(i.ref, (seen.get(i.ref) ?? 0) + 1);
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([r]) => r);
  return { changes: changes.filter((c) => c.from !== c.to).map(({ uuid, from, to }) => ({ uuid, from, to })), invalid, duplicates };
}

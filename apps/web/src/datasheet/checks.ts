/**
 * Checks of the design against the datasheet. They only compare and point:
 * every result carries the datasheet row it is based on (a Hit the panel
 * shows highlighted), and nothing is decided for the engineer.
 */
import { findSection, passageLines } from "./search";
import type { DatasheetIndex, Hit, Passage } from "./types";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface PinInfo {
  number: string;
  name: string;
  net: string;
  /** KiCad pin electrical type (power_in, input, …), when known. */
  type?: string;
}

export type PinStatus = "ok" | "ok-packages" | "number-differs" | "name-not-found";

export interface PinCheck {
  pin: PinInfo;
  status: PinStatus;
  /** The datasheet row it was compared with. */
  hit?: Hit;
  /** Pin numbers that row lists (several when it covers several packages). */
  numbers?: string[];
}

/** Numbers in a cell: "3", "6, 7", "3 (R5)", "A1". */
function numbersIn(cell: string): string[] {
  return (cell.replace(/\([^)]*\)/g, " ").match(/\b[A-Z]{0,2}\d{1,3}\b/g) ?? []).filter((n) => !/^\d{4,}$/.test(n));
}

const nameVariants = (name: string): string[] => {
  const n = norm(name);
  return [...new Set([n, n.replace(/^gp(io)?/, "io"), n.replace(/^io/, "gpio")])].filter(Boolean);
};

function rowMatchesName(cells: string[], variants: string[]): boolean {
  return cells.some((c) => {
    const parts = c.split(/[\s/,]+/).map(norm).filter(Boolean);
    const whole = norm(c);
    return variants.some((v) => whole === v || parts.includes(v));
  });
}

/** Compare each symbol pin (number and name) with the datasheet's pin tables. */
export function checkPins(index: DatasheetIndex, pins: PinInfo[]): PinCheck[] {
  const out: PinCheck[] = [];
  for (const pin of pins) {
    const variants = nameVariants(pin.name);
    if (!variants.length) {
      out.push({ pin, status: "name-not-found" });
      continue;
    }
    let best: { hit: Hit; numbers: string[]; score: number } | undefined;
    for (const p of index.passages) {
      if (p.kind === "heading") continue;
      const lines = index.pages[p.page - 1]!.lines;
      for (const i of passageLines(p)) {
        const l = lines[i]!;
        if (l.furniture || l.cells.length < 2 || !rowMatchesName(l.cells, variants)) continue;
        const nameCell = l.cells.findIndex((c) => rowMatchesName([c], variants));
        // Numbers sit in cells before the name (pin number columns), as in most pin tables.
        const numbers = l.cells.slice(0, nameCell).flatMap(numbersIn);
        if (!numbers.length) continue;
        const score = (/pin|terminal/i.test(p.heading ?? "") ? 3 : 0) + (p.kind === "table" ? 1 : 0) + (l.text.length > 25 ? 1 : 0) + (numbers.includes(pin.number) ? 2 : 0);
        if (!best || score > best.score) best = { hit: { passage: p, lines: [i], score, why: "pin table row" }, numbers, score };
      }
    }
    if (!best) out.push({ pin, status: "name-not-found" });
    else if (!best.numbers.includes(pin.number)) out.push({ pin, status: "number-differs", hit: best.hit, numbers: best.numbers });
    else out.push({ pin, status: new Set(best.numbers).size > 1 ? "ok-packages" : "ok", hit: best.hit, numbers: best.numbers });
  }
  return out;
}

// ---- Voltages ----

/** The voltage a net's name promises: +5V, +3V3, 3.3V, +1V8, 12V, VBUS (5 V). Undefined when the name says nothing. */
export function netVoltage(name: string): number | undefined {
  const n = name.replace(/^\//, "").toUpperCase();
  if (/^(\+?)VBUS$/.test(n)) return 5;
  const m = /^[+-]?(\d{1,2})V(\d{1,2})?$/.exec(n) ?? /^[+-]?(\d{1,2}\.\d+)V$/.exec(n) ?? /^[+-]?(\d{1,2})V$/.exec(n);
  if (!m) return undefined;
  const v = m[2] !== undefined ? Number(`${m[1]}.${m[2]}`) : Number(m[1]);
  return Number.isFinite(v) && v > 0 && v <= 60 ? (n.startsWith("-") ? -v : v) : undefined;
}

export interface LimitRow {
  hit: Hit;
  section: "abs-max" | "operating";
  text: string;
  /** Numbers in the row, as printed (minimums, maximums). */
  values: number[];
  /** False when the row was found by what it describes ("supply voltage"), not by the pin's name. */
  byName: boolean;
}

const numberTokens = (cells: string[]): number[] =>
  cells.flatMap((c) => (/^[-−–]?\d+(?:\.\d+)?\s*V?$/.test(c.trim()) ? [Number(c.trim().replace(/[−–]/, "-").replace(/\s*V$/, ""))] : /^[-−–]?\d+(?:\.\d+)?\s*(?:to|~)\s*[-−–+]?\d+(?:\.\d+)?\s*V?$/.test(c.trim()) ? (c.match(/[-−–]?\d+(?:\.\d+)?/g) ?? []).map((x) => Number(x.replace(/[−–]/, "-"))) : [])).filter((n) => Number.isFinite(n));

/** Rows of the abs-max and operating-conditions sections that mention a pin's name (VIN, VEN for EN, …). */
export function limitRows(index: DatasheetIndex, pinName: string, supply = false): LimitRow[] {
  const base = norm(pinName);
  if (!base || base === "nc" || base === "gnd") return [];
  const names = new Set([base, `v${base}`, base.replace(/^v/, "")]);
  const rows: LimitRow[] = [];
  for (const [section, id] of [["abs-max", "abs-max"], ["operating", "operating"]] as const) {
    for (const hit of findSection(index, id, 4)) {
      const p: Passage = hit.passage;
      const lines = index.pages[p.page - 1]!.lines;
      for (const i of passageLines(p)) {
        const l = lines[i]!;
        const first = norm(l.cells[0] ?? "");
        // The symbol column names the row ("VIN", "V IN"): match the first cell only, so prose doesn't count.
        const byName = names.has(first);
        if (l.furniture || (!byName && !(supply && /supply\s+voltage|input\s+voltage/i.test(l.text)))) continue;
        const values = numberTokens(l.cells.slice(1));
        if (values.length) rows.push({ hit: { passage: p, lines: [i], score: 1, why: hit.why }, section, text: l.text, values, byName });
      }
    }
  }
  return rows;
}

export type VoltageStatus = "above-abs-max" | "see-row";

export interface VoltageCheck {
  pin: PinInfo;
  volts: number;
  row: LimitRow;
  status: VoltageStatus;
}

/** For pins on nets whose name gives a voltage: the datasheet rows about that pin, flagged when the voltage exceeds an absolute maximum. */
export function checkVoltages(index: DatasheetIndex, pins: PinInfo[]): VoltageCheck[] {
  const out: VoltageCheck[] = [];
  for (const pin of pins) {
    const volts = netVoltage(pin.net);
    if (volts === undefined) continue;
    // A supply pin whose name the datasheet's ratings table doesn't use (VIN here, VCC there): also show the supply-voltage rows.
    let rows = limitRows(index, pin.name);
    if (pin.type === "power_in" && !rows.some((x) => x.section === "abs-max")) rows = [...rows, ...limitRows(index, pin.name, true).filter((x) => !x.byName && x.section === "abs-max")];
    for (const row of rows) {
      const max = Math.max(...row.values);
      out.push({ pin, volts, row, status: row.section === "abs-max" && Math.abs(volts) > max && max > 0 ? "above-abs-max" : "see-row" });
    }
  }
  return out;
}

/**
 * Compatibility checks across connected parts, by rule and without a model:
 *
 * - voltage domains: a signal driven from one supply rail into a pin of a part
 *   on another (a 5 V output into a 3.3 V input; 3.3 V into a 5 V input that
 *   may need 0.7 x VDD);
 * - I2C pull-ups: SDA/SCL nets with no pull-up, too strong a pull-up in
 *   parallel, or a pull-up to a rail above a device's own supply.
 *
 * A part's rail comes from the voltage its power-input pins' net names promise
 * (`+3V3`, `+5V`, `VBUS`). When the name says nothing, or a part sits on
 * several rails, the part is skipped rather than guessed. Findings point at a
 * condition to check against the datasheet; they are not verdicts.
 */
import { netVoltage } from "../datasheet/checks";
import type { ProjectView } from "../render/types";

export interface CompatFinding {
  severity: "error" | "warning" | "info";
  category: "voltage-domain" | "pull-up" | "supply-range";
  title: string;
  detail: string;
  references: string[];
  nets: string[];
  /** The pinned datasheet row a datasheet-backed finding rests on. */
  source?: { reference: string; document: string; page: number; text: string };
}

/** A voltage rating read from a datasheet row the engineer pinned to a part. */
export interface PinnedLimit {
  reference: string;
  /** Normalised symbol names the row is about ("vin", "in"). */
  names: string[];
  section: "abs-max" | "operating";
  min?: number;
  max: number;
  document: string;
  page: number;
  text: string;
}

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
const NUM = /^[-−–]?\d+(?:\.\d+)?$/;

/**
 * Voltage ratings from the lines of pinned datasheet text. Only rows under an
 * absolute-maximum or recommended-operating heading count, and only rows that
 * end in volts. The numbers are the printed ones; nothing is inferred.
 */
export function pinnedLimits(p: ProjectView): PinnedLimit[] {
  const out: PinnedLimit[] = [];
  for (const e of p.evidence) {
    const ref = e.target.reference;
    const h = e.evidence.heading ?? "";
    const section = /absolute\s+max/i.test(h) ? "abs-max" : /recommended|operating\s+cond/i.test(h) ? "operating" : undefined;
    if (!ref || !section) continue;
    for (const line of e.evidence.quote.split(/\r?\n/)) {
      const toks = line.trim().split(/\s+/);
      if (toks.length < 3 || !/\bV\b|volt/i.test(line)) continue;
      const first = /^V$/i.test(toks[0]!) && toks[1] && /^[A-Za-z]{1,6}$/.test(toks[1]) ? norm(toks[0]! + toks[1]) : norm(toks[0]!);
      if (!first || NUM.test(toks[0]!)) continue;
      const nums = toks.filter((t) => NUM.test(t)).map((t) => Number(t.replace(/[−–]/, "-")));
      if (!nums.length) continue;
      const names = [first, first.replace(/^v/, "")].filter(Boolean);
      const max = Math.max(...nums);
      const min = nums.length > 1 ? Math.min(...nums) : undefined;
      if (max <= 0) continue;
      out.push({ reference: ref, names, section, min, max, document: e.evidence.doc.title, page: e.evidence.page, text: line.trim() });
    }
  }
  return out;
}

const cite = (l: PinnedLimit) => `${l.document} p.${l.page}: "${l.text}"`;
const src = (l: PinnedLimit): CompatFinding["source"] => ({ reference: l.reference, document: l.document, page: l.page, text: l.text });

const TOL = 0.3;
const DRIVES = new Set(["output", "bidirectional", "tri_state", "power_out"]);
const RECEIVES = new Set(["input", "bidirectional"]);

/** 4.7k, 4k7, 2M2, 470, 10K, 1.5k → ohms. */
export function parseOhms(value: string): number | undefined {
  const v = value.trim().split(/\s+/)[0]!;
  const mm = /^(\d+)([rRkKmM])(\d+)$/.exec(v);
  if (mm) return Number(`${mm[1]}.${mm[3]}`) * mult(mm[2]!);
  const m2 = /^(\d+(?:[.,]\d+)?)\s*([rRkKmM]?)(?:Ω|ohms?)?$/i.exec(v);
  if (!m2) return undefined;
  return Number(m2[1]!.replace(",", ".")) * mult(m2[2]!);
}
const mult = (u: string) => ({ k: 1e3, m: 1e6, r: 1 })[u.toLowerCase() as "k"] ?? 1;

const ohms = (r: number) => (r >= 1e6 ? `${+(r / 1e6).toFixed(2)}M` : r >= 1e3 ? `${+(r / 1e3).toFixed(2)}k` : `${+r.toFixed(1)}`) + "Ω";
const volts = (v: number) => `${+v.toFixed(2)} V`;

/** The single supply voltage of each part with power-input pins on named rails; parts on several rails or none are left out. */
export function partRails(p: ProjectView): Map<string, number> {
  const rails = new Map<string, Set<number>>();
  for (const n of p.nets) {
    const v = netVoltage(n.name) ?? n.aliases.map(netVoltage).find((x) => x !== undefined);
    if (v === undefined || v <= 0) continue;
    for (const x of n.nodes) if (x.pinType === "power_in") rails.set(x.reference, (rails.get(x.reference) ?? new Set()).add(v));
  }
  const out = new Map<string, number>();
  for (const [ref, set] of rails) if (set.size === 1) out.set(ref, [...set][0]!);
  return out;
}

function voltageDomains(p: ProjectView, rails: Map<string, number>, limits: PinnedLimit[]): CompatFinding[] {
  const out: CompatFinding[] = [];
  for (const n of p.nets) {
    if (isI2c(n) || netVoltage(n.name) !== undefined || n.nodes.some((x) => x.pinType === "power_in" || x.pinType === "power_out")) continue;
    const drivers = n.nodes.filter((x) => DRIVES.has(x.pinType) && rails.has(x.reference));
    const receivers = n.nodes.filter((x) => RECEIVES.has(x.pinType) && rails.has(x.reference));
    const seen = new Set<string>();
    for (const d of drivers) {
      for (const r of receivers) {
        if (d.reference === r.reference) continue;
        const dv = rails.get(d.reference)!;
        const rv = rails.get(r.reference)!;
        const key = `${d.reference}>${r.reference}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (dv > rv + TOL) {
          const pin = [norm(r.pinName), norm(r.pinName).replace(/^v/, ""), "v" + norm(r.pinName)];
          const abs = limits.find((l) => l.reference === r.reference && l.section === "abs-max" && l.names.some((x) => pin.includes(x)));
          if (abs) {
            const over = dv > abs.max + 1e-6;
            out.push({
              severity: over ? "error" : "info",
              category: "voltage-domain",
              title: over ? `${d.reference} (${volts(dv)}) exceeds the rating of ${r.reference}.${r.pin} on ${n.name}` : `${d.reference} (${volts(dv)}) into ${r.reference}.${r.pin} is within its absolute maximum`,
              detail: `${d.reference}.${d.pin} ${d.pinName} can swing to about ${volts(dv)}; the datasheet row you pinned for ${r.reference} gives ${volts(abs.max)} (${cite(abs)}). ${over ? "Add a level shifter or divider." : "That is an absolute maximum, not a recommended operating level: check the input high/low levels too."}`,
              references: [d.reference, r.reference],
              nets: [n.name],
              source: src(abs),
            });
            continue;
          }
          out.push({
            severity: "warning",
            category: "voltage-domain",
            title: `${d.reference} (${volts(dv)}) drives ${r.reference} (${volts(rv)}) on ${n.name}`,
            detail: `${d.reference}.${d.pin} ${d.pinName} can swing to about ${volts(dv)}; ${r.reference}.${r.pin} ${r.pinName} runs from ${volts(rv)}. Check ${r.reference}'s input voltage rating (absolute maximum and 5 V tolerance) in its datasheet, or add a level shifter or divider.`,
            references: [d.reference, r.reference],
            nets: [n.name],
          });
        } else if (dv < 0.7 * rv - 1e-6) {
          out.push({
            severity: "warning",
            category: "voltage-domain",
            title: `${d.reference} (${volts(dv)}) may not reach the input high level of ${r.reference} (${volts(rv)}) on ${n.name}`,
            detail: `${d.reference}.${d.pin} ${d.pinName} drives up to about ${volts(dv)}; a typical input high threshold is 0.7 x VDD = ${volts(0.7 * rv)} for ${r.reference}.${r.pin} ${r.pinName}. Check VIH in ${r.reference}'s datasheet, or add a level shifter.`,
            references: [d.reference, r.reference],
            nets: [n.name],
          });
        }
      }
    }
  }
  return out;
}

/** Each part's rail against the pinned abs-max and operating-range rows of its supply pins. */
function supplyRanges(p: ProjectView, rails: Map<string, number>, limits: PinnedLimit[]): CompatFinding[] {
  const out: CompatFinding[] = [];
  for (const [ref, v] of rails) {
    const names = new Set<string>();
    for (const n of p.nets) for (const x of n.nodes) if (x.reference === ref && x.pinType === "power_in") for (const k of [norm(x.pinName), norm(x.pinName).replace(/^v/, ""), "v" + norm(x.pinName)]) names.add(k);
    const net = p.nets.find((n) => n.nodes.some((x) => x.reference === ref && x.pinType === "power_in") && netVoltage(n.name) === v)?.name;
    for (const l of limits.filter((x) => x.reference === ref && x.names.some((k) => names.has(k)))) {
      if (l.section === "abs-max" && v > l.max + 1e-6)
        out.push({ severity: "error", category: "supply-range", title: `${ref} supply ${volts(v)} exceeds its absolute maximum ${volts(l.max)}`, detail: `${ref} is powered from ${net ?? "a " + volts(v) + " rail"}; ${cite(l)}.`, references: [ref], nets: net ? [net] : [], source: src(l) });
      else if (l.section === "operating" && l.min !== undefined && l.min >= 0 && (v < l.min - 1e-6 || v > l.max + 1e-6))
        out.push({ severity: "warning", category: "supply-range", title: `${ref} supply ${volts(v)} is outside its recommended ${volts(l.min)} to ${volts(l.max)}`, detail: `${ref} is powered from ${net ?? "a " + volts(v) + " rail"}; ${cite(l)}.`, references: [ref], nets: net ? [net] : [], source: src(l) });
    }
  }
  return out;
}

const isI2c = (n: { name: string; nodes: Array<{ pinName: string }> }) => {
  const line = /(^|[_/.-])(SDA|SCL)\d*$/i.exec(n.name.replace(/^\//, ""))?.[2]?.toUpperCase();
  if (line) return line;
  const names = n.nodes.map((x) => x.pinName.toUpperCase().replace(/[^A-Z0-9]/g, ""));
  return names.find((x) => /^(I2C\d*)?(SDA|SCL)\d*$/.test(x))?.replace(/^I2C\d*/, "").replace(/\d+$/, "");
};

function i2cPullups(p: ProjectView, rails: Map<string, number>): CompatFinding[] {
  const out: CompatFinding[] = [];
  const netOf = new Map<string, string>();
  for (const n of p.nets) for (const x of n.nodes) netOf.set(`${x.reference}\0${x.pin}`, n.name);
  const railOf = (name: string) => {
    const n = p.nets.find((x) => x.name === name);
    return n ? (netVoltage(n.name) ?? n.aliases.map(netVoltage).find((v) => v !== undefined)) : undefined;
  };
  for (const n of p.nets) {
    const line = isI2c(n);
    if (!line) continue;
    const parts = new Set(n.nodes.map((x) => x.reference));
    // Pull-ups: two-pin passive resistors from this net to a net with a named voltage.
    const pulls: Array<{ ref: string; ohms: number; rail: number; railNet: string }> = [];
    for (const ref of parts) {
      const c = p.components.find((x) => x.reference === ref);
      if (!c || !/^R\d*[A-Z]*\d+$/i.test(ref) || c.dnp) continue;
      const others = p.nets.filter((m) => m !== n && m.nodes.some((x) => x.reference === ref));
      const own = n.nodes.filter((x) => x.reference === ref).length;
      if (own !== 1 || others.length !== 1) continue;
      const rail = railOf(others[0]!.name);
      const r = parseOhms(c.value);
      if (rail !== undefined && rail > 0 && r !== undefined && r > 0) pulls.push({ ref, ohms: r, rail, railNet: others[0]!.name });
    }
    const devices = [...parts].filter((r) => !/^R\d*[A-Z]*\d+$/i.test(r) && !/^(C|TP|FB|L|D)\d+$/i.test(r));
    const devs = devices.filter((r) => n.nodes.some((x) => x.reference === r && x.pinType !== "passive"));
    if (!devs.length) continue;
    if (!pulls.length) {
      out.push({
        severity: "warning",
        category: "pull-up",
        title: `${n.name}: no I2C pull-up resistor found`,
        detail: `${line} is open-drain and needs a pull-up to the bus rail. No resistor from ${n.name} to a named supply rail was found (devices on it: ${devs.join(", ")}). Fine if a module on the bus provides it; check its datasheet.`,
        references: devs.slice(0, 12),
        nets: [n.name],
      });
      continue;
    }
    const parallel = 1 / pulls.reduce((s, x) => s + 1 / x.ohms, 0);
    const list = pulls.map((x) => `${x.ref} ${ohms(x.ohms)} to ${x.railNet}`).join(", ");
    if (parallel < 1000) {
      out.push({
        severity: "warning",
        category: "pull-up",
        title: `${n.name}: pull-up is ${ohms(parallel)} in parallel`,
        detail: `${list}. Below 1 kΩ the bus low level needs more than the 3 mA that standard I2C devices sink. Check VOL and IOL in the devices' datasheets.`,
        references: pulls.map((x) => x.ref),
        nets: [n.name],
      });
    }
    const top = Math.max(...pulls.map((x) => x.rail));
    const low = devs.filter((r) => rails.has(r) && rails.get(r)! + TOL < top);
    if (low.length) {
      out.push({
        severity: "warning",
        category: "pull-up",
        title: `${n.name}: pulled up to ${volts(top)}, above the supply of ${low.join(", ")}`,
        detail: `${list}. ${low.map((r) => `${r} runs from ${volts(rails.get(r)!)}`).join("; ")}. Check that their I2C pins tolerate ${volts(top)}.`,
        references: [...new Set([...low, ...pulls.map((x) => x.ref)])],
        nets: [n.name],
      });
    }
  }
  return out;
}

export function checkCompatibility(p: ProjectView): CompatFinding[] {
  const rails = partRails(p);
  const order = { error: 0, warning: 1, info: 2 } as const;
  const limits = pinnedLimits(p);
  return [...voltageDomains(p, rails, limits), ...supplyRanges(p, rails, limits), ...i2cPullups(p, rails)].sort((a, b) => order[a.severity] - order[b.severity]);
}

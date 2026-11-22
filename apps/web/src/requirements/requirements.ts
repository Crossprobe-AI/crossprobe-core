/**
 * Structured requirements and the deterministic checks against the design.
 *
 * Requirements are the engineer's own statements ("board at most 50 x 40 mm",
 * "+5V supplies at most 500 mA", "J1 exposes USB D+/D-"), stored next to the
 * KiCad project (`<project>.crossprobe-requirements.json`) so the KiCad files
 * stay untouched. Each is checked by a rule, not by the model. A rule that
 * cannot decide (no board, no net of that name) says `unknown`, never `pass`.
 */
import type { ProjectView } from "../render/types";

export type Requirement = { id: string; title: string; note?: string } & (
  | { kind: "board_size"; maxWidthMm?: number; maxHeightMm?: number }
  | { kind: "board_layers"; layers?: number; maxLayers?: number }
  | { kind: "net_present"; net: string; minPins?: number }
  | { kind: "connector_nets"; reference: string; nets: string[] }
  /**
   * Parts (DNP left out) whose reference prefix is `prefix` ("D" counts D1 and D12, not DS1) and/or
   * where `match`, a case-insensitive regular expression, finds the reference, value, footprint,
   * symbol or symbol description; each is tried on its own, so `^10k$` means a value of exactly 10k.
   */
  | { kind: "part_count"; match?: string; prefix?: string; min?: number; max?: number }
  | { kind: "power_budget"; net: string; supplyMa: number; loads: Array<{ reference: string; maxMa: number }> }
  | { kind: "min_track_width"; net: string; minWidthMm: number }
);

export interface RequirementsFile {
  version: 1;
  requirements: Requirement[];
}

export type RequirementStatus = "pass" | "fail" | "unknown";

export interface RequirementResult {
  id: string;
  title: string;
  status: RequirementStatus;
  /** Why, with the numbers the rule used. */
  detail: string;
  references?: string[];
  nets?: string[];
}

export const requirementsFileName = (projectBase: string) => `${projectBase}.crossprobe-requirements.json`;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
const optNum = (v: unknown) => v === undefined || isNum(v);

/** What each kind needs besides `id` and `title`, for whoever writes requirements by hand (an assistant, through a design spec). */
export const REQUIREMENT_FIELDS: Record<Requirement["kind"], string> = {
  board_size: "maxWidthMm and/or maxHeightMm (numbers)",
  board_layers: "layers (exactly this many copper layers) and/or maxLayers",
  net_present: "net (name); optional minPins",
  connector_nets: "reference (the connector, e.g. \"J1\") and nets (the net names it must carry)",
  part_count: "match (a case-insensitive regular expression, tried on each part's reference, value, footprint, symbol and description) and/or prefix (the reference's letters: \"D\" counts D1, D2), and min and/or max",
  power_budget: "net (the rail), supplyMa (what the source can give) and loads: [{ reference, maxMa }]",
  min_track_width: "net and minWidthMm",
};

const REQUIREMENT_KEYS: Record<Requirement["kind"], string[]> = {
  board_size: ["maxWidthMm", "maxHeightMm"],
  board_layers: ["layers", "maxLayers"],
  net_present: ["net", "minPins"],
  connector_nets: ["reference", "nets"],
  part_count: ["match", "prefix", "min", "max"],
  power_budget: ["net", "supplyMa", "loads"],
  min_track_width: ["net", "minWidthMm"],
};

/**
 * Why `r` is not a valid requirement, in words the author can act on; undefined when it is valid.
 */
export function requirementProblem(r: unknown): string | undefined {
  if (validRequirement(r)) return undefined;
  if (!r || typeof r !== "object") return "not an object";
  const x = r as Record<string, unknown>;
  if (typeof x.kind !== "string" || !Object.hasOwn(REQUIREMENT_FIELDS, x.kind)) return `unknown kind ${JSON.stringify(x.kind)}; kinds are ${Object.keys(REQUIREMENT_FIELDS).join(", ")}`;
  const fields = REQUIREMENT_FIELDS[x.kind as Requirement["kind"]];
  if (!isStr(x.id) || !isStr(x.title)) return `needs "id" and "title" (short strings), then: ${fields}`;
  const known = new Set(["id", "title", "note", "kind", ...REQUIREMENT_KEYS[x.kind as Requirement["kind"]]]);
  const extra = Object.keys(x).filter((k) => !known.has(k));
  return `${x.kind} needs ${fields}${extra.length ? `; it has ${extra.map((k) => `"${k}"`).join(", ")} instead` : ""}`;
}

/** A requirement with the right shape, or undefined. Anything unrecognised is dropped, not guessed. */
export function validRequirement(r: unknown): Requirement | undefined {
  if (!r || typeof r !== "object") return undefined;
  const x = r as Record<string, unknown>;
  if (!isStr(x.id) || !isStr(x.title)) return undefined;
  const base = { id: x.id, title: x.title, note: typeof x.note === "string" ? x.note.slice(0, 1000) : undefined };
  switch (x.kind) {
    case "board_size":
      return optNum(x.maxWidthMm) && optNum(x.maxHeightMm) && (x.maxWidthMm !== undefined || x.maxHeightMm !== undefined)
        ? { ...base, kind: "board_size", maxWidthMm: x.maxWidthMm as number | undefined, maxHeightMm: x.maxHeightMm as number | undefined }
        : undefined;
    case "board_layers":
      return optNum(x.layers) && optNum(x.maxLayers) && (x.layers !== undefined || x.maxLayers !== undefined)
        ? { ...base, kind: "board_layers", layers: x.layers as number | undefined, maxLayers: x.maxLayers as number | undefined }
        : undefined;
    case "net_present":
      return isStr(x.net) && optNum(x.minPins) ? { ...base, kind: "net_present", net: x.net, minPins: x.minPins as number | undefined } : undefined;
    case "connector_nets":
      return isStr(x.reference) && Array.isArray(x.nets) && x.nets.length > 0 && x.nets.every(isStr)
        ? { ...base, kind: "connector_nets", reference: x.reference, nets: x.nets as string[] }
        : undefined;
    case "part_count":
      return (x.match === undefined || isStr(x.match)) &&
        (x.prefix === undefined || (isStr(x.prefix) && /^[A-Za-z_#]+$/.test(x.prefix))) &&
        (x.match !== undefined || x.prefix !== undefined) &&
        optNum(x.min) &&
        optNum(x.max) &&
        (x.min !== undefined || x.max !== undefined)
        ? { ...base, kind: "part_count", match: x.match as string | undefined, prefix: x.prefix as string | undefined, min: x.min as number | undefined, max: x.max as number | undefined }
        : undefined;
    case "power_budget":
      return isStr(x.net) && isNum(x.supplyMa) && Array.isArray(x.loads) && x.loads.every((l) => l && isStr((l as Record<string, unknown>).reference) && isNum((l as Record<string, unknown>).maxMa))
        ? { ...base, kind: "power_budget", net: x.net, supplyMa: x.supplyMa, loads: (x.loads as Array<{ reference: string; maxMa: number }>).map((l) => ({ reference: l.reference, maxMa: l.maxMa })) }
        : undefined;
    case "min_track_width":
      return isStr(x.net) && isNum(x.minWidthMm) ? { ...base, kind: "min_track_width", net: x.net, minWidthMm: x.minWidthMm } : undefined;
    default:
      return undefined;
  }
}

export function parseRequirements(text: string | undefined): Requirement[] {
  if (!text) return [];
  try {
    const f = JSON.parse(text) as Partial<RequirementsFile>;
    if (!Array.isArray(f.requirements)) return [];
    const seen = new Set<string>();
    const out: Requirement[] = [];
    for (const r of f.requirements) {
      const v = validRequirement(r);
      if (v && !seen.has(v.id)) {
        seen.add(v.id);
        out.push(v);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeRequirements(requirements: Requirement[]): string {
  return JSON.stringify({ version: 1, requirements } satisfies RequirementsFile, null, 2) + "\n";
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);
const findNet = (p: ProjectView, name: string) =>
  p.nets.find((n) => n.name === name) ?? p.nets.find((n) => n.aliases.includes(name) || n.name.replace(/^\//, "") === name.replace(/^\//, ""));

export function checkRequirement(p: ProjectView, r: Requirement): RequirementResult {
  const out = (status: RequirementStatus, detail: string, extra: Pick<RequirementResult, "references" | "nets"> = {}): RequirementResult => ({ id: r.id, title: r.title, status, detail, ...extra });
  switch (r.kind) {
    case "board_size": {
      const pts = p.board?.outline.flatMap((o) => o.points) ?? [];
      if (!pts.length) return out("unknown", "The board has no outline to measure.");
      const w = Math.max(...pts.map((q) => q.x)) - Math.min(...pts.map((q) => q.x));
      const h = Math.max(...pts.map((q) => q.y)) - Math.min(...pts.map((q) => q.y));
      // The outline's bounding box; the limit may be met either way round.
      const [a, b] = [Math.max(w, h), Math.min(w, h)];
      const [la, lb] = [Math.max(r.maxWidthMm ?? Infinity, r.maxHeightMm ?? Infinity), Math.min(r.maxWidthMm ?? Infinity, r.maxHeightMm ?? Infinity)];
      const straight = w <= (r.maxWidthMm ?? Infinity) + 1e-6 && h <= (r.maxHeightMm ?? Infinity) + 1e-6;
      const rotated = r.maxWidthMm !== undefined && r.maxHeightMm !== undefined ? a <= la + 1e-6 && b <= lb + 1e-6 : false;
      const limit = `${r.maxWidthMm !== undefined ? fmt(r.maxWidthMm) : "any"} x ${r.maxHeightMm !== undefined ? fmt(r.maxHeightMm) : "any"} mm`;
      return straight || rotated ? out("pass", `Board outline is ${fmt(w)} x ${fmt(h)} mm (limit ${limit}).`) : out("fail", `Board outline is ${fmt(w)} x ${fmt(h)} mm, over the limit of ${limit}.`);
    }
    case "board_layers": {
      if (!p.board) return out("unknown", "This project has no board file.");
      const n = p.board.copperLayers.length;
      if (r.layers !== undefined && n !== r.layers) return out("fail", `The board has ${n} copper layers, required ${r.layers}.`);
      if (r.maxLayers !== undefined && n > r.maxLayers) return out("fail", `The board has ${n} copper layers, at most ${r.maxLayers} allowed.`);
      return out("pass", `The board has ${n} copper layers.`);
    }
    case "net_present": {
      const n = findNet(p, r.net);
      if (!n) return out("fail", `No net named ${r.net}.`, { nets: [r.net] });
      const min = r.minPins ?? 2;
      return n.nodes.length >= min ? out("pass", `${n.name} has ${n.nodes.length} pins.`, { nets: [n.name] }) : out("fail", `${n.name} has ${n.nodes.length} pin(s), needs at least ${min}.`, { nets: [n.name] });
    }
    case "connector_nets": {
      const c = p.components.find((x) => x.reference.toLowerCase() === r.reference.toLowerCase());
      if (!c) return out("fail", `No component ${r.reference}.`, { references: [r.reference] });
      const onPart = new Set(p.nets.filter((n) => n.nodes.some((x) => x.reference === c.reference)).flatMap((n) => [n.name, ...n.aliases].map((s) => s.replace(/^\//, "").toLowerCase())));
      const missing = r.nets.filter((n) => !onPart.has(n.replace(/^\//, "").toLowerCase()));
      return missing.length
        ? out("fail", `${c.reference} is not connected to: ${missing.join(", ")}.`, { references: [c.reference], nets: missing })
        : out("pass", `${c.reference} is connected to ${r.nets.join(", ")}.`, { references: [c.reference], nets: r.nets });
    }
    case "part_count": {
      let re: RegExp | undefined;
      try {
        re = r.match === undefined ? undefined : new RegExp(r.match, "i");
      } catch {
        return out("unknown", `"${r.match}" is not a valid regular expression.`);
      }
      const prefix = r.prefix?.toUpperCase();
      const hits = p.components.filter(
        (c) =>
          !c.dnp &&
          (prefix === undefined || c.reference.replace(/[0-9?].*$/, "").toUpperCase() === prefix) &&
          (!re || [c.reference, c.value, c.footprint, c.libId, c.description].some((f) => !!f && re.test(f))),
      );
      const n = hits.length;
      const refs = hits.map((c) => c.reference).slice(0, 30);
      const what = [r.prefix !== undefined && `reference prefix "${r.prefix}"`, r.match !== undefined && `"${r.match}"`].filter(Boolean).join(" and ");
      if (r.min !== undefined && n < r.min) return out("fail", `${n} part(s) match ${what}, at least ${r.min} required.`, { references: refs });
      if (r.max !== undefined && n > r.max) return out("fail", `${n} part(s) match ${what}, at most ${r.max} allowed.`, { references: refs });
      return out("pass", `${n} part(s) match ${what}.`, { references: refs });
    }
    case "power_budget": {
      const n = findNet(p, r.net);
      if (!n) return out("fail", `No net named ${r.net}.`, { nets: [r.net] });
      const refs = r.loads.map((l) => l.reference);
      const onNet = new Set(n.nodes.map((x) => x.reference));
      const off = refs.filter((x) => !onNet.has(x));
      if (off.length) return out("fail", `Listed load(s) not connected to ${n.name}: ${off.join(", ")}.`, { references: off, nets: [n.name] });
      const total = r.loads.reduce((s, l) => s + l.maxMa, 0);
      const base = `Loads add up to ${fmt(total)} mA at their stated maximum; supply ${fmt(r.supplyMa)} mA.`;
      return total <= r.supplyMa
        ? out("pass", `${base} Only the loads listed are counted; the numbers are the engineer's, not read from a datasheet.`, { references: refs, nets: [n.name] })
        : out("fail", base, { references: refs, nets: [n.name] });
    }
    case "min_track_width": {
      if (!p.board) return out("unknown", "This project has no board file.");
      const n = findNet(p, r.net);
      if (!n) return out("fail", `No net named ${r.net}.`, { nets: [r.net] });
      const tracks = p.board.tracks.filter((t) => t.net === n.name);
      if (!tracks.length) return out("unknown", `${n.name} has no tracks (it may be a zone or unrouted).`, { nets: [n.name] });
      const min = Math.min(...tracks.map((t) => t.width));
      return min + 1e-6 >= r.minWidthMm ? out("pass", `Thinnest track on ${n.name} is ${fmt(min)} mm (needs ${fmt(r.minWidthMm)}).`, { nets: [n.name] }) : out("fail", `Thinnest track on ${n.name} is ${fmt(min)} mm, under ${fmt(r.minWidthMm)}.`, { nets: [n.name] });
    }
  }
}

export const checkRequirements = (p: ProjectView, requirements: Requirement[] = p.requirements): RequirementResult[] => requirements.map((r) => checkRequirement(p, r));

export type RequirementKind = Requirement["kind"];

/** The fields the editor asks for, per kind. `list` fields are comma-separated; `loads` is "U1:300, U2:50". */
export const FORM: Record<RequirementKind, { label: string; fields: Array<{ key: string; label: string; type: "text" | "number" | "list" | "loads" }> }> = {
  board_size: { label: "Board size", fields: [{ key: "maxWidthMm", label: "Max width (mm)", type: "number" }, { key: "maxHeightMm", label: "Max height (mm)", type: "number" }] },
  board_layers: { label: "Copper layers", fields: [{ key: "layers", label: "Exactly", type: "number" }, { key: "maxLayers", label: "At most", type: "number" }] },
  net_present: { label: "Net exists", fields: [{ key: "net", label: "Net", type: "text" }, { key: "minPins", label: "Min pins", type: "number" }] },
  connector_nets: { label: "Connector nets", fields: [{ key: "reference", label: "Reference", type: "text" }, { key: "nets", label: "Nets (comma separated)", type: "list" }] },
  part_count: { label: "Part count", fields: [{ key: "prefix", label: "Reference prefix (D, LED)", type: "text" }, { key: "match", label: "Matches (pattern: reference, value, footprint, symbol or description)", type: "text" }, { key: "min", label: "At least", type: "number" }, { key: "max", label: "At most", type: "number" }] },
  power_budget: { label: "Power budget", fields: [{ key: "net", label: "Rail net", type: "text" }, { key: "supplyMa", label: "Supply (mA)", type: "number" }, { key: "loads", label: "Loads, max mA (U1:300, U2:50)", type: "loads" }] },
  min_track_width: { label: "Min track width", fields: [{ key: "net", label: "Net", type: "text" }, { key: "minWidthMm", label: "Min width (mm)", type: "number" }] },
};

/** A requirement from the editor's text inputs, or undefined when they don't make a valid one. */
export function requirementFromForm(kind: RequirementKind, id: string, title: string, values: Record<string, string>): Requirement | undefined {
  const raw: Record<string, unknown> = { id, title: title.trim(), kind };
  for (const f of FORM[kind].fields) {
    const v = (values[f.key] ?? "").trim();
    if (!v) continue;
    if (f.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) return undefined;
      raw[f.key] = n;
    } else if (f.type === "list") raw[f.key] = v.split(",").map((x) => x.trim()).filter(Boolean);
    else if (f.type === "loads") {
      const loads = v.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
        const [reference, ma] = x.split(":").map((y) => y.trim());
        return { reference, maxMa: Number(ma) };
      });
      if (loads.some((l) => !l.reference || !Number.isFinite(l.maxMa))) return undefined;
      raw[f.key] = loads;
    } else raw[f.key] = v;
  }
  if (kind === "power_budget" && raw.loads === undefined) raw.loads = [];
  return validRequirement(raw);
}

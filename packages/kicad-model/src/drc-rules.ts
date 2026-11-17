/**
 * Custom design rules (.kicad_dru): parsing and the condition language,
 * enough for clearance constraints. KiCad evaluates a rule for an item pair
 * as (A, B) and (B, A); among matching rules the last one in the file wins
 * and overrides net classes and local overrides.
 *
 * Supported in conditions: == != (strings compare with * and ? wildcards),
 * < > <= >=, && || !, parentheses; properties Type, NetClass, NetName,
 * Layer, Reference; functions intersectsArea / insideArea / enclosedByArea,
 * inDiffPair, hasNetclass, existsOnLayer, isPlated, fromTo. Anything else is
 * undefined, and (as in KiCad) comparisons with undefined are false.
 */
import { arg, findChild, findChildren, headOf, isAtom, isList, parse, type List } from "@crossprobe/kicad-sexpr";

export interface DruConstraint {
  type: string;
  min?: number;
  max?: number;
  opt?: number;
}

export interface DruRule {
  name: string;
  /** "outer", "inner", or a layer name; undefined = all layers. */
  layer?: string;
  condition?: Expr;
  conditionText?: string;
  constraints: DruConstraint[];
}

/** A value an item exposes to rule conditions. */
export interface RuleItem {
  type: "Pad" | "Track" | "Via" | "Zone" | "Graphic" | "Text";
  netName: string;
  netClass: string;
  /** The item's own layer (A.Layer); undefined for multi-layer pads and vias, as in KiCad. */
  layer?: string;
  reference?: string;
  plated?: boolean;
  layers: Set<string>;
  /** Does the item's copper touch the named rule area? */
  intersectsArea: (name: string) => boolean;
  /** Is there a net of this name on the board (inDiffPair needs the partner net to exist)? */
  hasNet?: (name: string) => boolean;
  /** Is the item on a from-to path (fromTo('U1-*', 'U2-*'))? */
  fromTo?: (from: string, to: string) => boolean;
}

// ---------------------------------------------------------------------------
// Parsing the rule file
// ---------------------------------------------------------------------------

/** "1mm", "10mil", "0.1in", "0.2" (mm) → mm. */
export function parseLength(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return v;
  const m = /^(-?[\d.]+)\s*(mm|mil|in|um|µm)?$/.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  switch (m[2]) {
    case "mil":
      return n * 0.0254;
    case "in":
      return n * 25.4;
    case "um":
    case "µm":
      return n / 1000;
    default:
      return n;
  }
}

export function parseDru(text: string): DruRule[] {
  // Comments start with # at the start of a line.
  const clean = text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const doc = parse(clean, { recover: true });
  const rules: DruRule[] = [];
  for (const node of doc.children) {
    if (!isList(node) || headOf(node) !== "rule") continue;
    const name = String(arg(node, 0) ?? "");
    const layerNode = findChild(node, "layer");
    const condText = findChild(node, "condition") ? String(arg(findChild(node, "condition"), 0) ?? "") : undefined;
    const constraints: DruConstraint[] = [];
    for (const c of findChildren(node, "constraint")) {
      const type = String(arg(c, 0) ?? "");
      const get = (k: string) => {
        const n = findChild(c, k);
        if (!n) return undefined;
        // (min 0.1mm) parses as number then symbol, or a single atom "0.1mm".
        const parts = n.children.slice(1).filter(isAtom).map((a) => a.raw);
        return parseLength(parts.join(""));
      };
      constraints.push({ type, min: get("min"), max: get("max"), opt: get("opt") });
    }
    let condition: Expr | undefined;
    if (condText !== undefined) {
      try {
        condition = parseExpr(condText);
      } catch {
        condition = { k: "unknown" };
      }
    }
    rules.push({ name, layer: layerNode ? String(arg(layerNode, 0)) : undefined, condition, conditionText: condText, constraints });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// The condition language
// ---------------------------------------------------------------------------

export type Expr =
  | { k: "lit"; v: string | number | boolean }
  | { k: "prop"; obj: "A" | "B"; name: string }
  | { k: "call"; obj: "A" | "B"; name: string; args: Expr[] }
  | { k: "not"; e: Expr }
  | { k: "bin"; op: string; a: Expr; b: Expr }
  | { k: "unknown" };

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /\s*(\|\||&&|==|!=|<=|>=|[()!<>,.]|'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?(?:mm|mil|in|um)?|[A-Za-z_][A-Za-z0-9_]*)/y;
  let i = 0;
  while (i < s.length) {
    if (/^\s*$/.test(s.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) throw new Error(`Bad rule condition near "${s.slice(i, i + 12)}"`);
    out.push(m[1]!);
    i = re.lastIndex;
  }
  return out;
}

export function parseExpr(text: string): Expr {
  const t = tokenize(text);
  let i = 0;
  const peek = () => t[i];
  const next = () => t[i++];
  const expect = (x: string) => {
    if (next() !== x) throw new Error(`expected ${x}`);
  };
  const or = (): Expr => {
    let e = and();
    while (peek() === "||") {
      next();
      e = { k: "bin", op: "||", a: e, b: and() };
    }
    return e;
  };
  const and = (): Expr => {
    let e = unary();
    while (peek() === "&&") {
      next();
      e = { k: "bin", op: "&&", a: e, b: unary() };
    }
    return e;
  };
  const unary = (): Expr => {
    if (peek() === "!") {
      next();
      return { k: "not", e: unary() };
    }
    return cmp();
  };
  const cmp = (): Expr => {
    const a = primary();
    const op = peek();
    if (op && ["==", "!=", "<", ">", "<=", ">="].includes(op)) {
      next();
      return { k: "bin", op, a, b: primary() };
    }
    return a;
  };
  const primary = (): Expr => {
    const tok = next();
    if (tok === undefined) throw new Error("unexpected end");
    if (tok === "(") {
      const e = or();
      expect(")");
      return e;
    }
    if (/^['"]/.test(tok)) return { k: "lit", v: tok.slice(1, -1) };
    if (/^-?\d/.test(tok)) return { k: "lit", v: parseLength(tok) ?? Number(tok) };
    if (tok === "true" || tok === "false") return { k: "lit", v: tok === "true" };
    if ((tok === "A" || tok === "B" || tok === "L") && peek() === ".") {
      next();
      const name = next()!;
      if (peek() === "(") {
        next();
        const args: Expr[] = [];
        while (peek() !== ")") {
          args.push(or());
          if (peek() === ",") next();
        }
        expect(")");
        return { k: "call", obj: tok === "B" ? "B" : "A", name, args };
      }
      return { k: "prop", obj: tok === "B" ? "B" : "A", name };
    }
    return { k: "unknown" };
  };
  const e = or();
  if (i < t.length) throw new Error("trailing tokens");
  return e;
}

const patterns = new Map<string, RegExp>();
const wildcard = (pattern: string, s: string) => {
  let re = patterns.get(pattern);
  if (!re) patterns.set(pattern, (re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i")));
  return re.test(s);
};

type Val = string | number | boolean | undefined;

export function evalExpr(e: Expr, A: RuleItem, B?: RuleItem): Val {
  switch (e.k) {
    case "lit":
      return e.v;
    case "unknown":
      return undefined;
    case "not":
      return !evalExpr(e.e, A, B);
    case "prop": {
      const it = e.obj === "B" ? B : A;
      if (!it) return undefined;
      switch (e.name) {
        case "Type":
          return it.type;
        case "NetClass":
          return it.netClass;
        case "NetName":
          return it.netName;
        case "Layer":
          return it.layer;
        case "Reference":
          return it.reference;
        default:
          return undefined;
      }
    }
    case "call": {
      const it = e.obj === "B" ? B : A;
      if (!it) return undefined;
      const a0 = e.args[0] ? evalExpr(e.args[0], A, B) : undefined;
      switch (e.name) {
        case "intersectsArea":
        case "insideArea":
        case "enclosedByArea":
          return typeof a0 === "string" ? it.intersectsArea(a0) : undefined;
        case "inDiffPair": {
          // A pair needs both halves: KiCad finds the partner net (P↔N, +↔-) on the board.
          const base = diffBase(it.netName);
          const partner = diffPartner(it.netName);
          if (base === undefined || (it.hasNet && (!partner || !it.hasNet(partner)))) return false;
          return typeof a0 !== "string" || wildcard(a0, base);
        }
        case "hasNetclass":
          return typeof a0 === "string" ? classMatches(a0, it.netClass) : undefined;
        case "existsOnLayer":
          return typeof a0 === "string" ? [...it.layers].some((l) => wildcard(a0, l)) : undefined;
        case "isPlated":
          return it.plated;
        case "fromTo": {
          const a1 = e.args[1] ? evalExpr(e.args[1], A, B) : undefined;
          return typeof a0 === "string" && typeof a1 === "string" && it.fromTo ? it.fromTo(a0, a1) : undefined;
        }
        default:
          return undefined;
      }
    }
    case "bin": {
      if (e.op === "&&") return !!evalExpr(e.a, A, B) && !!evalExpr(e.b, A, B);
      if (e.op === "||") return !!evalExpr(e.a, A, B) || !!evalExpr(e.b, A, B);
      const a = evalExpr(e.a, A, B);
      const b = evalExpr(e.b, A, B);
      // As in KiCad: anything compared with an undefined value is false (for != too).
      if (a === undefined || b === undefined) return false;
      if (e.op === "==" || e.op === "!=") {
        // The right-hand string is the pattern (wildcards, case-insensitive). A net in several
        // classes ("A,B,Default") is in any of them, as in KiCad.
        const isClass = e.a.k === "prop" && e.a.name === "NetClass";
        const eq = typeof a === "string" && typeof b === "string" ? (isClass ? classMatches(b, a) : wildcard(b, a)) : a === b;
        return e.op === "==" ? eq : !eq;
      }
      const x = Number(a);
      const y = Number(b);
      return e.op === "<" ? x < y : e.op === ">" ? x > y : e.op === "<=" ? x <= y : x >= y;
    }
  }
}

/** Does a net class (a combined one is "A,B,Default") match the pattern: as a whole, or any of its classes? */
function classMatches(pattern: string, netClass: string): boolean {
  return wildcard(pattern, netClass) || netClass.split(",").some((c) => wildcard(pattern, c));
}

/**
 * KiCad's DRC_ENGINE::MatchDpSuffix: a diff pair net ends in P/N or +/-,
 * possibly followed by digits and underscores (DQS_P0 pairs with DQS_N0).
 * Gives the partner net's name and the pair's base name (the name less the
 * suffix: "DQS_", "CLK_").
 */
export function matchDpSuffix(net: string): { positive: boolean; partner: string; base: string } | undefined {
  let count = 0;
  for (let k = net.length - 1; k >= 0; k--) {
    const ch = net[k]!;
    count++;
    if ((ch >= "0" && ch <= "9") || ch === "_") continue;
    const swap: Record<string, string> = { P: "N", N: "P", "+": "-", "-": "+" };
    if (!swap[ch]) return undefined;
    const base = net.slice(0, net.length - count);
    return { positive: ch === "P" || ch === "+", partner: base + swap[ch] + net.slice(net.length - count + 1), base };
  }
  return undefined;
}

const diffPartner = (net: string) => matchDpSuffix(net)?.partner;
const diffBase = (net: string) => matchDpSuffix(net)?.base;

const layerMatches = (rule: DruRule, layer: string) => {
  if (!rule.layer) return true;
  if (rule.layer === "outer") return layer === "F.Cu" || layer === "B.Cu";
  if (rule.layer === "inner") return /^In\d+\.Cu$/.test(layer);
  return wildcard(rule.layer, layer);
};

/**
 * The clearance a custom rule sets for this pair on this layer, if any (the
 * last matching rule wins, tried as A/B and B/A).
 */
export function customClearance(rules: DruRule[], a: RuleItem, b: RuleItem, layer: string): { value: number; rule: string } | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]!;
    const c = r.constraints.find((x) => x.type === "clearance");
    if (!c || c.min === undefined || !layerMatches(r, layer)) continue;
    if (!r.condition || evalExpr(r.condition, a, b) === true || evalExpr(r.condition, b, a) === true) return { value: c.min, rule: r.name };
  }
  return undefined;
}

/**
 * A single-item constraint (hole_size, annular_width, track_width, …) from the
 * custom rules: the last rule whose condition holds for the item (as A) wins.
 */
export function customConstraint(rules: DruRule[], type: string, a: RuleItem, layer?: string): { min?: number; max?: number; rule: string } | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]!;
    const c = r.constraints.find((x) => x.type === type);
    if (!c || (layer && !layerMatches(r, layer))) continue;
    if (!r.condition || evalExpr(r.condition, a) === true) return { min: c.min, max: c.max, rule: r.name };
  }
  return undefined;
}

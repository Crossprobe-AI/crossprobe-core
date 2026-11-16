/**
 * Bus name expansion, following KiCad's syntax:
 *   vector  "D[0..7]"            → D0 … D7
 *   group   "{SDA SCL}"          → SDA, SCL
 *   named   "I2C{SDA SCL}"       → I2C.SDA, I2C.SCL
 *   alias   "{MYBUS}" or "X{MYBUS}" where MYBUS is a bus_alias
 * `_{…}`, `^{…}` and `~{…}` are text formatting (subscript etc.), not groups.
 */

const VECTOR_RE = /^(.*)\[(\d+)\.\.(\d+)\]$/;

/** Returns the member net names, or undefined when `name` is not a bus. */
export function expandBusMembers(name: string, aliases: Map<string, string[]>): string[] | undefined {
  const vector = VECTOR_RE.exec(name);
  if (vector) {
    const [, prefix, a, b] = vector;
    const from = Number(a);
    const to = Number(b);
    const out: string[] = [];
    const step = from <= to ? 1 : -1;
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) out.push(`${prefix}${i}`);
    return out;
  }

  const group = splitGroup(name);
  if (!group) return undefined;
  const { prefix, body } = group;
  const out: string[] = [];
  for (const part of body.split(/[\s,]+/).filter(Boolean)) {
    const expanded = aliases.has(part) ? expandAlias(part, aliases, 0) : (expandBusMembers(part, aliases) ?? [part]);
    for (const m of expanded) out.push(prefix ? `${prefix}.${m}` : m);
  }
  return out;
}

function expandAlias(name: string, aliases: Map<string, string[]>, depth: number): string[] {
  if (depth > 8) return [];
  const out: string[] = [];
  for (const m of aliases.get(name) ?? []) {
    if (aliases.has(m)) out.push(...expandAlias(m, aliases, depth + 1));
    else out.push(...(expandBusMembers(m, aliases) ?? [m]));
  }
  return out;
}

/** Find a trailing `{...}` group that is not a formatting markup block. */
function splitGroup(name: string): { prefix: string; body: string } | undefined {
  if (!name.endsWith("}")) return undefined;
  let depth = 0;
  for (let i = name.length - 1; i >= 0; i--) {
    const c = name[i];
    if (c === "}") depth++;
    else if (c === "{") {
      depth--;
      if (depth === 0) {
        const before = name[i - 1];
        if (before === "_" || before === "^" || before === "~") return undefined;
        return { prefix: name.slice(0, i), body: name.slice(i + 1, -1) };
      }
    }
  }
  return undefined;
}

/** One net of a bus. */
export interface BusMember {
  /** Net name within the sheet, prefix included ("I2C.SDA"). */
  name: string;
  /** The member as written in its group, without the bus prefix: "SDA", or "D[0..7]" for each of D0…D7. */
  token: string;
  /** Position within its own vector, counted from the lowest index; 0 for a plain name. */
  index: number;
}

export interface BusShape {
  /** A plain vector bus ("D[0..7]"); otherwise a group. */
  vector: boolean;
  members: BusMember[];
}

/**
 * The members of a bus name, or undefined when `name` is not a bus. Vector
 * members are listed from the lowest index up, whichever way the range is
 * written: that is the order KiCad pairs them in.
 */
export function busShape(name: string, aliases: Map<string, string[]>): BusShape | undefined {
  const vector = vectorMembers(name);
  if (vector) return { vector: true, members: vector };
  const group = splitGroup(name);
  if (!group) return undefined;
  const members: BusMember[] = [];
  const add = (part: string, depth: number) => {
    if (aliases.has(part) && depth <= 8) {
      for (const m of aliases.get(part)!) add(m, depth + 1);
      return;
    }
    const inner = vectorMembers(part) ?? busShape(part, aliases)?.members ?? [{ name: part, token: part, index: 0 }];
    for (const m of inner) members.push({ ...m, name: group.prefix ? `${group.prefix}.${m.name}` : m.name });
  };
  for (const part of group.body.split(/[\s,]+/).filter(Boolean)) add(part, 0);
  return { vector: false, members };
}

function vectorMembers(name: string): BusMember[] | undefined {
  const vector = VECTOR_RE.exec(name);
  if (!vector) return undefined;
  const [, prefix, a, b] = vector;
  const from = Math.min(Number(a), Number(b));
  const to = Math.max(Number(a), Number(b));
  const out: BusMember[] = [];
  for (let i = from; i <= to; i++) out.push({ name: `${prefix}${i}`, token: name, index: i - from });
  return out;
}

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

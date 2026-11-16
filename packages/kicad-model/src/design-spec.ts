/**
 * A design spec: a whole small board described the way an engineer (or an
 * assistant) states it, with no coordinates. It lists the parts (KiCad
 * library symbol, value, footprint), the net each pin goes to, and the board
 * (size, layers, where a connector must sit). Everything else is worked out
 * here, deterministically:
 *
 * - `checkDesignSpec` finds what cannot be built (unknown symbol or pin, a
 *   footprint with other pad numbers than the symbol's pins, a net with one pin);
 * - `layoutDesignSheet` gives every symbol a place on the sheet, grouped under
 *   headings, and picks the paper that holds them;
 * - `designBlockSpec` turns that into a block spec, so the schematic comes
 *   from the same generator as the design blocks (design-block.ts);
 * - `placeParts` puts the footprints inside the board outline, each part next
 *   to what it connects to.
 *
 * The caller (the app's design builder) strings these together with Update
 * PCB, the pour and the autorouter, and reports what the checks say. A spec
 * is the reviewable source of a generated design: change it and build again.
 */
import type { List } from "@crossprobe/kicad-sexpr";
import { findChildren, arg } from "@crossprobe/kicad-sexpr";
import type { BlockPart, BlockSpec } from "./design-block.js";
import { libPins, type LibPinGeom } from "./design-block.js";
import type { Point } from "./geometry.js";
import { resolveLibrarySymbol } from "./library.js";
import { PAPER_SIZES } from "./page-settings.js";
import { rectangleOutline, type RectCutout } from "./zone-fill.js";

export interface DesignPart {
  /** Reference designator, e.g. "U1". */
  ref: string;
  /** "Library:Symbol", from KiCad's symbol libraries. */
  symbol: string;
  value: string;
  /** "Library:Footprint", from KiCad's footprint libraries. */
  footprint: string;
  /** Pin number (or pin name) → net name. */
  pins: Record<string, string>;
  /** Pins not listed: `no_connect` flags them as unused; the default leaves them open, so ERC reports them. */
  otherPins?: "no_connect" | "ignore";
  dnp?: boolean;
  /** Further fields, e.g. { "MPN": "AP2112K-3.3TRG1", "Datasheet": "https://…" }. */
  fields?: Record<string, string>;
  /** Functional group ("Power", "MCU"): its parts sit together on the sheet, under this heading, and on the board. */
  group?: string;
  /** Why this part and value: the source or the reasoning. Kept in the spec and shown in the report. */
  why?: string;
  /**
   * Where the footprint goes. `x`, `y`: its anchor in mm from the board's top-left corner (fixed).
   * `edge`: against that board edge (connectors). `rotate`: degrees, counter-clockwise, as in KiCad.
   * `align` (with `edge`): where along the edge, "start" (left or top), "center" or "end" (right or bottom).
   * `overhang` (with `edge`): how far the part may hang over that edge, mm (a module whose antenna end is to be off the board).
   * `near`: the reference of a part to sit beside, whatever the nets say.
   * Without it the part is placed next to what it connects to.
   */
  place?: { x?: number; y?: number; rotate?: number; edge?: "left" | "right" | "top" | "bottom"; align?: "start" | "center" | "end"; overhang?: number; near?: string };
}

export interface DesignBoard {
  /** Outline size in mm: a rectangle, less the cut-outs. */
  width: number;
  height: number;
  /** Radius of the outline's four corners, mm. */
  cornerRadius?: number;
  /**
   * Rectangles removed from the outline, in mm from the board's top-left corner: one that reaches an
   * edge is a notch (under a module's antenna, round a connector's body), one inside is a hole or a
   * slot. `radius` rounds its corners. Nothing is placed, routed or poured there.
   */
  cutouts?: RectCutout[];
  /** Copper layers, 2 (default) or 4. */
  layers?: 2 | 4;
  /** Net of the ground pour (back layer on 2 layers, first inner layer on 4). Default "GND" when the design has that net; `null` for no pour. */
  pour?: string | null;
  /** Wider tracks for nets, e.g. [{ "nets": ["+5V", "+3V3"], "width": 0.5 }]. Net names may use * and ?. */
  trackWidths?: Array<{ nets: string[]; width: number }>;
  /**
   * Areas to keep clear, in mm from the board's top-left corner: under a module, around an antenna.
   * `keepOut` lists what stays out: "parts", "tracks", "vias", "pour". `side` limits tracks and pour to
   * the front or back copper (default both); parts and vias are kept out whatever the side.
   */
  keepouts?: DesignKeepout[];
}

export interface DesignKeepout {
  x: number;
  y: number;
  width: number;
  height: number;
  keepOut: Array<"parts" | "tracks" | "vias" | "pour">;
  side?: "front" | "back" | "both";
  /** What it is for; becomes the rule area's name. */
  name?: string;
}

export interface DesignSpec {
  /** Project name; becomes the file names. */
  name: string;
  title?: string;
  /** What the board is for and the requirements it was drawn up from, in a few sentences. */
  description?: string;
  board: DesignBoard;
  parts: DesignPart[];
  /**
   * Rails that are fed from off the board or through a passive part (a connector pin, a fuse, a diode):
   * each gets a PWR_FLAG, which tells ERC the rail has a source. A rail driven by a regulator's output needs none.
   */
  powerFlags?: string[];
  /** Requirements to check the result against (the project's requirements file; see docs/requirements.md). */
  requirements?: unknown[];
  /**
   * Parts that are in no library Crossprobe has: their KiCad files, carried in the spec. They are
   * used like library parts, and written into the project as its own libraries.
   */
  libraries?: DesignSpecLibraries;
}

export interface DesignSpecLibraries {
  /** "Nickname:Name" → the symbol: a .kicad_sym file's text (a whole library that holds the symbol), or one `(symbol "Name" …)`. */
  symbols?: Record<string, string>;
  /** "Nickname:Name" → the footprint: a .kicad_mod file's text. */
  footprints?: Record<string, string>;
  /** Per nickname, where the files come from and under which licence: credited on the schematic and in the report. */
  credits?: Record<string, { publisher?: string; license?: string; source?: string }>;
}

/** Sizes a spec's own parts may have, in characters: one file, and all of them together. */
export const SPEC_LIBRARY_LIMITS = { file: 500_000, total: 3_000_000 };

const LIB_ID = /^[\w.+-]+:[^\\/:]+$/;

/** A symbol carried in a spec, in embeddable form; throws with what is wrong with the text. */
export function specSymbol(text: string, libId: string): List {
  const lib = libId.slice(0, libId.indexOf(":")), name = libId.slice(libId.indexOf(":") + 1);
  const t = text.trimStart();
  if (/^EESchema-LIBRARY/.test(t)) throw new Error("this is a KiCad 5 library (.lib); a .kicad_sym file is needed (open it in KiCad 6 or later and save it, or find the newer file)");
  if (!t.startsWith("(kicad_symbol_lib") && !t.startsWith("(symbol")) throw new Error("this is not a KiCad symbol: it should start with (kicad_symbol_lib or (symbol");
  const library = t.startsWith("(symbol") ? `(kicad_symbol_lib\n${t}\n)` : t;
  try {
    return resolveLibrarySymbol(library, lib, name);
  } catch {
    const names = [...library.matchAll(/^\s*\(symbol\s+"([^"]+)"/gm)].map((m) => m[1]!).filter((n) => !/_\d+_\d+$/.test(n));
    throw new Error(`the text holds no symbol named "${name}"${names.length ? ` (it has: ${names.slice(0, 12).join(", ")})` : ""}. The part after the colon must be the symbol's name`);
  }
}

/** What is wrong with a footprint carried in a spec, or undefined. */
export function specFootprintProblem(text: string): string | undefined {
  const t = text.trimStart();
  if (t.startsWith("(module")) return "this is a KiCad 5 footprint (module …); a KiCad 6 or later .kicad_mod is needed";
  if (!t.startsWith("(footprint")) return "this is not a KiCad footprint: a .kicad_mod file starts with (footprint";
  if (!/\(pad\s/.test(t)) return "the footprint has no pads";
  return undefined;
}

/** Libraries with a spec's own parts in front: an id the spec carries is answered from the spec. */
export function withSpecLibraries(spec: DesignSpec, base: DesignLibraries): DesignLibraries {
  const own = spec?.libraries;
  if (!own || typeof own !== "object") return base;
  const symbols = new Map<string, List | undefined>();
  return {
    symbol: (id) => {
      const text = own.symbols?.[id];
      if (typeof text !== "string") return base.symbol(id);
      if (!symbols.has(id)) {
        try {
          symbols.set(id, specSymbol(text, id));
        } catch {
          symbols.set(id, undefined);
        }
      }
      return symbols.get(id);
    },
    footprint: (id) => {
      const text = own.footprints?.[id];
      return typeof text === "string" ? (specFootprintProblem(text) ? undefined : text) : base.footprint(id);
    },
  };
}

/** Whether a spec carries this "Nickname:Name" itself. */
export const inSpecLibraries = (spec: DesignSpec, libId: string | undefined): boolean => !!libId && (typeof spec?.libraries?.symbols?.[libId] === "string" || typeof spec?.libraries?.footprints?.[libId] === "string");

function specLibraryProblems(spec: DesignSpec): string[] {
  const own = spec.libraries;
  if (own === undefined) return [];
  if (!own || typeof own !== "object") return [`"libraries" must be an object with "symbols" and "footprints"`];
  const problems: string[] = [];
  let total = 0;
  for (const kind of ["symbols", "footprints"] as const) {
    const map = own[kind];
    if (map === undefined) continue;
    if (!map || typeof map !== "object") {
      problems.push(`"libraries.${kind}" must map "Nickname:Name" to the file's text`);
      continue;
    }
    for (const [id, text] of Object.entries(map)) {
      const at = `libraries.${kind}[${JSON.stringify(id)}]`;
      if (!LIB_ID.test(id)) problems.push(`${at}: the key must be "Nickname:Name" (letters, digits, _ . + - in the nickname)`);
      else if (typeof text !== "string" || !text.trim()) problems.push(`${at}: give the file's text`);
      else if (text.length > SPEC_LIBRARY_LIMITS.file) problems.push(`${at}: ${Math.round(text.length / 1000)} kB is more than a part may be (${SPEC_LIBRARY_LIMITS.file / 1000} kB). Footprints with embedded pictures are the usual cause: use one without`);
      else {
        total += text.length;
        if (kind === "symbols") {
          try {
            specSymbol(text, id);
          } catch (e) {
            problems.push(`${at}: ${(e as Error).message}`);
          }
        } else {
          const p = specFootprintProblem(text);
          if (p) problems.push(`${at}: ${p}`);
        }
      }
    }
  }
  if (total > SPEC_LIBRARY_LIMITS.total) problems.push(`"libraries" holds ${Math.round(total / 1000)} kB, more than the ${SPEC_LIBRARY_LIMITS.total / 1000} kB a spec may carry`);
  const used = new Set(spec.parts?.flatMap((p) => [p?.symbol, p?.footprint]) ?? []);
  const unused = [...Object.keys(own.symbols ?? {}), ...Object.keys(own.footprints ?? {})].filter((id) => !used.has(id));
  if (unused.length) problems.push(`"libraries" carries ${unused.join(", ")}, which no part uses: leave them out, or use them`);
  return problems;
}

export interface DesignLibraries {
  /** A library symbol by "Library:Name", in embeddable form (resolveLibrarySymbol's result); undefined if there is none. */
  symbol: (libId: string) => List | undefined;
  /** A footprint's .kicad_mod text by "Library:Name"; undefined if there is none. */
  footprint: (libId: string) => string | undefined;
}

export const DESIGN_LIMITS = { parts: 150, boardMm: 250 };

const POWER_LIB = "power";
const GRID = 2.54;
const STUB = 2.54;
/** Width of a character of 1.27 mm schematic text, generously. */
const CHAR = 1.15;

const snapUp = (v: number) => Math.ceil(v / GRID - 1e-9) * GRID;
const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Resolves symbols once per spec; a missing library or symbol is `undefined`. */
function symbolResolver(libs: Pick<DesignLibraries, "symbol">) {
  const defs = new Map<string, List | undefined>();
  return (libId: string): List | undefined => {
    if (!defs.has(libId)) {
      let def: List | undefined;
      try {
        def = libId.indexOf(":") > 0 ? libs.symbol(libId) : undefined;
      } catch {
        def = undefined;
      }
      defs.set(libId, def);
    }
    return defs.get(libId);
  };
}

/** Units of a library symbol (a dual op-amp has 3: two amplifiers and the supply). */
function unitCount(def: List): number {
  let n = 1;
  for (const u of findChildren(def, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(String(arg(u, 0)));
    if (m) n = Math.max(n, Number(m[1]));
  }
  return n;
}

function pinsFor(pins: LibPinGeom[], key: string): LibPinGeom[] {
  const byNumber = pins.filter((p) => p.number === key);
  return byNumber.length ? byNumber : pins.filter((p) => p.name === key);
}

/** The symbol ids a spec may need, for callers that fetch symbols one by one: its parts', a power symbol per net name, and PWR_FLAG. Not all of them exist. */
export function designSymbolIds(spec: DesignSpec): string[] {
  const ids = new Set<string>([`${POWER_LIB}:PWR_FLAG`]);
  for (const part of spec.parts ?? []) {
    if (typeof part?.symbol === "string") ids.add(part.symbol);
    for (const net of Object.values(part?.pins ?? {})) if (typeof net === "string") ids.add(`${POWER_LIB}:${net}`);
  }
  for (const net of spec.powerFlags ?? []) ids.add(`${POWER_LIB}:${net}`);
  return [...ids];
}

/** The nets of a spec that get a power symbol: those named like a symbol of KiCad's power library (GND, +3V3, VBUS, …). */
export function designPowerNets(spec: DesignSpec, libs: Pick<DesignLibraries, "symbol">): Record<string, string> {
  const resolve = symbolResolver(libs);
  const out: Record<string, string> = {};
  for (const part of spec.parts) for (const net of Object.values(part.pins)) if (!(net in out) && resolve(`${POWER_LIB}:${net}`)) out[net] = `${POWER_LIB}:${net}`;
  for (const net of spec.powerFlags ?? []) if (!(net in out) && resolve(`${POWER_LIB}:${net}`)) out[net] = `${POWER_LIB}:${net}`;
  return out;
}

/**
 * What stops a spec from being built, in words the author can act on. An
 * empty list means it can be built; whether it is a good design is for ERC,
 * DRC and the review to say.
 */
export function checkDesignSpec(spec: DesignSpec, libs: DesignLibraries): string[] {
  const problems: string[] = [];
  if (!spec || typeof spec !== "object") return ["The spec must be an object"];
  problems.push(...specLibraryProblems(spec));
  libs = withSpecLibraries(spec, libs);
  if (typeof spec.name !== "string" || !spec.name.trim()) problems.push(`"name" is required`);
  const b = spec.board;
  if (!b || !(b.width > 0) || !(b.height > 0)) problems.push(`"board" needs a width and height in mm`);
  else {
    if (b.width > DESIGN_LIMITS.boardMm || b.height > DESIGN_LIMITS.boardMm) problems.push(`The board is larger than ${DESIGN_LIMITS.boardMm} mm`);
    if (b.layers !== undefined && b.layers !== 2 && b.layers !== 4) problems.push(`"board.layers" must be 2 or 4`);
    if (b.cornerRadius !== undefined && !(typeof b.cornerRadius === "number" && b.cornerRadius >= 0 && b.cornerRadius <= Math.min(b.width, b.height) / 2)) problems.push(`"board.cornerRadius" is a radius in mm, at most half the board's shorter side`);
    let cutoutsOk = b.cutouts === undefined || Array.isArray(b.cutouts);
    if (!cutoutsOk) problems.push(`"board.cutouts" is a list of rectangles: x, y, width, height in mm, and an optional radius`);
    (cutoutsOk ? (b.cutouts ?? []) : []).forEach((c, i) => {
      const at = `"board.cutouts[${i}]"`;
      const before = problems.length;
      if (!c || ![c.x, c.y, c.width, c.height].every((v) => typeof v === "number" && Number.isFinite(v)) || !(c.width > 0) || !(c.height > 0)) problems.push(`${at} needs x, y, width and height in mm`);
      else if (c.x >= b.width || c.y >= b.height || c.x + c.width <= 0 || c.y + c.height <= 0) problems.push(`${at} is outside the board`);
      else if (c.radius !== undefined && !(typeof c.radius === "number" && c.radius >= 0 && c.radius <= Math.min(c.width, c.height) / 2)) problems.push(`${at}: "radius" is at most half the cut-out's shorter side`);
      if (problems.length > before) cutoutsOk = false;
    });
    if (cutoutsOk && typeof b.cornerRadius !== "object" && (b.cutouts?.length || b.cornerRadius)) {
      const shape = rectangleOutline(0, 0, b.width, b.height, { cornerRadius: typeof b.cornerRadius === "number" ? b.cornerRadius : 0, cutouts: b.cutouts });
      if (shape.outer.length !== 1) problems.push(shape.outer.length ? `The cut-outs split the board into ${shape.outer.length} pieces: it must stay in one` : `The cut-outs leave nothing of the board`);
    }
    (b.keepouts ?? []).forEach((k, i) => {
      const at = `"board.keepouts[${i}]"`;
      if (!k || ![k.x, k.y, k.width, k.height].every((v) => typeof v === "number" && Number.isFinite(v)) || !(k.width > 0) || !(k.height > 0)) return void problems.push(`${at} needs x, y, width and height in mm`);
      if (k.x < 0 || k.y < 0 || k.x + k.width > b.width || k.y + k.height > b.height) problems.push(`${at} reaches outside the board`);
      if (!Array.isArray(k.keepOut) || !k.keepOut.length || k.keepOut.some((w) => !["parts", "tracks", "vias", "pour"].includes(w))) problems.push(`${at}: "keepOut" lists what stays out: parts, tracks, vias, pour`);
      if (k.side !== undefined && !["front", "back", "both"].includes(k.side)) problems.push(`${at}: "side" is front, back or both`);
    });
    for (const t of b.trackWidths ?? []) if (!Array.isArray(t?.nets) || !(t.width > 0)) problems.push(`"board.trackWidths" entries need "nets" and a "width" in mm`);
  }
  if (!Array.isArray(spec.parts) || !spec.parts.length) return [...problems, `"parts" must list at least one part`];
  if (spec.parts.length > DESIGN_LIMITS.parts) problems.push(`At most ${DESIGN_LIMITS.parts} parts`);

  const resolve = symbolResolver(libs);
  const refs = new Set<string>();
  const netPins = new Map<string, string[]>();
  for (const part of spec.parts) {
    const ref = part?.ref;
    if (typeof ref !== "string" || !/^[A-Za-z]+[0-9]+$/.test(ref)) {
      problems.push(`A part's "ref" must look like R1 or U12 (got ${JSON.stringify(ref)})`);
      continue;
    }
    if (refs.has(ref)) problems.push(`${ref} is listed twice`);
    refs.add(ref);
    if (typeof part.value !== "string" || !part.value) problems.push(`${ref} has no value`);
    if (!part.pins || typeof part.pins !== "object") {
      problems.push(`${ref} has no "pins"`);
      continue;
    }
    const def = typeof part.symbol === "string" ? resolve(part.symbol) : undefined;
    if (!def) {
      if (typeof spec.libraries?.symbols?.[part.symbol] !== "string") problems.push(`${ref}: no symbol ${JSON.stringify(part.symbol)} in the libraries (find one with search_symbols, or carry the part's own .kicad_sym in "libraries.symbols")`);
      continue;
    }
    if (unitCount(def) > 1) {
      problems.push(`${ref}: ${part.symbol} has several units, which a design spec cannot place yet. Use a single-unit symbol`);
      continue;
    }
    const pins = libPins(def);
    const used = new Set<string>();
    for (const [key, net] of Object.entries(part.pins)) {
      if (typeof net !== "string" || !net.trim()) {
        problems.push(`${ref} pin ${key} has no net name`);
        continue;
      }
      const found = pinsFor(pins, key);
      if (!found.length) {
        problems.push(`${ref} (${part.symbol}) has no pin "${key}". Its pins: ${pins.map((p) => `${p.number} ${p.name}`).join(", ")}`);
        continue;
      }
      for (const p of found) {
        if (used.has(p.number)) problems.push(`${ref} pin ${p.number} is given two nets`);
        used.add(p.number);
        (netPins.get(net) ?? netPins.set(net, []).get(net)!).push(`${ref}.${p.number}`);
      }
    }
    // The footprint: it must exist and have a pad for every connected pin.
    const fp = typeof part.footprint === "string" && part.footprint ? libs.footprint(part.footprint) : undefined;
    if (!fp) {
      if (typeof spec.libraries?.footprints?.[part.footprint as string] !== "string") problems.push(`${ref}: no footprint ${JSON.stringify(part.footprint)} in the libraries (find one with search_footprints, or carry the part's own .kicad_mod in "libraries.footprints")`);
      continue;
    }
    const pads = new Set([...fp.matchAll(/\(pad\s+"?([^"\s)]*)"?/g)].map((m) => m[1]!));
    const missing = [...used].filter((n) => !pads.has(n));
    if (missing.length) problems.push(`${ref}: footprint ${part.footprint} has no pad ${missing.join(", ")} (its pads: ${[...pads].filter(Boolean).join(", ")})`);
    // Pins the spec leaves out still need a pad: schematic and board would not match otherwise.
    const padless = [...new Set(pins.map((p) => p.number))].filter((n) => !used.has(n) && !pads.has(n));
    if (padless.length && !missing.length) {
      const own = String(arg(findChildren(def, "property").find((p) => arg(p, 0) === "Footprint"), 1) ?? "");
      problems.push(
        `${ref}: symbol ${part.symbol} has pins ${padless.join(", ")} that footprint ${part.footprint} has no pads for. ` +
          `Use a symbol with only the pins this footprint has${own && own !== part.footprint ? `, or the symbol's own footprint ${own}` : ""}`,
      );
    }
    const pl = part.place;
    if (pl) {
      if ((pl.x === undefined) !== (pl.y === undefined)) problems.push(`${ref}: "place" needs both x and y, or neither`);
      if (pl.edge !== undefined && !["left", "right", "top", "bottom"].includes(pl.edge)) problems.push(`${ref}: "place.edge" is left, right, top or bottom`);
      if (pl.rotate !== undefined && pl.rotate % 90 !== 0) problems.push(`${ref}: "place.rotate" must be a multiple of 90`);
      if (pl.align !== undefined && !["start", "center", "end"].includes(pl.align)) problems.push(`${ref}: "place.align" is start, center or end`);
      if (pl.align !== undefined && pl.edge === undefined) problems.push(`${ref}: "place.align" goes with "place.edge" (which edge to be at the start, center or end of)`);
      if (pl.near !== undefined && (pl.near === ref || !spec.parts.some((p) => p.ref === pl.near))) problems.push(`${ref}: "place.near" must be the reference of another part (${JSON.stringify(pl.near)} is not)`);
      if (pl.overhang !== undefined && (typeof pl.overhang !== "number" || !(pl.overhang >= 0) || pl.overhang > 20)) problems.push(`${ref}: "place.overhang" is a distance in mm (0 to 20)`);
      if (pl.overhang !== undefined && pl.edge === undefined) problems.push(`${ref}: "place.overhang" goes with "place.edge" (which edge to hang over)`);
      if (pl.near !== undefined && pl.x !== undefined) problems.push(`${ref}: "place.near" has no effect with a fixed x and y; give one or the other`);
    }
  }
  for (const [net, pins] of netPins) if (pins.length < 2) problems.push(`Net ${net} has only one pin (${pins[0]}): connect it, or leave the pin out`);
  for (const net of spec.powerFlags ?? []) if (!netPins.has(net)) problems.push(`"powerFlags" names ${net}, which no pin is on`);
  if (b && typeof b.pour === "string" && !netPins.has(b.pour)) problems.push(`"board.pour" names ${b.pour}, which no pin is on`);
  return problems;
}

// ---------------------------------------------------------------------------
// Sheet layout
// ---------------------------------------------------------------------------

export interface SheetLayout {
  /** Symbol anchors (mm, on the 2.54 grid) by reference, PWR_FLAGs included. */
  at: Record<string, [number, number]>;
  /** Group headings. */
  notes: Array<{ at: [number, number]; text: string; heading: true }>;
  /** KiCad paper name that holds it. */
  paper: string;
  /** Where a line of text below everything goes (mm): the left margin, under the last row, still on the paper. */
  below: [number, number];
}

interface Cell {
  ref: string;
  group: string;
  /** Room needed left, right, above and below the anchor. */
  l: number;
  r: number;
  t: number;
  b: number;
}

/** The room a symbol needs with its stubs, labels and power symbols, from its anchor. */
function cellOf(ref: string, group: string, value: string, pins: LibPinGeom[], nets: Record<string, string>, power: Record<string, string>): Cell {
  let l = 3.81, r = 3.81, t = 3.81, b = 3.81;
  let sideways = false;
  for (const p of pins) {
    // Sheet coordinates: Y down.
    const x = p.tip.x, y = -p.tip.y;
    l = Math.max(l, -x);
    r = Math.max(r, x);
    t = Math.max(t, -y);
    b = Math.max(b, y);
    const net = nets[p.number] ?? nets[p.name];
    if (net === undefined) continue;
    const reach = STUB + (power[net] ? 6.35 : net.length * CHAR + 1.27);
    const rad = (p.angle * Math.PI) / 180;
    const out = { x: -Math.round(Math.cos(rad)), y: Math.round(Math.sin(rad)) }; // away from the body, on the sheet
    if (out.x < 0) l = Math.max(l, -x + reach);
    if (out.x > 0) r = Math.max(r, x + reach);
    if (out.y < 0) t = Math.max(t, -y + reach);
    if (out.y > 0) b = Math.max(b, y + reach);
    if (out.x) sideways = true;
  }
  // Reference and value: beside an upright two-pin part, above a part with pins to its sides.
  const text = Math.max(ref.length, value.length) * CHAR + 2.54;
  if (sideways) t += 5.08;
  else r = Math.max(r, 2.54 + text);
  return { ref, group, l: snapUp(l), r: snapUp(r), t: snapUp(t), b: snapUp(b) };
}

const MARGIN = 15.24;
const TITLE_BLOCK = 40.64;
const GUTTER = 5.08;
const HEADING = 7.62;

function pack(cells: Cell[], groups: string[], width: number): { at: SheetLayout["at"]; notes: SheetLayout["notes"]; height: number } {
  const at: SheetLayout["at"] = {};
  const notes: SheetLayout["notes"] = [];
  // Each group is a box: its parts in rows, under its heading. The boxes fill the sheet left to right, then down.
  let x0 = 0, y0 = 0, shelf = 0;
  for (const group of groups) {
    const mine = cells.filter((c) => c.group === group);
    if (!mine.length) continue;
    const local: Array<{ ref: string; x: number; y: number }> = [];
    const head = group ? HEADING : 0;
    let x = 0, y = head, rowH = 0, w = group ? group.length * 2 * CHAR : 0;
    for (const c of mine) {
      const cw = c.l + c.r + GUTTER;
      if (x > 0 && x + cw > width) {
        x = 0;
        y += rowH;
        rowH = 0;
      }
      local.push({ ref: c.ref, x: x + c.l, y: y + c.t });
      x += cw;
      w = Math.max(w, x);
      rowH = Math.max(rowH, c.t + c.b + GUTTER);
    }
    const h = y + rowH;
    if (x0 > 0 && x0 + w > width) {
      x0 = 0;
      y0 += shelf + GUTTER;
      shelf = 0;
    }
    if (group) notes.push({ at: [round(x0), round(y0 + HEADING - 2.54)], text: group, heading: true });
    for (const l of local) at[l.ref] = [round(snapUp(x0) + l.x), round(snapUp(y0) + l.y)];
    x0 += snapUp(w + 2 * GUTTER);
    shelf = Math.max(shelf, h);
  }
  return { at, notes, height: y0 + shelf };
}

/** References of the PWR_FLAG symbols a spec asks for, by net. */
export function designPowerFlags(spec: DesignSpec): Array<{ ref: string; net: string }> {
  return [...new Set(spec.powerFlags ?? [])].map((net, i) => ({ ref: `#FLG${String(i + 1).padStart(2, "0")}`, net }));
}

const FLAG_GROUP = "Power flags";

/**
 * Places for every symbol: groups in the order they first appear, each under
 * its heading, parts left to right in rows. The smallest paper from A4 up
 * that holds the result is chosen. Coordinates start at the sheet's margin.
 */
export function layoutDesignSheet(spec: DesignSpec, libs: Pick<DesignLibraries, "symbol">): SheetLayout {
  const resolve = symbolResolver(libs);
  const power = designPowerNets(spec, libs);
  const cells: Cell[] = [];
  const groups: string[] = [];
  const group = (g: string) => {
    if (!groups.includes(g)) groups.push(g);
    return g;
  };
  for (const part of spec.parts) {
    const def = resolve(part.symbol);
    if (!def) throw new Error(`No symbol ${part.symbol}`);
    cells.push(cellOf(part.ref, group(part.group ?? ""), part.value, libPins(def), part.pins, power));
  }
  const flag = resolve(`${POWER_LIB}:PWR_FLAG`);
  for (const f of designPowerFlags(spec)) {
    if (!flag) throw new Error("KiCad's power library has no PWR_FLAG");
    cells.push(cellOf(f.ref, group(FLAG_GROUP), "", libPins(flag), { "1": f.net }, power));
  }
  const papers = ["A4", "A3", "A2", "A1", "A0"];
  for (const paper of papers) {
    const [w, h] = PAPER_SIZES[paper]!;
    const packed = pack(cells, groups, w - 2 * MARGIN);
    if (packed.height <= h - MARGIN - TITLE_BLOCK || paper === "A0") {
      const shift = (p: [number, number]): [number, number] => [round(snapUp(MARGIN) + p[0]), round(snapUp(MARGIN) + p[1])];
      const at: SheetLayout["at"] = {};
      for (const [ref, p] of Object.entries(packed.at)) at[ref] = shift(p);
      const below: [number, number] = [snapUp(MARGIN), Math.min(round(snapUp(MARGIN) + packed.height + 2 * GRID), h - MARGIN)];
      return { at, notes: packed.notes.map((n) => ({ ...n, at: shift(n.at) })), paper, below };
    }
  }
  throw new Error("unreachable");
}

/** The spec as a block spec, for generateBlockSchematic: laid out, with power symbols and PWR_FLAGs. */
export function designBlockSpec(spec: DesignSpec, libs: Pick<DesignLibraries, "symbol">, layout = layoutDesignSheet(spec, libs)): BlockSpec {
  const parts: BlockPart[] = spec.parts.map((p) => ({
    ref: p.ref,
    symbol: p.symbol,
    value: p.value,
    footprint: p.footprint,
    at: layout.at[p.ref]!,
    dnp: p.dnp,
    fields: p.fields,
    pins: p.pins,
    otherPins: p.otherPins ?? "ignore",
    basis: "convention",
  }));
  for (const f of designPowerFlags(spec)) parts.push({ ref: f.ref, symbol: `${POWER_LIB}:PWR_FLAG`, value: "PWR_FLAG", at: layout.at[f.ref]!, pins: { "1": f.net }, basis: "convention" });
  // Neighbouring pins on one side that share a net are wired together and labelled once (VIN and EN, several GND pins).
  const resolve = symbolResolver(libs);
  const join: string[][] = [];
  for (const part of spec.parts) {
    const pins = libPins(resolve(part.symbol)!);
    const netOf = (p: LibPinGeom) => part.pins[p.number] ?? part.pins[p.name];
    const sides = new Map<string, LibPinGeom[]>();
    for (const p of pins) {
      const vertical = p.angle === 90 || p.angle === 270; // the pin runs up or down, so its side's tips share a y
      const key = `${p.angle}:${vertical ? p.tip.y : p.tip.x}`;
      (sides.get(key) ?? sides.set(key, []).get(key)!).push(p);
    }
    for (const [key, side] of sides) {
      const vertical = key.startsWith("90:") || key.startsWith("270:");
      const sorted = [...side].sort((a, b) => (vertical ? a.tip.x - b.tip.x : a.tip.y - b.tip.y));
      let run: LibPinGeom[] = [];
      const flush = () => {
        if (run.length > 1) join.push(run.map((p) => `${part.ref}.${p.number}`));
        run = [];
      };
      for (const p of sorted) {
        const net = netOf(p);
        const last = run[run.length - 1];
        if (last && p.tip.x === last.tip.x && p.tip.y === last.tip.y) continue; // stacked pins are one connection
        if (last && (net === undefined || net !== netOf(last))) flush();
        if (net !== undefined) run.push(p);
      }
      flush();
    }
  }
  return {
    join,
    id: spec.name,
    title: spec.title ?? spec.name,
    description: spec.description ?? "",
    keywords: [],
    category: "",
    status: "draft",
    license: "",
    sources: [],
    power: designPowerNets(spec, libs),
    parts,
    notes: layout.notes,
    checklist: [],
  };
}

// ---------------------------------------------------------------------------
// Board placement
// ---------------------------------------------------------------------------

export interface PlaceItem {
  reference: string;
  /** The footprint's extent around its anchor, unrotated (footprintExtent). */
  extent: { x: number; y: number; w: number; h: number };
  /** Pads relative to the anchor, unrotated, with their nets. */
  pads: Array<{ x: number; y: number; net: string }>;
  group?: string;
  /** A fixed anchor position (board coordinates). */
  at?: Point;
  /** Against this edge of the area. */
  edge?: "left" | "right" | "top" | "bottom";
  /** A fixed rotation; otherwise the four right angles are tried. */
  rotate?: number;
  /** Where along its edge: the start (left or top), the middle or the end. */
  align?: "start" | "center" | "end";
  /** The reference of a part to sit beside. */
  near?: string;
  /** How far the part's box may reach over its edge, mm. */
  overhang?: number;
  /** The footprint's body without its reference text, when `extent` includes that: what its pads are judged against. */
  body?: { x: number; y: number; w: number; h: number };
  /** The side a connector opens to (where the wire or the plug goes in), as a direction in the footprint's own axes, when known. */
  opening?: Point;
}

export interface PartPlacement {
  at: Point;
  /** Degrees, counter-clockwise on screen, as KiCad's footprint angle. */
  rotate: number;
}

/** A footprint-local point on the board, for a footprint at `at` turned by `deg` (KiCad's angle: counter-clockwise with Y down). */
export function footprintPoint(p: Point, at: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const c = Math.round(Math.cos(r) * 1e9) / 1e9, s = Math.round(Math.sin(r) * 1e9) / 1e9;
  return { x: at.x + p.x * c + p.y * s, y: at.y - p.x * s + p.y * c };
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxOf(it: PlaceItem, at: Point, deg: number): Box {
  const e = it.extent;
  const pts = [
    { x: e.x, y: e.y },
    { x: e.x + e.w, y: e.y },
    { x: e.x, y: e.y + e.h },
    { x: e.x + e.w, y: e.y + e.h },
  ].map((p) => footprintPoint(p, at, deg));
  return { x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) };
}

/**
 * Place footprints inside `area` (the board outline's rectangle), without
 * overlaps. Fixed parts go first, then parts bound to an edge, then the part
 * with the most pads in the middle; after that, always the part most
 * connected to those already placed, at the free spot and right-angle
 * rotation where its pads are closest to the pads they connect to. Nets with
 * few pins pull hardest; nets in `weakNets` (a poured ground) barely pull.
 * Parts that find no room are returned in `unplaced`.
 */
export function placeParts(
  items: PlaceItem[],
  area: { x: number; y: number; w: number; h: number },
  o: { margin?: number; gap?: number; weakNets?: string[]; keepouts?: Array<{ x: number; y: number; w: number; h: number }> } = {},
): { placed: Record<string, PartPlacement>; unplaced: string[] } {
  const margin = o.margin ?? 1;
  const gap = o.gap ?? 0.5;
  const weak = new Set(o.weakNets ?? []);
  // A connector on an edge may sit close to its neighbours: the roomy gap of an empty board must not
  // keep it out of the one space beside the pins it connects to.
  const tight = Math.min(gap, 0.5);
  const keepouts: Box[] = (o.keepouts ?? []).map((k) => ({ x0: k.x, y0: k.y, x1: k.x + k.w, y1: k.y + k.h }));
  /** Cost per mm away from where the spec's `near` or `align` asks for: more than any part's nets pull. */
  const ASKED = 20;
  const inner: Box = { x0: area.x + margin, y0: area.y + margin, x1: area.x + area.w - margin, y1: area.y + area.h - margin };
  const centre = { x: area.x + area.w / 2, y: area.y + area.h / 2 };
  // About 3000 candidate spots, on a grid no finer than 0.25 mm.
  const step = Math.min(2, Math.max(0.25, Math.round(Math.sqrt((area.w * area.h) / 3000) * 4) / 4));

  const netSize = new Map<string, number>();
  for (const it of items) for (const p of it.pads) if (p.net) netSize.set(p.net, (netSize.get(p.net) ?? 0) + 1);
  const weight = (net: string) => {
    const n = netSize.get(net) ?? 0;
    if (!net || n < 2) return 0;
    return (weak.has(net) ? 0.05 : 1) / Math.sqrt(n - 1);
  };

  const area2 = (it: PlaceItem) => it.extent.w * it.extent.h;
  const attempt = (edgeOrder: PlaceItem[]): { placed: Record<string, PartPlacement>; unplaced: string[] } => {
    const placed: Record<string, PartPlacement> = {};
    let boxes: Array<Box & { ref: string }> = [];
    // Placed pads by net, with what they belong to: its part and group, and whether it is more than a two-pad part.
    const netPads = new Map<string, Array<Point & { ref: string; group?: string; big: boolean }>>();
    const groupAt = new Map<string, Array<Point & { ref: string }>>();
    const unplaced: string[] = [];
    const apart = (b: Box, p: Box, gap: number) => b.x1 + gap <= p.x0 || p.x1 + gap <= b.x0 || b.y1 + gap <= p.y0 || p.y1 + gap <= b.y0;
    const clear = (b: Box, gap: number) => boxes.every((p) => apart(b, p, gap)) && keepouts.every((k) => apart(b, k, 0));
    const commit = (it: PlaceItem, at: Point, rotate: number) => {
      placed[it.reference] = { at: { x: round(at.x), y: round(at.y) }, rotate };
      boxes.push({ ...boxOf(it, at, rotate), ref: it.reference });
      for (const p of it.pads) if (p.net) (netPads.get(p.net) ?? netPads.set(p.net, []).get(p.net)!).push({ ...footprintPoint(p, at, rotate), ref: it.reference, group: it.group, big: it.pads.length > 2 });
      if (it.group) (groupAt.get(it.group) ?? groupAt.set(it.group, []).get(it.group)!).push({ ...at, ref: it.reference });
    };
    /** Take a placed part off again, to place it anew knowing what came after it. */
    const lift = (it: PlaceItem) => {
      delete placed[it.reference];
      boxes = boxes.filter((b) => b.ref !== it.reference);
      for (const [net, pads] of netPads) netPads.set(net, pads.filter((q) => q.ref !== it.reference));
      for (const [g, at] of groupAt) groupAt.set(g, at.filter((q) => q.ref !== it.reference));
    };

    const cost = (it: PlaceItem, at: Point, deg: number): number => {
      let c = 0, pulled = false;
      for (const p of it.pads) {
        const w = weight(p.net);
        let others = w ? netPads.get(p.net) : undefined;
        if (!others || !others.length) continue;
        // A part belongs with its own group's pads on the net, and a two-pad part (a decoupling capacitor,
        // a pull-up) with a pin of the device it serves rather than with another capacitor.
        const own = it.group ? others.filter((t) => t.group === it.group) : [];
        if (own.length) others = own;
        if (it.pads.length <= 2) {
          const devices = others.filter((t) => t.big);
          if (devices.length) others = devices;
        }
        const q = footprintPoint(p, at, deg);
        let d = Infinity;
        for (const t of others) d = Math.min(d, Math.abs(t.x - q.x) + Math.abs(t.y - q.y));
        c += w * d;
        pulled = true;
      }
      const mates = it.group ? groupAt.get(it.group) : undefined;
      if (mates?.length) {
        const g = { x: mates.reduce((s, m) => s + m.x, 0) / mates.length, y: mates.reduce((s, m) => s + m.y, 0) / mates.length };
        c += 0.15 * (Math.abs(g.x - at.x) + Math.abs(g.y - at.y));
      }
      // What the spec asks for outweighs what the nets suggest.
      const b = boxOf(it, at, deg);
      const beside = it.near ? boxes.find((p) => p.ref === it.near) : undefined;
      if (beside) c += ASKED * (Math.max(0, beside.x0 - b.x1, b.x0 - beside.x1) + Math.max(0, beside.y0 - b.y1, b.y0 - beside.y1));
      if (it.align && it.edge) {
        const [lo, hi, from, to] = it.edge === "top" || it.edge === "bottom" ? [b.x0, b.x1, inner.x0, inner.x1] : [b.y0, b.y1, inner.y0, inner.y1];
        c += ASKED * (it.align === "start" ? lo - from : it.align === "end" ? to - hi : Math.abs((lo + hi) / 2 - (from + to) / 2));
      }
      // Nothing to be near yet: towards the middle. Always a small pull there, to break ties compactly.
      c += (pulled || mates?.length || beside || it.align ? 0.01 : 1) * (Math.abs(centre.x - at.x) + Math.abs(centre.y - at.y));
      return c;
    };

    const search = (it: PlaceItem): boolean => {
      let rotations = it.rotate !== undefined ? [((it.rotate % 360) + 360) % 360] : [0, 90, 180, 270];
      if (it.edge && it.rotate === undefined && it.pads.length) {
        // A row of pins lies along the edge, not across the board.
        const depth = rotations.map((deg) => {
          const b = boxOf(it, { x: 0, y: 0 }, deg);
          return it.edge === "left" || it.edge === "right" ? b.x1 - b.x0 : b.y1 - b.y0;
        });
        const least = Math.min(...depth);
        if (Math.max(...depth) > 1.5 * least) rotations = rotations.filter((_, i) => depth[i]! < least + 0.05);
        // The opening faces out, when the footprint says where it is. Else a connector's pads are behind its
        // mating face: of what is left, turn it so they point into the board.
        const inward = { left: { x: 1, y: 0 }, right: { x: -1, y: 0 }, top: { x: 0, y: 1 }, bottom: { x: 0, y: -1 } }[it.edge];
        const lean = rotations.map((deg) => {
          if (it.opening) {
            const o = footprintPoint(it.opening, { x: 0, y: 0 }, deg);
            return -(o.x * inward.x + o.y * inward.y);
          }
          const b = boxOf(it.body ? { ...it, extent: it.body } : it, { x: 0, y: 0 }, deg);
          const pads = it.pads.map((p) => footprintPoint(p, { x: 0, y: 0 }, deg));
          const c = { x: pads.reduce((s, p) => s + p.x, 0) / pads.length - (b.x0 + b.x1) / 2, y: pads.reduce((s, p) => s + p.y, 0) / pads.length - (b.y0 + b.y1) / 2 };
          return c.x * inward.x + c.y * inward.y;
        });
        const most = Math.max(...lean);
        if (most > 0.3) rotations = rotations.filter((_, i) => lean[i]! > most - 0.05);
      }
      let best: { at: Point; deg: number; c: number } | undefined;
      for (const deg of rotations) {
        const b0 = boxOf(it, { x: 0, y: 0 }, deg); // the box around an anchor at the origin
        // Anchor ranges that keep the box inside the area.
        // An edge part only moves along its edge, so every 0.25 mm is tried there: on the coarser grid
        // it can miss the one gap beside the part it connects to.
        const along = it.edge ? 0.25 : step;
        let xs = range(inner.x0 - b0.x0, inner.x1 - b0.x1, along);
        let ys = range(inner.y0 - b0.y0, inner.y1 - b0.y1, along);
        // Over the edge by its overhang: the box starts that far outside the margin.
        const over = it.edge && it.overhang ? it.overhang + margin : 0;
        if (over) {
          if (it.edge === "left") xs = [round(inner.x0 - b0.x0 - over)];
          if (it.edge === "right") xs = [round(inner.x1 - b0.x1 + over)];
          if (it.edge === "top") ys = [round(inner.y0 - b0.y0 - over)];
          if (it.edge === "bottom") ys = [round(inner.y1 - b0.y1 + over)];
        }
        if (it.edge === "left") xs = xs.slice(0, 1);
        if (it.edge === "right") xs = xs.slice(-1);
        if (it.edge === "top") ys = ys.slice(0, 1);
        if (it.edge === "bottom") ys = ys.slice(-1);
        for (const x of xs)
          for (const y of ys) {
            const at = { x, y };
            const b = { x0: b0.x0 + x, y0: b0.y0 + y, x1: b0.x1 + x, y1: b0.y1 + y };
            if (!clear(b, it.edge ? tight : gap)) continue;
            const c = cost(it, at, deg);
            if (!best || c < best.c - 1e-9) best = { at, deg, c };
          }
      }
      if (!best) return false;
      commit(it, best.at, best.deg);
      return true;
    };

    const todo = new Set(items);
    for (const it of items) {
      if (!it.at) continue;
      commit(it, it.at, it.rotate ?? 0);
      todo.delete(it);
    }
    for (const it of edgeOrder) {
      if (!search(it)) unplaced.push(it.reference);
      todo.delete(it);
    }
    // The first edge part was placed knowing nothing of the others, so it went to the middle of its
    // edge. Now that they are all down, each is placed again next to the pins it connects to: a
    // connector turned round (its pin order reversed) pulls its neighbours to the new side.
    const settle = (parts: PlaceItem[], rounds: number) => {
      for (let pass = 0; pass < rounds; pass++) {
        let moved = false;
        for (const it of parts) {
          const was = placed[it.reference];
          if (!was) continue;
          lift(it);
          if (!search(it)) commit(it, was.at, was.rotate);
          const now = placed[it.reference]!;
          if (now.at.x !== was.at.x || now.at.y !== was.at.y || now.rotate !== was.rotate) moved = true;
        }
        if (!moved) break;
      }
    };
    settle(edgeOrder, 3);
    while (todo.size) {
      let next: PlaceItem | undefined;
      let score = -1;
      // A part that is to sit beside another waits for it.
      const waiting = (it: PlaceItem) => !!it.near && !placed[it.near] && [...todo].some((t) => t.reference === it.near);
      const ready = [...todo].filter((it) => !waiting(it));
      for (const it of ready.length ? ready : todo) {
        // How strongly it is tied to what is placed; before anything is placed, its pad count.
        let s = 0;
        for (const p of it.pads) if (netPads.get(p.net)?.length) s += weight(p.net);
        s = s * 1000 + it.pads.length + area2(it) * 1e-3;
        // A part asked to sit beside one that is down goes next, while there is still room there.
        if (it.near && placed[it.near]) s += 1e9;
        if (s > score) {
          score = s;
          next = it;
        }
      }
      if (!search(next!)) unplaced.push(next!.reference);
      todo.delete(next!);
    }
    return { placed, unplaced };
  };

  // Edge parts go largest first. If something then finds no room, try the other orders (a few parts at most).
  const edges = items.filter((i) => i.edge && !i.at).sort((x, y) => area2(y) - area2(x));
  let best = attempt(edges);
  if (best.unplaced.length && edges.length > 1 && edges.length <= 4) {
    for (const order of permutations(edges).slice(1)) {
      const r = attempt(order);
      if (r.unplaced.length < best.unplaced.length) best = r;
      if (!best.unplaced.length) break;
    }
  }
  return best;
}

function permutations<T>(a: T[]): T[][] {
  if (a.length <= 1) return [a];
  return a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r]));
}

/** Values from `from` to `to` in steps, on the 0.25 mm grid; empty when the range is. */
function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  const a = Math.ceil(from * 4 - 1e-6) / 4, b = Math.floor(to * 4 + 1e-6) / 4;
  for (let v = a; v <= b + 1e-9; v += step) out.push(round(v));
  // Always offer the far end, so a part can sit against the opposite edge.
  if (out.length && b - out[out.length - 1]! > 1e-6) out.push(round(b));
  return out;
}

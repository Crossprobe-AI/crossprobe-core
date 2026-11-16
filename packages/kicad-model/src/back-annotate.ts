/**
 * Update Schematic from PCB (KiCad's back-annotation): what changed on the board goes back to
 * the symbols it came from. Footprints are matched to symbols by their symbol path (as KiCad
 * does by default); what's compared: the reference, value, footprint, other fields, and the DNP
 * and exclude-from-BOM attributes.
 */
import type { Board } from "./board.js";
import { footprintPath } from "./board-update.js";
import type { Component, Schematic } from "./project.js";

export interface SchematicUpdateOptions {
  references?: boolean;
  values?: boolean;
  footprints?: boolean;
  /** Other fields (MPN, LCSC…) the footprint carries: set on the symbol when they differ. */
  fields?: boolean;
  /** DNP and exclude-from-BOM. */
  attributes?: boolean;
}

export interface SchematicUpdate {
  /** The part's reference in the schematic now. */
  reference: string;
  /** Every placed unit: sheet file (as the schematic names it), symbol UUID, sheet path. */
  units: Array<{ file: string; uuid: string; sheet: string }>;
  /** Field → new value (Reference, Value, Footprint, others). */
  fields: Record<string, string>;
  dnp?: boolean;
  inBom?: boolean;
  /** One line per change, for the dialog. */
  changes: string[];
}

const SKIP = new Set(["Reference", "Value", "Footprint", "Datasheet", "Description"]);

/** What the schematic needs to match the board, per part. */
export function planSchematicUpdate(schematic: Schematic, board: Board, o: SchematicUpdateOptions = {}): { updates: SchematicUpdate[]; unmatched: string[] } {
  const opt = { references: true, values: true, footprints: true, fields: true, attributes: true, ...o };
  const byPath = new Map<string, Component>();
  for (const c of schematic.components) for (const u of c.units) byPath.set(footprintPath(u.sheet.path, u.symbol.uuid), c);
  const updates: SchematicUpdate[] = [];
  const unmatched: string[] = [];
  // New references must stay unique: a board renumbering may swap them (R1 ↔ R2).
  for (const fp of board.footprints) {
    if (fp.attributes.boardOnly) continue;
    const c = fp.path ? byPath.get(fp.path) : undefined;
    if (!c) {
      if (fp.reference && !fp.reference.startsWith("#")) unmatched.push(fp.reference);
      continue;
    }
    const fields: Record<string, string> = {};
    const changes: string[] = [];
    if (opt.references && fp.reference && fp.reference !== c.reference) {
      fields.Reference = fp.reference;
      changes.push(`reference ${c.reference} → ${fp.reference}`);
    }
    if (opt.values && fp.value !== c.value) {
      fields.Value = fp.value;
      changes.push(`value ${c.value} → ${fp.value}`);
    }
    if (opt.footprints && fp.libId && fp.libId !== c.footprint) {
      fields.Footprint = fp.libId;
      changes.push(`footprint ${c.footprint || "(none)"} → ${fp.libId}`);
    }
    if (opt.fields)
      for (const [name, v] of Object.entries(fp.properties)) {
        if (SKIP.has(name) || name.startsWith("ki_")) continue;
        const now = c.properties[name] ?? "";
        if (v !== now && !(v === "" && now === "~")) {
          fields[name] = v;
          changes.push(`${name} ${now || "(none)"} → ${v || "(empty)"}`);
        }
      }
    const u: SchematicUpdate = { reference: c.reference, units: c.units.map((x) => ({ file: x.sheet.file, uuid: x.symbol.uuid, sheet: x.sheet.path })), fields, changes };
    if (opt.attributes) {
      if (fp.attributes.dnp !== c.dnp) {
        u.dnp = fp.attributes.dnp;
        changes.push(fp.attributes.dnp ? "do not populate" : "populate");
      }
      if (!fp.attributes.excludeFromBom !== c.inBom) {
        u.inBom = !fp.attributes.excludeFromBom;
        changes.push(u.inBom ? "in the BOM" : "out of the BOM");
      }
    }
    if (changes.length) updates.push(u);
  }
  return { updates, unmatched };
}

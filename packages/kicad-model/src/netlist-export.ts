/**
 * The netlist as a file, in KiCad's own format (`.net`, what Eeschema's
 * Export Netlist writes as "KiCad" and Pcbnew and other tools read): the
 * sheets, every part with its fields and where it is, the library parts with
 * their pins, and every net with its pins.
 */
import { format, list, serialize, str, type Document, type List } from "@crossprobe/kicad-sexpr";
import { isStackedExtra, shownText, stackedPinNumbers, unitLetter, type Netlist } from "./connectivity.js";
import { compareRefs, sheetsByPage, unitPins, type Schematic, type SheetInstance } from "./project.js";

export interface NetlistExportOptions {
  /** The design's file, as the header names it. */
  source?: string;
  /** The header's date (ISO, to the second); now when omitted. */
  date?: string;
  /** The header's tool name. */
  tool?: string;
  /** A net's class by its name ("Default" when omitted). */
  netClass?: (net: string) => string;
}

const q = (s: string) => str(s);
const named = (head: string, name: string, value?: string) => (value === undefined || value === "" ? list(head, list("name", q(name))) : list(head, list("name", q(name)), q(value)));
const property = (name: string, value?: string) => (value === undefined ? list("property", list("name", q(name))) : list("property", list("name", q(name)), list("value", q(value))));

/** A sheet's UUID path below the root, as KiCad writes it: "/" for the root, "/<uuid>/…/" below. */
function tstamps(sheet: SheetInstance, schematic: Schematic): string {
  const below = sheet.path.slice(schematic.root.path.length);
  return below ? `${below}/` : "/";
}

export function exportNetlist(schematic: Schematic, netlist: Netlist, options: NetlistExportOptions = {}): string {
  const file = (f: string) => f.split("/").pop()!;
  const design = list("design", list("source", q(options.source ?? schematic.root.file)), list("date", q(options.date ?? new Date().toISOString().slice(0, 19))), list("tool", q(options.tool ?? "Crossprobe")));
  sheetsByPage(schematic).forEach((sheet, i) => {
    const t = sheet.data.titleBlock;
    const block = list("title_block", list("title", q(t["title"] ?? "")), list("company", q(t["company"] ?? "")), list("rev", q(t["rev"] ?? "")), list("date", q(t["date"] ?? "")), list("source", q(file(sheet.file))));
    for (let n = 1; n <= 9; n++) block.children.push(list("comment", list("number", q(String(n))), list("value", q(t[`comment${n}`] ?? ""))));
    design.children.push(list("sheet", list("number", q(String(i + 1))), list("name", q(sheet.namePath)), list("tstamps", q(tstamps(sheet, schematic))), block));
  });

  const pageOrder = new Map(sheetsByPage(schematic).map((s, i) => [s, i]));
  const STANDARD = new Set(["Reference", "Value", "Footprint", "Datasheet", "Description"]);
  const components = list("components");
  const libparts = new Map<string, List>();
  const libraries = new Set<string>();
  for (const c of [...schematic.components].sort((a, b) => compareRefs(a.reference, b.reference))) {
    // A part with units on several sheets is filed under the first of them, by page.
    const first = [...c.units].sort((a, b) => pageOrder.get(a.sheet)! - pageOrder.get(b.sheet)!)[0]!;
    const colon = c.libId.indexOf(":");
    const lib = colon < 0 ? "" : c.libId.slice(0, colon);
    const part = c.libId.slice(colon + 1);
    // Every part's library part is listed, on the board or not.
    if (c.lib && !libparts.has(c.libId)) {
      const filters = (c.lib.properties["ki_fp_filters"] ?? "").split(/\s+/).filter(Boolean);
      const lp = list("libpart", list("lib", q(lib)), list("part", q(part)));
      if (c.lib.properties["Description"]) lp.children.push(list("description", q(c.lib.properties["Description"])));
      if (filters.length) lp.children.push(list("footprints", ...filters.map((f) => list("fp", q(f)))));
      lp.children.push(list("fields", ...["Reference", "Value", "Footprint", "Datasheet", "Description"].map((k) => named("field", k, c.lib!.properties[k]))));
      const seen = new Set<string>();
      const pins = list("pins");
      for (const p of [...c.lib.pins].sort((a, b) => compareRefs(a.number, b.number))) {
        if (seen.has(p.number) || p.bodyStyle > 1) continue;
        seen.add(p.number);
        pins.children.push(list("pin", list("num", q(p.number)), list("name", q(p.name === "~" ? "" : p.name)), list("type", q(p.type))));
      }
      if (pins.children.length > 1) lp.children.push(pins);
      libparts.set(c.libId, lp);
      if (lib) libraries.add(lib);
    }
    if (!first.symbol.onBoard) continue;
    // Fields read as KiCad shows them: a value of "${SIM.PARAMS}" is that field's text.
    const placement = schematic.placements.find((p) => p.symbol === first.symbol && p.sheet === first.sheet);
    const shown = (text: string) => shownText(text, first.sheet, schematic, placement);
    const comp = list("comp", list("ref", q(c.reference)), list("value", q(shown(c.value) || "~")));
    if (c.footprint) comp.children.push(list("footprint", q(c.footprint)));
    // "~" is how older files spell an empty datasheet.
    const datasheet = c.datasheet === "~" ? "" : shown(c.datasheet);
    if (datasheet) comp.children.push(list("datasheet", q(datasheet)));
    // KiCad's own fields are found whatever their case ("DESCRIPTION").
    // A part's fields are those of all its units: the first unit that fills one in gives its value.
    const all: Record<string, string> = {};
    for (const u of [first, ...c.units]) for (const [k, v] of Object.entries(u.symbol.properties)) if (!all[k]) all[k] = v;
    const descriptionFields = Object.keys(all).filter((k) => k.toLowerCase() === "description");
    const description = shown(descriptionFields.map((k) => all[k]!).filter(Boolean).pop() ?? "").trim();
    if (description) comp.children.push(list("description", q(description)));
    const fields = list("fields", named("field", "Footprint", c.footprint), named("field", "Datasheet", datasheet), named("field", "Description", description));
    // The part's own fields: listed as fields, and again as properties.
    const user = Object.entries(all).filter(([k]) => !STANDARD.has(k) && !descriptionFields.includes(k) && !k.startsWith("ki_")).map(([k, v]) => [k, v === "~" ? "" : shown(v)] as const);
    for (const [k, v] of user) fields.children.push(named("field", k, v));
    comp.children.push(fields);
    comp.children.push(list("libsource", list("lib", q(lib)), list("part", q(part)), list("description", q(c.lib?.properties["Description"] ?? ""))));
    for (const [k, v] of user) comp.children.push(property(k, v));
    // The root sheet is named after the project.
    comp.children.push(property("Sheetname", first.sheet.ref?.name ?? file(schematic.root.file).replace(/\.kicad_sch$/, "")), property("Sheetfile", first.sheet.ref?.file ?? file(first.sheet.file)));
    // The sheet symbol's own fields follow.
    for (const [k, v] of Object.entries(first.sheet.ref?.properties ?? {})) if (!/^Sheet ?(name|file)$/.test(k)) comp.children.push(property(k, v));
    if (!c.inBom) comp.children.push(property("exclude_from_bom"));
    if (c.dnp) comp.children.push(property("dnp"));
    for (const [k, v] of Object.entries({ ...c.lib?.properties, ...c.properties })) if (k.startsWith("ki_") && v) comp.children.push(property(k, v));
    comp.children.push(list("sheetpath", list("names", q(first.sheet.namePath)), list("tstamps", q(tstamps(first.sheet, schematic)))));
    comp.children.push(list("tstamps", ...c.units.filter((u) => u.sheet === first.sheet).map((u) => q(u.symbol.uuid))));
    if (c.lib) {
      const units = list("units");
      for (let unit = 1; unit <= c.lib.unitCount; unit++) {
        const pins = unitPins(c.lib, unit, first.symbol.bodyStyle).flatMap((p) => stackedPinNumbers(p.number) ?? [p.number]);
        units.children.push(list("unit", list("name", q(unitLetter(unit))), list("pins", ...pins.map((n) => list("pin", list("num", q(n)))))));
      }
      comp.children.push(units);
    }
    components.children.push(comp);
  }

  // Where each pin is in its symbol: pins drawn on top of each other count as one.
  const pinPlace = new Map<string, string>();
  for (const c of schematic.components) for (const p of c.lib?.pins ?? []) pinPlace.set(`${c.reference}\0${p.number}`, `${p.unit}|${p.at.x}|${p.at.y}`);
  const nets = list("nets");
  netlist.nets.forEach((net, i) => {
    const node = list("net", list("code", q(String(i + 1))), list("name", q(net.name)), list("class", q(options.netClass?.(net.name) ?? "Default")));
    // A pin alone on a net with a no-connect flag is marked so (as are the pads of one stacked pin).
    const pins = net.nodes.filter((n) => !isStackedExtra(n));
    const alone = pins.length === 1 || (pins.every((n) => n.reference === pins[0]!.reference) && new Set(pins.map((n) => pinPlace.get(`${n.reference}\0${n.pin}`) ?? n.pin)).size === 1);
    for (const n of net.nodes) {
      const base = n.pinName === "~" ? "" : n.pinName;
      const out = list("node", list("ref", q(n.reference)), list("pin", q(n.pin)));
      if (base) out.children.push(list("pinfunction", q(`${base}_${n.pin}`)));
      out.children.push(list("pintype", q(net.noConnect && alone && n.pinType !== "no_connect" ? `${n.pinType}+no_connect` : n.pinType)));
      node.children.push(out);
    }
    nets.children.push(node);
  });

  const root = list(
    "export",
    list("version", q("E")),
    design,
    components,
    list("libparts", ...[...libparts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((e) => e[1])),
    list("libraries", ...[...libraries].sort().map((l) => list("library", list("logical", q(l))))),
    nets,
  );
  format(root, "");
  const doc: Document = { type: "document", children: [root], trivia: [""], trailing: "\n", diagnostics: [] };
  return serialize(doc);
}

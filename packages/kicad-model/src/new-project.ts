/**
 * A new, empty KiCad 10 project: project file, root schematic and a two-layer
 * board, with KiCad's default design rules and the Default net class. KiCad
 * fills in every setting left out of the project file with its defaults when
 * it opens the project.
 */

const uuid = () => globalThis.crypto.randomUUID();

/** Project names become file names: keep them portable. */
/**
 * A file name that is safe everywhere a project's files go: shells, zip
 * archives, fab houses' upload forms and Windows. Only ASCII letters, digits,
 * `.`, `_` and `-` are kept (accents are dropped), and every other run of
 * characters (spaces, commas, brackets) becomes one `_`.
 * "Li-ion charger, 500 mA (MCP73831)" → "Li-ion_charger_500_mA_MCP73831".
 */
export function projectFileName(name: string): string {
  const clean = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return clean || "untitled";
}

export interface NewProjectOptions {
  /** Shown in the schematic and board title blocks. */
  title?: string;
  /** "YYYY-MM-DD"; defaults to today. */
  date?: string;
}

/** Returns project-relative path → file text, plus the .kicad_pro's path. */
export function newProject(name: string, o: NewProjectOptions = {}): { project: string; files: Record<string, string> } {
  const base = projectFileName(name);
  const rootUuid = uuid();
  const title = (o.title ?? name).replace(/"/g, "'");
  const date = o.date ?? new Date().toISOString().slice(0, 10);
  const titleBlock = `\t(title_block\n\t\t(title "${title}")\n\t\t(date "${date}")\n\t\t(rev "1")\n\t)\n`;

  const sch =
    `(kicad_sch\n\t(version 20260101)\n\t(generator "eeschema")\n\t(generator_version "10.0")\n\t(uuid "${rootUuid}")\n\t(paper "A4")\n` +
    titleBlock +
    `\t(lib_symbols)\n\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n`;

  const layers: Array<[number, string, string, string?]> = [
    [0, "F.Cu", "signal"],
    [2, "B.Cu", "signal"],
    [9, "F.Adhes", "user", "F.Adhesive"],
    [11, "B.Adhes", "user", "B.Adhesive"],
    [13, "F.Paste", "user"],
    [15, "B.Paste", "user"],
    [5, "F.SilkS", "user", "F.Silkscreen"],
    [7, "B.SilkS", "user", "B.Silkscreen"],
    [1, "F.Mask", "user"],
    [3, "B.Mask", "user"],
    [17, "Dwgs.User", "user", "User.Drawings"],
    [19, "Cmts.User", "user", "User.Comments"],
    [21, "Eco1.User", "user", "User.Eco1"],
    [23, "Eco2.User", "user", "User.Eco2"],
    [25, "Edge.Cuts", "user"],
    [27, "Margin", "user"],
    [31, "F.CrtYd", "user", "F.Courtyard"],
    [29, "B.CrtYd", "user", "B.Courtyard"],
    [35, "F.Fab", "user"],
    [33, "B.Fab", "user"],
  ];
  const pcb =
    `(kicad_pcb\n\t(version 20260206)\n\t(generator "pcbnew")\n\t(generator_version "10.0")\n\t(general\n\t\t(thickness 1.6)\n\t\t(legacy_teardrops no)\n\t)\n\t(paper "A4")\n` +
    titleBlock +
    `\t(layers\n` +
    layers.map(([n, l, t, u]) => `\t\t(${n} "${l}" ${t}${u ? ` "${u}"` : ""})\n`).join("") +
    `\t)\n\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t\t(allow_soldermask_bridges_in_footprints no)\n\t\t(tenting\n\t\t\t(front yes)\n\t\t\t(back yes)\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n`;

  // KiCad's defaults for a new project (as pcbnew writes them).
  const pro = {
    board: {
      design_settings: {
        defaults: { board_outline_line_width: 0.05, copper_line_width: 0.2, silk_line_width: 0.1, silk_text_size_h: 1, silk_text_size_v: 1, silk_text_thickness: 0.1 },
        rules: {
          max_error: 0.005,
          min_clearance: 0,
          min_connection: 0,
          min_copper_edge_clearance: 0.5,
          min_hole_clearance: 0.25,
          min_hole_to_hole: 0.25,
          min_microvia_diameter: 0.2,
          min_microvia_drill: 0.1,
          min_resolved_spokes: 2,
          min_silk_clearance: 0,
          min_text_height: 0.8,
          min_text_thickness: 0.08,
          min_through_hole_diameter: 0.3,
          min_track_width: 0.2,
          min_via_annular_width: 0.1,
          min_via_diameter: 0.5,
          solder_mask_to_copper_clearance: 0,
          use_height_for_length_calcs: true,
        },
        track_widths: [0],
        via_dimensions: [{ diameter: 0, drill: 0 }],
      },
    },
    boards: [],
    libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] },
    meta: { filename: `${base}.kicad_pro`, version: 3 },
    net_settings: {
      classes: [
        {
          bus_width: 12,
          clearance: 0.2,
          diff_pair_gap: 0.25,
          diff_pair_via_gap: 0.25,
          diff_pair_width: 0.2,
          line_style: 0,
          microvia_diameter: 0.3,
          microvia_drill: 0.1,
          name: "Default",
          pcb_color: "rgba(0, 0, 0, 0.000)",
          priority: 2147483647,
          schematic_color: "rgba(0, 0, 0, 0.000)",
          track_width: 0.2,
          via_diameter: 0.6,
          via_drill: 0.3,
          wire_width: 6,
        },
      ],
      meta: { version: 5 },
      net_colors: null,
      netclass_assignments: null,
      netclass_patterns: [],
    },
    sheets: [[rootUuid, "Root"]],
    text_variables: {},
  };

  return {
    project: `${base}.kicad_pro`,
    files: {
      [`${base}.kicad_pro`]: JSON.stringify(pro, null, 2) + "\n",
      [`${base}.kicad_sch`]: sch,
      [`${base}.kicad_pcb`]: pcb,
    },
  };
}

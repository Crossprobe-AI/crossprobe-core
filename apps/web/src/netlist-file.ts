/** The schematic's netlist as a file in KiCad's format (Eeschema's Export Netlist, "KiCad"). */
import { buildNetlist, exportNetlist, loadSchematic, netClassOf, projectDesignRules } from "@crossprobe/kicad-model";

/** `files` are the project's files by path; `projectFile` is its .kicad_pro among them. */
export function netlistFile(files: Record<string, string>, projectFile: string): string {
  const dir = projectFile.slice(0, projectFile.lastIndexOf("/") + 1);
  const root = projectFile.slice(dir.length).replace(/\.kicad_pro$/, ".kicad_sch");
  const schematic = loadSchematic(root, (f) => {
    const text = files[dir + f];
    if (text === undefined) throw new Error(`missing ${f}`);
    return text;
  });
  const rules = projectDesignRules(files[projectFile]);
  return exportNetlist(schematic, buildNetlist(schematic), { source: root, netClass: (net) => netClassOf(rules, net).name });
}

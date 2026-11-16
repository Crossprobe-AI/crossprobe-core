/**
 * A new project with a design block already in its schematic: what "Open in
 * Crossprobe" on a block's web page opens. The block goes in with the same
 * operation as the Add block tool, keeping its own reference designators
 * (C1, R1, …): the project is empty, and they match the block's page.
 */
import { loadSchematic, newProject } from "@crossprobe/kicad-model";
import { Editor } from "./edit/ops";

/** Top-left corner of the block on the A4 sheet: inside the frame, with room for the title block. */
const AT = { x: 25.4, y: 25.4 };

/** `name` becomes the file names (use the block id); `title` goes in the title blocks. */
export function projectFromBlock(name: string, blockText: string, blockPcb?: string, title?: string): { project: string; files: Record<string, string> } {
  const { project, files } = newProject(name, { title });
  const rootFile = project.replace(/\.kicad_pro$/, ".kicad_sch");
  const root = loadSchematic(rootFile, (f) => files[f]!).root;
  const changed = new Editor().apply(
    files,
    [{ op: "insertBlock", file: rootFile, blockText, at: AT, sheetPaths: [root.path], projectName: project.replace(/\.kicad_pro$/, ""), keepReferences: true, blockPcb }],
    rootFile,
  );
  return { project, files: { ...files, ...changed } };
}

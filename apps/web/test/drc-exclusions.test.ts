/**
 * DRC exclusions: written into the project file as KiCad keeps them, honoured by the analysis
 * (the finding moves to "excluded"), and removed again by "Include".
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyze";
import { Editor } from "../src/edit/ops";
import { exclusionEntry } from "@crossprobe/kicad-model";

const DIR = `${process.env.KICAD_DEMOS}/interf_u`;

describe.skipIf(!existsSync(DIR))("DRC exclusions", () => {
  it("exclude a finding, see it set apart, include it again", () => {
    const files: Record<string, string> = {};
    for (const f of ["interf_u.kicad_pro", "interf_u.kicad_pcb", "interf_u.kicad_sch"]) files[f] = readFileSync(`${DIR}/${f}`, "utf8");
    const before = analyze({ project: "interf_u.kicad_pro", files });
    const v = before.boardChecks[0]!;
    expect(v).toBeDefined();
    const pro = new Editor().apply(files, [{ op: "setProjectRules", file: "interf_u.kicad_pro", exclude: { entry: exclusionEntry(v.type, v.at, v.items), comment: "fine here" } }])["interf_u.kicad_pro"]!;
    const entries = JSON.parse(pro).board.design_settings.drc_exclusions;
    expect(entries.at(-1)).toEqual([expect.stringMatching(new RegExp(`^${v.type}\\|\\d+\\|\\d+\\|`)), "fine here"]);
    const after = analyze({ project: "interf_u.kicad_pro", files: { ...files, "interf_u.kicad_pro": pro } });
    expect(after.boardChecks.length).toBe(before.boardChecks.length - 1);
    expect(after.drcExcluded.map((x) => x.type)).toEqual([v.type]);
    const again = new Editor().apply({ ...files, "interf_u.kicad_pro": pro }, [{ op: "setProjectRules", file: "interf_u.kicad_pro", include: after.drcExcluded[0]!.key }])["interf_u.kicad_pro"]!;
    expect(analyze({ project: "interf_u.kicad_pro", files: { ...files, "interf_u.kicad_pro": again } }).boardChecks.length).toBe(before.boardChecks.length);
  });
});

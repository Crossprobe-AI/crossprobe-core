/**
 * Unsaved changes kept for a reload: only the changed files are stored, and
 * restoring gives back the same files and the same "changed since saved" set.
 */
import { describe, expect, it } from "vitest";
import { fromStored, syncedFromStored, toStored, upgradeStored, type PersistMeta } from "../src/persist";

const meta: PersistMeta = { tab: "t1", unsaved: false };
const original = { "a.kicad_pro": "{}", "a.kicad_sch": "(sch v1)", "a.kicad_pcb": "(pcb v1)" };

describe("kept changes", () => {
  it("keeps nothing when nothing changed", () => {
    expect(toStored("a.kicad_pro", { ...original }, original, meta)).toBeUndefined();
  });

  it("stores only the changed and new files, and restores them over the saved files", () => {
    const files = { ...original, "a.kicad_sch": "(sch v2)", "power.kicad_sch": "(sch new)" };
    const s = toStored("a.kicad_pro", files, original, { ...meta, link: "demo=x" })!;
    expect(s.changed).toEqual({ "a.kicad_sch": "(sch v2)", "power.kicad_sch": "(sch new)" });
    expect(s.link).toBe("demo=x");
    expect(fromStored(s)).toEqual(files);
  });

  it("restores a file that no longer exists as gone", () => {
    const files: Record<string, string> = { ...original };
    delete files["a.kicad_pcb"];
    const s = toStored("a.kicad_pro", files, original, meta)!;
    expect(s.changed).toEqual({ "a.kicad_pcb": null });
    expect(fromStored(s)).toEqual(files);
  });

  it("keeps every file of a project that was never saved", () => {
    const s = toStored("a.kicad_pro", original, {}, { ...meta, unsaved: true })!;
    expect(s.unsaved).toBe(true);
    expect(Object.keys(s.changed).sort()).toEqual(Object.keys(original).sort());
    expect(fromStored(s)).toEqual(original);
  });

  // An extension's link is opaque here; this one is shaped like a GitHub link.
  describe("linked (e.g. to GitHub)", () => {
    const git = { owner: "acme", repo: "board", branch: "main", dir: "hw", head: "abc123", blobs: { "a.kicad_sch": "b1" } };

    it("keeps the link and what was last synced with the changes", () => {
      const files = { ...original, "a.kicad_sch": "(sch v2)" };
      const s = toStored("a.kicad_pro", files, original, { ...meta, links: { github: git } }, { ...original })!;
      expect(s.links?.github).toEqual(git);
      // Synced matches the saved files: nothing extra stored for it.
      expect(s.synced).toEqual({});
      expect(syncedFromStored(s)).toEqual(original);
      expect(fromStored(s)).toEqual(files);
    });

    it("keeps a project that is saved but not committed, and what GitHub had", () => {
      const saved = { ...original, "a.kicad_pcb": "(pcb v2)", "new.kicad_sch": "(sch new)" };
      const synced: Record<string, string> = { ...original };
      const s = toStored("a.kicad_pro", { ...saved }, saved, { ...meta, links: { github: git } }, synced)!;
      expect(s.changed).toEqual({});
      expect(s.synced).toEqual({ "a.kicad_pcb": "(pcb v1)", "new.kicad_sch": null });
      expect(syncedFromStored(s)).toEqual(synced);
      expect(fromStored(s)).toEqual(saved);
    });

    it("keeps nothing when everything is saved and committed", () => {
      expect(toStored("a.kicad_pro", { ...original }, original, { ...meta, links: { github: git } }, { ...original })).toBeUndefined();
    });

    it("drops the link once unlinked", () => {
      const files = { ...original, "a.kicad_sch": "(sch v2)" };
      const s = toStored("a.kicad_pro", files, original, meta, { ...original })!;
      expect(s.links).toBeUndefined();
      expect(syncedFromStored(s)).toBeUndefined();
    });

    it("reads a record kept by an earlier version, with the link in a field of its own", () => {
      const legacy = { tab: "t", project: "a.kicad_pro", original, changed: {}, unsaved: false, savedAt: 1, git: { link: git, synced: { "a.kicad_pcb": "(pcb v0)" } }, cloud: { id: "p1", name: "a", revision: 3 } };
      const s = upgradeStored(legacy);
      expect(s.links).toEqual({ github: git, cloud: { id: "p1", name: "a", revision: 3 } });
      expect(syncedFromStored(s)).toEqual({ ...original, "a.kicad_pcb": "(pcb v0)" });
      expect("git" in s || "cloud" in s).toBe(false);
    });
  });
});

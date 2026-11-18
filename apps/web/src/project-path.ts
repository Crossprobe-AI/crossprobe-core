/**
 * A path from the project file (a drawing sheet's, for now) to one of the project's files, as
 * KiCad resolves it: ${KIPRJMOD} is the project folder, the project's text variables are filled in
 * (their values may hold variables themselves), backslashes become slashes, and a relative path
 * is taken from the project folder. The browser has only the project's own files, keyed by path
 * from where it was opened: an absolute path is read when it ends in the project folder's name
 * and a file of the project (as KiCad projects often store it), else it is outside the project.
 */
export type ProjectPath =
  { file: string } | { missing: string } | { outside: string };

export function resolveProjectPath(
  raw: string,
  dir: string,
  files: Record<string, string>,
  vars?: Record<string, string>,
): ProjectPath {
  let p = raw;
  // Variables whose values hold variables: a few rounds, as KiCad's expansion recurses.
  for (let round = 0; round < 8 && p.includes("${"); round++) {
    const next = p.replace(/\$\{([^}]+)\}/g, (m, name: string) =>
      name === "KIPRJMOD" ? "\0" : (vars?.[name] ?? m),
    );
    if (next === p) break;
    p = next;
  }
  // ${KIPRJMOD} once at the start is the project folder; anywhere else it's left unresolved.
  p = p.replace(/\\/g, "/").replace(/^\0\/?/, "");
  if (p.includes("\0") || p.includes("${")) return { outside: raw };
  const absolute = /^(\/|[A-Za-z]:\/)/.test(p);
  if (absolute) {
    const parts = p.split("/").filter(Boolean);
    const folder = dir.replace(/\/$/, "").split("/").pop();
    for (let i = 1; i < parts.length; i++) {
      if (folder && parts[i - 1] !== folder) continue;
      const rel = parts.slice(i).join("/");
      if (files[dir + rel] !== undefined) return { file: dir + rel };
    }
    return { outside: raw };
  }
  // Relative: from the project folder, "." and ".." taken out.
  const out: string[] = dir.split("/").filter(Boolean);
  const base = out.length;
  let above = false;
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length <= base) above = true;
      if (out.length) out.pop();
      else return { outside: raw };
    } else out.push(seg);
  }
  const file = out.join("/");
  if (files[file] !== undefined) return { file };
  return above ? { outside: raw } : { missing: raw };
}

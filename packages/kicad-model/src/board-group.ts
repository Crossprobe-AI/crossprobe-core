/**
 * Groups on the board, as KiCad's (PCB_GROUP): a named set of items (which
 * may be other groups) that select, move and delete together.
 *
 * - Grouping makes a new group of the selected top-level items.
 * - Ungrouping removes the group; its members join the group it was in, if any.
 * - Deleting items takes them out of their groups; a group left empty goes too
 *   (KiCad's commit drops empty groups).
 * - Selecting any member selects its top-level group: all the items in it.
 *
 * Written as KiCad writes them: after the zones, `(group "name" (uuid …)
 * (members "…" …))`.
 */
import { arg, findChild, findChildren, format, headOf, insertAt, isAtom, isList, list, removeChild, str, sym, atomText, type List } from "@crossprobe/kicad-sexpr";
import type { Board, BoardGroup } from "./board.js";
import { newBoardUuid } from "./board-edit.js";

const uuidOf = (n: List) => String(arg(findChild(n, "uuid"), 0) ?? "");
const membersOf = (g: List) => (findChild(g, "members")?.children.slice(1) ?? []).filter(isAtom).map(atomText);

/** The group (top-level `group` node) that lists `uuid` as a member. */
function parentNode(root: List, uuid: string): List | undefined {
  return findChildren(root, "group").find((g) => membersOf(g).includes(uuid));
}

/** Replace a group's member list (on one line; KiCad rewraps it when it saves). */
function setMembers(g: List, members: string[]): void {
  const fresh = list("members", ...members.map((m) => str(m)));
  fresh.trivia = fresh.children.map((_, k) => (k ? " " : ""));
  fresh.closeTrivia = "";
  const old = findChild(g, "members");
  if (old) g.children[g.children.indexOf(old)] = fresh;
  else insertAt(g, g.children.length, fresh);
}

/**
 * Make a group of `members` (top-level items or groups: members already in a
 * group are taken out of it and the new group goes in their place). Returns
 * its UUID.
 */
export function addGroup(root: List, members: string[], name = "", uuid = newBoardUuid()): string {
  // KiCad groups what is selected at the top level; the new group joins the parent they shared.
  const parents = new Set(members.map((m) => parentNode(root, m)).filter((g): g is List => !!g));
  for (const p of parents) setMembers(p, membersOf(p).filter((m) => !members.includes(m)));
  const g = list("group", str(name), list("uuid", str(uuid)), list("members", ...members.map((m) => str(m))));
  // After the last group, else after the zones, before generated items and embedded fonts.
  let at = -1;
  root.children.forEach((c, i) => {
    if (isList(c) && ["zone", "group"].includes(headOf(c) ?? "")) at = i;
  });
  if (at < 0) {
    const tail = root.children.findIndex((c) => isList(c) && ["generated", "embedded_fonts", "embedded_files"].includes(headOf(c) ?? ""));
    at = (tail < 0 ? root.children.length : tail) - 1;
  }
  insertAt(root, at + 1, format(g, "\t"), "");
  if (parents.size === 1) {
    const p = [...parents][0]!;
    setMembers(p, [...membersOf(p), uuid]);
  }
  return uuid;
}

/** Ungroup: the group goes; its members join the group it was in, if any. */
export function removeGroup(root: List, uuid: string): boolean {
  const g = findChildren(root, "group").find((x) => uuidOf(x) === uuid);
  if (!g) return false;
  const parent = parentNode(root, uuid);
  if (parent) setMembers(parent, [...membersOf(parent).filter((m) => m !== uuid), ...membersOf(g)]);
  removeChild(root, g);
  return true;
}

/** Take deleted items out of their groups; drop groups left empty (and so on up). */
export function pruneGroups(root: List, removed: Iterable<string>): void {
  const gone = new Set(removed);
  for (;;) {
    let changed = false;
    for (const g of findChildren(root, "group")) {
      const m = membersOf(g);
      const kept = m.filter((u) => !gone.has(u));
      if (kept.length === m.length) continue;
      changed = true;
      if (kept.length) setMembers(g, kept);
      else {
        gone.add(uuidOf(g));
        removeChild(root, g);
      }
    }
    if (!changed) return;
  }
}

/** Lock or unlock a group, as KiCad writes it: (locked yes) after the name. */
export function setGroupLocked(root: List, uuid: string, locked: boolean): void {
  const g = findChildren(root, "group").find((x) => uuidOf(x) === uuid);
  if (!g) return;
  const l = findChild(g, "locked") ?? g.children.find((c) => isAtom(c) && c.raw === "locked");
  if (l) removeChild(g, l);
  if (locked) insertAt(g, 2, list("locked", sym("yes")));
}

/** The outermost group an item belongs to (itself if it is a top-level group), if any. */
export function topGroup(board: Board, uuid: string): BoardGroup | undefined {
  const byMember = new Map<string, BoardGroup>();
  for (const g of board.groups) for (const m of g.members) byMember.set(m, g);
  let g = byMember.get(uuid);
  if (!g) return undefined;
  for (let up = byMember.get(g.uuid); up; up = byMember.get(up.uuid)) g = up;
  return g;
}

/** The items (not groups) in a group, through nested groups. */
export function groupItems(board: Board, uuid: string): string[] {
  const byId = new Map(board.groups.map((g) => [g.uuid, g]));
  const out: string[] = [];
  const walk = (id: string, seen: Set<string>) => {
    const g = byId.get(id);
    if (!g || seen.has(id)) return;
    seen.add(id);
    for (const m of g.members) byId.has(m) ? walk(m, seen) : out.push(m);
  };
  walk(uuid, new Set());
  return out;
}

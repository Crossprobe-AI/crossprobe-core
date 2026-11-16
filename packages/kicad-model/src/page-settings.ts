/**
 * Page settings (KiCad's Page Settings dialog), the same in schematic sheets and boards: the paper
 * — a named size, portrait or landscape, or a user size in mm — and the title block (title,
 * date, revision, company, comments 1–9).
 */
import { arg, findChild, findChildren, format, headOf, insertAt, isAtom, isList, list, removeChild, str, sym, type List } from "@crossprobe/kicad-sexpr";

/** KiCad's named paper sizes (landscape, mm). */
export const PAPER_SIZES: Record<string, [number, number]> = {
  A5: [210, 148],
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
  A: [279.4, 215.9],
  B: [431.8, 279.4],
  C: [558.8, 431.8],
  D: [863.6, 558.8],
  E: [1117.6, 863.6],
  USLetter: [279.4, 215.9],
  USLegal: [355.6, 215.9],
  USLedger: [431.8, 279.4],
};

export interface PageSettings {
  /** A name from PAPER_SIZES, or "User" with width and height. */
  paper: string;
  width?: number;
  height?: number;
  portrait?: boolean;
  title: string;
  date: string;
  rev: string;
  company: string;
  /** Comments 1–9 ("" = none). */
  comments: string[];
}

/** The page settings of a sheet or board root. */
export function pageSettings(root: List): PageSettings {
  const paper = findChild(root, "paper");
  const name = String(arg(paper, 0) ?? "A4");
  const tb = findChild(root, "title_block");
  const field = (h: string) => String(arg(tb && findChild(tb, h), 0) ?? "");
  const comments = Array.from({ length: 9 }, (_, i) => String(arg(findChildren(tb ?? list("x"), "comment").find((c) => Number(arg(c, 0)) === i + 1), 1) ?? ""));
  return {
    paper: name,
    width: name === "User" ? Number(arg(paper, 1)) : undefined,
    height: name === "User" ? Number(arg(paper, 2)) : undefined,
    portrait: !!paper?.children.some((c) => isAtom(c) && c.raw === "portrait"),
    title: field("title"),
    date: field("date"),
    rev: field("rev"),
    company: field("company"),
    comments,
  };
}

/** Set the paper and title block. Empty title-block fields are left out, as KiCad writes them. */
export function setPageSettings(root: List, s: PageSettings): void {
  const paper = s.paper === "User" ? list("paper", str("User"), s.width ?? 297, s.height ?? 210) : list("paper", str(s.paper), ...(s.portrait ? [sym("portrait")] : []));
  const old = findChild(root, "paper");
  let at: number;
  if (old) {
    at = root.children.indexOf(old);
    removeChild(root, old);
  } else {
    // After the header: version, generator(s), uuid.
    const head = root.children.filter((c) => isList(c) && ["version", "generator", "generator_version", "uuid", "general"].includes(headOf(c) ?? ""));
    at = head.length ? root.children.indexOf(head[head.length - 1]!) + 1 : 1;
  }
  insertAt(root, at, paper);

  const oldTb = findChild(root, "title_block");
  if (oldTb) removeChild(root, oldTb);
  const fields: List[] = [];
  if (s.title) fields.push(list("title", str(s.title)));
  if (s.date) fields.push(list("date", str(s.date)));
  if (s.rev) fields.push(list("rev", str(s.rev)));
  if (s.company) fields.push(list("company", str(s.company)));
  s.comments.forEach((c, i) => c && fields.push(list("comment", i + 1, str(c))));
  if (fields.length) insertAt(root, root.children.indexOf(findChild(root, "paper")!) + 1, format(list("title_block", ...fields), "\t"));
}

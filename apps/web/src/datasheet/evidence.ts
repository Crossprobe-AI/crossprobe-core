/**
 * Evidence the engineer pinned to a part, pin or net: a place in a datasheet,
 * stored next to the KiCad project (`<project>.crossprobe-evidence.json`) so
 * the KiCad files stay untouched.
 */
import type { Evidence } from "./types";

export interface PinnedEvidence {
  id: string;
  /** What it is evidence for. A reference alone means the part. */
  target: { reference?: string; pin?: string; net?: string };
  evidence: Evidence;
  /** The engineer's own note ("max VIN is 6.5 V, we run 5 V"). */
  note?: string;
  pinnedAt: string;
}

export interface EvidenceFile {
  version: 1;
  items: PinnedEvidence[];
}

export const evidenceFileName = (projectBase: string) => `${projectBase}.crossprobe-evidence.json`;

export function parseEvidence(text: string | undefined): PinnedEvidence[] {
  if (!text) return [];
  try {
    const f = JSON.parse(text) as Partial<EvidenceFile>;
    return Array.isArray(f.items) ? f.items.filter((i) => i && typeof i.id === "string" && i.evidence && typeof i.evidence.page === "number") : [];
  } catch {
    return [];
  }
}

export type EvidenceOp = { add: PinnedEvidence } | { remove: string } | { note: { id: string; text: string } };

/** The file text after one change; a missing file starts empty. */
export function applyEvidence(text: string | undefined, op: EvidenceOp): string {
  let items = parseEvidence(text);
  if ("add" in op) items = [...items.filter((i) => i.id !== op.add.id), op.add];
  else if ("remove" in op) items = items.filter((i) => i.id !== op.remove);
  else items = items.map((i) => (i.id === op.note.id ? { ...i, note: op.note.text || undefined } : i));
  return JSON.stringify({ version: 1, items } satisfies EvidenceFile, null, 2) + "\n";
}

/** Same place in the same document for the same target: pinning twice is one pin. */
export function evidenceId(e: Evidence, target: PinnedEvidence["target"]): string {
  const t = `${target.reference ?? ""}|${target.pin ?? ""}|${target.net ?? ""}`;
  return `${e.doc.id}-${e.page}-${Math.round(e.box.x)}-${Math.round(e.box.y)}-${t}`;
}

/** What the user has selected; shared by every view for cross-probing. */
export type Selection =
  | { kind: "net"; name: string }
  /** A part on the board or in the schematic; `pad` when one of its pads was picked. */
  | { kind: "component"; reference: string; pad?: string }
  /** A location on a sheet (an ERC marker) or on the board (sheet "board", a DRC marker). */
  | { kind: "marker"; sheet: string; at: { x: number; y: number }; label: string }
  | null;

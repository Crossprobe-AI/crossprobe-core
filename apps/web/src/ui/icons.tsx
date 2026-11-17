/**
 * Crossprobe's icon set: one stroke style (24 px grid, round 1.75 px strokes,
 * `currentColor`) for both general UI actions and EDA-specific tools
 * (wire, label, junction, no-connect, part…), so they sit together cleanly
 * and follow the light/dark theme. Add an icon by adding an entry to ICONS.
 */
import type { ReactNode } from "react";

const dot = (cx: number, cy: number, r = 1.6) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

const ICONS = {
  // Files & history
  folderOpen: (
    <>
      <path d="M3 18V6a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v2" />
      <path d="M3 18l2.4-6.5a1 1 0 0 1 .9-.5H21l-2.5 6.6a1 1 0 0 1-.9.4H3z" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  // Board drawing & outputs
  outline: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="1" strokeDasharray="3 2.2" />
    </>
  ),
  zone: (
    <>
      <path d="M4 6l7-2 9 4-2 11-12 1z" />
      <path d="M8 16l8-8M7 11l4-4M12 17l5-5" />
    </>
  ),
  power: (
    <>
      <path d="M12 20V9" />
      <path d="M6 9h12" />
      <path d="M12 9l-4-5h8z" />
    </>
  ),
  dimension: (
    <>
      <path d="M4 7v10M20 7v10" />
      <path d="M4 12h16" />
      <path d="M7 9.5L4 12l3 2.5M17 9.5l3 2.5-3 2.5" />
    </>
  ),
  text: (
    <>
      <path d="M5 6V4h14v2" />
      <path d="M12 4v16" />
      <path d="M9 20h6" />
    </>
  ),
  hole: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  fab: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a5.5 5.5 0 0 1 0 11h-3" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H10a5.5 5.5 0 0 0 0 11h3" />
    </>
  ),
  save: (
    <>
      <path d="M5 3h11l5 5v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M8 3v5h7V3" />
      <path d="M8 21v-7h8v7" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V3" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 21h14" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  // The account's storage.
  cloud: (
    <>
      <path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96 6 6 0 0 1 11.5 1.5A3.75 3.75 0 0 1 17.5 18.5H7z" />
    </>
  ),
  // Git: a branch (two commits and a fork), and GitHub as a plain repository mark.
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10M18 9c0 5-12 3-12 8" />
    </>
  ),
  github: (
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
      <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3M9 7h6" />
    </>
  ),

  // Views
  doc: <path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6" />,
  schematic: <path d="M2 12h4l1.5-3.5 3 7 3-7 3 7L18 12h4" />,
  pcb: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1" />
      <path d="M10 7V3M14 7V3M10 21v-4M14 21v-4M7 10H3M7 14H3M21 10h-4M21 14h-4" />
    </>
  ),
  cube: (
    <>
      <path d="M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5z" />
      <path d="M12 21.5V12M20.5 7.25L12 12 3.5 7.25" />
    </>
  ),
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  viewTop: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M12 8v8M8.5 12.5L12 16l3.5-3.5" />
    </>
  ),
  viewBottom: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M12 16V8M8.5 11.5L12 8l3.5 3.5" />
    </>
  ),
  flip: (
    <>
      <path d="M12 3v18" strokeDasharray="2 2.5" />
      <path d="M8.5 7L4 12l4.5 5M15.5 7L20 12l-4.5 5" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),

  // Editing
  edit: (
    <>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" />
      <path d="M14.5 7.5l3 3" />
    </>
  ),
  select: <path d="M5 3.5l13 6.5-5.5 1.8L10.7 17.5z" />,
  spark: (
    <>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </>
  ),
  route: (
    <>
      <path d="M4 19h5l9-9V5" />
      <circle cx="18" cy="5" r="1.8" />
      {dot(4, 19)}
    </>
  ),
  via: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  sync: (
    <>
      <path d="M19 8a7.5 7.5 0 0 0-13.4-1.6M5 4v3h3" />
      <path d="M5 16a7.5 7.5 0 0 0 13.4 1.6M19 20v-3h-3" />
    </>
  ),
  wire: (
    <>
      <path d="M4 18h7V6h9" />
      {dot(4, 18)}
      {dot(20, 6)}
    </>
  ),
  label: (
    <>
      <path d="M3 15h18" />
      <path d="M5 11V7h8l2.5 2-2.5 2z" />
    </>
  ),
  junction: (
    <>
      <path d="M3 12h18M12 3v18" />
      {dot(12, 12, 2.6)}
    </>
  ),
  noConnect: (
    <>
      <path d="M3 12h7" />
      <path d="M13 9l6 6M19 9l-6 6" />
    </>
  ),
  addPart: (
    <>
      <path d="M2 14h4M15 14h4" />
      <rect x="6" y="11" width="9" height="6" rx="0.5" />
      <path d="M19 3v6M16 6h6" />
    </>
  ),
  glabel: (
    <>
      <path d="M3 8h13l4 4-4 4H3z" />
    </>
  ),
  hlabel: (
    <>
      <path d="M3 12h6" />
      <path d="M9 8h7l4 4-4 4H9z" />
    </>
  ),
  sheetPin: (
    <>
      <rect x="9" y="4" width="11" height="16" rx="1" />
      <path d="M3 12h4M7 9.5L9.5 12 7 14.5" />
    </>
  ),
  annotate: (
    <>
      <path d="M4 6h3M5.5 4.5V9M4 9h3" />
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="M4 12.5a1.5 1.5 0 1 1 2.4 1.2L4 16.5h3M4 18h0" />
    </>
  ),
  rotate: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v5h-5" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="1.5" />
      <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
    </>
  ),
  trash: <path d="M4 7h16M9.5 7V4h5v3M6 7l1 13h10l1-13" />,

  // Inspector & navigation
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  // A reusable block of circuit: a frame holding a few connected parts.
  block: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" strokeDasharray="3 2" />
      <path d="M8 12h3M13 12h3M8 12v3M16 12V9" />
      {dot(8, 15.5)}
      {dot(16, 8.5)}
    </>
  ),
  component: (
    <>
      <path d="M2 12h5M17 12h5" />
      <rect x="7" y="9" width="10" height="6" rx="0.5" />
    </>
  ),
  net: (
    <>
      <path d="M6.5 7.5l4 9M17.5 7.5l-4 9M7 6h10" />
      {dot(5.5, 6, 2)}
      {dot(18.5, 6, 2)}
      {dot(12, 18, 2)}
    </>
  ),
  issue: (
    <>
      <path d="M12 3.5L21.5 20h-19z" />
      <path d="M12 10v4.5" />
      {dot(12, 17.2, 1.1)}
    </>
  ),
  sheet: (
    <>
      <path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  bus: <path d="M3 8h18M3 12h18M3 16h18" />,
  busEntry: <path d="M4 18h6l4-4M14 14V4M20 4v16" />,
  textBox: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1" />
      <path d="M8 9h8M12 9v7" />
    </>
  ),
  drawLine: <path d="M4 18l6-10 5 6 5-9" />,
  drawRect: <rect x="4" y="6" width="16" height="12" />,
  drawCircle: <circle cx="12" cy="12" r="8" />,
  drawArc: <path d="M4 18a10 10 0 0 1 16 0" />,
  table: <path d="M4 5h16v14H4zM4 10h16M4 15h16M10 5v14" />,
  chevronRight: <path d="M9 5l7 7-7 7" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, title, className }: { name: IconName; size?: number; title?: string; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      {ICONS[name]}
    </svg>
  );
}

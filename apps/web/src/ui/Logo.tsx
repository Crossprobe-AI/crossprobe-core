/**
 * The Crossprobe mark: two traces with 45° bends crossing at a probe point (a via
 * ringed in highlighter yellow). The colours are the brand's
 * and are the same in both themes.
 */
export function Logo({ className, size = 22 }: { className?: string; size?: number }) {
  return (
    <svg className={className} viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect width="64" height="64" rx="10" fill="#0e3b2d" />
      <g fill="none" stroke="#f4f7f5" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20H20L44 44H52" />
        <path d="M12 44H20L44 20H52" />
      </g>
      <g fill="#f4f7f5">
        <circle cx="11" cy="20" r="4.5" />
        <circle cx="11" cy="44" r="4.5" />
        <circle cx="53" cy="20" r="4.5" />
        <circle cx="53" cy="44" r="4.5" />
      </g>
      <circle cx="32" cy="32" r="7" fill="#0e3b2d" stroke="#ffd84a" strokeWidth="4.5" />
    </svg>
  );
}

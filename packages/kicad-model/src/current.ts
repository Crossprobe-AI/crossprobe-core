/**
 * Current a track can carry (IPC-2221's chart, as KiCad's calculator uses it):
 * I = k · ΔT^0.44 · A^0.725, A the cross-section in mil², k 0.048 on outer layers and
 * 0.024 on inner ones.
 */
export function trackCurrent(width: number, copper = 0.035, rise = 10, inner = false): number {
  const mil = 1 / 0.0254;
  const area = width * mil * (copper * mil);
  return (inner ? 0.024 : 0.048) * Math.pow(rise, 0.44) * Math.pow(area, 0.725);
}

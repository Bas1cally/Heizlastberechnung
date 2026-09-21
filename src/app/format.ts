/** Format a probability without rounding 0.9996 up to "1.00". */
export function formatProbability(p: number): string {
  if (!Number.isFinite(p)) return String(p);
  if (p >= 1) return "1";
  if (p <= 0) return "0";
  if (p > 0.999) return ">0.999";
  if (p < 0.001) return "<0.001";
  return p.toFixed(3);
}

// V-534.AF — shared formatting helpers for the crypto-orders view
// family. Previously each view (history, detail, checkout flow, receipt)
// declared its own local `formatCents` / `formatRelative` helpers; this
// module consolidates them.

export function formatCents(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

/**
 * "5m ago" / "2h ago" / "3d ago" relative formatting against `Date.now()`.
 * Optional `now` override is for tests; production callers pass nothing.
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const ago = now - then;
  if (ago < 60_000) return 'just now';
  if (ago < 60 * 60_000) return `${Math.floor(ago / 60_000).toString()}m ago`;
  if (ago < 24 * 60 * 60_000) return `${Math.floor(ago / (60 * 60_000)).toString()}h ago`;
  return `${Math.floor(ago / (24 * 60 * 60_000)).toString()}d ago`;
}

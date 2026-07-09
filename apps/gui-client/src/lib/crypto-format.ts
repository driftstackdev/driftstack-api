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

/**
 * Friendly display names for the server-side product slugs. Raw slugs
 * ("solo_manual", "api_starter") leaked into the checkout picker,
 * orders history, summary card, and receipt — customers shouldn't be
 * reading internal identifiers. Unknown slugs fall back to the raw
 * value so a new server-side tier degrades gracefully rather than
 * rendering blank.
 */
export const PRODUCT_LABEL: Record<string, string> = {
  solo_manual: 'Solo (manual)',
  team_manual: 'Team (manual)',
  agency_manual: 'Agency (manual)',
  api_starter: 'API Starter',
  api_builder: 'API Builder',
  api_scale: 'API Scale',
};

export function formatProduct(slug: string): string {
  return PRODUCT_LABEL[slug] ?? slug;
}

/**
 * Human-readable absolute timestamp for raw ISO strings surfaced in
 * the crypto views (order created/updated/paid/issued, event
 * timeline). Renders in the viewer's locale; falls back to the raw
 * value if the string isn't a parseable date.
 */
export function formatTimestamp(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

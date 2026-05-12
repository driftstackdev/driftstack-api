// W192 — single source of truth for the customer-dashboard's API base
// URL. Mirrors the server-side V-079.B / W190 pattern: one helper, one
// rule, prod build refuses to ship without the env var set.
//
// Before this lived in 20 .astro files as the inline expression
//   `const apiBaseUrl = import.meta.env.PUBLIC_API_BASE_URL ?? 'http://localhost:3000';`
// which made the localhost fallback silent in prod — a single missed
// env var on deploy would point every customer browser at
// `http://localhost:3000` and the dashboard would 404 every API call.
// Same bug class as the 2026-05-12 verify-email link incident, just
// scoped to the dashboard rather than email transport.
//
// The helper:
//   - returns `PUBLIC_API_BASE_URL` when set (trailing slash stripped)
//   - in dev mode (`import.meta.env.DEV`) falls back to
//     `http://localhost:3000` to keep `npm run dev` zero-config
//   - in prod mode throws at evaluation time when the env var is
//     unset, which fails the static-prerender pass during build —
//     deploys don't ship a broken bundle.

const DEV_FALLBACK = 'http://localhost:3000';

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

export function resolveApiBaseUrl(): string {
  const raw = import.meta.env.PUBLIC_API_BASE_URL;
  if (typeof raw === 'string' && raw.length > 0) {
    return stripTrailingSlash(raw);
  }
  if (import.meta.env.DEV) {
    return DEV_FALLBACK;
  }
  throw new Error(
    'customer-dashboard: PUBLIC_API_BASE_URL must be set for production builds. ' +
      'Set it to the public API origin (e.g. https://api.driftstack.dev) before running `astro build`.',
  );
}

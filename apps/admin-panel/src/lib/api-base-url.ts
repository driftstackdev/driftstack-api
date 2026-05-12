// W193 — single source of truth for the admin-panel's API base URL.
// Mirrors `apps/customer-dashboard/src/lib/api-base-url.ts` (W192) so
// the same prod-fail-fast guarantee applies to admin pages.
//
// Before this lived in 10 .astro files as the inline expression
//   `const apiBaseUrl = import.meta.env.PUBLIC_API_BASE_URL ?? 'http://localhost:3000';`
// which would have silently broken every admin page in production if
// the env var was missed at deploy — same bug class as the
// 2026-05-12 verify-email link incident, applied to the admin
// surface. Worse, actually: an admin staring at a "no accounts found"
// page might assume the system is empty rather than realising the
// deployment is misconfigured.

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
    'admin-panel: PUBLIC_API_BASE_URL must be set for production builds. ' +
      'Set it to the public API origin (e.g. https://api.driftstack.dev) before running `astro build`.',
  );
}

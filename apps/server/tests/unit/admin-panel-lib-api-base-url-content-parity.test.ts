// W462.A — drift guard for apps/admin-panel/src/lib/api-base-url.ts.
// W193 single-source-of-truth admin API base URL. Drift here
// either drops the prod-fail-fast throw (a missed env var at deploy
// silently points every admin browser at localhost:3000 and admins
// see "no accounts found" instead of recognising a misconfigured
// build) or relaxes the trailing-slash strip (downstream template-
// literal URLs end up with `//` and Safari mishandles some paths).
//
//   • W193 framing pinned + 'Mirrors apps/customer-dashboard/src/
//     lib/api-base-url.ts (W192) so the same prod-fail-fast
//     guarantee applies to admin pages.'
//   • Before-state framing pinned: '10 .astro files as the inline
//     expression `const apiBaseUrl = import.meta.env.
//     PUBLIC_API_BASE_URL ?? 'http://localhost:3000';'`
//   • 2026-05-12 incident framing + 'Worse, actually: an admin
//     staring at a "no accounts found" page might assume the
//     system is empty rather than realising the deployment is
//     misconfigured.'
//   • DEV_FALLBACK = 'http://localhost:3000'.
//   • stripTrailingSlash: replace(/\/+$/, '').
//   • resolveApiBaseUrl 3-branch: (1) raw is non-empty string →
//     strip slash; (2) import.meta.env.DEV → DEV_FALLBACK;
//     (3) throw with 'admin-panel: PUBLIC_API_BASE_URL must be
//     set for production builds.' + Astro build hint.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/lib/api-base-url.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W462.A apps/admin-panel/src/lib/api-base-url.ts content parity', () => {
  const body = read(LIB);

  it("W193 framing pinned: 'W193 — single source of truth for the admin-panel's API base URL. Mirrors apps/customer-dashboard/src/lib/api-base-url.ts (W192) so the same prod-fail-fast guarantee applies to admin pages.'", () => {
    expect(body).toMatch(
      /\/\/ W193 — single source of truth for the admin-panel's API base URL\.\s*\/\/ Mirrors `apps\/customer-dashboard\/src\/lib\/api-base-url\.ts` \(W192\) so\s*\/\/ the same prod-fail-fast guarantee applies to admin pages\./,
    );
  });

  it("Before-state framing pinned: '10 .astro files as the inline expression `const apiBaseUrl = import.meta.env.PUBLIC_API_BASE_URL ?? 'http://localhost:3000';` which would have silently broken every admin page in production if the env var was missed at deploy'", () => {
    expect(body).toMatch(
      /\/\/ Before this lived in 10 \.astro files as the inline expression\s*\/\/\s*`const apiBaseUrl = import\.meta\.env\.PUBLIC_API_BASE_URL \?\? 'http:\/\/localhost:3000';`\s*\/\/ which would have silently broken every admin page in production if\s*\/\/ the env var was missed at deploy/,
    );
  });

  it("2026-05-12 verify-email incident framing pinned: 'same bug class as the 2026-05-12 verify-email link incident, applied to the admin surface' + 'Worse, actually: an admin staring at a \"no accounts found\" page might assume the system is empty rather than realising the deployment is misconfigured.'", () => {
    expect(body).toMatch(
      /same bug class as the\s*\/\/ 2026-05-12 verify-email link incident, applied to the admin\s*\/\/ surface\. Worse, actually: an admin staring at a "no accounts found"\s*\/\/ page might assume the system is empty rather than realising the\s*\/\/ deployment is misconfigured\./,
    );
  });

  it("DEV_FALLBACK constant pinned to 'http://localhost:3000' + stripTrailingSlash: replace(/\\/+$/, '')", () => {
    expect(body).toMatch(/const DEV_FALLBACK = 'http:\/\/localhost:3000';/);
    expect(body).toMatch(
      /function stripTrailingSlash\(s: string\): string \{\s*return s\.replace\(\/\\\/\+\$\/, ''\);\s*\}/,
    );
  });

  it('resolveApiBaseUrl 3-branch: (1) typeof raw === "string" && length>0 → stripTrailingSlash(raw); (2) import.meta.env.DEV → DEV_FALLBACK; (3) throw with admin-panel prefix + production-builds hint + `astro build` mention', () => {
    expect(body).toMatch(
      /export function resolveApiBaseUrl\(\): string \{\s*const raw = import\.meta\.env\.PUBLIC_API_BASE_URL;\s*if \(typeof raw === 'string' && raw\.length > 0\) \{\s*return stripTrailingSlash\(raw\);\s*\}\s*if \(import\.meta\.env\.DEV\) \{\s*return DEV_FALLBACK;\s*\}\s*throw new Error\(\s*'admin-panel: PUBLIC_API_BASE_URL must be set for production builds\. ' \+\s*'Set it to the public API origin \(e\.g\. https:\/\/api\.driftstack\.dev\) before running `astro build`\.',\s*\);\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

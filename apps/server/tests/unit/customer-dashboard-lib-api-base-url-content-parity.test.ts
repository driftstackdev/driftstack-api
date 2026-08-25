// W462.B — drift guard for apps/customer-dashboard/src/lib/api-base-url.ts.
// W192 single-source-of-truth customer-dashboard API base URL.
// Drift here either drops the dev-mode `import.meta.env.DEV`
// fallback (npm run dev breaks zero-config) or relaxes the prod
// fail-fast throw (a missed env var on deploy points every customer
// browser at localhost:3000 and the dashboard 404s every API call).
//
//   • W192 framing pinned + 'Mirrors the server-side V-079.B / W190
//     pattern: one helper, one rule, prod build refuses to ship
//     without the env var set.'
//   • Before-state framing pinned: '20 .astro files as the inline
//     expression PUBLIC_API_BASE_URL ?? http://localhost:3000;' +
//     'which made the localhost fallback silent in prod — a single
//     missed env var on deploy would point every customer browser
//     at http://localhost:3000 and the dashboard would 404 every
//     API call.'
//   • 2026-05-12 incident framing: 'Same bug class as the
//     2026-05-12 verify-email link incident, just scoped to the
//     dashboard rather than email transport.'
//   • Helper-contract 3-bullet framing pinned (returns env var
//     when set with trailing slash stripped + dev fallback +
//     prod fail-fast at evaluation time — fails static-prerender
//     pass during build).
//   • DEV_FALLBACK = 'http://localhost:3000'.
//   • stripTrailingSlash: replace(/\/+$/, '').
//   • resolveApiBaseUrl 3-branch: raw → strip; DEV → DEV_FALLBACK;
//     throw 'customer-dashboard: PUBLIC_API_BASE_URL must be set for
//     production builds.' + `astro build` hint.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/lib/api-base-url.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W462.B apps/customer-dashboard/src/lib/api-base-url.ts content parity', () => {
  const body = read(LIB);

  it("W192 framing pinned: 'W192 — single source of truth for the customer-dashboard's API base URL. Mirrors the server-side V-079.B / W190 pattern: one helper, one rule, prod build refuses to ship without the env var set.'", () => {
    expect(body).toMatch(
      /\/\/ W192 — single source of truth for the customer-dashboard's API base\s*\/\/ URL\. Mirrors the server-side V-079\.B \/ W190 pattern: one helper, one\s*\/\/ rule, prod build refuses to ship without the env var set\./,
    );
  });

  it("Before-state framing pinned: '20 .astro files as the inline expression `const apiBaseUrl = import.meta.env.PUBLIC_API_BASE_URL ?? 'http://localhost:3000';` which made the localhost fallback silent in prod — a single missed env var on deploy would point every customer browser at http://localhost:3000 and the dashboard would 404 every API call.'", () => {
    expect(body).toMatch(
      /\/\/ Before this lived in 20 \.astro files as the inline expression\s*\/\/\s*`const apiBaseUrl = import\.meta\.env\.PUBLIC_API_BASE_URL \?\? 'http:\/\/localhost:3000';`\s*\/\/ which made the localhost fallback silent in prod — a single missed\s*\/\/ env var on deploy would point every customer browser at\s*\/\/ `http:\/\/localhost:3000` and the dashboard would 404 every API call\./,
    );
  });

  it("2026-05-12 incident framing pinned: 'Same bug class as the 2026-05-12 verify-email link incident, just scoped to the dashboard rather than email transport.'", () => {
    expect(body).toMatch(
      /\/\/ Same bug class as the 2026-05-12 verify-email link incident, just\s*\/\/ scoped to the dashboard rather than email transport\./,
    );
  });

  it("Helper-contract 3-bullet framing pinned: returns PUBLIC_API_BASE_URL with trailing slash stripped + dev fallback to localhost:3000 'to keep npm run dev zero-config' + prod throws at evaluation time 'fails the static-prerender pass during build — deploys don't ship a broken bundle.'", () => {
    expect(body).toMatch(
      /\/\/ The helper:\s*\/\/\s+- returns `PUBLIC_API_BASE_URL` when set \(trailing slash stripped\)\s*\/\/\s+- in dev mode \(`import\.meta\.env\.DEV`\) falls back to\s*\/\/\s+`http:\/\/localhost:3000` to keep `npm run dev` zero-config\s*\/\/\s+- in prod mode throws at evaluation time when the env var is\s*\/\/\s+unset, which fails the static-prerender pass during build —\s*\/\/\s+deploys don't ship a broken bundle\./,
    );
  });

  it("DEV_FALLBACK constant pinned to 'http://localhost:3000' + stripTrailingSlash: replace(/\\/+$/, '')", () => {
    expect(body).toMatch(/const DEV_FALLBACK = 'http:\/\/localhost:3000';/);
    expect(body).toMatch(
      /function stripTrailingSlash\(s: string\): string \{\s*return s\.replace\(\/\\\/\+\$\/, ''\);\s*\}/,
    );
  });

  it('resolveApiBaseUrl 3-branch: (1) typeof raw === "string" && length>0 → stripTrailingSlash(raw); (2) import.meta.env.DEV → DEV_FALLBACK; (3) throw with customer-dashboard prefix + production-builds hint + `astro build` mention', () => {
    expect(body).toMatch(
      /export function resolveApiBaseUrl\(\): string \{\s*const raw = import\.meta\.env\.PUBLIC_API_BASE_URL;\s*if \(typeof raw === 'string' && raw\.length > 0\) \{\s*return stripTrailingSlash\(raw\);\s*\}\s*if \(import\.meta\.env\.DEV\) \{\s*return DEV_FALLBACK;\s*\}\s*throw new Error\(\s*'customer-dashboard: PUBLIC_API_BASE_URL must be set for production builds\. ' \+\s*'Set it to the public API origin \(e\.g\. https:\/\/api\.driftstack\.dev\) before running `astro build`\.',\s*\);\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

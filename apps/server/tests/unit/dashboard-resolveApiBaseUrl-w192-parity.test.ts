// W742 — customer-dashboard resolveApiBaseUrl W192 helper parity.
// Sixty-eighth in the cross-SDK drift-guard series.
//
// Pins the single source of truth for the customer-dashboard's API
// base URL. The helper is consumed by every dashboard page that
// makes an authenticated API call (W735-W741 all use it). Drift
// here would re-introduce the same class of bug as the 2026-05-12
// verify-email link incident — silent localhost fallback in prod.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const HELPER = resolve(REPO_ROOT, 'apps/customer-dashboard/src/lib/api-base-url.ts');

describe('W742 dashboard resolveApiBaseUrl W192 helper parity', () => {
  it('api-base-url.ts helper file exists', () => {
    expect(existsSync(HELPER)).toBe(true);
  });

  it('CRITICAL W192 anchor + V-079.B / W190 mirror framing pinned. The "Mirrors the server-side V-079.B / W190 pattern: one helper, one rule, prod build refuses to ship without the env var set" wording threads the cross-app pattern.', () => {
    const h = read(HELPER);

    expect(h).toMatch(/W192 — single source of truth for the customer-dashboard's API base/);
    expect(h).toMatch(/URL\. Mirrors the server-side V-079\.B \/ W190 pattern: one helper, one/);
    expect(h).toMatch(/rule, prod build refuses to ship without the env var set/);
  });

  it("CRITICAL pre-helper bug-class framing pinned. The doc-block explains why this helper exists — `import.meta.env.PUBLIC_API_BASE_URL ?? 'http://localhost:3000'` inline in 20 .astro files would silently fallback to localhost on a missed env var. Drift to dropping the framing would lose the institutional why.", () => {
    const h = read(HELPER);

    expect(h).toMatch(/Before this lived in 20 \.astro files as the inline expression/);
    expect(h).toMatch(
      /`const apiBaseUrl = import\.meta\.env\.PUBLIC_API_BASE_URL \?\? 'http:\/\/localhost:3000';`/,
    );
    expect(h).toMatch(/which made the localhost fallback silent in prod — a single missed/);
    expect(h).toMatch(/env var on deploy would point every customer browser at/);
  });

  it('CRITICAL 2026-05-12 verify-email link incident cross-reference pinned. The wording — "Same bug class as the 2026-05-12 verify-email link incident, just scoped to the dashboard rather than email transport" — anchors the institutional learning to the V-079.C class of regression W734 + W735 + W736 + W737 + W739 all guard against.', () => {
    const h = read(HELPER);
    expect(h).toMatch(
      /Same bug class as the 2026-05-12 verify-email link incident, just\s*\n\/\/\s+scoped to the dashboard rather than email transport/,
    );
  });

  it('CRITICAL 3-rule contract documented — (1) PUBLIC_API_BASE_URL with trailing-slash strip when set, (2) dev localhost fallback, (3) prod-throw-on-unset (fails the build).', () => {
    const h = read(HELPER);

    expect(h).toMatch(/returns `PUBLIC_API_BASE_URL` when set \(trailing slash stripped\)/);
    expect(h).toMatch(
      /in dev mode \(`import\.meta\.env\.DEV`\) falls back to\s*\n\/\/\s+`http:\/\/localhost:3000` to keep `npm run dev` zero-config/,
    );
    expect(h).toMatch(
      /in prod mode throws at evaluation time when the env var is\s*\n\/\/\s+unset, which fails the static-prerender pass during build —\s*\n\/\/\s+deploys don't ship a broken bundle/,
    );
  });

  it("CRITICAL DEV_FALLBACK = 'http://localhost:3000' (NOT 5173). The :3000 port matches the local API server (Fastify); :5173 is the dashboard. Drift to dashboard-port would create a self-loop where the dashboard calls itself.", () => {
    const h = read(HELPER);
    expect(h).toMatch(/const DEV_FALLBACK = 'http:\/\/localhost:3000'/);
  });

  it('CRITICAL stripTrailingSlash() helper pinned with regex /\\/+$/. Drift to a different regex would let `PUBLIC_API_BASE_URL=https://api.driftstack.dev/` produce `https://api.driftstack.dev//v1/...` double-slash bugs.', () => {
    const h = read(HELPER);

    expect(h).toMatch(
      /function stripTrailingSlash\(s: string\): string \{\s*\n\s+return s\.replace\(\/\\\/\+\$\/, ''\);\s*\n\}/,
    );
  });

  it('CRITICAL resolveApiBaseUrl() signature pinned — `export function resolveApiBaseUrl(): string`. Drift to making it a const-returning-a-promise or differently-shaped would break the 20+ .astro pages that import it.', () => {
    const h = read(HELPER);

    expect(h).toMatch(/export function resolveApiBaseUrl\(\): string \{/);
  });

  it("CRITICAL PUBLIC_API_BASE_URL read pattern pinned — typeof guard + non-empty-string check. Drift to truthy-only would let `PUBLIC_API_BASE_URL=' '` (whitespace) slip through; the explicit `length > 0` after type-check rejects empty strings.", () => {
    const h = read(HELPER);

    expect(h).toMatch(
      /const raw = import\.meta\.env\.PUBLIC_API_BASE_URL;\s*\n\s+if \(typeof raw === 'string' && raw\.length > 0\) \{\s*\n\s+return stripTrailingSlash\(raw\);/,
    );
  });

  it('CRITICAL dev-mode fallback gate pinned — `import.meta.env.DEV`. The Vite-built-in DEV flag is what threads npm-run-dev vs npm-run-build mode; drift to a different gate would either always-fallback (production breakage) or never-fallback (dev-time breakage).', () => {
    const h = read(HELPER);

    expect(h).toMatch(/if \(import\.meta\.env\.DEV\) \{\s*\n\s+return DEV_FALLBACK;\s*\n\s+\}/);
  });

  it('CRITICAL production-throw error-message pinned with API-origin example. The error tells the operator EXACTLY what to set (e.g. `https://api.driftstack.dev`) + WHEN (`before running astro build`). Drift to a vague message would force operators to grep the codebase to figure out the fix.', () => {
    const h = read(HELPER);

    expect(h).toMatch(
      /throw new Error\(\s*\n\s+'customer-dashboard: PUBLIC_API_BASE_URL must be set for production builds\. ' \+\s*\n\s+'Set it to the public API origin \(e\.g\. https:\/\/api\.driftstack\.dev\) before running `astro build`\.'/,
    );
  });

  it('CRITICAL helper exports only resolveApiBaseUrl (NOT stripTrailingSlash + NOT DEV_FALLBACK). Drift to exporting helpers would let .astro pages reach past the abstraction + skip the prod-throw guard.', () => {
    const h = read(HELPER);

    // Count the export statements.
    const exports = h.match(/^export /gm) ?? [];
    expect(exports.length, 'export count').toBe(1);
  });

  it('CRITICAL consumed by 20+ .astro files. Cross-app parity — the W735-W741 pages (verify-email, reset-password, magic-link, signup, login, cli/authorize, forgot-password, select-tier) MUST import resolveApiBaseUrl from this helper. (first-session removed 2026-07-02 with the account-portal IA.)', () => {
    const consumers = [
      'apps/customer-dashboard/src/pages/verify-email.astro',
      'apps/customer-dashboard/src/pages/reset-password.astro',
      'apps/customer-dashboard/src/pages/auth/magic-link.astro',
      'apps/customer-dashboard/src/pages/signup.astro',
      'apps/customer-dashboard/src/pages/login.astro',
      'apps/customer-dashboard/src/pages/cli/authorize.astro',
      'apps/customer-dashboard/src/pages/forgot-password.astro',
      'apps/customer-dashboard/src/pages/select-tier.astro',
    ];

    for (const path of consumers) {
      const full = resolve(REPO_ROOT, path);
      expect(existsSync(full), `consumer page ${path} exists`).toBe(true);

      const content = read(full);
      // Each consumer imports resolveApiBaseUrl + calls it.
      expect(content, `${path} imports resolveApiBaseUrl`).toMatch(
        /import \{ resolveApiBaseUrl \} from '\.\.(?:\/\.\.)?\/lib\/api-base-url'/,
      );
      expect(content, `${path} calls resolveApiBaseUrl()`).toMatch(
        /const apiBaseUrl = resolveApiBaseUrl\(\)/,
      );
    }
  });

  it("CRITICAL no .astro file in the dashboard bypasses the helper with inline PUBLIC_API_BASE_URL ?? 'http://localhost:...'. Drift to inlining would re-introduce the W192-class bug.", () => {
    const consumers = [
      'apps/customer-dashboard/src/pages/verify-email.astro',
      'apps/customer-dashboard/src/pages/reset-password.astro',
      'apps/customer-dashboard/src/pages/auth/magic-link.astro',
      'apps/customer-dashboard/src/pages/signup.astro',
      'apps/customer-dashboard/src/pages/login.astro',
      'apps/customer-dashboard/src/pages/cli/authorize.astro',
      'apps/customer-dashboard/src/pages/forgot-password.astro',
      'apps/customer-dashboard/src/pages/select-tier.astro',
    ];

    for (const path of consumers) {
      const content = read(resolve(REPO_ROOT, path));
      // No inline `PUBLIC_API_BASE_URL ?? 'http://localhost'` pattern.
      expect(content, `${path} must NOT inline the env-var-with-fallback`).not.toMatch(
        /import\.meta\.env\.PUBLIC_API_BASE_URL\s*\?\?\s*'http/,
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/dashboard-resolveApiBaseUrl-w192-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

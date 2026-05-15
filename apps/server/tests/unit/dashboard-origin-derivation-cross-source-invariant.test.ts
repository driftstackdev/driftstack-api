// W885 — V-079.B + V-079.C DASHBOARD_ORIGIN auth-flow URL
// derivation cross-source invariant. Two-hundred-eleventh in the
// drift-guard series. Pins the V-079 derive-auth-flow contract:
//
//   3-tier resolution per URL:
//     1. Explicit per-URL env var (AUTH_VERIFY_EMAIL_URL etc.).
//     2. DASHBOARD_ORIGIN + the conventional path.
//     3. Dev-friendly localhost default (dev-only fallback).
//
//   3 derived URLs:
//     - verifyEmail   ← DASHBOARD_ORIGIN + '/verify-email'
//     - magicLink     ← DASHBOARD_ORIGIN + '/auth/magic-link'
//     - passwordReset ← DASHBOARD_ORIGIN + '/reset-password'
//
//   Production-mode guard:
//     - If NODE_ENV=production AND any URL resolves to a localhost,
//       boot REFUSES with explicit error.
//
//   V-079.C — paths match customer-dashboard's actual file routes;
//     the previous `/auth/<flow>` paths landed on 404s when Postmark
//     approval landed 2026-05-12.
//
// stays in lockstep across:
//   - apps/server/src/lib/config.ts deriveAuthFlowUrls function.
//   - apps/customer-dashboard/src/pages/verify-email.astro etc.
//     (actual file-based routes).
//
// Drift would silently break:
//   * Customer email-verify links pointing at 404 (the V-079.C bug).
//   * Production deploy without DASHBOARD_ORIGIN booting silently
//     with localhost URLs in emails.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W885 DASHBOARD_ORIGIN derive-auth-flow cross-source invariant', () => {
  // ─── V-079.B anchor + 3-tier resolution ──────────────────────

  it("CRITICAL apps/server/src/lib/config.ts has V-079.B anchor for deriveAuthFlowUrls function. The 'derive the three auth-flow URLs from a single DASHBOARD_ORIGIN env var' framing pins the single-source-of-truth contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/V-079\.B — derive the three auth-flow URLs from a single/);
    expect(p).toMatch(/`DASHBOARD_ORIGIN` env var when the per-URL overrides aren't set/);
  });

  it("CRITICAL deriveAuthFlowUrls comment pins the 3-tier resolution order — '1. explicit per-URL env var; 2. DASHBOARD_ORIGIN + conventional path; 3. dev-friendly localhost default'. The 3-tier order is the documentation of precedence.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/1\. explicit per-URL env var \(AUTH_VERIFY_EMAIL_URL etc\.\)/);
    expect(p).toMatch(/2\. DASHBOARD_ORIGIN \+ the conventional path/);
    expect(p).toMatch(/3\. dev-friendly localhost default \(final fallback, dev-only\)/);
  });

  // ─── 3 derived URLs ──────────────────────────────────────────

  it("CRITICAL deriveAuthFlowUrls derives 3 URLs: verifyEmail ← '/verify-email' + magicLink ← '/auth/magic-link' + passwordReset ← '/reset-password'. The 3-URL set matches the 3 email-input auth flows.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(
      /verifyEmail: env\.AUTH_VERIFY_EMAIL_URL \?\? fromOrigin\('\/verify-email'\)/,
    );
    expect(p).toMatch(
      /magicLink: env\.AUTH_MAGIC_LINK_URL \?\? fromOrigin\('\/auth\/magic-link'\)/,
    );
    expect(p).toMatch(
      /passwordReset: env\.AUTH_PASSWORD_RESET_URL \?\? fromOrigin\('\/reset-password'\)/,
    );
  });

  // ─── V-079.C path-correction framing ─────────────────────────

  it("CRITICAL V-079.C path-correction framing pinned — 'paths match the customer-dashboard's actual file-based routes' + '`/auth/<flow>` paths landed on 404s' + 'bug surfaced in a real customer's verify-email when Postmark approval landed (2026-05-12)'. The narrative explains why the paths are what they are.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/V-079\.C — paths match the customer-dashboard's actual file-based/);
    expect(p).toMatch(/routes \(`\/verify-email`, `\/reset-password`\)\. The previous/);
    expect(p).toMatch(/`\/auth\/<flow>` paths landed on 404s because no such pages/);
    expect(p).toMatch(
      /bug surfaced in a real customer's verify-email\s*\n\s*\/\/\s*when Postmark approval landed \(2026-05-12\)/,
    );
  });

  // ─── Customer-dashboard files exist at the derived paths ──────

  it("CRITICAL apps/customer-dashboard/src/pages/verify-email.astro EXISTS — the path DASHBOARD_ORIGIN + '/verify-email' must resolve to a real file. Drift to deleting verify-email.astro would break the V-079.C fix.", () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/verify-email.astro')),
      'apps/customer-dashboard/src/pages/verify-email.astro must exist',
    ).toBe(true);
  });

  it("CRITICAL apps/customer-dashboard/src/pages/reset-password.astro EXISTS — the path DASHBOARD_ORIGIN + '/reset-password' must resolve to a real file.", () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/reset-password.astro')),
      'apps/customer-dashboard/src/pages/reset-password.astro must exist',
    ).toBe(true);
  });

  // ─── Production-mode localhost-reject guard ──────────────────

  it("CRITICAL deriveAuthFlowUrls has a production-mode boot-time guard — 'if (env.NODE_ENV === 'production') { for each URL, if /localhost/ test passes, throw' refuses to start a deploy that would emit broken-link emails.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/if \(env\.NODE_ENV === 'production'\)/);
    expect(p).toMatch(/if \(value !== undefined && \/\\blocalhost\\b\/\.test\(value\)\)/);
    expect(p).toMatch(/Refusing to boot: \$\{name\} resolves to a localhost URL/);
  });

  it('CRITICAL production-mode guard checks 4 env vars — DASHBOARD_ORIGIN + the 3 derived URLs. The 4-var sweep ensures the localhost check covers BOTH the source-of-truth + the derived URLs.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/DASHBOARD_ORIGIN: env\.DASHBOARD_ORIGIN,/);
    expect(p).toMatch(/AUTH_VERIFY_EMAIL_URL: resolved\.verifyEmail,/);
    expect(p).toMatch(/AUTH_MAGIC_LINK_URL: resolved\.magicLink,/);
    expect(p).toMatch(/AUTH_PASSWORD_RESET_URL: resolved\.passwordReset,/);
  });

  // ─── Trailing-slash normalization ────────────────────────────

  it("CRITICAL deriveAuthFlowUrls strips trailing slashes from DASHBOARD_ORIGIN — 'env.DASHBOARD_ORIGIN?.replace(/\\/+$/, '')'. The strip lets consumers safely template-literal `${dashboardOrigin}/path` without double-slash bugs.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/const origin = env\.DASHBOARD_ORIGIN\?\.replace\(\/\\\/\+\$\/, ''\);/);
  });

  // ─── Postmark-approval 2026-05-12 date pinning ───────────────

  it("CRITICAL the V-079.C narrative pins '2026-05-12' — Postmark approval date when V-079.C bug surfaced. The date provides time-anchored provenance for the path-correction fix.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/2026-05-12/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/dashboard-origin-derivation-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

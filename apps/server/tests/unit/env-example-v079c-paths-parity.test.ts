// W734 — .env.example V-079.C auth-flow path parity.
//
// Pins .env.example to the V-079.C canonical paths (/verify-email +
// /auth/magic-link + /reset-password). The 2026-05-12 customer
// incident landed because a real customer received a broken email
// with `/auth/verify-email` — a path that 404s on the customer
// dashboard. The .env.example was the most likely source of stale
// config copy-paste; this test pins it.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const ENV_EXAMPLE = resolve(REPO_ROOT, '.env.example');

describe('W734 .env.example V-079.C path parity', () => {
  it('.env.example exists', () => {
    expect(existsSync(ENV_EXAMPLE)).toBe(true);
  });

  it('CRITICAL .env.example AUTH_VERIFY_EMAIL_URL example uses /verify-email path (NOT /auth/verify-email). The legacy /auth/<flow> paths 404 on the customer dashboard — the 2026-05-12 incident landed precisely because of stale copy-paste from .env.example.', () => {
    const e = read(ENV_EXAMPLE);

    // Must include the correct path as a commented example.
    expect(e).toMatch(/# AUTH_VERIFY_EMAIL_URL=http:\/\/localhost:5173\/verify-email/);

    // Must NOT include the legacy broken path as an active example
    // (it would mislead operators copy-pasting it into a real .env).
    expect(e).not.toMatch(/^AUTH_VERIFY_EMAIL_URL=.*\/auth\/verify-email/m);

    // The doc-text MAY reference the legacy path for historical
    // context but only as a "previous" / "broken" call-out.
    if (/\/auth\/verify-email/.test(e)) {
      expect(e).toMatch(/previous .{0,300}\/auth\/<flow>|legacy|history|404/i);
    }
  });

  it('CRITICAL .env.example AUTH_PASSWORD_RESET_URL example uses /reset-password path (NOT /auth/password-reset). Same V-079.C fix applies.', () => {
    const e = read(ENV_EXAMPLE);

    expect(e).toMatch(/# AUTH_PASSWORD_RESET_URL=http:\/\/localhost:5173\/reset-password/);
    expect(e).not.toMatch(/^AUTH_PASSWORD_RESET_URL=.*\/auth\/password-reset/m);
  });

  it("CRITICAL .env.example AUTH_MAGIC_LINK_URL example uses /auth/magic-link path. (Note: magic-link IS at /auth/magic-link per V-079.C — the customer-dashboard's actual route. Only verify-email + password-reset moved off the /auth/ prefix.)", () => {
    const e = read(ENV_EXAMPLE);
    expect(e).toMatch(/# AUTH_MAGIC_LINK_URL=http:\/\/localhost:5173\/auth\/magic-link/);
  });

  it('CRITICAL V-079.C anchor + 2026-05-12 incident provenance pinned in .env.example. The dated incident note is what tells operators why the paths matter.', () => {
    const e = read(ENV_EXAMPLE);
    expect(e).toMatch(/V-079\.C/);
    expect(e).toMatch(/2026-05-12/);
  });

  it('CRITICAL .env.example tells operators to PREFER DASHBOARD_ORIGIN over per-URL overrides. The "leave these UNSET and set DASHBOARD_ORIGIN instead" framing guides operators to the single-source-of-truth pattern (matches W715 + deriveAuthFlowUrls).', () => {
    const e = read(ENV_EXAMPLE);
    expect(e).toMatch(/leave these UNSET.{0,80}DASHBOARD_ORIGIN/i);
    expect(e).toMatch(/deriveAuthFlowUrls/);
  });

  it('CRITICAL .env.example has DASHBOARD_ORIGIN=http://localhost:5173 (dev default). Drift to dropping would force every operator to set it before first signup works.', () => {
    const e = read(ENV_EXAMPLE);
    expect(e).toMatch(/^DASHBOARD_ORIGIN=http:\/\/localhost:5173$/m);
  });

  it('CRITICAL cross-file consistency — .env.example example paths match config.ts deriveAuthFlowUrls() defaults. Both files MUST use the same paths: /verify-email + /auth/magic-link + /reset-password.', () => {
    const e = read(ENV_EXAMPLE);
    const c = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));

    // config.ts deriveAuthFlowUrls function uses these paths.
    expect(c).toMatch(/fromOrigin\('\/verify-email'\)/);
    expect(c).toMatch(/fromOrigin\('\/auth\/magic-link'\)/);
    expect(c).toMatch(/fromOrigin\('\/reset-password'\)/);

    // .env.example example URLs use the same paths.
    expect(e).toMatch(/\/verify-email/);
    expect(e).toMatch(/\/auth\/magic-link/);
    expect(e).toMatch(/\/reset-password/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/env-example-v079c-paths-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

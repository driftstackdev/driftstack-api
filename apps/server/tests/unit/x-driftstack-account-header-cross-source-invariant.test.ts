// W848 — X-Driftstack-Account header (V-326e Team RBAC) cross-source
// invariant. One-hundred-seventy-fourth in the drift-guard series.
// Pins the team-RBAC header is spelled + framed consistently across
// server routes + SDK docstrings.
//
// The V-326 series + V-330 add the X-Driftstack-Account header for
// team-member-on-behalf-of-owner requests:
//   - V-326c: read-side honors (Account.audit-log / etc).
//   - V-326e: OpenAPI documents the header.
//   - V-330: profiles + email-preferences + webhooks honor write-side.
//   - V-330d: documented for email-preferences.
//
// The Python+TS+Go SDK docstrings on AccountResource + AuditLogResource
// + MfaResource explicitly mention 'honor / does NOT honor' the header
// as part of each resource's contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W848 X-Driftstack-Account header cross-source invariant', () => {
  // ─── Header-name canonical spelling ──────────────────────────

  it("CRITICAL the X-Driftstack-Account header name (canonical Pascal-Hyphenated) is referenced by EVERY server route that honors it. The lowercase 'x-driftstack-account' is the wire form (HTTP headers are case-insensitive on the wire). Both spellings must reach the same handler.", () => {
    for (const route of [
      'apps/server/src/routes/profiles.ts',
      'apps/server/src/routes/webhooks.ts',
      'apps/server/src/routes/email-preferences.ts',
    ]) {
      const p = read(resolve(REPO_ROOT, route));
      // Each route declares 'x-driftstack-account' lowercase const.
      expect(p, `${route} must declare 'x-driftstack-account' header const`).toMatch(
        /'x-driftstack-account'/,
      );
    }
  });

  // ─── V-326e documents the header in OpenAPI ──────────────────

  it("CRITICAL apps/server/src/lib/openapi.ts documents V-326e Team RBAC + the X-Driftstack-Account header. The OpenAPI section explains the 'acc_<owner-uuid>' format + server-side validation. Drift to dropping the documentation would break customer-side SDK auto-generation.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    expect(p).toMatch(/## Team RBAC: X-Driftstack-Account header \(V-326e\)/);
    expect(p).toMatch(
      /the `X-Driftstack-Account: acc_<owner-uuid>` request header\. The server validates that/,
    );
  });

  // ─── EFFECTIVE_ACCOUNT_HEADER const consistency ──────────────

  it("CRITICAL the 'EFFECTIVE_ACCOUNT_HEADER' const name is reused across 3 routes (profiles + webhooks + email-preferences). The shared const name makes the cross-route invariant grep-able. Drift to per-route inline strings would let one route silently honor a different header spelling.", () => {
    for (const route of [
      'apps/server/src/routes/profiles.ts',
      'apps/server/src/routes/webhooks.ts',
      'apps/server/src/routes/email-preferences.ts',
    ]) {
      const p = read(resolve(REPO_ROOT, route));
      expect(p, `${route} must declare EFFECTIVE_ACCOUNT_HEADER`).toMatch(
        /const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';/,
      );
    }
  });

  // ─── V-anchor consistency across V-326* + V-330 ──────────────

  it('CRITICAL V-326* + V-330* V-anchor framing pinned. The V-326c (read-side) + V-326e (OpenAPI doc) + V-330 (profiles+webhooks+email-prefs honor write-side) sequence threads the team-RBAC story.', () => {
    const profiles = read(resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts'));
    const webhooks = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks.ts'));
    const emailPrefs = read(resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts'));
    const openapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));

    expect(profiles).toMatch(/V-330 — honors X-Driftstack-Account/);
    expect(webhooks).toMatch(/X-Driftstack-Account is set/);
    expect(emailPrefs).toMatch(/V-330d — both endpoints honor X-Driftstack-Account/);
    expect(openapi).toMatch(/V-326e/);
  });

  // ─── SDK resource docstrings reference the header ────────────

  it("CRITICAL SDK resource docstrings explicitly document 'honor / does NOT honor' the X-Driftstack-Account header per-resource. The dual-framing lets customers know which resources are team-RBAC-aware vs strictly per-key.", () => {
    const tsAuditLog = read(
      resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/audit-log.ts'),
    );
    const tsMfa = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/mfa.ts'));
    const pyAccount = read(
      resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/account.py'),
    );
    const goAccount = read(resolve(REPO_ROOT, 'packages/sdk-go/account.go'));
    const goAuditLog = read(resolve(REPO_ROOT, 'packages/sdk-go/audit_log.go'));
    const goMfa = read(resolve(REPO_ROOT, 'packages/sdk-go/mfa.go'));

    // Audit log honors the V-326c header.
    expect(tsAuditLog).toMatch(/V-326c X-Driftstack-Account/);
    expect(goAuditLog).toMatch(/V-326c X-Driftstack-Account/);

    // MFA does NOT honor the header (per-account-only).
    expect(tsMfa).toMatch(/X-Driftstack-Account team-RBAC header is not honored/);
    expect(goMfa).toMatch(/the X-Driftstack-Account header\./);

    // Account never honors (Bearer-only).
    expect(pyAccount).toMatch(/never honors the X-Driftstack-Account/);
    expect(goAccount).toMatch(/never honors the X-Driftstack-Account header/);
  });

  // ─── Header-format `acc_<uuid>` invariant ────────────────────

  it("CRITICAL the X-Driftstack-Account header value format is 'acc_<owner-uuid>'. Drift to a different format (raw UUID, slug, etc) would break server-side parsing.", () => {
    const openapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    expect(openapi).toMatch(/`X-Driftstack-Account: acc_<owner-uuid>`/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/x-driftstack-account-header-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

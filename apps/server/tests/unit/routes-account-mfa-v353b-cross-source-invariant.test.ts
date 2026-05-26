// W1035 — routes/account-mfa V-353b cross-source invariant. Three-
// hundred-sixty-first in the drift-guard series. Pins the apps/
// server/src/routes/account-mfa.ts customer-facing MFA routes:
//
//   V-353b anchor — 'V-353b — customer-facing MFA enrollment + status
//   + disable + recovery code regen. Step-up gating (account-delete
//   + MFA-disable per V-353a verdict Q3) lands in V-353e; for now,
//   disable is gated only by web-session auth + an explicit confirm
//   body field'.
//
//   6-endpoint inventory:
//     - GET /v1/account/mfa — status.
//     - POST /v1/account/mfa/enroll — start (returns otpauth URI +
//       base32 secret).
//     - POST /v1/account/mfa/verify — complete enrollment (returns
//       recovery codes).
//     - DELETE /v1/account/mfa — disable (V-353e requireMfaFresh).
//     - POST /v1/account/mfa/disable — V-353f POST alias (same gate).
//     - POST /v1/account/mfa/recovery-codes/regenerate.
//
//   TOTP enroll constants — algorithm: 'SHA1' + digits: 6 +
//     period_seconds: 30 (RFC 6238 default).
//
//   V-353e + V-353f framing — 'V-353b/V-353e — disable. Per V-353a
//   verdict Q3 this is one of the two step-up-gated ops (account-
//   delete + MFA-disable). The step-up gate (requireMfaFresh) refuses
//   (403 + requires_mfa_step_up extension) when the caller's session
//   hasn't satisfied MFA in the last 15 min. Caller refreshes via
//   POST /v1/auth/mfa/step-up (separate route, also bearer-authed)
//   and retries'.
//
//   confirm: 'disable-mfa' framing — 'Body still requires { confirm:
//   "disable-mfa" } as a defensive check against accidental DELETEs
//   from a stray client'.
//
//   V-353f POST alias framing — 'V-353f — POST alias per founder-
//   named canonical shape. Same gate, same handler. Some clients
//   prefer POST for non-idempotent ops'.
//
//   disableHandler shared between DELETE + POST.
//
// stays in lockstep across apps/server/src/routes/account-mfa.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1035 routes/account-mfa V-353b cross-source invariant', () => {
  it('CRITICAL V-353b anchor + step-up-deferred-to-V-353e framing.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-mfa.ts'));
    expect(p).toMatch(/V-353b — customer-facing MFA enrollment \+ status \+ disable \+ recovery/);
    expect(p).toMatch(/code regen\. Step-up gating \(account-delete \+ MFA-disable per V-353a/);
    expect(p).toMatch(/verdict Q3\) lands in V-353e; for now, disable is gated only by web-/);
    expect(p).toMatch(/session auth \+ an explicit confirm body field\./);
  });

  it('CRITICAL 6-endpoint inventory — GET /mfa + POST /enroll + POST /verify + DELETE /mfa + POST /disable + POST /recovery-codes/regenerate.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-mfa.ts'));
    expect(p).toMatch(/app\.get\(\s*'\/v1\/account\/mfa',/);
    expect(p).toMatch(/app\.post\(\s*'\/v1\/account\/mfa\/enroll',/);
    expect(p).toMatch(/app\.post\(\s*'\/v1\/account\/mfa\/verify',/);
    expect(p).toMatch(/app\.delete\(\s*'\/v1\/account\/mfa',/);
    expect(p).toMatch(/app\.post\(\s*'\/v1\/account\/mfa\/disable',/);
    expect(p).toMatch(/app\.post\(\s*'\/v1\/account\/mfa\/recovery-codes\/regenerate',/);
  });

  it("CRITICAL TOTP enroll RFC 6238 constants — algorithm:'SHA1' + digits:6 + period_seconds:30.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-mfa.ts'));
    expect(p).toMatch(/algorithm: 'SHA1',/);
    expect(p).toMatch(/digits: 6,/);
    expect(p).toMatch(/period_seconds: 30,/);
  });

  it("CRITICAL V-353e + 15-min freshness framing — 'The step-up gate (requireMfaFresh) refuses (403 + requires_mfa_step_up extension) when the caller's session hasn't satisfied MFA in the last 15 min. Caller refreshes via POST /v1/auth/mfa/step-up (separate route, also bearer-authed) and retries'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-mfa.ts'));
    expect(p).toMatch(/\/\/ V-353b\/V-353e — disable\. Per V-353a verdict Q3 this is one of/);
    expect(p).toMatch(/\/\/ the two step-up-gated ops \(account-delete \+ MFA-disable\)\. The/);
    expect(p).toMatch(
      /\/\/ step-up gate \(`requireMfaFresh`\) refuses \(403 \+ requires_mfa_step_up/,
    );
    expect(p).toMatch(/\/\/ extension\) when the caller's session hasn't satisfied MFA in the/);
    expect(p).toMatch(/\/\/ last 15 min\. Caller refreshes via POST \/v1\/auth\/mfa\/step-up/);
    expect(p).toMatch(/\/\/ \(separate route, also bearer-authed\) and retries\./);
  });

  it("CRITICAL confirm:'disable-mfa' defensive check + 'Disable requires an explicit confirmation. Pass { confirm: disable-mfa }.' error.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-mfa.ts'));
    expect(p).toMatch(/if \(body\.confirm !== 'disable-mfa'\) \{/);
    expect(p).toMatch(/throw new BadRequestError\(/);
    expect(p).toMatch(
      /'Disable requires an explicit confirmation\. Pass \{ "confirm": "disable-mfa" \}\.',/,
    );
  });

  it("CRITICAL V-353f POST alias framing — 'V-353f — POST alias per founder-named canonical shape. Same gate, same handler. Some clients prefer POST for non-idempotent ops'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-mfa.ts'));
    expect(p).toMatch(/\/\/ V-353f — POST alias per founder-named canonical shape\. Same gate,/);
    expect(p).toMatch(/\/\/ same handler\. Some clients prefer POST for non-idempotent ops\./);
  });

  it('CRITICAL DELETE + POST disable both step-up-gated (requireMfaFresh) + account_owner-scoped + share disableHandler.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-mfa.ts'));
    // V-481 added app.requireScope('account_owner') to the disable/delete
    // preHandler arrays (now multi-line under prettier), so count each
    // guard independently rather than as the old adjacent triple.
    expect((p.match(/app\.requireMfaFresh\(\)/g) ?? []).length).toBe(2);
    expect((p.match(/app\.requireScope\('account_owner'\)/g) ?? []).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(p).toMatch(/const disableHandler = async/);
    expect(p).toMatch(/disableHandler,/);
  });

  it('CRITICAL GET /mfa response 4-field — enrolled + nullable ISO enrolled_at + nullable ISO last_used_at + unused_recovery_codes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-mfa.ts'));
    expect(p).toMatch(/enrolled: status\.enrolled,/);
    expect(p).toMatch(
      /enrolled_at: status\.enrolledAt \? status\.enrolledAt\.toISOString\(\) : null,/,
    );
    expect(p).toMatch(
      /last_used_at: status\.lastUsedAt \? status\.lastUsedAt\.toISOString\(\) : null,/,
    );
    expect(p).toMatch(/unused_recovery_codes: status\.unusedRecoveryCodes,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-account-mfa-v353b-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

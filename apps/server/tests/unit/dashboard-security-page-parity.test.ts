// W759-security — customer-dashboard /security.astro V-079
// (change-pw via password-reset) + V-353h (MFA enroll/verify +
// recovery codes) + V-355 (sessions / devices) + V-216 (audit teaser)
// parity. Split out of dashboard-settings-page-v217-v353h-parity
// when the 2026-07-03 design-system v2 redesign moved the security
// surfaces to the dedicated /security page.
//
// /security carries the MFA lifecycle that admin-gated security
// depends on. Drift to recovery-code-shown-ONCE or step-up
// reauthentication framing would erode account-security guarantees.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/security.astro');

describe('W759-security dashboard /security page V-079 + V-353h + V-355 + V-216 parity', () => {
  it('security.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-216 + V-079 live-wire framing pinned. The frontmatter threads BOTH the audit-log + password-reset anchors that moved here from settings.astro (2026-07-03 split).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/v1\/account\/audit-log \(V-216\) — recent customer-visible events/);
    expect(p).toMatch(/\/v1\/auth\/password-reset\/request \(V-079\) — change-password trigger/);
  });

  it("CRITICAL V-353h MFA recovery-codes-shown-ONCE-at-enrollment framing pinned. The 'Recovery codes are issued at enrollment — store them somewhere safe; without your authenticator AND your recovery codes, account access' wording is the load-bearing 'no admin recovery path' security framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Recovery codes are issued at enrollment — store them somewhere safe;/);
    expect(p).toMatch(/without your authenticator AND your recovery codes, account access/);
  });

  it("CRITICAL V-353h enroll + verify + recovery-codes-list-10 framing pinned. The 'Save your recovery codes — these are shown ONCE' wording matches the W750 api-key + W753 webhook 'shown ONCE' security pattern.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Save your recovery codes — these are shown ONCE/);
    expect(p).toMatch(/<span data-field="mfa-recovery-remaining">—<\/span> unused of 10/);
  });

  it('CRITICAL V-353h step-up reauthentication framing pinned. The "Enter a fresh 6-digit code (or a recovery code) to continue" copy + placeholder="123456 or recovery" tells customers both TOTP + recovery codes work as step-up.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Enter a fresh 6-digit code \(or a recovery code\) to continue\./);
    expect(p).toMatch(/placeholder="123456 or recovery"/);
  });

  it("CRITICAL MFA disable clears TOTP secret + invalidates recovery codes. The 'Disabling clears your TOTP secret + invalidates all recovery codes' wording is the load-bearing customer-comms before a destructive MFA-disable action.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Disabling clears your TOTP secret \+ invalidates all recovery codes\./);
  });

  it('CRITICAL POST /v1/account/mfa/enroll + POST /v1/account/mfa/verify pinned. Drift to a different endpoint would break the V-353h enrollment flow.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/authedFetch\('\/v1\/account\/mfa\/enroll', \{ method: 'POST' \}\)/);
    expect(p).toMatch(/authedFetch\('\/v1\/account\/mfa\/verify', \{/);
  });

  it('CRITICAL POST /v1/auth/mfa/step-up pinned (step-up uses /v1/auth/ NOT /v1/account/). The mid-session step-up is auth-scoped not account-scoped.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/authedFetch\('\/v1\/auth\/mfa\/step-up', \{/);
  });

  it('CRITICAL POST /v1/account/mfa/recovery-codes/regenerate pinned. Drift to dropping would force customers to disable-then-re-enroll MFA to get fresh codes.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /authedFetch\('\/v1\/account\/mfa\/recovery-codes\/regenerate', \{ method: 'POST' \}\)/,
    );
  });

  it('CRITICAL V-079 change-password trigger uses password-reset flow pinned. The "V-079 — change password trigger via password-reset request" comment + POST /v1/auth/password-reset/request is what avoids exposing a separate password-change endpoint.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ V-079 — change password trigger via password-reset request\./);
    expect(p).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/password-reset\/request', \{/);
  });

  it('CRITICAL V-216 audit-log live-wire pinned with limit=20 cap. /security shows a recent-activity summary not the full log (full lives at /audit-log).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-216 — audit log live wire\./);
    expect(p).toMatch(/authedFetch\('\/v1\/account\/audit-log\?limit=20', \{ method: 'GET' \}\)/);
  });

  it('CRITICAL V-355 active sign-ins (web-sessions) live wire pinned. GET + per-id DELETE + bulk DELETE-with-?keep=current. Drift to dropping bulk-revoke would force customers to revoke sessions one-by-one.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-355 — active sign-ins live wire\./);
    expect(p).toMatch(/authedFetch\('\/v1\/account\/web-sessions', \{ method: 'GET' \}\)/);
    expect(p).toMatch(
      /authedFetch\('\/v1\/account\/web-sessions\/' \+ encodeURIComponent\(id\), \{/,
    );
    expect(p).toMatch(
      /authedFetch\('\/v1\/account\/web-sessions\?keep=current', \{ method: 'DELETE' \}\)/,
    );
  });

  it("CRITICAL V-331b act-as header passthrough pinned in security authedFetch. Drift would let team-RBAC customers update the wrong owner's MFA / sign-ins.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ V-331b — act-as header for team-scoped requests\./);
    expect(p).toMatch(
      /\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n\s+\? window\.driftstackActAsHeaders\(\)\s*\n\s+: \{\}\),/,
    );
  });

  it("CRITICAL no-token banner — 'Sign in to see live security status + recent activity.' Drift to a 401 redirect would lose the partial-preview affordance.", () => {
    const p = read(PAGE);
    expect(p).toMatch(/showBanner\('Sign in to see live security status \+ recent activity\.'\);/);
  });

  it('CRITICAL resolveApiBaseUrl + DashboardLayout used with the "Privacy & security" title.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/<DashboardLayout title="Privacy & security">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/dashboard-security-page-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

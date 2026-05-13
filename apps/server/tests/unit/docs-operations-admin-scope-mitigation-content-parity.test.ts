// W553.A — drift guard for /docs/operations/admin-scope-mitigation.md.
// Operational security note. Drift here either weakens the
// V-135-Cloudflare-Access-load-bearing posture (would re-permit
// removing the front-door without first closing the scope reach
// in app code), drops the 4-step closure-shape inventory, or
// weakens the founder verification checklist (no-Allow-any-
// authenticated-user-in-the-world reads like a footnote but is
// the critical guard against admin-panel breach).
//
//   • V-253 / V-246-P1-003 operational note.
//   • Customer-facing account_owner scope CAN currently reach
//     /v1/admin/* alongside driftstack_internal_admin staff scope.
//   • Mitigation: Cloudflare Access on admin.driftstack.dev (V-135)
//     prevents customer-API-key reaching the admin origin at all.
//   • DO NOT remove or bypass without first closing app-code reach.
//   • V-216 + V-237 closed two prior customer uses of /v1/admin/*.
//   • 4-step closure shape queued as V-NNN follow-up.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/operations/admin-scope-mitigation.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W553.A /docs/operations/admin-scope-mitigation.md content parity', () => {
  const body = read(LIB);

  it("Header + V-253/V-246-P1-003 + TL;DR framing pinned: '# Admin scope reach mitigation — V-135 Cloudflare Access dependency' + 'V-253 / V-246-P1-003. Operational note documenting a security-posture dependency that the codebase relies on but doesn't enforce in app code.' + 'The Driftstack API has a known scope-architecture gap: API keys with the customer-facing `'account_owner'` scope can reach `/v1/admin/*` routes alongside Driftstack-staff keys with the `'driftstack_internal_admin'` scope.' + 'Cloudflare Access on the `admin.driftstack.dev` origin** (V-135) prevents the customer from reaching the admin origin in the first place, regardless of API key scope.' + 'DO NOT remove or bypass the Cloudflare Access front-door without first closing the scope reach in app code.' — pinned so the V-253-V-246-P1-003 + account_owner-vs-driftstack_internal_admin-gap + V-135-Cloudflare-Access-mitigation + DO-NOT-remove-without-closing-app-code commitment survives", () => {
    expect(body).toMatch(/^# Admin scope reach mitigation — V-135 Cloudflare Access dependency$/m);
    expect(body).toMatch(/V-253 \/ V-246-P1-003\. Operational note documenting a security-posture/);
    expect(body).toMatch(/dependency that the codebase relies on but doesn't enforce in app/);
    expect(body).toMatch(/The Driftstack API has a known scope-architecture gap: API keys with/);
    expect(body).toMatch(/the customer-facing `'account_owner'` scope can reach `\/v1\/admin\/\*`/);
    expect(body).toMatch(/routes alongside Driftstack-staff keys with the/);
    expect(body).toMatch(/`'driftstack_internal_admin'` scope\./);
    expect(body).toMatch(
      /\*\*Cloudflare Access on the `admin\.driftstack\.dev` origin\*\* \(V-135\)/,
    );
    expect(body).toMatch(/prevents the customer from reaching the admin origin in the first/);
    expect(body).toMatch(/> \*\*DO NOT remove or bypass the Cloudflare Access front-door without/);
    expect(body).toMatch(/> first closing the scope reach in app code\.\*\*/);
  });

  it("What's in app code framing pinned: 'auth.ts` lines ~255-267 carry a `KNOWN GAP`' + 'comment documenting the architecture' + '`driftstack_internal_admin` is the canonical staff scope' + '`account_owner` is the customer-dashboard scope (web sessions issued to dashboard users with that role).' + 'The original V-174 scope split intentionally allowed `account_owner` to also reach `/v1/admin/*`' + 'before V-216 added a customer-facing audit endpoint' + 'The gap: nothing in app code prevents `account_owner` from calling `/v1/admin/*` against ANOTHER customer's account.' — pinned so the auth.ts-KNOWN-GAP-255-267 + V-174-scope-split-intentional + V-216-customer-audit-closed-pre-existing + cross-account-leak-surface commitment survives", () => {
    expect(body).toMatch(
      /`apps\/server\/src\/services\/auth\.ts` lines ~255-267 carry a `KNOWN GAP`/,
    );
    expect(body).toMatch(/comment documenting the architecture:/);
    expect(body).toMatch(/- `'driftstack_internal_admin'` is the canonical staff scope; admin/);
    expect(body).toMatch(/- `'account_owner'` is the customer-dashboard scope \(web sessions/);
    expect(body).toMatch(/issued to dashboard users with that role\)\./);
    expect(body).toMatch(/The original V-174 scope/);
    expect(body).toMatch(/split intentionally allowed `account_owner` to also reach/);
    expect(body).toMatch(/`\/v1\/admin\/\*` so the customer dashboard's "account settings" pages/);
    expect(body).toMatch(/before V-216 added a customer-facing audit endpoint/);
    expect(body).toMatch(/- The gap: nothing in app code prevents `account_owner` from calling/);
    expect(body).toMatch(/`\/v1\/admin\/\*` against ANOTHER customer's account\./);
  });

  it("What-V-135-does + Cloudflare-Access framing pinned: '`admin.driftstack.dev` is a separate Cloudflare Pages project (V-135 admin panel scaffolding).' + 'Cloudflare Access policy enforces' + 'Authenticated identity required (Driftstack staff Google Workspace account; future: Okta or similar).' + 'Access list scoped to `@driftstack.dev` email domain only' + 'Customer-facing API keys CANNOT pass the access policy — they're not identities Cloudflare Access recognizes.' + 'The customer would have to reach the canonical API origin (`api.driftstack.dev`) which exposes only `/v1/*` (non-admin).' — pinned so the admin.driftstack.dev-separate-CF-Pages + Google-Workspace-Okta-future + @driftstack.dev-email-domain + api.driftstack.dev-canonical-only-non-admin commitment survives", () => {
    expect(body).toMatch(/`admin\.driftstack\.dev` is a separate Cloudflare Pages project \(V-135/);
    expect(body).toMatch(/admin panel scaffolding\)\./);
    expect(body).toMatch(/Cloudflare Access policy enforces:/);
    expect(body).toMatch(/- Authenticated identity required \(Driftstack staff Google Workspace/);
    expect(body).toMatch(/account; future: Okta or similar\)\./);
    expect(body).toMatch(/- Access list scoped to `@driftstack\.dev` email domain only/);
    expect(body).toMatch(/- Customer-facing API keys CANNOT pass the access policy — they're not/);
    expect(body).toMatch(/identities Cloudflare Access recognizes\./);
    expect(body).toMatch(/The customer would/);
    expect(body).toMatch(/have to reach the canonical API origin \(`api\.driftstack\.dev`\) which/);
    expect(body).toMatch(/exposes only `\/v1\/\*` \(non-admin\)\./);
  });

  it("4-step closure-shape framing pinned: '## Conditions for safely closing the V-135 dependency' + 'Split admin routes into two registration paths' + '`/v1/admin/*` accepts ONLY `driftstack_internal_admin` scope.' + 'Customer-facing equivalents land under `/v1/account/*` with `account_owner` scope' + '`/v1/account/audit-log` already exists per V-216' + '`/v1/account/me` per V-237' + 'Update auth.ts `KNOWN GAP` comment to \"RESOLVED V-NNN\"' + 'Audit existing customer-dashboard code to confirm no live caller relies on `account_owner` → `/v1/admin/*`.' + 'Verify with an integration test that asserts `account_owner` keys get 403 on `/v1/admin/*` post-fix.' — pinned so the 4-step closure-shape + /v1/account-replaces-/v1/admin + V-216-audit-log + V-237-account-me + 403-integration-test commitment survives", () => {
    expect(body).toMatch(/## Conditions for safely closing the V-135 dependency/);
    expect(body).toMatch(/1\. Split admin routes into two registration paths:/);
    expect(body).toMatch(/- `\/v1\/admin\/\*` accepts ONLY `driftstack_internal_admin` scope\./);
    expect(body).toMatch(/- Customer-facing equivalents land under `\/v1\/account\/\*` with/);
    expect(body).toMatch(/`account_owner` scope \(e\.g\. `\/v1\/account\/audit-log` already/);
    expect(body).toMatch(/exists per V-216; `\/v1\/account\/me` per V-237;/);
    expect(body).toMatch(/2\. Update auth\.ts `KNOWN GAP` comment to "RESOLVED V-NNN" and remove/);
    expect(body).toMatch(/the `account_owner` reach into `\/v1\/admin\/\*`\./);
    expect(body).toMatch(/3\. Audit existing customer-dashboard code to confirm no live caller/);
    expect(body).toMatch(/relies on `account_owner` → `\/v1\/admin\/\*`\./);
    expect(body).toMatch(/4\. Verify with an integration test that asserts `account_owner` keys/);
    expect(body).toMatch(/get 403 on `\/v1\/admin\/\*` post-fix\./);
  });

  it("Founder verification checklist framing pinned: '## Verification checklist (founder, on Cloudflare config)' + 'Cloudflare Access policy is in place on the `admin.driftstack.dev`' + 'Access policy is set to **Bypass: NEVER allow without identity**' + 'Identity provider is configured (Google Workspace recommended; Okta also acceptable).' + 'Access list is scoped to `@driftstack.dev` email domain only' + 'Do NOT use `Allow: any authenticated user`' + 'Session duration is set conservatively (24h or less)' + '`apps/admin-panel/` build target is set to deploy ONLY to `admin.driftstack.dev`, never to a public URL.' — pinned so the 6-checkbox-verification + Bypass-NEVER + Google-Workspace-or-Okta + @driftstack.dev-only + no-Allow-any-authenticated-user + 24h-session-conservative + admin-panel-never-public-URL commitment survives", () => {
    expect(body).toMatch(/## Verification checklist \(founder, on Cloudflare config\)/);
    expect(body).toMatch(
      /- \[ \] Cloudflare Access policy is in place on the `admin\.driftstack\.dev`/,
    );
    expect(body).toMatch(
      /- \[ \] Access policy is set to \*\*Bypass: NEVER allow without identity\*\*\./,
    );
    expect(body).toMatch(/- \[ \] Identity provider is configured \(Google Workspace recommended;/);
    expect(body).toMatch(/Okta also acceptable\)\./);
    expect(body).toMatch(
      /- \[ \] Access list is scoped to `@driftstack\.dev` email domain only OR/,
    );
    expect(body).toMatch(/\*\*Do NOT use `Allow: any\s*\n?authenticated user`\*\*/);
    expect(body).toMatch(/- \[ \] Session duration is set conservatively \(24h or less\)/);
    expect(body).toMatch(/- \[ \] `apps\/admin-panel\/` build target is set to deploy ONLY to/);
    expect(body).toMatch(/`admin\.driftstack\.dev`, never to a public URL\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

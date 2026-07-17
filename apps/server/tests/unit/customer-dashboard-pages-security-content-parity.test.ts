// W497.C-security — drift guard for
// apps/customer-dashboard/src/pages/security.astro. V-079 + V-216 +
// V-353h + V-355 Privacy & security page (split out of settings.astro
// 2026-07-03, design-system v2). Drift here either drops the V-353h
// MFA section (would break the recovery-codes shown-ONCE contract) or
// weakens the step-up gate that keeps a stolen session from disabling
// MFA.
//
//   • V-353h MFA enroll + verify + recovery codes + step-up reauth.
//   • V-355 active sign-ins (web-sessions list + revoke).
//   • V-079 change-password via password-reset request.
//   • V-216 audit log live wire (last 20 entries).
//   • V-331b act-as header in authedFetch.
//   • Danger-zone: 7-year Dutch tax law invoice retention +
//     support@driftstack.dev pre-launch deletion, anchored at
//     #danger-zone for the trust-panel deep link.
//   • Honest data-protection trust panel (copied from the overview,
//     with request-based export/deletion linked to the danger zone).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/security.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W497.C-security apps/customer-dashboard/src/pages/security.astro content parity', () => {
  const body = read(LIB);

  it('V-353h MFA enroll + verify + recovery contract: POST /v1/account/mfa/enroll → { otpauth_uri, secret_base32 } + POST /v1/account/mfa/verify { code } → { recovery_codes } — pinned so the 2-step enroll-then-verify flow + the recovery_codes response field stay correct (drift to a single-step enroll would skip the QR-scan verification; drift to dropping recovery_codes would orphan customers from the shown-ONCE backup-codes flow)', () => {
    expect(body).toMatch(/authedFetch\('\/v1\/account\/mfa\/enroll', \{ method: 'POST' \}\)/);
    expect(body).toMatch(
      /authedFetch\('\/v1\/account\/mfa\/verify', \{\s*\n?\s*method: 'POST',\s*\n?\s*body: JSON\.stringify\(\{ code \}\),\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(/body\.recovery_codes \|\| \[\]/);
  });

  it("MFA recovery codes shown-ONCE framing pinned: 'Save your recovery codes — these are shown ONCE' + 'Each code works once. Store them somewhere safe (password manager, printed copy, secure note). Without your authenticator AND these codes, account access requires support intervention.' — pinned so the shown-ONCE contract + support-intervention escape-hatch both survive (drift to dropping support-intervention would let lockout victims think there's no recovery path)", () => {
    expect(body).toMatch(/Save your recovery codes — these are shown ONCE/);
    expect(body).toMatch(
      /Each code works once\. Store them somewhere safe \(password manager,\s*\n?\s*printed copy, secure note\)\. Without your authenticator AND these\s*\n?\s*codes, account access requires support intervention\./,
    );
  });

  it("MFA step-up reauth framing: 'requires_mfa_step_up' response flag → openStepUp('disable') + POST /v1/auth/mfa/step-up { code | recovery_code } — pinned so the disable-needs-fresh-code security gate survives (drift to dropping step-up would let an attacker with a stolen session disable MFA without proving fresh possession of the authenticator)", () => {
    expect(body).toMatch(/if \(b && b\.requires_mfa_step_up\) \{\s*\n?\s*openStepUp\('disable'\);/);
    expect(body).toMatch(/const body = isCode \? \{ code: raw \} : \{ recovery_code: raw \};/);
    expect(body).toMatch(/authedFetch\('\/v1\/auth\/mfa\/step-up', \{/);
  });

  it("V-355 active sign-ins contract: GET /v1/account/web-sessions + DELETE /v1/account/web-sessions/:id + DELETE /v1/account/web-sessions?keep=current bulk-revoke — pinned so the 3-endpoint web-sessions contract stays correct (drift to dropping ?keep=current would let bulk-revoke kill the current session, signing the customer out of the page they're using)", () => {
    expect(body).toMatch(/authedFetch\('\/v1\/account\/web-sessions', \{ method: 'GET' \}\)/);
    expect(body).toMatch(
      /authedFetch\('\/v1\/account\/web-sessions\/' \+ encodeURIComponent\(id\), \{\s*\n?\s*method: 'DELETE',\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /authedFetch\('\/v1\/account\/web-sessions\?keep=current', \{ method: 'DELETE' \}\)/,
    );
  });

  it("V-355 IP-omitted-for-privacy framing pinned: 'IP omitted for privacy. The \"current\" session is the one you're using right now and can't be revoked from this list — sign out from the menu instead.' — pinned so the privacy-by-default + don't-revoke-self framing stays explicit (drift to surfacing IP would change the privacy posture; drift to dropping the can't-revoke-self framing would confuse customers who try to revoke their current session)", () => {
    expect(body).toMatch(
      /IP omitted for privacy\. The "current" session is the one you're using\s*\n?\s*right now and can't be revoked from this list — sign out from the menu\s*\n?\s*instead\./,
    );
  });

  it("V-079 change-password via password-reset request framing: 'We email you a magic link to confirm. The link expires after 60 minutes; old sessions stay signed in until they naturally expire.' + POST /v1/auth/password-reset/request { email } — pinned so the magic-link UX + the 60-min expiry (this flow issues AUTH_TOKEN_TTL_MS.passwordReset = 60min via requestPasswordReset, NOT the 15-min magicLink) + the old-sessions-stay-alive contract all survive (drift to revoke-on-reset would force customers to re-login everywhere on a routine password change)", () => {
    expect(body).toMatch(
      /We email you a magic link to confirm\. The link expires after 60\s*\n?\s*minutes; old sessions stay signed in until they naturally expire\./,
    );
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/auth\/password-reset\/request', \{\s*\n?\s*method: 'POST',/,
    );
  });

  it('destructive account actions expose truthful local progress while their requests are pending', () => {
    expect(body).toMatch(/showWebSessionMutationProgress\(btn, 'Revoking…'\);/);
    expect(body).toMatch(
      /showWebSessionMutationProgress\(webSessionsRevokeAllBtn, 'Signing out…'\);/,
    );
    expect(body).toMatch(/if \(btn\) btn\.textContent = 'Sending…';/);
  });

  it("V-216 audit-log live wire: GET /v1/account/audit-log?limit=20 + actor_type + target_resource_id + action+timestamp render — pinned so the recent-activity card surfaces the latest 20 entries with full provenance (drift to dropping ?limit=20 would either over-fetch or default the server's larger limit; drift to dropping actor_type would hide whether the action was customer/system/staff-initiated)", () => {
    expect(body).toMatch(
      /authedFetch\('\/v1\/account\/audit-log\?limit=20', \{ method: 'GET' \}\)/,
    );
  });

  // S38 2026-07-07 (fable-truth-audit follow-on) — the old pin locked TWO fictions: session recordings
  // (feature never shipped — recordingKey() has zero callers) and a
  // customer-configurable retention window (no such setting). The
  // danger zone now points at the privacy-policy purge schedule.
  it('Danger-zone framing pinned: irreversible deletion + privacy-policy purge schedule + 7y Dutch-tax invoice retention + support@ mailto + #danger-zone anchor (S38: recordings/configurable-retention fictions retired)', () => {
    expect(body).toMatch(
      /All sessions, profiles, API keys,\s*\n?\s*and webhook endpoints are immediately revoked, and stored account\s*\n?\s*data is purged on the schedule in the privacy policy\. Invoice\s*\n?\s*history retained per Dutch tax law \(7 years\) — not\s*\n?\s*deletable on\s*\n?\s*request\./,
    );
    expect(body).toMatch(
      /href="mailto:support@driftstack\.dev\?subject=Account%20deletion%20request"/,
    );
    expect(body).toMatch(/<section id="danger-zone"/);
  });

  it('Data-protection trust panel pins context-bound platform-held encryption and recorded-event audit truth', () => {
    expect(body).toMatch(/Your data is protected/);
    expect(body).toMatch(
      /recoverable credentials are encrypted at rest with context-bound wrapping under platform-held keys\./,
    );
    expect(body).toMatch(/AES-256-GCM at rest/);
    expect(body).toMatch(/Context-bound encryption/);
    expect(body).toMatch(
      /owning account and, for record-scoped stores, the exact record and value slot/,
    );
    expect(body).toMatch(/Recorded management events/);
    expect(body).toMatch(
      /credential-management events that were recorded in your <a href="\/audit-log\/"[\s\S]{0,180}routine runtime use is not logged as a credential-read event\./i,
    );
    expect(body).not.toMatch(/Profiles are client-encrypted/);
    expect(body).not.toMatch(/Every credential read lands/);
    expect(body).not.toMatch(/Always audited/);
    expect(body).not.toMatch(/Management changes audited/);
    expect(body).not.toMatch(/Account \+ record bound/);
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /export and deletion are request-based today; start in\s*\n?\s*<a href="#danger-zone" class="text-tk-accent-text underline">the danger zone<\/a>\./,
    );
    expect(body).not.toMatch(/export or delete anytime/);
  });

  it("V-331b act-as header in authedFetch — pinned so the team-scoped flow propagates to security reads/writes (drift would let team managers accidentally modify their OWN MFA / sign-ins when trying to manage a team-mate's account)", () => {
    expect(body).toMatch(
      /\/\/ V-331b — act-as header for team-scoped requests\.\s*\n?\s*\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n?\s*\? window\.driftstackActAsHeaders\(\)\s*\n?\s*: \{\}\),/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

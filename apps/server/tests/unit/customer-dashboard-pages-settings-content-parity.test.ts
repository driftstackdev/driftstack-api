// W497.C — drift guard for apps/customer-dashboard/src/pages/settings.astro.
// V-217 + V-079 + V-204 + V-216 + V-298a + V-298b + V-352 + V-352b +
// V-353h + V-355 settings page. Drift here either drops the
// V-353h MFA section (would break the recovery-codes shown-ONCE
// contract) or breaks the V-204 EMAIL_EVENTS 8-entry list
// (customers couldn't opt out of lifecycle emails matching the
// server-side OptOutableEmailEventSchema).
//
//   • V-217 progressive-enhancement framing.
//   • V-204 EMAIL_EVENTS 8-entry list mirroring
//     OptOutableEmailEventSchema.
//   • V-353h MFA enroll + verify + recovery codes + step-up reauth.
//   • V-352 + V-352b + V-298a + V-298b profile form (name +
//     timezone + slug + region + avatar).
//   • V-355 active sign-ins (web-sessions list + revoke).
//   • V-079 change-password via password-reset request.
//   • V-216 audit log live wire (last 20 entries).
//   • V-331b act-as header in authedFetch.
//   • Danger-zone: 10-year EU tax law invoice retention +
//     support@driftstack.dev pre-launch deletion.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/settings.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W497.C apps/customer-dashboard/src/pages/settings.astro content parity', () => {
  const body = read(LIB);

  it("V-217 framing pinned: 'progressive-enhancement live wiring against: /v1/account/email-preferences (V-204) — list + PUT per-event toggles / /v1/account/audit-log (V-216) — recent customer-visible events / /v1/auth/password-reset/request (V-079) — change-password trigger' — pinned so the 3-endpoint live-wire scope + the V-204/V-216/V-079 provenance survive", () => {
    expect(body).toMatch(
      /\/\/ V-217 — progressive-enhancement live wiring against:\s*\n?\s*\/\/ {3}- \/v1\/account\/email-preferences \(V-204\) — list \+ PUT per-event toggles\s*\n?\s*\/\/ {3}- \/v1\/account\/audit-log \(V-216\) — recent customer-visible events\s*\n?\s*\/\/ {3}- \/v1\/auth\/password-reset\/request \(V-079\) — change-password trigger/,
    );
  });

  it('V-204 EMAIL_EVENTS 6-entry list: signup-welcome / session-failed-first / session-success-first / tier-changed / billing-receipt / billing-renewal-reminder — pinned so the customer-facing opt-outable email taxonomy stays consistent with OptOutableEmailEventSchema (drift to dropping any would orphan customers from opting out of a lifecycle email they receive; drift to adding security/financial events would let customers opt out of must-deliver emails). The trial-pack pair was removed with the dead trial_pack lifecycle.', () => {
    expect(body).toMatch(/type: 'signup-welcome',/);
    expect(body).toMatch(/type: 'session-failed-first',/);
    expect(body).toMatch(/type: 'session-success-first',/);
    expect(body).toMatch(/type: 'tier-changed',/);
    expect(body).toMatch(/type: 'billing-receipt',/);
    expect(body).toMatch(/type: 'billing-renewal-reminder',/);
    expect(body).not.toMatch(/type: 'trial-pack-purchased',/);
    expect(body).not.toMatch(/type: 'trial-pack-expired',/);
  });

  it("Security-vs-lifecycle email framing pinned: 'Security + financial emails (signup verification, password reset, billing failure, subscription cancellation, support replies) always go out. Below are the optional lifecycle emails — toggle off any you don't want.' — pinned so the must-deliver vs. opt-outable distinction stays explicit (drift to dropping the security/financial framing would let customers think they can opt out of billing-failure or password-reset emails, breaking the security model)", () => {
    expect(body).toMatch(
      /Security \+ financial emails \(signup verification, password reset,\s*\n?\s*billing failure, subscription cancellation, support replies\) always\s*\n?\s*go out\. Below are the optional lifecycle emails — toggle off any\s*\n?\s*you don't want\./,
    );
  });

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
    expect(body).toMatch(
      /const body = isCode \? \{ code: raw \} : \{ recovery_code: raw \};\s*\n?\s*authedFetch\('\/v1\/auth\/mfa\/step-up', \{/,
    );
  });

  it("V-352 + V-298a + V-298b profile form contract: PATCH /v1/account/me { name, timezone, slug?, region? } with null-on-empty + IANA timezone hint — pinned so the 4-field profile mutation contract stays consistent (drift to dropping null-on-empty would force customers to keep filling fields they've cleared; drift to dropping region would orphan the V-298b data-residency preference UI)", () => {
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/account\/me', \{\s*\n?\s*method: 'PATCH',/);
    expect(body).toMatch(
      /name: name\.length > 0 \? name : null,\s*\n?\s*timezone: tz\.length > 0 \? tz : null,/,
    );
    expect(body).toMatch(/body\.slug = slug\.length > 0 \? slug : null;/);
    expect(body).toMatch(/body\.region = region\.length > 0 \? region : null;/);
  });

  it("V-298b region 3-option preference: us / eu / apac — pinned so the data-residency preference taxonomy stays consistent + the 'sub-processor list governs physical routing' clarifier stays explicit (drift to dropping APAC would orphan ANZ/JP customers; drift to dropping the sub-processor link would let customers think the preference forces physical routing)", () => {
    expect(body).toMatch(/<option value="us">us — Americas<\/option>/);
    expect(body).toMatch(/<option value="eu">eu — Europe<\/option>/);
    expect(body).toMatch(/<option value="apac">apac — Asia-Pacific<\/option>/);
    expect(body).toMatch(
      /sub-processor list \(see <a href="https:\/\/driftstack\.dev\/trust\/sub-processors"/,
    );
  });

  it('V-352b avatar upload contract: 2MB max + PNG/JPEG/WebP only + R2 EU storage + POST /v1/account/me/avatar { content_type, data_base64 } + DELETE /v1/account/me/avatar — pinned so the upload constraints (size + types + region) + the base64 wire format + the DELETE-to-remove contract all survive (drift to dropping size limit would let bad actors flood R2 with multi-GB avatars; drift to dropping base64 would change the wire format)', () => {
    expect(body).toMatch(/PNG, JPEG, or WebP\. Max 2 MB\. Stored on Cloudflare R2 \(EU\)\./);
    expect(body).toMatch(/if \(file\.size > 2 \* 1024 \* 1024\) \{/);
    expect(body).toMatch(/if \(!\/\^image\\\/\(png\|jpeg\|webp\)\$\/\.test\(file\.type\)\) \{/);
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/account\/me\/avatar', \{\s*\n?\s*method: 'POST',/,
    );
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/account\/me\/avatar', \{\s*\n?\s*method: 'DELETE',/,
    );
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

  it("V-079 change-password via password-reset request framing: 'We email you a magic link to confirm. The link expires after 15 minutes; old sessions stay signed in until they naturally expire.' + POST /v1/auth/password-reset/request { email } — pinned so the magic-link UX + the 15-min expiry + the old-sessions-stay-alive contract all survive (drift to revoke-on-reset would force customers to re-login everywhere on a routine password change)", () => {
    expect(body).toMatch(
      /We email you a magic link to confirm\. The link expires after 15\s*\n?\s*minutes; old sessions stay signed in until they naturally expire\./,
    );
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/password-reset\/request', \{\s*\n?\s*method: 'POST',/,
    );
  });

  it("V-216 audit-log live wire: GET /v1/account/audit-log?limit=20 + actor_type + target_resource_id + action+timestamp render — pinned so the recent-activity card surfaces the latest 20 entries with full provenance (drift to dropping ?limit=20 would either over-fetch or default the server's larger limit; drift to dropping actor_type would hide whether the action was customer/system/staff-initiated)", () => {
    expect(body).toMatch(
      /authedFetch\('\/v1\/account\/audit-log\?limit=20', \{ method: 'GET' \}\)/,
    );
  });

  it("Danger-zone framing pinned: 'Account deletion is irreversible. All sessions, profiles, API keys, and webhook endpoints are immediately revoked. Recordings are hard-deleted from R2 within 14 days. Invoice history retained per EU tax law (10 years) — not deletable on request.' + 'Pre-launch: deletion is processed by emailing support@driftstack.dev. Self-service deletion endpoint lands post-launch.' — pinned so the irreversibility + 14d R2 hard-delete + 10y EU tax retention + the pre-launch-via-email path all survive", () => {
    expect(body).toMatch(
      /All sessions, profiles, API keys,\s*\n?\s*and webhook endpoints are immediately revoked\. Recordings are hard-\s*\n?\s*deleted from R2 within 14 days\. Invoice history retained per EU tax\s*\n?\s*law \(10 years\) — not deletable on request\./,
    );
    expect(body).toMatch(
      /href="mailto:support@driftstack\.dev\?subject=Account%20deletion%20request"/,
    );
  });

  it("V-331b act-as header in authedFetch — pinned so the team-scoped flow propagates to settings reads/writes (drift would let team managers accidentally modify their OWN email prefs / MFA when trying to manage a team-mate's account)", () => {
    expect(body).toMatch(
      /\/\/ V-331b — act-as header for team-scoped requests\.\s*\n?\s*\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n?\s*\? window\.driftstackActAsHeaders\(\)\s*\n?\s*: \{\}\),/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

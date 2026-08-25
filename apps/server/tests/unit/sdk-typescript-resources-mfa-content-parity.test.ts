// W427.A (W661-deepened) — drift guard for packages/sdk-typescript/
// src/resources/mfa.ts. V-353b/V-353e/V-448 MFA TS parity.
//
// W661 splits the original 12 it() blocks into 18 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • CRITICAL Per-account-NOT-team-RBAC invariant pinned: "the
//     V-326e X-Driftstack-Account team-RBAC header is not honored
//     — MFA is per-account, not per-team-context." Drift to
//     honoring the header would let a team member with bearer-
//     token access to the owner's account set up MFA on the
//     owner's account (silent auth-surface widening).
//   • TOTP parameter literal-type triplet (algorithm 'SHA1' +
//     digits 6 + period_seconds 30) — pinned per-line as TS
//     LITERAL types (not just strings). Drift to a different
//     algorithm/digits/period without coordinated server+client
//     update would silently break authenticator-app pairings.
//   • Show-ONCE invariants — secret_base32 on enroll AND
//     recovery_codes on verify AND recovery_codes on regenerate.
//     Each pinned because the customer must persist them now;
//     the server stores only encrypted-at-rest secrets + one-way
//     recovery code hashes.
//   • Literal 'disable-mfa' confirmation phrase on MfaDisableRequest
//     — typo-safe destructive-action gate. Drift to allowing free-
//     form strings would let "yes" / "ok" / typos accidentally
//     disable MFA.
//   • V-353e 15-min step-up gate on disable — pinned per-line.
//     Drift to skipping the step-up check would let MFA be
//     disabled with stale auth.
//   • Recovery-codes-invalidated side-effect on disable — drift
//     to NOT invalidating would let recovery codes survive
//     past disable and re-enable, giving a stale escape hatch.
//   • Auth.mfaChallenge/mfaStepUp pairing pinned — drift to
//     dropping the pairing reference would lose the navigation
//     breadcrumb that connects enrollment to login.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/mfa.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W427.A packages/sdk-typescript/src/resources/mfa.ts content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module header V-353b/V-448 anchor on the resource line', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /\/\/ MfaResource — typed methods for \/v1\/account\/mfa\/\* \(V-353b\/V-448\)\./,
    );
  });

  it('Enrollment management scope pinned with 5-verb list (status / enroll / verify / disable / regenerate recovery codes) + "Uses the calling web-session bearer". CRITICAL: drift to using an API-key bearer would break the web-session-only MFA enrollment flow (API keys are NOT supposed to enroll/disable MFA on the account).', () => {
    expect(body).toMatch(
      /\/\/ Enrollment management \(status \/ enroll \/ verify \/ disable \/ regenerate\s*\/\/ recovery codes\)\. Uses the calling web-session bearer;/,
    );
  });

  it('CRITICAL Per-account-NOT-team-RBAC invariant pinned per-line: "the V-326e X-Driftstack-Account team-RBAC header is not honored — MFA is per-account, not per-team-context." Drift to honoring the header would let a team member with bearer-token access to the owner\'s account ENROLL MFA on the OWNER\'s account, locking the owner out. Silent auth-surface widening.', () => {
    expect(body).toMatch(
      /the V-326e\s*\/\/ X-Driftstack-Account team-RBAC header is not honored — MFA is per-\s*\/\/ account, not per-team-context\./,
    );
  });

  it('Pairs-with-auth navigation breadcrumb pinned: "Pairs with `client.auth.mfaChallenge` (login MFA exchange) + `client.auth.mfaStepUp` (V-353e step-up gate)." Drift to dropping the pairing reference would lose the discoverability link that helps customers find the login-side MFA verbs after they finish enrollment.', () => {
    expect(body).toMatch(
      /\/\/ Pairs with `client\.auth\.mfaChallenge` \(login MFA exchange\) \+\s*\/\/ `client\.auth\.mfaStepUp` \(V-353e step-up gate\)\./,
    );
  });

  it("Imports — HttpClient only (no @driftstack/api-types import). MFA shapes are SDK-INTERNAL, not re-exported. Drift to importing from api-types would force MFA shapes into the Zod schema that's also consumed by the dashboard — but the MFA shapes are designed for SDK ergonomics (literal types for SHA1/6/30) which are awkward in Zod.", () => {
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).not.toMatch(/from '@driftstack\/api-types'/);
  });

  it('MfaStatusResponse — 4-field shape: enrolled (bool) + enrolled_at (nullable string) + last_used_at (nullable string) + unused_recovery_codes (number). CRITICAL: unused_recovery_codes is what lets the dashboard NAG customers when they\'ve burnt through their codes and should regenerate before lockout (e.g. "You have 2 recovery codes left — generate more"). Drift to dropping the count would lose the nag-banner trigger.', () => {
    expect(body).toMatch(
      /export interface MfaStatusResponse \{\s*enrolled: boolean;\s*enrolled_at: string \| null;\s*last_used_at: string \| null;\s*unused_recovery_codes: number;\s*\}/,
    );
  });

  it("CRITICAL MfaEnrollResponse — TOTP parameter literal-type triplet pinned as TS LITERAL types (not just `string` / `number`): `algorithm: 'SHA1'` + `digits: 6` + `period_seconds: 30`. Drift to widening to `string` / `number` would silently accept SHA256 or 8-digit codes from server-side changes; widening would also lose the type-system enforcement that authenticator-app pairings stay stable. otpauth_uri (QR code) + secret_base32 (manual entry fallback) both pinned.", () => {
    expect(body).toMatch(
      /export interface MfaEnrollResponse \{\s*\/\*\* otpauth:\/\/ URI for QR-code rendering in an authenticator app\. \*\/\s*otpauth_uri: string;\s*\/\*\* Plaintext base32-encoded TOTP secret for manual entry\. \*\/\s*secret_base32: string;\s*algorithm: 'SHA1';\s*digits: 6;\s*period_seconds: 30;\s*\}/,
    );
  });

  it('MfaVerifyRequest — single field `code: string` with "First 6-digit TOTP code from the customer\'s authenticator app" framing. The "first" wording is load-bearing — it tells customers verify is one-shot enrollment-confirmation, NOT an ongoing login-challenge (those live on auth.mfaChallenge).', () => {
    expect(body).toMatch(
      /export interface MfaVerifyRequest \{\s*\/\*\* First 6-digit TOTP code from the customer's authenticator app\. \*\/\s*code: string;\s*\}/,
    );
  });

  it('CRITICAL MfaVerifyResponse — single field `recovery_codes: string[]` with "10 single-use recovery codes; shown ONCE" framing. Drift to dropping "shown ONCE" would lose the customer-facing warning. Drift to a different count than 10 would mismatch dashboard rendering. Drift to multi-use codes would invert the single-use security model. This shape is also re-used by regenerateRecoveryCodes (same wire shape).', () => {
    expect(body).toMatch(
      /export interface MfaVerifyResponse \{\s*\/\*\* 10 single-use recovery codes; shown ONCE\. \*\/\s*recovery_codes: string\[\];\s*\}/,
    );
  });

  it('CRITICAL MfaDisableRequest — literal `\'disable-mfa\'` confirmation phrase as TS LITERAL type. Drift to widening to `string` would let "yes" / "ok" / typos accidentally disable MFA. Typo-safe destructive-action gate — drift to dropping the literal would invert the safety model.', () => {
    expect(body).toMatch(
      /export interface MfaDisableRequest \{\s*\/\*\* Literal 'disable-mfa' confirmation phrase\. \*\/\s*confirm: 'disable-mfa';\s*\}/,
    );
  });

  it('MfaResource class declaration + private-readonly http constructor field.', () => {
    expect(body).toMatch(/^export class MfaResource \{$/m);
    expect(body).toMatch(/constructor\(private readonly http: HttpClient\) \{\}/);
  });

  it('status verb — GET /v1/account/mfa → Promise<MfaStatusResponse>. Single-line implementation. No body, no auth state — just reads enrollment state.', () => {
    expect(body).toMatch(/\/\*\* Read MFA enrollment state for the calling account\. \*\//);
    expect(body).toMatch(
      /status\(\): Promise<MfaStatusResponse> \{\s*return this\.http\.request<MfaStatusResponse>\(\{\s*method: 'GET',\s*path: '\/v1\/account\/mfa',\s*\}\);\s*\}/,
    );
  });

  it('enroll verb — POST /v1/account/mfa/enroll with EXPLICIT `body: {}` empty object. JSDoc pinned per-line: customer scans otpauth_uri → calls verify with first code → server stores secret encrypted at rest → plaintext shown ONCE here. Drift to omitting `body: {}` would silently send no body, but the server expects a JSON object; drift to including any field would force POSTed input.', () => {
    expect(body).toMatch(
      /\*\s*Start TOTP enrollment\. Customer scans `otpauth_uri` with their\s*\*\s*authenticator app, then calls `verify\(\.\.\.\)` with the first\s*\*\s*6-digit code\. Server stores the secret encrypted at rest;\s*\*\s*plaintext is shown ONCE here\./,
    );
    expect(body).toMatch(
      /enroll\(\): Promise<MfaEnrollResponse> \{\s*return this\.http\.request<MfaEnrollResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/account\/mfa\/enroll',\s*body: \{\},\s*\}\);\s*\}/,
    );
  });

  it('verify verb — POST /v1/account/mfa/verify with MfaVerifyRequest body → Promise<MfaVerifyResponse> (returns 10 recovery codes). "Confirm enrollment with the first code. Returns 10 recovery codes" JSDoc pinned. Drift to allowing verify without enroll would let customers skip the enrollment-pairing step.', () => {
    expect(body).toMatch(
      /\/\*\* Confirm enrollment with the first code\. Returns 10 recovery codes\. \*\//,
    );
    expect(body).toMatch(
      /verify\(body: MfaVerifyRequest\): Promise<MfaVerifyResponse> \{\s*return this\.http\.request<MfaVerifyResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/account\/mfa\/verify',\s*body,\s*\}\);\s*\}/,
    );
  });

  it('CRITICAL disable verb — DELETE /v1/account/mfa with MfaDisableRequest body. V-353e step-up gate framing pinned per-line: "Requires fresh MFA proof per V-353e step-up gate (15-minute freshness window) — call `client.auth.mfaStepUp(...)` first if the gate is stale." + "Recovery codes are invalidated." Drift to skipping the step-up check would let MFA be disabled with stale auth — a stolen session 16+ minutes old could disable MFA without re-proving. Drift to NOT invalidating recovery codes on disable would leave them valid for a future re-enroll, defeating the disable-as-reset semantic.', () => {
    expect(body).toMatch(
      /\*\s*Disable MFA\. Requires fresh MFA proof per V-353e step-up gate\s*\*\s*\(15-minute freshness window\) — call `client\.auth\.mfaStepUp\(\.\.\.\)`\s*\*\s*first if the gate is stale\. Recovery codes are invalidated\./,
    );
    expect(body).toMatch(
      /disable\(body: MfaDisableRequest\): Promise<void> \{\s*return this\.http\.request<void>\(\{\s*method: 'DELETE',\s*path: '\/v1\/account\/mfa',\s*body,\s*\}\);\s*\}/,
    );
  });

  it('regenerateRecoveryCodes verb — POST /v1/account/mfa/recovery-codes/regenerate with empty `body: {}` → Promise<MfaVerifyResponse>. "Mint 10 fresh recovery codes. Old codes invalidated; shown ONCE." Drift to NOT invalidating old codes would let stale codes survive past regeneration — defeating the rotation purpose. Drift to a different count than 10 would mismatch the verify shape (same response interface re-used).', () => {
    expect(body).toMatch(
      /\/\*\* Mint 10 fresh recovery codes\. Old codes invalidated; shown ONCE\. \*\//,
    );
    expect(body).toMatch(
      /regenerateRecoveryCodes\(\): Promise<MfaVerifyResponse> \{\s*return this\.http\.request<MfaVerifyResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/account\/mfa\/recovery-codes\/regenerate',\s*body: \{\},\s*\}\);\s*\}/,
    );
  });

  it('5-verb inventory + verb-mix invariants — exactly 5 method declarations (status + enroll + verify + disable + regenerateRecoveryCodes). Verb mix: 1 GET (status) + 3 POSTs (enroll + verify + regenerateRecoveryCodes) + 1 DELETE (disable). NO PATCH/PUT — MFA state transitions are atomic (enroll/verify/regen mints fresh secret; disable hard-deletes). ZERO partial-update verbs.', () => {
    const methods = body.match(/^ {2}(?!constructor)[a-zA-Z]+\(/gm) ?? [];
    expect(methods.length, 'expected 5 verb declarations').toBe(5);
    const gets = (body.match(/method: 'GET'/g) ?? []).length;
    expect(gets, 'expected 1 GET (status)').toBe(1);
    const posts = (body.match(/method: 'POST'/g) ?? []).length;
    expect(posts, 'expected 3 POSTs (enroll + verify + regenerateRecoveryCodes)').toBe(3);
    const deletes = (body.match(/method: 'DELETE'/g) ?? []).length;
    expect(deletes, 'expected 1 DELETE (disable)').toBe(1);
    expect(body).not.toMatch(/method: 'PATCH'/);
    expect(body).not.toMatch(/method: 'PUT'/);
  });

  it('Show-ONCE invariant appears in EXACTLY 3 places (enroll JSDoc + MfaVerifyResponse field comment + regenerateRecoveryCodes JSDoc). Drift to dropping the "shown ONCE" wording in any would lose the customer-facing warning. The 3-count is the load-bearing assertion — all 3 secret-emitting verbs MUST carry the warning.', () => {
    const onceMatches = body.match(/\bONCE\b/g) ?? [];
    expect(
      onceMatches.length,
      'expected 3 ONCE mentions (enroll + MfaVerifyResponse + regenerate)',
    ).toBe(3);
  });

  it('Wire-path inventory — exactly 4 DISTINCT /v1/account/mfa paths: bare /v1/account/mfa (status GET + disable DELETE share) + /v1/account/mfa/enroll + /v1/account/mfa/verify + /v1/account/mfa/recovery-codes/regenerate. Status and disable share the bare path (verb-as-discriminator). Drift to adding a 5th path without a 6th verb would break the path-verb cardinality.', () => {
    const paths = body.match(/path: '\/v1\/account\/mfa[^']*'/g) ?? [];
    expect(
      paths.length,
      'expected 5 path: literals (status + enroll + verify + disable + regen)',
    ).toBe(5);
    const unique = new Set(paths);
    expect(
      unique.size,
      'expected 4 DISTINCT paths (status+disable share bare /v1/account/mfa)',
    ).toBe(4);
  });
});

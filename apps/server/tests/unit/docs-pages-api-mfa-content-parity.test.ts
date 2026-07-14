// W767 — apps/docs api/mfa.md content parity. Ninety-third in the
// cross-SDK drift-guard series.
//
// /api/mfa is the canonical reference for TOTP + recovery codes +
// step-up. Drift to RFC 6238 SHA-1 defaults, the 15-min step-up
// freshness window, the 5-min challenge TTL, or the 10-recovery-code
// shape would mismatch W759 dashboard /settings + W755 audit-log +
// V-353h server-side enforcement.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/mfa.md');

describe('W767 docs /api/mfa content parity', () => {
  it('api/mfa.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned. Description threads TOTP + recovery codes + step-up + /v1/account/mfa + /v1/auth/mfa endpoints.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Two-factor authentication \(MFA\)\n/,
    );
    expect(p).toMatch(
      /description: TOTP enrollment, verification, login challenge, step-up reauth, recovery codes — the \/v1\/account\/mfa and \/v1\/auth\/mfa endpoints\./,
    );
  });

  it("CRITICAL RFC 6238 TOTP + recovery codes framing pinned. The 'time-based one-time passwords (TOTP) per RFC 6238 plus single-use recovery codes' wording is the canonical algorithm anchor.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Driftstack supports time-based one-time passwords \(TOTP\) per RFC 6238/);
    expect(p).toMatch(/plus single-use recovery codes\./);
  });

  it("CRITICAL 15-minute step-up freshness window pinned. The 'most sensitive operations (disabling MFA; future: account deletion) require a fresh code within a 15-minute window' wording matches W764 /api/auth + W759 dashboard /settings step-up.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /the most\s*\n?sensitive operations \(disabling MFA; future: account deletion\) require\s*\n?a fresh code within a 15-minute window\./,
    );
  });

  it("CRITICAL enroll fresh-secret-on-each-call framing pinned. The 'Re-calling /enroll while still pending (no /verify yet) is OK — each call returns a fresh secret. The customer\\'s authenticator app should be re-scanned each time.' wording explains the no-double-secret-stash framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Re-calling `\/enroll` while still pending \(no `\/verify` yet\) is OK —\s*\n?each call returns a fresh secret\./,
    );
  });

  it("CRITICAL enroll-while-already-enrolled returns 409 framing pinned. The 'If MFA is **already enrolled**, the endpoint returns 409 Conflict. Disable first via DELETE /v1/account/mfa, then re-enroll' wording is the load-bearing state-machine framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/If MFA is \*\*already enrolled\*\*, the endpoint returns `409 Conflict`\./);
    expect(p).toMatch(/Disable first via `DELETE \/v1\/account\/mfa`, then re-enroll\./);
  });

  it('CRITICAL verify ±1 window drift tolerance (90s total) framing pinned. Drift to a wider window would weaken security; drift to a narrower would fail legitimate customers with clock skew.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The server checks the 6-digit against the pending secret with ±1\s*\n?window drift tolerance \(90 seconds total\)\./,
    );
  });

  it("CRITICAL 10 recovery codes shown-ONCE framing pinned. The '**Recovery codes are shown ONCE.**' callout + 'Without your authenticator AND these codes, account access requires support intervention' wording matches W759 dashboard /settings + W750 api-keys shown-ONCE security pattern.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Recovery codes are shown ONCE\.\*\*/);
    expect(p).toMatch(
      /Without your authenticator AND these codes, account\s*\n?> access requires support intervention\./,
    );
    expect(p).toMatch(/marks the\s*\n?enrollment active and returns 10 single-use recovery codes:/);
  });

  it("CRITICAL verify-failure-keeps-pending-secret framing pinned. The 'If the code is invalid, the endpoint returns 400 Bad Request. The pending secret stays alive — the customer can retype within the authenticator\\'s window' wording is what prevents lock-out on typo.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /If the code is invalid, the endpoint returns `400 Bad Request`\. The\s*\n?pending secret stays alive — the customer can retype within the\s*\n?authenticator's window\./,
    );
  });

  it('CRITICAL status response shape pinned — enrolled / enrolled_at / last_used_at / unused_recovery_codes. Matches W759 dashboard /settings mfa-recovery-remaining display.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"enrolled": true/);
    expect(p).toMatch(/"enrolled_at":/);
    expect(p).toMatch(/"last_used_at":/);
    expect(p).toMatch(/"unused_recovery_codes": 9/);
  });

  it('CRITICAL challenge-token 5-minute TTL + single-use + IP-bound framing pinned. Drift would mismatch W764 auth.md challenge_token wording. The IP-bind is the load-bearing CSRF/token-theft defense.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The token is valid for 5 minutes, single-use, and bound to the\s*\n?issuing IP address\./,
    );
  });

  it("CRITICAL challenge body accepts code OR recovery_code framing pinned. The 'hyphen optional; codes normalize to uppercase + no separators internally' wording explains the canonical recovery-code parsing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Or use a recovery code \(hyphen optional; codes normalize to upper-\s*\n?case \+ no separators internally\):/,
    );
  });

  it('CRITICAL challenge via discriminator pinned — totp | recovery + recovery-code-consumed-permanently framing. Matches W764 /api/auth via discriminator + W755 /audit-log account.recovery_code_used.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`via` is `"totp"` when matched against the 6-digit; `"recovery"` when\s*\n?a recovery code was consumed\. Recovery-code success consumes the row\s*\n?permanently — it can't be used again\./,
    );
  });

  it('CRITICAL challenge 4-failure-mode list pinned — invalid code / token expired / IP mismatch / re-use. The token-not-consumed-on-invalid-code clause is what prevents typo-lockout.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Invalid 6-digit \/ recovery code: `400 Bad Request`\. Token is NOT\s*\n?\s+consumed; customer can retype\./,
    );
    expect(p).toMatch(/Token expired or unknown: `400 Bad Request`\./);
    expect(p).toMatch(
      /Token \+ IP mismatch: `400 Bad Request`\. Defense against challenge-\s*\n?\s+token theft from chat \/ email paste; legitimate caller is on the\s*\n?\s+same IP\./,
    );
    expect(p).toMatch(/Token already consumed \(re-use after success\): `400 Bad Request`\./);
  });

  it('CRITICAL recovery and linked-IDP session minting cannot bypass enrolled MFA', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Magic-link consume, password-reset confirm, and linked-IdP\/OAuth\s*\n?sign-in use the same MFA gate as password login\./,
    );
    expect(p).toMatch(
      /each returns the `mfa_required` challenge shape above and\s*\n?mints \*\*no web session\*\* until `\/v1\/auth\/mfa\/challenge` succeeds/,
    );
    expect(p).toMatch(/A mailbox or IdP assertion is the first\s*\n?factor/);
    expect(p).toMatch(
      /Password reset changes the password and invalidates predecessor web\s*\n?sessions before returning that challenge/,
    );
    expect(p).toMatch(
      /Email verification is the\s*\n?signup-activation flow and does not challenge an existing enrolled\s*\n?factor/,
    );
  });

  it('CRITICAL step-up 403 envelope shape pinned — application/problem+json + requires_mfa_step_up: true + reason discriminator. Drift to a different problem+json type URI would break SDK error handlers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Content-Type: application\/problem\+json/);
    expect(p).toMatch(/"type": "https:\/\/errors\.driftstack\.dev\/mfa-step-up-required"/);
    expect(p).toMatch(/"requires_mfa_step_up": true/);
    expect(p).toMatch(/"reason": "never_satisfied"/);
  });

  it("CRITICAL step-up reason 2-state enum — never_satisfied | expired framing pinned. The 'never_satisfied when the calling session has never passed an MFA challenge (e.g. a session issued by signup-verify before MFA was enrolled), and expired when the freshness window (15 minutes) has elapsed since the last successful challenge' wording is the canonical reason taxonomy.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`reason` is `"never_satisfied"` when the calling session has never\s*\n?passed an MFA challenge \(e\.g\. a session issued by signup-verify\s*\n?before MFA was enrolled\), and `"expired"` when the freshness window\s*\n?\(15 minutes\) has elapsed since the last successful challenge\./,
    );
  });

  it('CRITICAL machine-auth separation: generic step-up carve-out cannot authorize MFA credential management', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The generic step-up middleware has a machine-auth carve-out because an API key\s*\n?has no human session to refresh\. MFA credential-management routes do not rely\s*\n?on that carve-out: they reject API-key bearers before step-up evaluation\./,
    );
    expect(p).toMatch(
      /`POST \/v1\/auth\/mfa\/step-up` itself also returns 403 for an API key because\s*\n?there is no session row to refresh\./,
    );
  });

  it('CRITICAL disable triple-gate framing pinned — (1) web-session bearer (2) fresh MFA proof (3) confirm body field. Drift to dropping any layer would let accidental disable slip through.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /1\. Interactive web-session bearer; API-key bearers are rejected even when the\s*\n?\s+key has `account_owner`\./,
    );
    expect(p).toMatch(/2\. A fresh MFA proof \(15-minute window\)/);
    expect(p).toMatch(
      /3\. The `confirm: "disable-mfa"` body field — defensive layer beneath\s*\n?\s+the gate so a stray client request can't accidentally disable\./,
    );
  });

  it('CRITICAL all MFA credential changes require an interactive web session while status remains machine-readable', () => {
    const p = read(PAGE);

    expect(p).toMatch(/MFA credential changes are interactive-account operations\./);
    expect(p).toMatch(/API keys cannot call them, even with `account_owner`\./);
    expect(p).toMatch(/`GET \/v1\/account\/mfa` remains available/);
    expect(p).toMatch(/cannot replace the\s*\n?human account's recovery credentials\./);
  });

  it("CRITICAL disable-clears-TOTP-secret + all-unused-recovery-codes framing pinned. The 'Disabling clears the TOTP secret AND every unused recovery code. Re-enabling requires the full enrollment dance from scratch.' wording matches W759 dashboard /settings disable-confirm framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Disabling clears the TOTP secret AND every unused recovery code\./);
    expect(p).toMatch(/Re-enabling requires the full enrollment dance from scratch\./);
  });

  it("CRITICAL recovery-codes regenerate IS-step-up-gated framing pinned. The 'This endpoint is step-up gated, the same as MFA disable and account-delete … Without the gate a stolen web session could mint fresh recovery codes, then redeem one to satisfy step-up on disable — a full MFA bypass' wording is the load-bearing security policy.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /This endpoint \*\*is\*\* step-up gated, the same as MFA disable and\s*\n?account-delete: a stale web session returns the `403` step-up\s*\n?envelope above \(`requires_mfa_step_up: true`\)\./,
    );
    expect(p).toMatch(
      /Without the gate a\s*\n?stolen web session could mint fresh recovery codes, then redeem one\s*\n?to satisfy step-up on disable — a full MFA bypass\./,
    );
    expect(p).toMatch(
      /The legitimate\s*\n?lost-device-but-logged-in flow still works: an existing recovery\s*\n?code satisfies `POST \/v1\/auth\/mfa\/step-up` before regenerating\./,
    );
    // Ban the superseded "NOT step-up gated" policy — the corrected doc reversed it
    // (regenerate IS gated, to close the mint-then-redeem MFA-bypass).
    expect(p).not.toMatch(/this endpoint is NOT step-up gated/i);
  });

  it('CRITICAL Algorithm details table pinned with 10 rows — Algorithm/Period/Digits/Drift tolerance/Issuer/At-rest encryption/Recovery code shape+count+hash + Challenge TTL + Step-up freshness. Drift to dropping any row would silently break SDK consumers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\| Algorithm\s+\| SHA-1\s+\|/);
    expect(p).toMatch(/\| Period\s+\| 30 seconds\s+\|/);
    expect(p).toMatch(/\| Digits\s+\| 6\s+\|/);
    expect(p).toMatch(/\| Drift tolerance\s+\| ±1 window \(90s total\)\s+\|/);
    expect(p).toMatch(/\| Issuer\s+\| `Driftstack`\s+\|/);
    expect(p).toMatch(/\| At-rest encryption\s+\| AES-256-GCM \(env-keyed\)\s+\|/);
    expect(p).toMatch(/\| Recovery code shape\s+\| 10 chars, Crockford base32\s+\|/);
    expect(p).toMatch(/\| Recovery code count\s+\| 10 per enrollment \/ regenerate\s+\|/);
    expect(p).toMatch(/\| Recovery code hash\s+\| scrypt-kdf \(same as API keys\)\s+\|/);
    expect(p).toMatch(/\| Challenge token TTL\s+\| 5 minutes\s+\|/);
    expect(p).toMatch(/\| Step-up freshness\s+\| 15 minutes\s+\|/);
  });

  it("CRITICAL SHA-1 RFC-default framing pinned. The 'SHA-1 is the RFC 6238 default and what every authenticator app (Google Authenticator, 1Password, Authy, Bitwarden, etc.) supports. SHA-256/SHA-512 are out of scope for v1.' wording is the canonical compatibility framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /SHA-1 is the RFC 6238 default and what every authenticator app\s*\n?\(Google Authenticator, 1Password, Authy, Bitwarden, etc\.\) supports\./,
    );
    expect(p).toMatch(/SHA-256\/SHA-512 are out of scope for v1\./);
  });

  it('CRITICAL 4-row audit-log table pinned — account.mfa_enrolled / account.mfa_disabled / account.recovery_code_used / account.login (with mfa_totp/mfa_recovery payload). Matches W755 /audit-log enum + V-398 expansion.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`account\.mfa_enrolled`\s+\|\s+First successful `\/verify`/);
    expect(p).toMatch(/`account\.mfa_disabled`\s+\|\s+Successful disable/);
    expect(p).toMatch(
      /`account\.recovery_code_used`\s+\|\s+Recovery code consumed \(login or step-up\)/,
    );
    expect(p).toMatch(
      /`account\.login`\s+\|\s+Successful challenge exchange \(with `method: mfa_totp` or `mfa_recovery` payload\)/,
    );
  });

  it('CRITICAL 7-endpoint canonical action set pinned — POST /v1/account/mfa/enroll + POST /v1/account/mfa/verify + GET /v1/account/mfa + DELETE /v1/account/mfa + POST /v1/account/mfa/recovery-codes/regenerate + POST /v1/auth/mfa/challenge + POST /v1/auth/mfa/step-up.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`POST \/v1\/account\/mfa\/enroll`/);
    expect(p).toMatch(/`POST \/v1\/account\/mfa\/verify`/);
    expect(p).toMatch(/`GET \/v1\/account\/mfa`/);
    expect(p).toMatch(/`DELETE \/v1\/account\/mfa`/);
    expect(p).toMatch(/`POST \/v1\/account\/mfa\/recovery-codes\/regenerate`/);
    expect(p).toMatch(/`POST \/v1\/auth\/mfa\/challenge`/);
    expect(p).toMatch(/`POST \/v1\/auth\/mfa\/step-up`/);
  });

  it('CRITICAL otpauth URI shape pinned — algorithm=SHA1 + digits=6 + period=30. Drift to non-default params would let some authenticator apps reject the QR.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /"otpauth_uri": "otpauth:\/\/totp\/Driftstack:you@example\.com\?secret=\.\.\.&issuer=Driftstack&algorithm=SHA1&digits=6&period=30"/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-api-mfa-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

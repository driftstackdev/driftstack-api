// W559.C — drift guard for /docs/architecture/v353-mfa-design.md.
// V-353 Tier-3 DRAFT awaiting founder verdict. Drift here either
// weakens the TOTP-only-v1-WebAuthn-deferred posture, drops the
// AES-256-GCM-env-key-vs-KMS open question, or loosens the 15-min
// step-up freshness window.
//
//   • V-353. Tier-3 blocking review. DRAFT — code paused.
//   • Catalog row V-301 MFA / TOTP setup + recovery codes.
//   • TOTP RFC 6238 30s SHA-1. 10 single-use recovery codes scrypt.
//   • account_mfa + account_mfa_recovery_codes + web_sessions.
//     mfa_satisfied_at schema.
//   • Encryption-at-rest: A=env-key (proposed v1) vs B=KMS-derived.
//   • Step-up: account-delete + MFA-disable minimum v1.
//   • 15-min MFA-fresh window.
//   • POST /v1/auth/password → mfa_required+challenge_token →
//     POST /v1/auth/mfa/challenge → session.
//   • Recovery codes: 10 shown ONCE, base32-no-ambiguous, single-use.
//   • 8-open-question + 6-non-decision-autonomous + 8-implementation
//     order V-353a..h.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/architecture/v353-mfa-design.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W559.C /docs/architecture/v353-mfa-design.md content parity', () => {
  const body = read(LIB);

  it("Header + V-353-DRAFT + Tier-3-blocking + V-301-catalog framing pinned: '# V-353 — MFA design pre-check (DRAFT, awaiting founder verdict)' + '**Status:** DRAFT — Tier-3 blocking review per agent-autonomy guidance.' + 'Security architecture decisions need founder confirmation BEFORE code lands.' + '**Spec source:** planning files' + '[18-security-architecture.md](../../../driftstack/docs/planning/18-security-architecture.md)' + '[47-customer-dashboard-ui.md](../../../driftstack/docs/planning/47-customer-dashboard-ui.md)' + 'The V-294 catalog calls this \"V-301 MFA / TOTP setup + recovery codes' + '(security gate per planning file 47).\"' + 'We're implementing it under the slice number `V-353` per the running V-NNN cadence' + '\"V-301\" remains the catalog row id.' — pinned so the V-353-DRAFT-Tier-3-blocking + planning-file-18+47-spec-source + V-294-catalog-V-301-row commitment survives", () => {
    expect(body).toMatch(/^# V-353 — MFA design pre-check \(DRAFT, awaiting founder verdict\)$/m);
    expect(body).toMatch(
      /\*\*Status:\*\* DRAFT — Tier-3 blocking review per agent-autonomy guidance\./,
    );
    expect(body).toMatch(
      /Security architecture decisions need founder confirmation BEFORE code lands\./,
    );
    expect(body).toMatch(/\*\*Spec source:\*\* planning files/);
    expect(body).toMatch(
      /\[18-security-architecture\.md\]\(\.\.\/\.\.\/\.\.\/driftstack\/docs\/planning\/18-security-architecture\.md\)/,
    );
    expect(body).toMatch(
      /\[47-customer-dashboard-ui\.md\]\(\.\.\/\.\.\/\.\.\/driftstack\/docs\/planning\/47-customer-dashboard-ui\.md\)/,
    );
    expect(body).toMatch(/The V-294 catalog calls this "V-301 MFA \/ TOTP setup \+ recovery codes/);
    expect(body).toMatch(/\(security gate per planning file 47\)\."/);
    expect(body).toMatch(/We're implementing it under the/);
    expect(body).toMatch(/slice number `V-353` per the running V-NNN cadence; "V-301" remains the/);
    expect(body).toMatch(/catalog row id\./);
  });

  it("Scope v1 + deferred-followup framing pinned: '## 1. Scope (proposed)' + '**v1 (this cycle):**' + 'TOTP enrollment + verification (RFC 6238, 30s window, SHA-1).' + '10 single-use recovery codes (scrypt-hashed at rest, like API keys).' + 'Per-account MFA on/off toggle in /settings/security.' + 'Login challenge: web password sign-in returns' + '`{ mfa_required: true, challenge_token }`' + '`/v1/auth/mfa/challenge`' + 'Step-up gate on a small set of sensitive ops (see §4).' + 'Audit emit (`account.mfa_enrolled`, `account.mfa_disabled`,' + '`account.mfa_challenge_succeeded`, `account.mfa_challenge_failed`,' + '`account.recovery_code_used`).' + '**Deferred to follow-up slice(s):**' + 'WebAuthn / hardware keys (planning file 18 lists this; bigger slice).' + 'SMS fallback (planning file 18 explicitly downgrades SMS as' + 'GUI / Tauri client MFA handling' + 'Admin panel MFA (catalog row V-333 is \"separate auth + mandatory' + 'TOTP\" for admins — different surface, separate slice).' + 'Step-up reauth for ALL writes — v1 only gates the highest-impact ops.' — pinned so the RFC-6238-30s-SHA-1 + 10-recovery-scrypt + mfa_required+challenge_token + 5-audit-event + 5-deferred (WebAuthn + SMS + GUI + admin-V-333 + step-up-all-writes) commitment survives", () => {
    expect(body).toMatch(/## 1\. Scope \(proposed\)/);
    expect(body).toMatch(/\*\*v1 \(this cycle\):\*\*/);
    expect(body).toMatch(/- TOTP enrollment \+ verification \(RFC 6238, 30s window, SHA-1\)\./);
    expect(body).toMatch(
      /- 10 single-use recovery codes \(scrypt-hashed at rest, like API keys\)\./,
    );
    expect(body).toMatch(/- Per-account MFA on\/off toggle in \/settings\/security\./);
    expect(body).toMatch(/- Login challenge: web password sign-in returns/);
    expect(body).toMatch(/`\{ mfa_required: true, challenge_token \}`/);
    expect(body).toMatch(/`\/v1\/auth\/mfa\/challenge`/);
    expect(body).toMatch(/- Step-up gate on a small set of sensitive ops \(see §4\)\./);
    expect(body).toMatch(/- Audit emit \(`account\.mfa_enrolled`, `account\.mfa_disabled`,/);
    expect(body).toMatch(/`account\.mfa_challenge_succeeded`, `account\.mfa_challenge_failed`,/);
    expect(body).toMatch(/`account\.recovery_code_used`\)\./);
    expect(body).toMatch(/\*\*Deferred to follow-up slice\(s\):\*\*/);
    expect(body).toMatch(
      /- WebAuthn \/ hardware keys \(planning file 18 lists this; bigger slice\)\./,
    );
    expect(body).toMatch(/- SMS fallback \(planning file 18 explicitly downgrades SMS as/);
    expect(body).toMatch(/- GUI \/ Tauri client MFA handling/);
    expect(body).toMatch(/- Admin panel MFA \(catalog row V-333 is "separate auth \+ mandatory/);
    expect(body).toMatch(/TOTP" for admins — different surface, separate slice\)\./);
    expect(body).toMatch(
      /- Step-up reauth for ALL writes — v1 only gates the highest-impact ops\./,
    );
  });

  it("Schema + encryption-at-rest framing pinned: '## 2. Schema (proposed)' + 'New table `account_mfa`:' + '`totp_secret_ciphertext` | bytea             | AES-256-GCM ciphertext of base32 TOTP secret.' + '`totp_secret_iv`         | bytea             | 12-byte GCM IV.' + '`totp_secret_tag`        | bytea             | 16-byte GCM auth tag.' + 'New table `account_mfa_recovery_codes`:' + '`code_hash`  | text              | scrypt(`raw_code`) — same KDF as API keys.' + '`used_at`    | timestamp \\| null | Single-use; non-null = consumed.' + 'Web session row gains `mfa_satisfied_at: timestamp | null`' + '## 3. Encryption-at-rest (open question)' + 'The TOTP secret CANNOT be hashed' + '**A. AES-256-GCM with a single env-supplied key** (`MFA_ENCRYPTION_KEY`)' + '**B. AES-256-GCM with a KMS-derived key** (HKDF from a Cloudflare /' + 'Hetzner-managed root). Cleaner rotation; more infra. Hetzner doesn't' + 'ship a managed KMS' + '**Proposed: A for v1**, surface key rotation as a future runbook item.' — pinned so the account_mfa-AES-256-GCM-12-IV-16-tag + account_mfa_recovery_codes-scrypt + web_sessions.mfa_satisfied_at + encryption-A-MFA_ENCRYPTION_KEY-vs-B-KMS-Hetzner-no-managed + A-for-v1-proposed commitment survives", () => {
    expect(body).toMatch(/## 2\. Schema \(proposed\)/);
    expect(body).toMatch(/New table `account_mfa`:/);
    expect(body).toMatch(
      /`totp_secret_ciphertext` \| bytea\s+\| AES-256-GCM ciphertext of base32 TOTP secret\./,
    );
    expect(body).toMatch(/`totp_secret_iv`\s+\| bytea\s+\| 12-byte GCM IV\./);
    expect(body).toMatch(/`totp_secret_tag`\s+\| bytea\s+\| 16-byte GCM auth tag\./);
    expect(body).toMatch(/New table `account_mfa_recovery_codes`:/);
    expect(body).toMatch(
      /`code_hash`\s+\| text\s+\| scrypt\(`raw_code`\) — same KDF as API keys\./,
    );
    expect(body).toMatch(/`used_at`\s+\| timestamp \\\| null \| Single-use; non-null = consumed\./);
    expect(body).toMatch(/Web session row gains `mfa_satisfied_at: timestamp \| null`/);
    expect(body).toMatch(/## 3\. Encryption-at-rest \(open question\)/);
    expect(body).toMatch(/The TOTP secret CANNOT be hashed/);
    expect(body).toMatch(
      /\*\*A\. AES-256-GCM with a single env-supplied key\*\* \(`MFA_ENCRYPTION_KEY`\)/,
    );
    expect(body).toMatch(
      /\*\*B\. AES-256-GCM with a KMS-derived key\*\* \(HKDF from a Cloudflare \//,
    );
    expect(body).toMatch(/Hetzner-managed root\)\. Cleaner rotation; more infra\. Hetzner doesn't/);
    expect(body).toMatch(/ship a managed KMS/);
    expect(body).toMatch(
      /\*\*Proposed: A for v1\*\*, surface key rotation as a future runbook item\./,
    );
  });

  it("Step-up + login-flow + recovery-codes framing pinned: '## 4. Step-up gate scope (open question — needs founder pick)' + 'Concrete v1 candidates:' + '| MFA disable                                | DELETE /v1/account/mfa                             | **Yes — always**' + '**Proposed minimum v1 step-up:** account deletion, MFA disable.' + '**Step-up window:** session is \"MFA-fresh\" for **15 minutes**' + '## 5. Login flow (proposed)' + 'POST /v1/auth/password' + 'if MFA enrolled:' + '200 { mfa_required: true, challenge_token: \"ds_mfac_...\" }' + 'POST /v1/auth/mfa/challenge' + 'on success: 200 { session_token, ... }   (sets mfa_satisfied_at)' + 'on fail:    401 InvalidMfaChallenge      (max 5 wrong codes;' + '`challenge_token` is opaque, server-side stored in Redis with 5min' + 'TTL, single-use exchange. Bound to email + IP at issuance' + '## 6. Recovery codes UX' + '10 codes shown ONCE at enrollment' + '10-char base32-no-ambiguous (no 0/O/1/I). Single-use.' + 'When all 10 are exhausted (or 7 used + customer asks)' — pinned so the MFA-disable-Yes-always + 15-minute-MFA-fresh + ds_mfac_-prefix + Redis-5min-TTL-IP-bound + 5-wrong-codes-burns-429 + 10-codes-shown-ONCE-base32-no-0/O/1/I commitment survives", () => {
    expect(body).toMatch(/## 4\. Step-up gate scope \(open question — needs founder pick\)/);
    expect(body).toMatch(/Concrete v1 candidates:/);
    expect(body).toMatch(/\| MFA disable\s+\| DELETE \/v1\/account\/mfa\s+\| \*\*Yes — always\*\*/);
    expect(body).toMatch(/\*\*Proposed minimum v1 step-up:\*\* account deletion, MFA disable\./);
    expect(body).toMatch(/\*\*Step-up window:\*\* session is "MFA-fresh" for \*\*15 minutes\*\*/);
    expect(body).toMatch(/## 5\. Login flow \(proposed\)/);
    expect(body).toMatch(/POST \/v1\/auth\/password/);
    expect(body).toMatch(/if MFA enrolled:/);
    expect(body).toMatch(/200 \{ mfa_required: true, challenge_token: "ds_mfac_\.\.\." \}/);
    expect(body).toMatch(/POST \/v1\/auth\/mfa\/challenge/);
    expect(body).toMatch(/on success: 200 \{ session_token, \.\.\. \}\s+\(sets mfa_satisfied_at\)/);
    expect(body).toMatch(/on fail:\s+401 InvalidMfaChallenge\s+\(max 5 wrong codes;/);
    expect(body).toMatch(/`challenge_token` is opaque, server-side stored in Redis with 5min/);
    expect(body).toMatch(/TTL, single-use exchange\. Bound to email \+ IP at issuance/);
    expect(body).toMatch(/## 6\. Recovery codes UX/);
    expect(body).toMatch(/10 codes shown ONCE at enrollment/);
    expect(body).toMatch(/modal with copy \+ download buttons\. Each code = 10-char base32-no-/);
    expect(body).toMatch(/ambiguous \(no 0\/O\/1\/I\)\. Single-use\./);
    expect(body).toMatch(/When all 10 are exhausted \(or 7 used \+ customer asks\)/);
  });

  it("Disclosure + 8-open-question + 6-non-decision framing pinned: '## 7. Disclosure (proposed)' + '**privacy.md §3.1 (Account data):** add \"MFA enrollment state +' + 'Same legal basis (Art 6(1)(b) + 6(1)(c) Art 32 security).' + '**No new sub-processor** (TOTP is device-local; recovery codes are' + '**DPA Annex 3:** no change (no new vendor).' + '## 8. Open questions for founder verdict' + 'TOTP-only for v1 with WebAuthn deferred — agree?' + 'Encryption-at-rest option A (env key, no KMS) — agree, or push' + 'Step-up scope: minimum (account-delete + MFA-disable)' + 'Step-up freshness window: 15 min — or different (5? 30? 60?)?' + 'MFA enforcement: optional opt-in for everyone v1' + 'Recovery code count: 10 single-use, regenerable — agree?' + 'GUI / Tauri MFA handling: out of scope for V-353, addressed in' + 'a follow-up V-353g once dashboard ships' + 'Pricing-tier gating: MFA available on all tiers' + '## 9. Non-decisions (agent-autonomous)' + 'TOTP algorithm: SHA-1 (RFC 6238 default; what every authenticator' + 'app supports). NOT SHA-256 — auth-app compatibility wins.' + 'Period: 30 seconds. Digits: 6.' + 'Issuer name in otpauth:// URI: `Driftstack`.' + 'Drift tolerance: ±1 window (90s effective). Standard.' + 'Rate limit on /mfa/challenge: 5 attempts per challenge_token,' + '20 challenges per account per hour.' — pinned so the 4-disclosure (privacy.md + Art-6(1)(b)/(c)+Art-32 + no-new-sub-processor + DPA-Annex-3-no-change) + 8-open-question + 6-non-decision (SHA-1 + 30s-6-digit + Driftstack-issuer + ±1-window + 5/challenge_token-20/hour) commitment survives", () => {
    expect(body).toMatch(/## 7\. Disclosure \(proposed\)/);
    expect(body).toMatch(
      /- \*\*privacy\.md §3\.1 \(Account data\):\*\* add "MFA enrollment state \+/,
    );
    expect(body).toMatch(/Same legal basis \(Art 6\(1\)\(b\) \+ 6\(1\)\(c\) Art 32 security\)\./);
    expect(body).toMatch(
      /- \*\*No new sub-processor\*\* \(TOTP is device-local; recovery codes are/,
    );
    expect(body).toMatch(/- \*\*DPA Annex 3:\*\* no change \(no new vendor\)\./);
    expect(body).toMatch(/## 8\. Open questions for founder verdict/);
    expect(body).toMatch(/1\. \*\*TOTP-only for v1 with WebAuthn deferred — agree\?\*\*/);
    expect(body).toMatch(
      /2\. \*\*Encryption-at-rest option A \(env key, no KMS\) — agree, or push/,
    );
    expect(body).toMatch(/3\. \*\*Step-up scope: minimum \(account-delete \+ MFA-disable\)/);
    expect(body).toMatch(
      /4\. \*\*Step-up freshness window: 15 min — or different \(5\? 30\? 60\?\)\?\*\*/,
    );
    expect(body).toMatch(/5\. \*\*MFA enforcement: optional opt-in for everyone v1/);
    expect(body).toMatch(/6\. \*\*Recovery code count: 10 single-use, regenerable — agree\?\*\*/);
    expect(body).toMatch(/7\. \*\*GUI \/ Tauri MFA handling: out of scope for V-353, addressed in/);
    expect(body).toMatch(/a follow-up V-353g once dashboard ships/);
    expect(body).toMatch(/8\. \*\*Pricing-tier gating: MFA available on all tiers/);
    expect(body).toMatch(/## 9\. Non-decisions \(agent-autonomous\)/);
    expect(body).toMatch(/- TOTP algorithm: SHA-1 \(RFC 6238 default; what every authenticator/);
    expect(body).toMatch(/app supports\)\. NOT SHA-256 — auth-app compatibility wins\./);
    expect(body).toMatch(/- Period: 30 seconds\. Digits: 6\./);
    expect(body).toMatch(/- Issuer name in otpauth:\/\/ URI: `Driftstack`\./);
    expect(body).toMatch(/- Drift tolerance: ±1 window \(90s effective\)\. Standard\./);
    expect(body).toMatch(/- Rate limit on \/mfa\/challenge: 5 attempts per challenge_token,/);
    expect(body).toMatch(/20 challenges per account per hour\./);
  });

  it("V-353a-h 8-implementation-order framing pinned: '## 10. Implementation order (post-verdict)' + '**V-353a** schema + migration (account_mfa, recovery codes,' + 'web_sessions.mfa_satisfied_at).' + '**V-353b** services: MfaService (enroll, verify, challenge,' + 'recovery-code consume), TotpEncryption helper.' + '**V-353c** routes: POST /v1/account/mfa/enroll +' + 'POST /v1/account/mfa/verify + DELETE /v1/account/mfa +' + 'POST /v1/account/mfa/recovery-codes/regenerate.' + '**V-353d** login wire-in: POST /v1/auth/password returns' + 'challenge_token; POST /v1/auth/mfa/challenge exchanges.' + '**V-353e** step-up gate: DELETE /v1/account (when it lands) +' + 'DELETE /v1/account/mfa require fresh MFA.' + '**V-353f** dashboard /settings/security: enroll flow with QR,' + 'recovery-code modal, disable button.' + '**V-353g** audit + email notifications' + '**V-353h** disclosure update + V-log + tests.' + 'Estimated total: ~10–14h once verdicts land.' — pinned so the V-353a-schema-migration + V-353b-MfaService-TotpEncryption + V-353c-4-route + V-353d-login-wire-in + V-353e-step-up-gate + V-353f-dashboard-settings-security + V-353g-audit-email + V-353h-disclosure + 10-14h-estimate commitment survives", () => {
    expect(body).toMatch(/## 10\. Implementation order \(post-verdict\)/);
    expect(body).toMatch(/1\. \*\*V-353a\*\* schema \+ migration \(account_mfa, recovery codes,/);
    expect(body).toMatch(/web_sessions\.mfa_satisfied_at\)\./);
    expect(body).toMatch(/2\. \*\*V-353b\*\* services: MfaService \(enroll, verify, challenge,/);
    expect(body).toMatch(/recovery-code consume\), TotpEncryption helper\./);
    expect(body).toMatch(/3\. \*\*V-353c\*\* routes: POST \/v1\/account\/mfa\/enroll \+/);
    expect(body).toMatch(/POST \/v1\/account\/mfa\/verify \+ DELETE \/v1\/account\/mfa \+/);
    expect(body).toMatch(/POST \/v1\/account\/mfa\/recovery-codes\/regenerate\./);
    expect(body).toMatch(/4\. \*\*V-353d\*\* login wire-in: POST \/v1\/auth\/password returns/);
    expect(body).toMatch(/challenge_token; POST \/v1\/auth\/mfa\/challenge exchanges\./);
    expect(body).toMatch(
      /5\. \*\*V-353e\*\* step-up gate: DELETE \/v1\/account \(when it lands\) \+/,
    );
    expect(body).toMatch(/DELETE \/v1\/account\/mfa require fresh MFA\./);
    expect(body).toMatch(/6\. \*\*V-353f\*\* dashboard \/settings\/security: enroll flow with QR,/);
    expect(body).toMatch(/recovery-code modal, disable button\./);
    expect(body).toMatch(/7\. \*\*V-353g\*\* audit \+ email notifications/);
    expect(body).toMatch(/8\. \*\*V-353h\*\* disclosure update \+ V-log \+ tests\./);
    expect(body).toMatch(/Estimated total: ~10–14h once verdicts land\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

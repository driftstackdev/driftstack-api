# V-353 — MFA design pre-check (DRAFT, awaiting founder verdict)

**Status:** DRAFT — Tier-3 blocking review per agent-autonomy guidance.
Security architecture decisions need founder confirmation BEFORE code lands.

**Spec source:** planning files
[18-security-architecture.md](../../../driftstack/docs/planning/18-security-architecture.md)

- [47-customer-dashboard-ui.md](../../../driftstack/docs/planning/47-customer-dashboard-ui.md).

The V-294 catalog calls this "V-301 MFA / TOTP setup + recovery codes
(security gate per planning file 47)." We're implementing it under the
slice number `V-353` per the running V-NNN cadence; "V-301" remains the
catalog row id.

---

## 1. Scope (proposed)

**v1 (this cycle):**

- TOTP enrollment + verification (RFC 6238, 30s window, SHA-1).
- 10 single-use recovery codes (scrypt-hashed at rest, like API keys).
- Per-account MFA on/off toggle in /settings/security.
- Login challenge: web password sign-in returns
  `{ mfa_required: true, challenge_token }` instead of session token
  when MFA is enrolled; client posts the 6-digit code to
  `/v1/auth/mfa/challenge` to exchange for the real session.
- Step-up gate on a small set of sensitive ops (see §4).
- Audit emit (`account.mfa_enrolled`, `account.mfa_disabled`,
  `account.mfa_challenge_succeeded`, `account.mfa_challenge_failed`,
  `account.recovery_code_used`).

**Deferred to follow-up slice(s):**

- WebAuthn / hardware keys (planning file 18 lists this; bigger slice).
- SMS fallback (planning file 18 explicitly downgrades SMS as
  less-secure-fallback; deferring entirely until WebAuthn lands).
- GUI / Tauri client MFA handling (the GUI uses the same
  `ds_web_session_token` after the dashboard sign-in; if dashboard
  gates correctly, the GUI inherits — but step-up on GUI-initiated
  sensitive ops needs its own thread).
- Admin panel MFA (catalog row V-333 is "separate auth + mandatory
  TOTP" for admins — different surface, separate slice).
- Step-up reauth for ALL writes — v1 only gates the highest-impact ops.

---

## 2. Schema (proposed)

New table `account_mfa`:

| Column                   | Type              | Notes                                              |
| ------------------------ | ----------------- | -------------------------------------------------- |
| `account_id`             | uuid (PK, FK)     | One row per enrolled account; absent row = no MFA. |
| `totp_secret_ciphertext` | bytea             | AES-256-GCM ciphertext of base32 TOTP secret.      |
| `totp_secret_iv`         | bytea             | 12-byte GCM IV.                                    |
| `totp_secret_tag`        | bytea             | 16-byte GCM auth tag.                              |
| `enrolled_at`            | timestamp         | Set on first successful 6-digit verify.            |
| `last_used_at`           | timestamp \| null | Updated on each challenge success.                 |
| `created_at`             | timestamp         |                                                    |
| `updated_at`             | timestamp         |                                                    |

New table `account_mfa_recovery_codes`:

| Column       | Type              | Notes                                      |
| ------------ | ----------------- | ------------------------------------------ |
| `id`         | uuid (PK)         |                                            |
| `account_id` | uuid (FK)         |                                            |
| `code_hash`  | text              | scrypt(`raw_code`) — same KDF as API keys. |
| `used_at`    | timestamp \| null | Single-use; non-null = consumed.           |
| `created_at` | timestamp         |                                            |

Web session row gains `mfa_satisfied_at: timestamp | null` (added to
existing `web_sessions` table). Null = MFA not yet exchanged on this
session; non-null = step-up gate looks at age.

---

## 3. Encryption-at-rest (open question)

The TOTP secret CANNOT be hashed (the verifier needs the plaintext to
recompute the 30s window). Two options:

**A. AES-256-GCM with a single env-supplied key** (`MFA_ENCRYPTION_KEY`).
Simple, consistent with how DEPLOY_DOTENV_BASE64 already injects
secrets. Rotation is hard — every row re-encrypted on key change.

**B. AES-256-GCM with a KMS-derived key** (HKDF from a Cloudflare /
Hetzner-managed root). Cleaner rotation; more infra. Hetzner doesn't
ship a managed KMS — would need a side-channel (sops-encrypted file?
Vault? Infisical?). Adds a sub-processor.

**Proposed: A for v1**, surface key rotation as a future runbook item.
Reason: keeps disclosure surface unchanged (no new sub-processor),
matches the existing secrets posture, and lets us ship.

---

## 4. Step-up gate scope (open question — needs founder pick)

Planning file 18 §122–124 lists "account closure, payment method
changes, KYB updates, billing tier changes" as step-up candidates.
Concrete v1 candidates:

| Op                                         | Endpoint                                           | Gate?                       |
| ------------------------------------------ | -------------------------------------------------- | --------------------------- |
| Account deletion (when self-service lands) | DELETE /v1/account                                 | Yes                         |
| Subscription tier change via Stripe portal | redirect to portal                                 | **portal-side**             |
| API key minting                            | POST /v1/api-keys                                  | Maybe — surface for verdict |
| API key rotation                           | POST /v1/api-keys/:id/rotate                       | Maybe                       |
| Webhook secret rotation                    | POST /v1/webhooks/:id/rotate-secret                | Maybe                       |
| Team member invite / remove                | /v1/team/members                                   | Maybe                       |
| MFA disable                                | DELETE /v1/account/mfa                             | **Yes — always**            |
| Password change                            | POST /v1/auth/password-reset (existing email link) | **email-link**              |

Stripe Portal handles its own step-up (tier change happens entirely
on Stripe's domain after our redirect; no API call from us during the
sensitive op). So that row is handled.

**Proposed minimum v1 step-up:** account deletion, MFA disable.
Everything else stays open with a single MFA-on-login challenge.

**Step-up window:** session is "MFA-fresh" for **15 minutes** after
the most recent successful challenge. Sensitive ops require fresh.
Re-challenge re-fills `mfa_satisfied_at`.

---

## 5. Login flow (proposed)

```
POST /v1/auth/password
  { email, password }
  →  if no MFA enrolled:
       200 { session_token, ... }   (existing behavior, unchanged)
     if MFA enrolled:
       200 { mfa_required: true, challenge_token: "ds_mfac_..." }
       (no session token issued yet)

POST /v1/auth/mfa/challenge
  { challenge_token, code | recovery_code }
  →  on success: 200 { session_token, ... }   (sets mfa_satisfied_at)
     on fail:    401 InvalidMfaChallenge      (max 5 wrong codes;
                                                challenge_token then
                                                burns + 429 cooldown)
```

`challenge_token` is opaque, server-side stored in Redis with 5min
TTL, single-use exchange. Bound to email + IP at issuance to prevent
code-stealing-from-Slack-paste cross-channel attacks.

---

## 6. Recovery codes UX

10 codes shown ONCE at enrollment, in a "Save these somewhere safe"
modal with copy + download buttons. Each code = 10-char base32-no-
ambiguous (no 0/O/1/I). Single-use.

When all 10 are exhausted (or 7 used + customer asks), the
"Regenerate codes" action requires a fresh MFA challenge. Old codes
are invalidated (marked used_at = now, no further redemption).

---

## 7. Disclosure (proposed)

- **privacy.md §3.1 (Account data):** add "MFA enrollment state +
  encrypted TOTP secret + hashed recovery codes" to the "What" list.
  Same legal basis (Art 6(1)(b) + 6(1)(c) Art 32 security).
- **No new sub-processor** (TOTP is device-local; recovery codes are
  hashed in our existing Postgres).
- **changes-log.md V-353 entry:** append.
- **DPA Annex 3:** no change (no new vendor).

---

## 8. Open questions for founder verdict

Per agent-autonomy guidance these are blocking — code paused until
verdicts land.

1. **TOTP-only for v1 with WebAuthn deferred — agree?**
2. **Encryption-at-rest option A (env key, no KMS) — agree, or push
   for option B?**
3. **Step-up scope: minimum (account-delete + MFA-disable) — or
   wider (include API key mint / webhook secret rotation / team
   member changes)?**
4. **Step-up freshness window: 15 min — or different (5? 30? 60?)?**
5. **MFA enforcement: optional opt-in for everyone v1 — or
   "encouraged for admins, required for owners on sensitive ops"
   per planning file 18 §314? (The latter requires the step-up
   distinction to actually exist; ties to question 3.)**
6. **Recovery code count: 10 single-use, regenerable — agree?**
7. **GUI / Tauri MFA handling: out of scope for V-353, addressed in
   a follow-up V-353g once dashboard ships — agree?**
8. **Pricing-tier gating: MFA available on all tiers (including
   trial pack), or paid-only?**

---

## 9. Non-decisions (agent-autonomous)

These the agent will decide and ship without surfacing further
(per autonomy guidance "DECIDE AUTONOMOUSLY"):

- TOTP algorithm: SHA-1 (RFC 6238 default; what every authenticator
  app supports). NOT SHA-256 — auth-app compatibility wins.
- Period: 30 seconds. Digits: 6.
- Issuer name in otpauth:// URI: `Driftstack`.
- Drift tolerance: ±1 window (90s effective). Standard.
- Rate limit on /mfa/challenge: 5 attempts per challenge_token,
  20 challenges per account per hour.
- UI copy: agent drafts, founder reviews tone post-hoc per
  V-294 marketing-copy-cadence rule.

---

## 10. Implementation order (post-verdict)

1. **V-353a** schema + migration (account_mfa, recovery codes,
   web_sessions.mfa_satisfied_at).
2. **V-353b** services: MfaService (enroll, verify, challenge,
   recovery-code consume), TotpEncryption helper.
3. **V-353c** routes: POST /v1/account/mfa/enroll +
   POST /v1/account/mfa/verify + DELETE /v1/account/mfa +
   POST /v1/account/mfa/recovery-codes/regenerate.
4. **V-353d** login wire-in: POST /v1/auth/password returns
   challenge_token; POST /v1/auth/mfa/challenge exchanges.
5. **V-353e** step-up gate: DELETE /v1/account (when it lands) +
   DELETE /v1/account/mfa require fresh MFA.
6. **V-353f** dashboard /settings/security: enroll flow with QR,
   recovery-code modal, disable button.
7. **V-353g** audit + email notifications (account.mfa_enrolled,
   account.mfa_disabled — both already opt-out-NOT-allowed since
   they're security-class).
8. **V-353h** disclosure update + V-log + tests.

Estimated total: ~10–14h once verdicts land.

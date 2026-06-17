# Profile master-key hardening — KMS-backed envelope (design)

Status: **✅ PROVIDER-AGNOSTIC PATH SHIPPED (the generic enabler) — see §3a.** The
cloud-KMS-SDK-native variants (§5) remain an optional founder follow-on. Not a
v1.0 blocker (the static key works); this hardens the cross-account DEK boundary
the founder repeatedly flags.
Author: Driftstack · 2026-06-17 · Scope: Agent 2 (server).

## 3a. ✅ SHIPPED — `PROFILE_MASTER_KEY_CMD` (provider-agnostic, no SDK, opt-in)

Rather than commit to one cloud KMS SDK, the server now supports
`PROFILE_MASTER_KEY_CMD` (`apps/server/src/lib/config.ts` `resolveProfileMasterKey`):
when set, the command is run **once at boot** and its stdout is used as the base64
master key. Operators wire ANY secret source via a command —
`aws kms decrypt …`, `vault read …`, `sops -d …`, `gcloud kms decrypt …` — so the
plaintext key never lives in `.env` (only the decrypt command + the KMS ciphertext
do), and a `.env` leak alone can't recover it. **Fail-closed:** a configured
command that fails or returns empty makes the server refuse to start (no silent
fallback). **Backward-compat:** unset → plaintext `PROFILE_MASTER_KEY` (today's
behavior) → **prod is inert until an operator opts in (zero deploy risk).** The
command's output flows through the existing 32-byte base64 schema refine. Tests:
`config-profile-master-key-cmd.test.ts` (CMD stdout used / trim / fail-closed on
non-zero + empty / bad-key refine / plaintext fallback / inert when both unset).

This is the generalized form of §5-option-4 and _enables_ §5-option-1 (AWS KMS)
too — `PROFILE_MASTER_KEY_CMD="aws kms decrypt --ciphertext-blob fileb://… --query
Plaintext --output text"`. A native-SDK integration (§5) is now optional, not
required, to get the hardening.

## 1. Current state (verified in code + prod)

The profile key hierarchy (`apps/server/src/lib/profile-key-hierarchy.ts`):

```
PROFILE_MASTER_KEY ──HKDF(salt="tenant"||accountId, info="TMK-v1")──▶ TMK_account
TMK_account ──AES-256-GCM-wrap──▶ DEK_profile        (stored: profiles.wrapped_dek)
TMK_account ──AES-256-GCM-wrap──▶ proxy password      (ARC A: account_proxies.wrapped_password)
DEK_profile ──AES-256-GCM──▶ profile state            (harness-side, opaque to us)
```

`PROFILE_MASTER_KEY` is a base64 32-byte AES key. **It sits in plaintext in prod
`/opt/driftstack/api/.env`** (verified live: SET on `driftstack-production`).

## 2. The gap

The master key is the root of trust for every per-account TMK → every profile DEK
and proxy password. At rest it's **plaintext on the box**: anyone who reads that
`.env` (host compromise, backup leak, misconfigured access) can derive every TMK
and unwrap every account's DEK + proxy secret — a full cross-account confidentiality
break. Encryption-at-rest is only as strong as the master key's own protection,
which today is filesystem permissions alone.

## 3. Proposed design — KMS-wrapped master key (envelope), decrypted once at boot

**Don't** route per-operation crypto through a KMS (latency + cost on every
session-assign). Instead protect the _master key itself_:

1. Wrap the existing 32-byte master key under a KMS customer-managed key (CMK),
   **once, offline**. Store the resulting ciphertext as
   `PROFILE_MASTER_KEY_CIPHERTEXT` in `.env` (replacing the plaintext
   `PROFILE_MASTER_KEY`).
2. At boot (`bootstrap.ts`, where `decodeMasterKey` runs today), if
   `PROFILE_MASTER_KEY_CIPHERTEXT` is set, call **KMS Decrypt once** to recover
   the plaintext master key into process memory; everything downstream
   (`deriveTenantMasterKey` etc.) is unchanged.
3. Backward-compat: if `PROFILE_MASTER_KEY_CIPHERTEXT` is unset, fall back to the
   plaintext `PROFILE_MASTER_KEY` (today's path). So the change is opt-in per
   deployment and self-hosters keep the simple env-key option.

**Why this shape:** smallest blast radius — one new boot-time call, zero change to
the hot path, the CMK never leaves the KMS, and a stolen `.env` alone is useless
without KMS Decrypt permission (which is IAM-scoped to the prod box's identity).

## 4. Migration — NO data re-wrap needed

The master key _value_ is unchanged — only its at-rest _form_ changes
(plaintext → KMS-ciphertext). So every existing `wrapped_dek` and
`wrapped_password` still unwraps correctly. Migration is purely operational:
KMS-encrypt the current key, swap the env var, redeploy. No DB migration, no
re-wrapping, no customer-visible change. Rollback = restore the plaintext env var.

(Key _rotation_ — minting a new master key — is a separate, larger effort because
it requires re-wrapping every DEK under the new key; out of scope here. This
design only hardens the _storage_ of the existing key.)

## 5. Decision (founder) — the KMS provider

Prod is Hetzner (no native managed KMS), and the decryption is **boot-time only**
(not hot-path), so cross-cloud latency is a non-issue. Options:

1. **AWS KMS** — mature, cheap (~$1/CMK/mo + per-call), one boot-time Decrypt.
   Adds an AWS dependency + IAM identity for the Hetzner box. **Recommended** if
   any AWS footprint already exists.
2. **GCP KMS** — equivalent; pick to match existing cloud footprint.
3. **HashiCorp Vault (self-hostable)** — no third-party cloud; more ops to run.
4. **age/sops with a hardware or cloud KEK** — lightweight, git-friendly secret
   encryption; simplest if no KMS relationship exists.

Questions: (a) go / no-go on hardening the master-key storage now? (b) which
provider (drives the boot-time client dependency)? (c) confirm the boot-time
fail-closed posture — if KMS Decrypt fails at boot, the server should refuse to
start (rather than silently fall back to a missing key), matching the existing
"profiles inert when master key unset" behavior.

On a go + provider pick: implement as one slice (env var + boot-time KMS Decrypt +
fail-closed + tests + the operational runbook to KMS-encrypt the current key),
plus the §6 follow-on if rotation is wanted later.

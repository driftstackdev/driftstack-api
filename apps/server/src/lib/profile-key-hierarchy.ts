// Profile key hierarchy (planning file 57 — Cryptography & Key Management).
//
//   Master Key ──HKDF-SHA256──▶ TMK_{account} ──AES-256-GCM-wrap──▶ DEK_{profile}
//
// Per file 57:
//   TMK_{account_id} = HKDF(Master, salt = "tenant"||account_id, info = "TMK-v1", 32)
//   DEK              = random 32 bytes
//   wrapped_DEK      = AES-256-GCM(TMK, DEK)        ← stored per-profile in the DB
//   profile_state    = AES-256-GCM(DEK, plaintext)  ← done HARNESS-side (opaque to us)
//
// This module owns the TMK/DEK half (server-side). The profile STATE encryption
// (LZFSE + AES-256-GCM under the DEK) is the harness's job — we only mint/wrap/
// unwrap the DEK and ship the plaintext DEK to the harness over the
// mutually-authenticated (Ed25519-JWT) + TLS WSS at session-assign time.
//
// v1.0 master-key storage: a host-resident env var (PROFILE_MASTER_KEY), the
// same trust boundary as MFA_ENCRYPTION_KEY / livekit-secret-encryption. File
// 57's "Master Key in KMS, never on app servers" is a platform-wide post-v1.0
// upgrade (it would move EVERY env secret to KMS at once), tracked separately —
// not profile-specific. The account-binding is still cryptographic: a DEK
// wrapped under account A's TMK cannot be unwrapped with account B's TMK (the
// GCM tag fails to verify), so a compromised node/account can't read another
// account's profile DEK.
//
// Wrapped-DEK storage form: base64([IV(12) | tag(16) | ciphertext(32)]) — the
// legacy v1 form. New profile writes use an explicit v2 prefix and authenticate
// the owning account + profile UUID as AES-GCM AAD, so a valid wrapped key cannot
// be relocated to another profile in the same account. The prefixless reader is
// bootstrap-only and exists solely for the bounded no-DDL migration.

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AES_256_KEY_BYTES, GCM_IV_BYTES, GCM_TAG_BYTES } from './aes-gcm-parameters.js';
const WRAPPED_DEK_PAYLOAD_BYTES = GCM_IV_BYTES + GCM_TAG_BYTES + AES_256_KEY_BYTES;
const WRAPPED_DEK_BASE64_CHARS = 80;
const TMK_SALT_PREFIX = 'tenant';
const TMK_INFO = 'TMK-v1';
const PROFILE_DEK_AAD_PURPOSE = 'driftstack.profile-dek';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PROFILE_DEK_V2_PREFIX = 'driftstack:profile-dek:v2:';

export interface ProfileDekContext {
  accountId: string;
  profileId: string;
}

function decodeCanonicalBase64(value: string): Buffer {
  if (value.length !== WRAPPED_DEK_BASE64_CHARS) {
    throw new Error(
      `wrapped DEK base64 is ${value.length.toString()} characters; expected exactly ` +
        `${WRAPPED_DEK_BASE64_CHARS.toString()} for ${WRAPPED_DEK_PAYLOAD_BYTES.toString()} bytes.`,
    );
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('wrapped DEK is not canonical base64.');
  }
  return decoded;
}

function normalizeUuid(name: 'accountId' | 'profileId', value: string): string {
  if (!UUID_RE.test(value)) throw new Error(`${name} must be a UUID.`);
  return value.toLowerCase();
}

function normalizeProfileDekContext(context: ProfileDekContext): ProfileDekContext {
  return {
    accountId: normalizeUuid('accountId', context.accountId),
    profileId: normalizeUuid('profileId', context.profileId),
  };
}

function buildProfileDekAad(normalizedContext: ProfileDekContext): Buffer {
  return Buffer.from(
    JSON.stringify([
      PROFILE_DEK_AAD_PURPOSE,
      2,
      normalizedContext.accountId,
      normalizedContext.profileId,
    ]),
    'utf8',
  );
}

/** Decode + validate a base64 AES-256 key (the master key). */
export function decodeMasterKey(masterKeyBase64: string): Buffer {
  const key = Buffer.from(masterKeyBase64, 'base64');
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `PROFILE_MASTER_KEY must decode to ${AES_256_KEY_BYTES.toString()} bytes; got ${key.length.toString()}. ` +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return key;
}

/**
 * Derive the per-account Tenant Master Key (file 57):
 * `TMK = HKDF-SHA256(master, salt = "tenant"||account_id, info = "TMK-v1", 32)`.
 * Pure function of (master, accountId) — never stored; re-derived on demand.
 */
export function deriveTenantMasterKey(masterKey: Buffer, accountId: string): Buffer {
  if (accountId.length === 0) throw new Error('accountId is required to derive a TMK');
  const salt = Buffer.concat([
    Buffer.from(TMK_SALT_PREFIX, 'utf8'),
    Buffer.from(accountId, 'utf8'),
  ]);
  const info = Buffer.from(TMK_INFO, 'utf8');
  // hkdfSync returns an ArrayBuffer — wrap it as a Buffer.
  return Buffer.from(hkdfSync('sha256', masterKey, salt, info, AES_256_KEY_BYTES));
}

/** Mint a fresh per-resource DEK (random 32 bytes) — file 57. */
export function mintDek(): Buffer {
  return randomBytes(AES_256_KEY_BYTES);
}

function wrapDekPayload(dek: Buffer, tmk: Buffer, aad?: Buffer): string {
  if (dek.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `DEK must be ${AES_256_KEY_BYTES.toString()} bytes; got ${dek.length.toString()}`,
    );
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', tmk, iv);
  if (aad !== undefined) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Legacy context-free DEK wrapper. New profile writes use mintWrappedProfileDek(). */
export function wrapDek(dek: Buffer, tmk: Buffer): string {
  return wrapDekPayload(dek, tmk);
}

/**
 * Unwrap a stored base64([IV | tag | ciphertext]) DEK under a TMK. Throws if the
 * blob is malformed or the GCM tag fails (wrong TMK / tamper) — a wrong-account
 * TMK therefore cannot unwrap another account's DEK.
 */
function unwrapDekPayload(wrappedDekBase64: string, tmk: Buffer, aad?: Buffer): Buffer {
  const blob = decodeCanonicalBase64(wrappedDekBase64);
  if (blob.length !== WRAPPED_DEK_PAYLOAD_BYTES) {
    throw new Error(
      `wrapped DEK blob is ${blob.length.toString()} bytes; expected exactly ${WRAPPED_DEK_PAYLOAD_BYTES.toString()} (iv + tag + 32-byte DEK)`,
    );
  }
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', tmk, iv);
  if (aad !== undefined) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (dek.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `unwrapped DEK is ${dek.length.toString()} bytes; expected ${AES_256_KEY_BYTES.toString()}`,
    );
  }
  return dek;
}

export function unwrapDek(wrappedDekBase64: string, tmk: Buffer): Buffer {
  return unwrapDekPayload(wrappedDekBase64, tmk);
}

/**
 * Mint a per-profile DEK for `accountId` and return BOTH the plaintext DEK (for
 * immediate use — ship to the harness / seal the first blob) and the wrapped DEK
 * (base64) to persist with the profile row. The plaintext DEK is never stored.
 */
export function mintWrappedProfileDek(
  masterKey: Buffer,
  accountId: string,
  profileId: string,
): { dek: Buffer; wrappedDek: string } {
  const dek = mintDek();
  return { dek, wrappedDek: wrapProfileDek(masterKey, accountId, profileId, dek) };
}

/** Wrap an existing 32-byte DEK into its exact profile-bound v2 envelope. */
export function wrapProfileDek(
  masterKey: Buffer,
  accountId: string,
  profileId: string,
  dek: Buffer,
): string {
  const context = normalizeProfileDekContext({ accountId, profileId });
  const tmk = deriveTenantMasterKey(masterKey, context.accountId);
  return `${PROFILE_DEK_V2_PREFIX}${wrapDekPayload(dek, tmk, buildProfileDekAad(context))}`;
}

/**
 * Recover a profile's plaintext DEK from its stored wrapped form. Used at
 * session-assign time to ship the DEK to the harness. Throws unless `wrappedDek`
 * was wrapped for this exact account + profile context.
 */
export function unwrapProfileDek(
  masterKey: Buffer,
  accountId: string,
  profileId: string,
  wrappedDek: string,
): Buffer {
  if (!wrappedDek.startsWith(PROFILE_DEK_V2_PREFIX)) {
    throw new Error('wrapped profile DEK is not a v2 envelope.');
  }
  const context = normalizeProfileDekContext({ accountId, profileId });
  const tmk = deriveTenantMasterKey(masterKey, context.accountId);
  return unwrapDekPayload(
    wrappedDek.slice(PROFILE_DEK_V2_PREFIX.length),
    tmk,
    buildProfileDekAad(context),
  );
}

/** Bootstrap-only reader for the prefixless, account-only legacy envelope. */
export function unwrapLegacyProfileDek(
  masterKey: Buffer,
  accountId: string,
  wrappedDek: string,
): Buffer {
  if (wrappedDek.startsWith(PROFILE_DEK_V2_PREFIX)) {
    throw new Error('legacy wrapped profile DEK reader refuses a v2 envelope.');
  }
  return unwrapDekPayload(wrappedDek, deriveTenantMasterKey(masterKey, accountId));
}

/** Constant-time equality for two keys (test/verification helper). */
export function keysEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ───────────────────────────────────────────────────────────────────────────
// Arbitrary-length account secrets (ARC A — customer proxy passwords).
//
// Same AEAD construction as wrapDek/unwrapDek (AES-256-GCM under the account
// TMK) but without the 32-byte constraint, so account-scoped secrets reuse this
// one audited primitive instead of a parallel crypto path. A secret wrapped
// under account A's TMK cannot be unwrapped with account B's TMK (the GCM tag
// fails to verify) — the same cross-account isolation the DEK relies on.
//
// ⛔ 2026-08-26 — THE NAMED USE CASE SHIPPED ELSEWHERE, AND THESE HAVE NO
// PRODUCTION CALLERS. Customer proxy credentials are encrypted by
// `account-proxy-secret-encryption.ts` ("record- and slot-bound", AAD purpose
// `driftstack.account-proxy-secret`, four call sites), which derives the TMK
// from here and then adds its OWN AAD on top. `wrapSecret`/`unwrapSecret` are
// referenced only by their unit tests.
//
// That matters because of what the paragraph above invites: reusing this
// primitive for a new account-scoped secret. It binds by KEY only. Cross-account
// substitution fails, as described — but two secrets belonging to the SAME
// account are interchangeable, because nothing in the envelope names which
// record or field a ciphertext belongs to. Measured across the nine AES-GCM
// surfaces in `src/lib`, the convention is the opposite: every encrypt path
// binds unconditionally and only decrypt is permissive, so it can still read
// pre-AAD ciphertext.
//
// So: a new account-scoped secret that has a record identity wants the
// `account-proxy-secret-encryption` shape, not this one. These two stay because
// they are exported, tested and harmless unused; whether to delete them is the
// owner's call rather than a silent removal from a crypto module.
// ───────────────────────────────────────────────────────────────────────────

/** Envelope-encrypt an arbitrary-length secret under a TMK → base64([IV | tag | ciphertext]). */
export function wrapSecret(plaintext: Buffer, tmk: Buffer): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', tmk, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Unwrap a base64([IV | tag | ciphertext]) secret under a TMK. Throws if the
 *  blob is malformed or the GCM tag fails (wrong-account TMK / tamper). */
export function unwrapSecret(wrappedBase64: string, tmk: Buffer): Buffer {
  const blob = Buffer.from(wrappedBase64, 'base64');
  const min = GCM_IV_BYTES + GCM_TAG_BYTES; // empty plaintext is permitted
  if (blob.length < min) {
    throw new Error(
      `wrapped secret blob is ${blob.length.toString()} bytes; expected at least ${min.toString()} (iv + tag)`,
    );
  }
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', tmk, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Wrap an account-scoped secret (e.g. a proxy password) for storage — derives
 *  the account TMK then envelope-encrypts. Mirrors mintWrappedProfileDek. */
export function wrapAccountSecret(masterKey: Buffer, accountId: string, plaintext: Buffer): string {
  return wrapSecret(plaintext, deriveTenantMasterKey(masterKey, accountId));
}

/** Recover an account-scoped secret from its stored wrapped form. Throws if it
 *  wasn't wrapped under THIS account's TMK (cross-account isolation). Mirrors
 *  unwrapProfileDek. */
export function unwrapAccountSecret(
  masterKey: Buffer,
  accountId: string,
  wrappedBase64: string,
): Buffer {
  return unwrapSecret(wrappedBase64, deriveTenantMasterKey(masterKey, accountId));
}

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
// identical envelope shape used across the codebase (livekit-secret-encryption).

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const AES_256_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const TMK_SALT_PREFIX = 'tenant';
const TMK_INFO = 'TMK-v1';

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

/** Envelope-encrypt a DEK under a TMK → base64([IV | tag | ciphertext]). */
export function wrapDek(dek: Buffer, tmk: Buffer): string {
  if (dek.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `DEK must be ${AES_256_KEY_BYTES.toString()} bytes; got ${dek.length.toString()}`,
    );
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', tmk, iv);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Unwrap a stored base64([IV | tag | ciphertext]) DEK under a TMK. Throws if the
 * blob is malformed or the GCM tag fails (wrong TMK / tamper) — a wrong-account
 * TMK therefore cannot unwrap another account's DEK.
 */
export function unwrapDek(wrappedDekBase64: string, tmk: Buffer): Buffer {
  const blob = Buffer.from(wrappedDekBase64, 'base64');
  const min = GCM_IV_BYTES + GCM_TAG_BYTES + AES_256_KEY_BYTES;
  if (blob.length !== min) {
    throw new Error(
      `wrapped DEK blob is ${blob.length.toString()} bytes; expected exactly ${min.toString()} (iv + tag + 32-byte DEK)`,
    );
  }
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', tmk, iv);
  decipher.setAuthTag(tag);
  const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (dek.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `unwrapped DEK is ${dek.length.toString()} bytes; expected ${AES_256_KEY_BYTES.toString()}`,
    );
  }
  return dek;
}

/**
 * Mint a per-profile DEK for `accountId` and return BOTH the plaintext DEK (for
 * immediate use — ship to the harness / seal the first blob) and the wrapped DEK
 * (base64) to persist with the profile row. The plaintext DEK is never stored.
 */
export function mintWrappedProfileDek(
  masterKey: Buffer,
  accountId: string,
): { dek: Buffer; wrappedDek: string } {
  const tmk = deriveTenantMasterKey(masterKey, accountId);
  const dek = mintDek();
  return { dek, wrappedDek: wrapDek(dek, tmk) };
}

/**
 * Recover a profile's plaintext DEK from its stored wrapped form. Used at
 * session-assign time to ship the DEK to the harness. Throws if `wrappedDek`
 * wasn't wrapped under THIS account's TMK (cross-account isolation).
 */
export function unwrapProfileDek(masterKey: Buffer, accountId: string, wrappedDek: string): Buffer {
  const tmk = deriveTenantMasterKey(masterKey, accountId);
  return unwrapDek(wrappedDek, tmk);
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

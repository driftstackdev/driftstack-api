// Helpers for the user-facing auth flow (signup/verify/login/magic-link/
// password-reset/web-session). Distinct from `api-keys.ts` which generates
// long-lived API keys for SDK consumers.
//
// Two primitives:
//
//   1. Password hashing — scrypt-kdf, same parameters as the API-key path
//      (logN=15, r=8, p=1). Re-uses the api-keys hashing functions to
//      avoid divergence; the storage column is `accounts.password_hash`.
//
//   2. Opaque single-use tokens — 32 random bytes encoded as URL-safe
//      base64, sha256-hashed at rest. The plaintext is sent ONCE
//      (via Postmark for email-bearing flows; in the response body for
//      web-session login). The hash provides a constant-time-equality
//      lookup index without storing reversible material.
//
// Token lifetime defaults (caller can override per-flow):
//   - signup-verification: 30 minutes
//   - magic-link:           15 minutes
//   - password-reset:        1 hour
//   - web-session:          30 days

import { createHash, randomBytes } from 'node:crypto';
import { hashApiKey, verifyApiKey } from './api-keys.js';

export const TOKEN_RANDOM_BYTES = 32;

/**
 * Generate a URL-safe single-use auth token. Returned plaintext is sent
 * to the user once; only `tokenHash(plaintext)` should ever land in the
 * database.
 */
export function generateAuthToken(): string {
  return randomBytes(TOKEN_RANDOM_BYTES).toString('base64url');
}

/**
 * Hash an auth token for at-rest storage / lookup. Sha256 is sufficient
 * here because the input has full random entropy (256 bits) — scrypt is
 * reserved for low-entropy user-chosen passwords.
 */
export function tokenHash(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Hash a password for at-rest storage. Re-uses the API-key scrypt path:
 * same algorithm, same parameters, same encoded format. Both columns
 * (`api_keys.key_hash` and `accounts.password_hash`) round-trip through
 * scrypt-kdf's standard-format string.
 */
export function hashPassword(plaintext: string): Promise<string> {
  return hashApiKey(plaintext);
}

export function verifyPassword(plaintext: string, encodedHash: string): Promise<boolean> {
  return verifyApiKey(plaintext, encodedHash);
}

/** Default lifetimes per flow (in milliseconds). Caller may override. */
export const AUTH_TOKEN_TTL_MS = {
  signupVerification: 30 * 60 * 1000,
  magicLink: 15 * 60 * 1000,
  passwordReset: 60 * 60 * 1000,
  webSession: 30 * 24 * 60 * 60 * 1000,
} as const;

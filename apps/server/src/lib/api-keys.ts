// API key issuance and verification.
//
// Format: ds_<env>_<32-char-base32>
//   env ∈ {"live", "test"}; "live" for any production-style account,
//   "test" reserved for sandbox accounts (Phase 6+).
//
// The lookup column on `api_keys` is `key_prefix` — the first 16 chars of
// the plaintext (which is *not* secret on its own, equivalent to a username).
// Verification re-hashes the supplied plaintext and constant-time-compares
// against `key_hash` (scrypt-kdf encoded).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TIER_FEATURES } from '@driftstack/api-types';
import type { AccountTier } from '@driftstack/api-types';
import scryptKdf from 'scrypt-kdf';

const PREFIX_PUBLIC_LEN = 16;
const RANDOM_BODY_BYTES = 20; // 20 bytes -> 32 base32 chars
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export type ApiKeyEnv = 'live' | 'test';

/**
 * The key environment a tier mints in.
 *
 * Reads `TIER_FEATURES`, which declares itself the source of truth for this
 * ("Stripe environment for API-key minting"). It was not: both mint paths
 * computed `tier === 'free' ? 'test' : 'live'` inline, so the table field was
 * read by no runtime code at all. The two agreed for all eight tiers, which is
 * why nothing was visibly wrong — but a tier added with
 * `apiKeyEnvironment: 'test'` would have minted `ds_live_…` keys regardless,
 * and three test files assert the field's values as though it decided
 * something. A setting that varies and drives nothing is a lie in the shape of
 * a setting.
 */
export function apiKeyEnvForTier(tier: AccountTier): ApiKeyEnv {
  return TIER_FEATURES[tier].apiKeyEnvironment;
}

export function generateApiKey(env: ApiKeyEnv): string {
  const buf = randomBytes(RANDOM_BODY_BYTES);
  const body = base32Encode(buf);
  return `ds_${env}_${body}`;
}

export function keyPrefixFromPlaintext(plaintext: string): string {
  return plaintext.slice(0, PREFIX_PUBLIC_LEN);
}

export async function hashApiKey(plaintext: string): Promise<string> {
  // scrypt-kdf returns a base64-encoded standard-format hash
  // ("scrypt"+params+salt+key). Defaults: logN=15, r=8, p=1.
  const buf = await scryptKdf.kdf(plaintext, { logN: 15, r: 8, p: 1 });
  return buf.toString('base64');
}

export async function verifyApiKey(plaintext: string, encodedHash: string): Promise<boolean> {
  try {
    const ok = await scryptKdf.verify(Buffer.from(encodedHash, 'base64'), plaintext);
    return ok === true;
  } catch {
    return false;
  }
}

export function constantTimeStringEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

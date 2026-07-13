// Webhook signing — server side.
//
// Header format (Stripe-style, matches the SDK's verifyWebhookSignature):
//   X-Driftstack-Signature: t=<unix-seconds>,v1=<hex-hmac>
//
// hmac = HMAC-SHA256(`<unix-seconds>.<raw body>`, <secret-plaintext>)
//
// Secrets are generated at subscription-creation time and stored in a
// versioned AES-GCM envelope. The delivery worker receives plaintext only
// after repository-boundary decryption; customer verification uses the SDK.

import { createHmac, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const SECRET_BODY_BYTES = 20; // 32 base32 chars after encoding
const SECRET_PREFIX_LEN = 12; // length of plaintext stored as secretPrefix for display

/** Generate a fresh webhook signing secret in the form `whsec_<32 base32>`. */
export function generateWebhookSecret(): string {
  return `whsec_${base32Encode(randomBytes(SECRET_BODY_BYTES))}`;
}

/** First N chars of the plaintext, used as the human-displayable secret prefix. */
export function webhookSecretPrefix(plaintext: string): string {
  return plaintext.slice(0, SECRET_PREFIX_LEN);
}

export interface SignWebhookPayloadOpts {
  body: string;
  secret: string;
  /**
   * V-359 — when set, sign with both the current AND the previous
   * secret and emit two `v1=…` entries comma-separated. Used during
   * the rotation grace period so the customer's verifier accepts
   * either while they roll the new secret across their infra. The
   * SDK verifier iterates over every `v1=…` entry and accepts the
   * first match.
   */
  secretPrev?: string;
  /** Override "now" (test seam). */
  timestampSec?: number;
}

/**
 * Build the signed header value. The signed string is `<timestamp>.<body>`;
 * inverse of `verifyWebhookSignature` in @driftstack/sdk.
 *
 * V-359 — when `secretPrev` is set, emits both signatures:
 *   `t=<ts>,v1=<curr>,v1=<prev>`
 */
export function signWebhookPayload(opts: SignWebhookPayloadOpts): string {
  const t = opts.timestampSec ?? Math.floor(Date.now() / 1000);
  const signed = `${t.toString()}.${opts.body}`;
  const curr = createHmac('sha256', opts.secret).update(signed).digest('hex');
  const parts = [`t=${t.toString()}`, `v1=${curr}`];
  if (opts.secretPrev !== undefined && opts.secretPrev !== '') {
    const prev = createHmac('sha256', opts.secretPrev).update(signed).digest('hex');
    parts.push(`v1=${prev}`);
  }
  return parts.join(',');
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

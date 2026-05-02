// Webhook signing — server side.
//
// Header format (Stripe-style, matches the SDK's verifyWebhookSignature):
//   X-Driftstack-Signature: t=<unix-seconds>,v1=<hex-hmac>
//
// hmac = HMAC-SHA256(`<unix-seconds>.<raw body>`, <secret-plaintext>)
//
// Secrets are generated at subscription-creation time and stored in
// plaintext (D-023). Verification happens on the customer's machine using
// the SDK helper.

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
  /** Override "now" (test seam). */
  timestampSec?: number;
}

/**
 * Build the signed header value. The signed string is `<timestamp>.<body>`;
 * inverse of `verifyWebhookSignature` in @driftstack/sdk.
 */
export function signWebhookPayload(opts: SignWebhookPayloadOpts): string {
  const t = opts.timestampSec ?? Math.floor(Date.now() / 1000);
  const hex = createHmac('sha256', opts.secret)
    .update(`${t.toString()}.${opts.body}`)
    .digest('hex');
  return `t=${t.toString()},v1=${hex}`;
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

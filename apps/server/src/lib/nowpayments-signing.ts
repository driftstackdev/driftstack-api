// V-487 — NowPayments IPN (Instant Payment Notification) signature
// verifier. NowPayments signs every webhook payload with HMAC-SHA512
// keyed on the IPN secret you set in the merchant dashboard. The
// algorithm is documented at:
//   https://documenter.getpostman.com/view/7907941/2s93JusNJt
//
// Header format:
//   x-nowpayments-sig: <hex HMAC-SHA512 of the canonicalised body>
//
// The body is canonicalised before HMAC: JSON-parsed, keys sorted
// lexicographically at every level, then re-serialised — NowPayments'
// IPN signing protocol computes the signature over the sorted-key
// serialisation, not the wire byte order. A non-JSON body falls back to
// raw-body HMAC. Fastify exposes the raw buffer via `request.rawBody`
// when the route opts in.
//
// Consumed by the NowPayments IPN route
// (`apps/server/src/routes/webhooks-nowpayments.ts`): it verifies the
// signature and rejects a mismatch with 401. The route is registered
// only when `NOWPAYMENTS_IPN_SECRET` is configured (the wiring in
// `lib/app.ts` is gated on it), so the verifier stays dormant until the
// founder lands a merchant account.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyNowpaymentsSignatureOpts {
  /** Raw body bytes as received over HTTP. */
  body: string | Buffer;
  /** The IPN secret from the NowPayments dashboard. */
  secret: string;
  /** Hex-encoded signature from the `x-nowpayments-sig` header. */
  signature: string;
}

/**
 * Returns true iff `signature` is a valid HMAC-SHA512 of `body` keyed
 * on `secret`. Constant-time comparison via {@link timingSafeEqual}.
 *
 * Returns false (rather than throwing) on:
 *   - empty body or empty secret or empty signature
 *   - signature is not valid hex
 *   - hex-decoded signature has a length mismatch with the expected
 *     SHA-512 digest (64 bytes)
 *
 * Throwing is reserved for misuse (non-string secret, etc.); a
 * malformed-input path stays false so the caller can return 401
 * uniformly.
 */
export function verifyNowpaymentsSignature(opts: VerifyNowpaymentsSignatureOpts): boolean {
  if (!opts.body || !opts.secret || !opts.signature) return false;

  // Sort the parsed JSON body's keys lexicographically before signing —
  // NowPayments' IPN signing protocol mandates this canonicalisation.
  // We only do it when the body parses as a JSON object; for non-JSON
  // bodies we fall through to raw-body HMAC so the verifier is robust
  // against either provider behaviour.
  const bodyStr = Buffer.isBuffer(opts.body) ? opts.body.toString('utf8') : opts.body;
  const canonical = canonicalizeJsonObject(bodyStr) ?? bodyStr;

  const expected = createHmac('sha512', opts.secret).update(canonical).digest();

  let received: Buffer;
  try {
    received = Buffer.from(opts.signature, 'hex');
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

/**
 * If the input string is a JSON object, return it re-serialised with
 * keys sorted lexicographically at every level. Returns `null` if the
 * input is not a JSON object (caller falls back to raw-body HMAC).
 *
 * NowPayments signs the body with sorted keys; failing to canonicalise
 * before HMAC produces a mismatch even with a correct secret.
 */
function canonicalizeJsonObject(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return JSON.stringify(sortKeys(parsed));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

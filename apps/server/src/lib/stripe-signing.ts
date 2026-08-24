// Stripe webhook signature verification.
//
// We do NOT depend on the `stripe` SDK for this — the verification is a
// few lines of HMAC and we don't want a heavy dependency on the path
// between an unauthenticated POST and our event handler. Format:
//
//   Stripe-Signature: t=<unix-seconds>,v1=<hex>,v0=<legacy-sha1>
//
// `v1` is the current scheme (HMAC-SHA256 of `<timestamp>.<raw body>`
// with the webhook secret as the key). We verify only `v1`; v0 is
// legacy SHA-1 and Stripe stopped issuing it for new webhooks.
//
// Stripe may include MULTIPLE `v1` signatures in one header (most
// commonly during a webhook-secret roll, where the event is signed with
// BOTH the old and the new secret). We accept the event if ANY `v1`
// verifies against our configured secret — matching Stripe's official
// SDK and our own outbound verifier (packages/webhook-delivery +
// sdk-*). This is security-neutral: each candidate must independently
// match a real HMAC over `<t>.<raw body>`, so an attacker adding bogus
// `v1` entries gains nothing without the secret; it only makes a
// legitimate secret rotation zero-downtime instead of dropping the
// mid-roll deliveries whose matching signature wasn't listed last.
//
// The `t=` timestamp is checked against a tolerance window (default 5
// minutes) to bound replay; Stripe's official SDK uses the same window.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyArgs {
  /** Raw, unparsed request body (string). Order matters — `JSON.parse(body)` would lose key ordering and break HMAC. */
  rawBody: string;
  /** The full `Stripe-Signature` header value. */
  header: string;
  /** The webhook signing secret as configured in the Stripe dashboard (`whsec_...`). */
  secret: string;
  /** Override "now" for tests. Default: real wall-clock seconds. */
  nowSec?: number;
  /** Tolerance window in seconds. Default 300 (5 min) — matches Stripe's SDK default. */
  toleranceSec?: number;
}

export type VerifyResult =
  | { ok: true; timestampSec: number }
  | { ok: false; reason: VerifyFailureReason };

export type VerifyFailureReason =
  | 'malformed_header'
  | 'missing_v1'
  | 'invalid_signature'
  | 'timestamp_outside_tolerance';

/**
 * Verify a Stripe webhook signature. Returns `{ ok: true }` on success,
 * `{ ok: false, reason }` on any failure mode. Constant-time comparison
 * on the v1 hex digest prevents timing-leak signature recovery.
 */
export function verifyStripeSignature(args: VerifyArgs): VerifyResult {
  // V-1465 — refuse before hashing when the signing secret is absent.
  //
  // Node's HMAC accepts an EMPTY key and returns a perfectly good digest, so
  // without this an attacker who knows the body and timestamp computes
  // `HMAC-SHA256('', "<t>.<body>")` and it verifies. Measured: that exact input
  // returned `{ ok: true }`. The sibling verifier in `nowpayments-signing.ts`
  // has always had this check (`!opts.secret`); this one never did.
  //
  // Reuses `invalid_signature` rather than adding a fifth `VerifyFailureReason`:
  // three parity files pin that union as a "4-literal" set with the count spelled
  // out in their test names, and a security guard is not worth re-wording three
  // prose-embedded counts. The route logs the reason, so the source comment is
  // where the config-versus-attack distinction is recorded.
  if (args.secret.length === 0) return { ok: false, reason: 'invalid_signature' };

  const parsed = parseHeader(args.header);
  if (parsed === null) return { ok: false, reason: 'malformed_header' };
  if (parsed.v1.length === 0) return { ok: false, reason: 'missing_v1' };

  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = args.toleranceSec ?? 300;
  if (Math.abs(now - parsed.t) > tolerance) {
    return { ok: false, reason: 'timestamp_outside_tolerance' };
  }

  const expectedHex = createHmac('sha256', args.secret)
    .update(`${parsed.t.toString()}.${args.rawBody}`)
    .digest('hex');
  // Accept if ANY of the header's `v1` signatures matches (Stripe
  // dual-signs during a secret roll). Constant-time per candidate.
  if (!parsed.v1.some((sig) => constantTimeHexEq(expectedHex, sig))) {
    return { ok: false, reason: 'invalid_signature' };
  }

  return { ok: true, timestampSec: parsed.t };
}

interface ParsedHeader {
  t: number;
  v1: string[];
}

function parseHeader(header: string): ParsedHeader | null {
  // Format: t=<seconds>,v1=<hex>[,v1=<hex>][,v0=<legacy>]. We tolerate
  // ordering, collect EVERY `v1` (Stripe dual-signs during a secret
  // roll), and ignore unknown keys (e.g., a future `v2`).
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      t = Math.floor(n);
    } else if (key === 'v1' && value.length > 0) {
      v1.push(value);
    }
  }
  if (t === null) return null;
  return { t, v1 };
}

function constantTimeHexEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Buffer.from(hex, 'hex') silently truncates on bad chars — guard before.
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Build a signature header value (for tests). Inverse of `verifyStripeSignature`.
 */
export function signStripePayload(args: {
  rawBody: string;
  secret: string;
  timestampSec?: number;
}): string {
  const t = args.timestampSec ?? Math.floor(Date.now() / 1000);
  const hex = createHmac('sha256', args.secret)
    .update(`${t.toString()}.${args.rawBody}`)
    .digest('hex');
  return `t=${t.toString()},v1=${hex}`;
}

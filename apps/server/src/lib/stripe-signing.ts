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
  const parsed = parseHeader(args.header);
  if (parsed === null) return { ok: false, reason: 'malformed_header' };
  if (parsed.v1 === null) return { ok: false, reason: 'missing_v1' };

  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = args.toleranceSec ?? 300;
  if (Math.abs(now - parsed.t) > tolerance) {
    return { ok: false, reason: 'timestamp_outside_tolerance' };
  }

  const expectedHex = createHmac('sha256', args.secret)
    .update(`${parsed.t.toString()}.${args.rawBody}`)
    .digest('hex');
  if (!constantTimeHexEq(expectedHex, parsed.v1)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  return { ok: true, timestampSec: parsed.t };
}

interface ParsedHeader {
  t: number;
  v1: string | null;
}

function parseHeader(header: string): ParsedHeader | null {
  // Format: t=<seconds>,v1=<hex>,v0=<legacy>. We tolerate ordering
  // and ignore unknown keys (e.g., a future `v2`).
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      t = Math.floor(n);
    } else if (key === 'v1') {
      v1 = value;
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

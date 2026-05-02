// Webhook signature verification helper.
//
// Signature header format (Stripe-style): `t=<unix-seconds>,v1=<hex hmac>`.
// HMAC = SHA256(`<unix-seconds>.<raw body>`, `<webhook secret>`).
//
// Customers verify inbound webhook deliveries with this helper:
//
//   import { verifyWebhookSignature } from '@driftstack/sdk';
//
//   app.post('/driftstack-webhook', (req, res) => {
//     const sig = req.headers['x-driftstack-signature'];
//     const ok = verifyWebhookSignature({
//       body: req.rawBody,           // string or Buffer
//       header: sig,
//       secret: process.env.DRIFTSTACK_WEBHOOK_SECRET!,
//     });
//     if (!ok) return res.status(401).end();
//     // ... process event ...
//   });
//
// The full delivery + retry semantics land in the Webhook System work
// (Priority 2). This helper ships now so customers can integrate as soon as
// webhooks arrive.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifySignatureInput {
  body: string | Buffer | Uint8Array;
  header: string | string[] | undefined;
  secret: string;
  /** Reject signatures with timestamps older than this many seconds. Default 300 (5 min). */
  toleranceSec?: number;
  /** Override "now" for testing. */
  nowMs?: number;
}

const DEFAULT_TOLERANCE_SEC = 300;

export function verifyWebhookSignature(input: VerifySignatureInput): boolean {
  const headerValue = Array.isArray(input.header) ? input.header[0] : input.header;
  if (!headerValue || typeof headerValue !== 'string') return false;

  const parsed = parseSignatureHeader(headerValue);
  if (!parsed) return false;

  const tolerance = input.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const now = input.nowMs ?? Date.now();
  if (Math.abs(now - parsed.timestampMs) > tolerance * 1000) {
    return false;
  }

  const bodyStr =
    typeof input.body === 'string' ? input.body : Buffer.from(input.body).toString('utf8');
  const expectedHex = createHmac('sha256', input.secret)
    .update(`${parsed.timestamp.toString()}.${bodyStr}`)
    .digest('hex');

  return constantTimeHexEq(expectedHex, parsed.signatureHex);
}

function parseSignatureHeader(
  header: string,
): { timestamp: number; timestampMs: number; signatureHex: string } | null {
  let timestamp: number | null = null;
  let signature: string | null = null;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') {
      const n = Number(v);
      if (Number.isFinite(n)) timestamp = n;
    } else if (k === 'v1') {
      signature = v;
    }
  }
  if (timestamp === null || signature === null) return null;
  return { timestamp, timestampMs: timestamp * 1000, signatureHex: signature };
}

function constantTimeHexEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

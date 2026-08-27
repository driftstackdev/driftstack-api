// Webhook signature verification helper.
//
// Signature header format (Stripe-style): `t=<unix-seconds>,v1=<hex hmac>`.
// HMAC = SHA256(`<unix-seconds>.<raw body>`, `<webhook secret>`).
//
// Browser-isomorphic: uses `globalThis.crypto.subtle` (Web Crypto API)
// rather than Node's `crypto` module. Works in:
//   - Node.js 20+    (subtle exposed on globalThis.crypto)
//   - Modern browsers (Chrome 92+, Firefox 90+, Safari 15.4+, Edge 92+)
//   - Tauri / Electron WebViews
//   - Cloudflare Workers / Deno / Bun
//
// Customers verify inbound webhook deliveries with this helper:
//
//   import { verifyWebhookSignature } from '@driftstack/sdk';
//
//   app.post('/driftstack-webhook', async (req, res) => {
//     const sig = req.headers['x-driftstack-signature'];
//     const ok = await verifyWebhookSignature({
//       body: req.rawBody,           // string, Uint8Array, or ArrayBuffer
//       header: sig,
//       secret: process.env.DRIFTSTACK_WEBHOOK_SECRET!,
//     });
//     if (!ok) return res.status(401).end();
//     // ... process event ...
//   });
//
// NOTE: in 0.1.0 this function was sync (used Node's crypto). In
// 0.1.1 it became async because Web Crypto's HMAC API is async.
// Callers must `await` the result. The signature verification cost is
// negligible (sub-millisecond on any modern hardware) so async-on-the-
// wire doesn't affect throughput.

export interface VerifySignatureInput {
  body: string | Uint8Array | ArrayBuffer;
  header: string | string[] | undefined;
  /**
   * V-359 — OPTIONAL fallback for a separately-supplied previous-secret
   * signature. Driftstack does NOT emit a separate header: during a
   * rotation grace window the previous-secret HMAC is included as a
   * second `v1=` inside the main `x-driftstack-signature` header
   * (`t=,v1=<new>,v1=<old>`), which the verifier already checks. So
   * passing `header` alone verifies rotation deliveries correctly and
   * this input is rarely needed. When set, the verifier accepts EITHER
   * `header` OR `headerPrev` matching the `secret`.
   */
  headerPrev?: string | string[] | undefined;
  secret: string;
  /** Reject signatures with timestamps older than this many seconds. Default 300 (5 min). */
  toleranceSec?: number;
  /** Override "now" for testing. */
  nowMs?: number;
}

const DEFAULT_TOLERANCE_SEC = 300;

export async function verifyWebhookSignature(input: VerifySignatureInput): Promise<boolean> {
  // V-2010 — refuse before hashing when the signing secret is empty.
  //
  // The three SDK verifiers each document "returns false on any failure mode",
  // and an empty secret is a failure mode. They reached three DIFFERENT wrong
  // answers: Python and Go hash with a zero-length key (both accept an HMAC an
  // attacker computes with no secret at all, since the message is the timestamp
  // and the body they already have), and this one THREW `DataError: Zero-length
  // key is not supported` out of `subtle.importKey` — safe against forgery by
  // accident of WebCrypto, but an exception in the customer's webhook handler
  // where the contract promises a boolean. The server-side sibling has carried
  // this check since V-1465 for exactly the same reason.
  // ⛔ `!input.secret`, NOT `.length === 0` — V-2011. The first spelling of this
  // guard read `.length`, which THROWS a TypeError when an untyped JavaScript
  // caller passes `undefined` or `null`, and untyped JS is the common case for a
  // webhook handler. Measured before and after: pre-guard, `null` RETURNED FALSE
  // and `undefined` threw a DOMException out of subtle.importKey; the `.length`
  // guard made `null` throw too, so the fix regressed the very contract it was
  // written to restore. The falsy test covers '', undefined and null in one, and
  // is what Python's `if not secret:` has always done.
  if (!input.secret) return false;

  const ok = await verifySingleHeader(input.header, input);
  if (ok) return true;
  // V-359 — fall through to the prev header (rotation grace). When
  // unset this is a no-op; when set the customer accepts either the
  // new or the old secret's HMAC during the 24h grace window.
  if (input.headerPrev !== undefined) {
    return verifySingleHeader(input.headerPrev, input);
  }
  return false;
}

async function verifySingleHeader(
  rawHeader: string | string[] | undefined,
  input: VerifySignatureInput,
): Promise<boolean> {
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!headerValue || typeof headerValue !== 'string') return false;

  const parsed = parseSignatureHeader(headerValue);
  if (!parsed) return false;

  const tolerance = input.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const now = input.nowMs ?? Date.now();
  if (Math.abs(now - parsed.timestampMs) > tolerance * 1000) {
    return false;
  }

  const subtle = getSubtleCrypto();
  if (!subtle) return false;

  const enc = new TextEncoder();
  const bodyBytes = toBodyBytes(input.body);
  const payload = concatBytes(enc.encode(`${parsed.timestamp.toString()}.`), bodyBytes);

  const key = await subtle.importKey(
    'raw',
    toArrayBuffer(enc.encode(input.secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuffer = await subtle.sign('HMAC', key, toArrayBuffer(payload));
  const expectedHex = bytesToHex(new Uint8Array(sigBuffer));

  // The header may carry MULTIPLE `v1=` signatures (Stripe-style) — e.g.
  // during a secret-rotation grace window the server dual-signs
  // `t=,v1=<new>,v1=<old>`. Accept if our computed HMAC matches ANY of them
  // (constant-time per candidate), so a verifier holding either the new or
  // the old secret passes. Single-`v1` headers are the one-element case.
  return parsed.signatureHexes.some((sig) => constantTimeHexEq(expectedHex, sig));
}

function parseSignatureHeader(
  header: string,
): { timestamp: number; timestampMs: number; signatureHexes: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') {
      const n = Number(v);
      if (Number.isFinite(n)) timestamp = n;
    } else if (k === 'v1' && v.length > 0) {
      signatures.push(v);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, timestampMs: timestamp * 1000, signatureHexes: signatures };
}

function toBodyBytes(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Copy a Uint8Array's contents into a fresh ArrayBuffer. WebCrypto
 *  rejects SharedArrayBuffer-backed inputs and the TS lib types
 *  differentiate them from ArrayBuffer; this normalises both. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

const HEX_LOOKUP = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
  // Manual hex encoding — both `Buffer.from(...).toString('hex')`
  // (Node-only) and `bytes.toHex()` (Stage 3 proposal, not in Tauri's
  // WebView) would have wider browser-compat caveats. This loop is
  // ~10 ns per byte and fine for the ~32-byte HMAC output.
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += HEX_LOOKUP[b >> 4];
    out += HEX_LOOKUP[b & 0xf];
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const high = parseHexNibble(hex.charCodeAt(i * 2));
    const low = parseHexNibble(hex.charCodeAt(i * 2 + 1));
    if (high < 0 || low < 0) return null;
    out[i] = (high << 4) | low;
  }
  return out;
}

function parseHexNibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  if (code >= 65 && code <= 70) return code - 55; // A-F
  return -1;
}

function constantTimeHexEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = hexToBytes(a);
  const bb = hexToBytes(b);
  if (ab === null || bb === null) return false;
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= (ab[i] as number) ^ (bb[i] as number);
  }
  return diff === 0;
}

function getSubtleCrypto(): SubtleCrypto | null {
  // `globalThis.crypto` exists in Node 20+ (still gated by Node-version
  // policies) and every browser environment we ship into. Defensively
  // probe rather than assume.
  const c = globalThis.crypto;
  if (!c || !c.subtle) return null;
  return c.subtle;
}

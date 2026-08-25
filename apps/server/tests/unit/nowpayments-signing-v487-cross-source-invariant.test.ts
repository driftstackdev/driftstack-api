// W963 — V-487 nowpayments-signing IPN HMAC-SHA512 cross-source
// invariant. Two-hundred-eighty-ninth in the drift-guard series.
// Pins the inbound NowPayments IPN signature-verification primitive:
//
//   V-487 anchor — 'V-487 — NowPayments IPN (Instant Payment
//   Notification) signature verifier. NowPayments signs every
//   webhook payload with HMAC-SHA512 keyed on the IPN secret you
//   set in the merchant dashboard'.
//
//   Header format — 'x-nowpayments-sig: <hex HMAC-SHA512 of the
//   canonicalised body>'.
//
//   Canonicalise-before-HMAC framing — 'The body is canonicalised
//   before HMAC: JSON-parsed, keys sorted lexicographically at every
//   level, then re-serialised — NowPayments' IPN signing protocol
//   computes the signature over the sorted-key serialisation, not the
//   wire byte order. A non-JSON body falls back to raw-body HMAC.
//   Fastify exposes the raw buffer via request.rawBody when the route
//   opts in'.
//
//   Live-consumer framing — 'Consumed by the NowPayments IPN route
//   (routes/webhooks-nowpayments.ts): it verifies the signature and
//   rejects a mismatch with 401. The route is registered only when
//   NOWPAYMENTS_IPN_SECRET is configured (lib/app.ts gate), so the
//   verifier stays dormant until the founder lands a merchant account'.
//
//   VerifyNowpaymentsSignatureOpts (3 fields): body (string |
//     Buffer) + secret + signature (hex string).
//
//   verifyNowpaymentsSignature returns boolean (not throws):
//     - false on: empty body / empty secret / empty signature /
//       invalid hex / digest-length mismatch / hash mismatch.
//     - 'Throwing is reserved for misuse (non-string secret, etc.);
//       a malformed-input path stays false so the caller can
//       return 401 uniformly'.
//
//   Canonicalisation framing — 'NowPayments signs the body with
//   sorted keys; failing to canonicalise before HMAC produces a
//   mismatch even with a correct secret'. The
//   canonicalizeJsonObject path sorts keys lexicographically at
//   every level + recurses through nested objects + arrays.
//
//   Fallback-to-raw framing — 'we only do it when the body parses
//   as a JSON object; for non-JSON bodies we fall through to
//   raw-body HMAC so the verifier is robust against either provider
//   behaviour'.
//
//   timingSafeEqual on hex-decoded digest — constant-time-compare
//   primitive (matches W962 stripe-signing + W961 oauth-pkce
//   pattern).
//
// stays in lockstep across apps/server/src/lib/nowpayments-signing.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyNowpaymentsSignature } from '../../src/lib/nowpayments-signing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W963 V-487 nowpayments-signing IPN cross-source invariant', () => {
  // ─── V-487 anchor + HMAC-SHA512 framing ──────────────────────

  it("CRITICAL apps/server/src/lib/nowpayments-signing.ts header pins V-487 anchor — 'V-487 — NowPayments IPN (Instant Payment Notification) signature verifier. NowPayments signs every webhook payload with HMAC-SHA512 keyed on the IPN secret you set in the merchant dashboard'. The V-487 + HMAC-SHA512 + IPN-secret framing is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'));
    expect(p).toMatch(/V-487 — NowPayments IPN \(Instant Payment Notification\) signature/);
    expect(p).toMatch(/verifier\. NowPayments signs every webhook payload with HMAC-SHA512/);
    expect(p).toMatch(/keyed on the IPN secret you set in the merchant dashboard\./);
  });

  // ─── NowPayments doc reference ───────────────────────────────

  it("CRITICAL NowPayments doc reference framing — 'The algorithm is documented at: https://documenter.getpostman.com/view/7907941/2s93JusNJt'. The doc-link reference is the upstream-source provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'));
    expect(p).toMatch(/algorithm is documented at:/);
    expect(p).toMatch(/https:\/\/documenter\.getpostman\.com\/view\/7907941\/2s93JusNJt/);
  });

  // ─── Header format framing ───────────────────────────────────

  it("CRITICAL header format framing — 'x-nowpayments-sig: <hex HMAC-SHA512 of the canonicalised body>'. The hex-encoded SHA-512 (128 hex chars = 64 bytes) over the canonicalised body is the wire format.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'));
    expect(p).toMatch(/x-nowpayments-sig: <hex HMAC-SHA512 of the canonicalised body>/);
  });

  // ─── Canonicalise-before-HMAC framing ────────────────────────

  it("CRITICAL canonicalise framing — 'The body is canonicalised before HMAC: JSON-parsed, keys sorted lexicographically at every level, then re-serialised — NowPayments' IPN signing protocol computes the signature over the sorted-key serialisation, not the wire byte order. A non-JSON body falls back to raw-body HMAC. Fastify exposes the raw buffer via request.rawBody when the route opts in'. The canonicalise-then-HMAC contract is what an auditor relies on; the impl re-serialises sorted keys (sortKeys), NOT raw bytes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'));
    expect(p).toMatch(/The body is canonicalised before HMAC: JSON-parsed, keys sorted/);
    expect(p).toMatch(/lexicographically at every level, then re-serialised/);
    expect(p).toMatch(/IPN signing protocol computes the signature over the sorted-key/);
    expect(p).toMatch(/serialisation, not the wire byte order\. A non-JSON body falls back to/);
    expect(p).toMatch(/raw-body HMAC\. Fastify exposes the raw buffer via `request\.rawBody`/);
  });

  // ─── Live-consumer framing ───────────────────────────────────

  it("CRITICAL live-consumer framing — 'Consumed by the NowPayments IPN route (apps/server/src/routes/webhooks-nowpayments.ts): it verifies the signature and rejects a mismatch with 401. The route is registered only when NOWPAYMENTS_IPN_SECRET is configured (the wiring in lib/app.ts is gated on it), so the verifier stays dormant until the founder lands a merchant account'. The live-consumer + 401-on-mismatch + secret-gated registration is the accurate wiring.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'));
    expect(p).toMatch(/Consumed by the NowPayments IPN route/);
    expect(p).toMatch(/`apps\/server\/src\/routes\/webhooks-nowpayments\.ts`\): it verifies the/);
    expect(p).toMatch(/signature and rejects a mismatch with 401\./);
    expect(p).toMatch(/registered\s*\/\/ only when `NOWPAYMENTS_IPN_SECRET` is configured/);
    expect(p).toMatch(/so the verifier stays dormant until the/);
  });

  // ─── VerifyNowpaymentsSignatureOpts 3-field shape ────────────

  it("CRITICAL VerifyNowpaymentsSignatureOpts has 3 fields — body (string | Buffer) + secret (IPN secret) + signature (hex-encoded x-nowpayments-sig header value). The 3-field shape is the verifier's input contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'));
    expect(p).toMatch(/export interface VerifyNowpaymentsSignatureOpts \{/);
    expect(p).toMatch(/Raw body bytes as received over HTTP\./);
    expect(p).toMatch(/body: string \| Buffer;/);
    expect(p).toMatch(/The IPN secret from the NowPayments dashboard\./);
    expect(p).toMatch(/secret: string;/);
    expect(p).toMatch(/Hex-encoded signature from the `x-nowpayments-sig` header\./);
    expect(p).toMatch(/signature: string;/);
  });

  // ─── verifyNowpaymentsSignature return-false framing ─────────

  it("CRITICAL verifyNowpaymentsSignature JSDoc — 'Returns true iff signature is a valid HMAC-SHA512 of body keyed on secret. Constant-time comparison via timingSafeEqual. Returns false (rather than throwing) on: empty body or empty secret or empty signature; signature is not valid hex; hex-decoded signature has a length mismatch with the expected SHA-512 digest (64 bytes)'. The 4-false-paths + timingSafeEqual is the boolean-return + constant-time contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'));
    expect(p).toMatch(/Returns true iff `signature` is a valid HMAC-SHA512 of `body` keyed/);
    expect(p).toMatch(/on `secret`\. Constant-time comparison via \{@link timingSafeEqual\}\./);
    expect(p).toMatch(/Returns false \(rather than throwing\) on:/);
    expect(p).toMatch(/- empty body or empty secret or empty signature/);
    expect(p).toMatch(/- signature is not valid hex/);
    expect(p).toMatch(/- hex-decoded signature has a length mismatch with the expected/);
    expect(p).toMatch(/SHA-512 digest \(64 bytes\)/);
  });

  it("CRITICAL throw-vs-return-false rationale framing — 'Throwing is reserved for misuse (non-string secret, etc.); a malformed-input path stays false so the caller can return 401 uniformly'. The 401-uniform-return design avoids leaking pre-validation vs post-compare distinctions to attackers.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'));
    expect(p).toMatch(/Throwing is reserved for misuse \(non-string secret, etc\.\); a/);
    expect(p).toMatch(/malformed-input path stays false so the caller can return 401/);
    expect(p).toMatch(/uniformly\./);
  });

  // ─── Lex-sorted-keys canonicalisation ────────────────────────

  it("CRITICAL canonicalisation framing — 'Sort the parsed JSON body's keys lexicographically before signing — NowPayments' IPN signing protocol mandates this canonicalisation. We only do it when the body parses as a JSON object; for non-JSON bodies we fall through to raw-body HMAC so the verifier is robust against either provider behaviour'. The mandated-sort + JSON-only + fallback-to-raw design is the V-487 verifier contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'));
    expect(p).toMatch(/Sort the parsed JSON body's keys lexicographically before signing —/);
    expect(p).toMatch(/NowPayments' IPN signing protocol mandates this canonicalisation\./);
    expect(p).toMatch(/We only do it when the body parses as a JSON object; for non-JSON/);
    expect(p).toMatch(/bodies we fall through to raw-body HMAC so the verifier is robust/);
    expect(p).toMatch(/against either provider behaviour\./);
  });

  it("CRITICAL canonicalizeJsonObject JSDoc — 'If the input string is a JSON object, return it re-serialised with keys sorted lexicographically at every level. Returns null if the input is not a JSON object (caller falls back to raw-body HMAC). NowPayments signs the body with sorted keys; failing to canonicalise before HMAC produces a mismatch even with a correct secret'. The recursive-sort + null-fallback design is the canonicalisation primitive contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'));
    expect(p).toMatch(/If the input string is a JSON object, return it re-serialised with/);
    expect(p).toMatch(/keys sorted lexicographically at every level\. Returns `null` if the/);
    expect(p).toMatch(/input is not a JSON object \(caller falls back to raw-body HMAC\)\./);
    expect(p).toMatch(/NowPayments signs the body with sorted keys; failing to canonicalise/);
    expect(p).toMatch(/before HMAC produces a mismatch even with a correct secret\./);
  });

  // ─── sortKeys recursion (arrays + nested objects) ────────────

  it('CRITICAL sortKeys recurses through arrays + nested objects — array elements recursed via .map(sortKeys); object keys sorted via Object.keys().sort(). The 2-recurse-path lets nested NowPayments payloads canonicalise correctly.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'));
    expect(p).toMatch(/function sortKeys\(value: unknown\): unknown \{/);
    expect(p).toMatch(/if \(Array\.isArray\(value\)\) return value\.map\(sortKeys\);/);
    expect(p).toMatch(/for \(const key of Object\.keys\(obj\)\.sort\(\)\) \{/);
    expect(p).toMatch(/out\[key\] = sortKeys\(obj\[key\]\);/);
  });

  // ─── timingSafeEqual import (matches W961/W962/W959 pattern) ─

  it('CRITICAL imports createHmac + timingSafeEqual from node:crypto. The 2-primitive import matches W961 oauth-pkce + W962 stripe-signing + W959 webhook-signing convention.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'));
    expect(p).toMatch(/import \{ createHmac, timingSafeEqual \} from 'node:crypto';/);
  });

  // ─── Runtime parity: round-trip valid signature ──────────────

  it('CRITICAL verifyNowpaymentsSignature runtime — valid HMAC-SHA512 hex over canonicalised JSON returns true. Mechanically verified against createHmac round-trip.', () => {
    const secret = 'ipn_test_secret';
    const body = '{"payment_id":"abc","payment_status":"finished","price_amount":100}';
    // Canonicalise: sort keys at every level.
    const canonical = JSON.stringify({
      payment_id: 'abc',
      payment_status: 'finished',
      price_amount: 100,
    });
    const sig = createHmac('sha512', secret).update(canonical).digest('hex');
    expect(verifyNowpaymentsSignature({ body, secret, signature: sig })).toBe(true);
  });

  it('CRITICAL verifyNowpaymentsSignature runtime — canonicalisation matters: input body with reverse-sorted keys still verifies with sig over canonical-sorted body. NowPayments-canonical contract.', () => {
    const secret = 'ipn_test_secret';
    const bodyReversedKeys = '{"price_amount":100,"payment_status":"finished","payment_id":"abc"}';
    // Sort-canonical version.
    const canonical = JSON.stringify({
      payment_id: 'abc',
      payment_status: 'finished',
      price_amount: 100,
    });
    const sigOverCanonical = createHmac('sha512', secret).update(canonical).digest('hex');
    expect(
      verifyNowpaymentsSignature({ body: bodyReversedKeys, secret, signature: sigOverCanonical }),
    ).toBe(true);
  });

  // ─── Runtime: 6 false-paths ──────────────────────────────────

  it('CRITICAL verifyNowpaymentsSignature returns false on empty inputs (3 cases). The empty-checks are the first false-path.', () => {
    expect(verifyNowpaymentsSignature({ body: '', secret: 'x', signature: 'x' })).toBe(false);
    expect(verifyNowpaymentsSignature({ body: 'x', secret: '', signature: 'x' })).toBe(false);
    expect(verifyNowpaymentsSignature({ body: 'x', secret: 'x', signature: '' })).toBe(false);
  });

  it('CRITICAL verifyNowpaymentsSignature returns false on signature-length-mismatch — hex-decoded SHA-512 digest must be 64 bytes. Shorter / longer hex → false.', () => {
    const body = '{"a":1}';
    const secret = 's';
    expect(verifyNowpaymentsSignature({ body, secret, signature: 'aa' })).toBe(false); // 1 byte
    expect(verifyNowpaymentsSignature({ body, secret, signature: 'aa'.repeat(63) })).toBe(false); // 63 bytes
  });

  it('CRITICAL verifyNowpaymentsSignature returns false on hash-mismatch (wrong secret). The hash-mismatch path is the core verification defense.', () => {
    const body = '{"a":1}';
    const sig = createHmac('sha512', 'correct')
      .update(JSON.stringify({ a: 1 }))
      .digest('hex');
    expect(verifyNowpaymentsSignature({ body, secret: 'wrong', signature: sig })).toBe(false);
  });

  // ─── Runtime: Buffer body acceptance ─────────────────────────

  it('CRITICAL verifyNowpaymentsSignature accepts Buffer body (raw bytes). The Buffer + string union lets Fastify rawBody be passed directly.', () => {
    const secret = 'ipn_test_secret';
    const body = '{"a":1}';
    const sig = createHmac('sha512', secret)
      .update(JSON.stringify({ a: 1 }))
      .digest('hex');
    expect(
      verifyNowpaymentsSignature({ body: Buffer.from(body, 'utf8'), secret, signature: sig }),
    ).toBe(true);
  });

  // ─── Runtime: non-JSON body fallback to raw HMAC ─────────────

  it("CRITICAL verifyNowpaymentsSignature falls back to raw-body HMAC for non-JSON inputs — 'fall through to raw-body HMAC so the verifier is robust against either provider behaviour'. Plain-text body verified against HMAC of plain-text.", () => {
    const secret = 'ipn_test_secret';
    const body = 'plain-text-not-json';
    const sigOverRaw = createHmac('sha512', secret).update(body).digest('hex');
    expect(verifyNowpaymentsSignature({ body, secret, signature: sigOverRaw })).toBe(true);
  });

  // ─── Runtime: invalid-hex signature ──────────────────────────

  it("CRITICAL verifyNowpaymentsSignature returns false on invalid-hex signature (e.g. odd-length or non-hex chars). Buffer.from with 'hex' coerces silently; the length-mismatch check after decode catches odd-length.", () => {
    const body = '{"a":1}';
    const secret = 's';
    // odd-length hex → Buffer.from silently truncates → length mismatch
    expect(verifyNowpaymentsSignature({ body, secret, signature: 'odd' })).toBe(false);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/nowpayments-signing-v487-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

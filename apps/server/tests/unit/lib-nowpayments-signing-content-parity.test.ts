// W387.C — drift guard for apps/server/src/lib/nowpayments-signing.
// ts. V-487 NowPayments IPN verifier referenced by /trust/security-
// overview ("NowPayments: V-487 HMAC-SHA512 on canonical-keyed JSON
// + shared raw-body parser"). Behavioural tests cover round-
// tripping; this guard pins the security-relevant protocol +
// canonicalisation claims.
//
//   • V-487 framing pinned.
//   • HMAC-SHA512 on canonical-keyed JSON (NOT raw bytes — keys
//     sorted lexicographically before signing).
//   • x-nowpayments-sig header convention (hex HMAC-SHA512).
//   • Fall through to raw-body HMAC when not a JSON object
//     (robust against either provider behaviour).
//   • timingSafeEqual constant-time compare.
//   • False-on-malformed-input posture (NOT throwing — caller can
//     return 401 uniformly).
//   • SHA-512 64-byte hex digest length check.
//   • Recursive sortKeys helper for nested objects.
//   • Live-consumer framing pinned (webhooks-nowpayments route;
//     gated on NOWPAYMENTS_IPN_SECRET).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W387.C apps/server/src/lib/nowpayments-signing.ts content parity', () => {
  const body = read(LIB);

  it('V-487 framing + HMAC-SHA512 algorithm pinned', () => {
    expect(body).toMatch(
      /V-487 — NowPayments IPN \(Instant Payment Notification\) signature\s*\/\/\s*verifier\. NowPayments signs every webhook payload with HMAC-SHA512/,
    );
  });

  it('x-nowpayments-sig header format pinned (hex HMAC-SHA512 of the canonicalised body)', () => {
    expect(body).toMatch(
      /Header format:\s*\/\/\s*x-nowpayments-sig: <hex HMAC-SHA512 of the canonicalised body>/,
    );
  });

  it('canonicalise-before-HMAC framing: sorted-key serialisation (not wire byte order); non-JSON falls back to raw-body HMAC', () => {
    expect(body).toMatch(
      /The body is canonicalised before HMAC: JSON-parsed, keys sorted\s*\/\/\s*lexicographically at every level, then re-serialised/,
    );
    expect(body).toMatch(/A non-JSON body falls back to\s*\/\/\s*raw-body HMAC\./);
    expect(body).toMatch(
      /Fastify exposes the raw buffer via `request\.rawBody`\s*\/\/\s*when the route opts in/,
    );
  });

  it('NowPayments postman docs URL pinned in JSDoc', () => {
    expect(body).toMatch(/https:\/\/documenter\.getpostman\.com\/view\/7907941\/2s93JusNJt/);
  });

  it('Live-consumer framing pinned (webhooks-nowpayments route; gated on NOWPAYMENTS_IPN_SECRET)', () => {
    expect(body).toMatch(
      /Consumed by the NowPayments IPN route\s*\/\/\s*\(`apps\/server\/src\/routes\/webhooks-nowpayments\.ts`\): it verifies the\s*\/\/\s*signature and rejects a mismatch with 401/,
    );
    expect(body).toMatch(/registered\s*\/\/\s*only when `NOWPAYMENTS_IPN_SECRET` is configured/);
  });

  it('VerifyNowpaymentsSignatureOpts: 3 fields (body / secret / signature)', () => {
    expect(body).toMatch(/body: string \| Buffer;/);
    expect(body).toMatch(/secret: string;/);
    expect(body).toMatch(/signature: string;/);
    expect(body).toMatch(/Hex-encoded signature from the `x-nowpayments-sig` header/);
  });

  it('verifyNowpaymentsSignature: returns false (not throws) on malformed input + constant-time compare', () => {
    expect(body).toMatch(/Constant-time comparison via \{@link timingSafeEqual\}\./);
    expect(body).toMatch(/Returns false \(rather than throwing\) on:/);
    expect(body).toMatch(/- empty body or empty secret or empty signature/);
    expect(body).toMatch(/- signature is not valid hex/);
    expect(body).toMatch(
      /- hex-decoded signature has a length mismatch with the expected\s*\*\s*SHA-512 digest \(64 bytes\)/,
    );
  });

  it('verifyNowpaymentsSignature: explicit body/secret/signature truthiness gate', () => {
    expect(body).toMatch(
      /if \(!opts\.body \|\| !opts\.secret \|\| !opts\.signature\) return false;/,
    );
  });

  it('canonicalizeJsonObject framing: sort keys lexicographically at every level', () => {
    expect(body).toMatch(
      /Sort the parsed JSON body's keys lexicographically before signing —\s*\/\/\s*NowPayments' IPN signing protocol mandates this canonicalisation/,
    );
    expect(body).toMatch(
      /NowPayments signs the body with sorted keys; failing to canonicalise\s*\*\s*before HMAC produces a mismatch even with a correct secret/,
    );
  });

  it('canonicalizeJsonObject: returns null when not a JSON object (falls through to raw-body HMAC)', () => {
    expect(body).toMatch(
      /if \(parsed === null \|\| typeof parsed !== 'object' \|\| Array\.isArray\(parsed\)\) \{\s*return null;\s*\}/,
    );
    expect(body).toMatch(
      /we fall through to raw-body HMAC so the verifier is robust\s*\/\/\s*against either provider behaviour/,
    );
    expect(body).toMatch(/const canonical = canonicalizeJsonObject\(bodyStr\) \?\? bodyStr;/);
  });

  it('sortKeys: recursive (handles arrays + nested objects)', () => {
    expect(body).toMatch(/function sortKeys\(value: unknown\): unknown/);
    expect(body).toMatch(/if \(Array\.isArray\(value\)\) return value\.map\(sortKeys\);/);
    expect(body).toMatch(
      /for \(const key of Object\.keys\(obj\)\.sort\(\)\) \{\s*out\[key\] = sortKeys\(obj\[key\]\);/,
    );
  });

  it('HMAC-SHA512 + Buffer.from(hex) hex-decode with try/catch (returns false on invalid hex)', () => {
    expect(body).toMatch(
      /const expected = createHmac\('sha512', opts\.secret\)\.update\(canonical\)\.digest\(\);/,
    );
    expect(body).toMatch(
      /try \{\s*received = Buffer\.from\(opts\.signature, 'hex'\);\s*\} catch \{\s*return false;\s*\}/,
    );
  });

  it('length-mismatch pre-check before timingSafeEqual (defends against truncation)', () => {
    expect(body).toMatch(/if \(received\.length !== expected\.length\) return false;/);
    expect(body).toMatch(/return timingSafeEqual\(received, expected\);/);
  });

  it('imports: createHmac + timingSafeEqual from node:crypto only', () => {
    expect(body).toMatch(/import \{ createHmac, timingSafeEqual \} from 'node:crypto';/);
  });

  it('file exists at canonical path referenced by /trust/security-overview', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

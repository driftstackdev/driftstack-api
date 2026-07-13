// W959 — webhook-signing V-359 dual-sign HMAC cross-source invariant.
// Two-hundred-eighty-fifth in the drift-guard series. Pins the
// webhook-signing primitive:
//
//   Service intro — 'Webhook signing — server side'.
//
//   Header format (Stripe-style):
//     X-Driftstack-Signature: t=<unix-seconds>,v1=<hex-hmac>
//
//   HMAC framing — 'hmac = HMAC-SHA256(<unix-seconds>.<raw body>,
//   <secret-plaintext>)'.
//
//   D-023 plaintext-secret framing — 'Secrets are generated at
//   subscription-creation time and stored in plaintext (D-023).
//   Verification happens on the customer's machine using the SDK
//   helper'.
//
//   Constants:
//     - SECRET_BODY_BYTES = 20 (32 base32 chars after encoding).
//     - SECRET_PREFIX_LEN = 12 (plaintext prefix for display).
//     - BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567' (RFC
//       4648 lowercase; matches W912 api-keys + W917 mfa-challenge
//       cross-source).
//
//   generateWebhookSecret — returns `whsec_<32 base32>` shape.
//
//   webhookSecretPrefix(plaintext) — first 12 chars for display.
//
//   SignWebhookPayloadOpts (4-field): body + secret + secretPrev?
//     (V-359 dual-sign during rotation grace) + timestampSec? (test
//     seam).
//
//   V-359 dual-sign framing — 'when set, sign with both the current
//   AND the previous secret and emit two v1=… entries comma-
//   separated. Used during the rotation grace period so the
//   customer's verifier accepts either while they roll the new
//   secret across their infra. The SDK verifier iterates over every
//   v1=… entry and accepts the first match'.
//
//   Header format with V-359 dual-sign:
//     `t=<ts>,v1=<curr>,v1=<prev>`.
//
// stays in lockstep across apps/server/src/lib/webhook-signing.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateWebhookSecret,
  signWebhookPayload,
  webhookSecretPrefix,
} from '../../src/lib/webhook-signing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W959 webhook-signing V-359 dual-sign cross-source invariant', () => {
  // ─── Service intro + Stripe-style header framing ─────────────

  it("CRITICAL apps/server/src/lib/webhook-signing.ts header pins surface — 'Webhook signing — server side'. The server-side scope is what distinguishes this from the SDK verifier.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(/Webhook signing — server side\./);
  });

  it("CRITICAL header format framing — 'Header format (Stripe-style, matches the SDK's verifyWebhookSignature): X-Driftstack-Signature: t=<unix-seconds>,v1=<hex-hmac>'. The Stripe-compat + SDK-verifier-matches contract is the customer-facing wire shape.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(/Header format \(Stripe-style, matches the SDK's verifyWebhookSignature\):/);
    expect(p).toMatch(/X-Driftstack-Signature: t=<unix-seconds>,v1=<hex-hmac>/);
  });

  // ─── HMAC-SHA256 framing ─────────────────────────────────────

  it("CRITICAL HMAC framing — 'hmac = HMAC-SHA256(<unix-seconds>.<raw body>, <secret-plaintext>)'. The Stripe-style `t.body` signed-string contract is what the SDK verifier expects.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(/hmac = HMAC-SHA256\(`<unix-seconds>\.<raw body>`, <secret-plaintext>\)/);
  });

  // ─── D-023 encrypted-at-rest framing ─────────────────────────

  it('CRITICAL D-023 framing — versioned AES-GCM at rest and repository-boundary decryption', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(/versioned AES-GCM envelope/);
    expect(p).toMatch(/delivery worker receives plaintext only/);
    expect(p).toMatch(/repository-boundary decryption/);
  });

  // ─── Constants ───────────────────────────────────────────────

  it("CRITICAL BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567' (RFC 4648 lowercase). Matches W912 api-keys + W917 mfa-challenge cross-source — lowercase-not-Crockford preference is consistent across services.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(/const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';/);
  });

  it("CRITICAL SECRET_BODY_BYTES = 20 — 'SECRET_BODY_BYTES = 20; // 32 base32 chars after encoding'. The 20-byte body matches W912 api-keys RANDOM_BODY_BYTES — same 32-base32-char output.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(/const SECRET_BODY_BYTES = 20;\s*\/\/ 32 base32 chars after encoding/);
  });

  it("CRITICAL SECRET_PREFIX_LEN = 12 — 'length of plaintext stored as secretPrefix for display'. The 12-char prefix is the human-displayable identifier.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(
      /const SECRET_PREFIX_LEN = 12;\s*\/\/ length of plaintext stored as secretPrefix for display/,
    );
  });

  // ─── generateWebhookSecret format ────────────────────────────

  it("CRITICAL generateWebhookSecret JSDoc — 'Generate a fresh webhook signing secret in the form whsec_<32 base32>'. The whsec_ prefix matches Stripe's webhook secret convention.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(/Generate a fresh webhook signing secret in the form `whsec_<32 base32>`/);
    expect(p).toMatch(/return `whsec_\$\{base32Encode\(randomBytes\(SECRET_BODY_BYTES\)\)\}`;/);
  });

  it("CRITICAL generateWebhookSecret runtime — returns 'whsec_' + 32 base32 chars (38 total). Verified mechanically.", () => {
    const secret = generateWebhookSecret();
    expect(secret).toHaveLength(38); // 'whsec_' (6) + 32 base32 chars
    expect(secret).toMatch(/^whsec_[a-z2-7]{32}$/);
  });

  it('CRITICAL generateWebhookSecret distinct on each call — no collisions in 10 samples. The randomness is what makes per-endpoint secrets unique.', () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 10; i++) secrets.add(generateWebhookSecret());
    expect(secrets.size).toBe(10);
  });

  // ─── webhookSecretPrefix runtime ─────────────────────────────

  it('CRITICAL webhookSecretPrefix returns first 12 chars (SECRET_PREFIX_LEN). For a whsec_ secret, that includes whsec_ prefix + 6 body chars.', () => {
    const secret = 'whsec_abcdefghij1234567890klmnopqrstuvwxyz';
    expect(webhookSecretPrefix(secret)).toBe('whsec_abcdef'); // first 12
    expect(webhookSecretPrefix(secret)).toHaveLength(12);
  });

  // ─── SignWebhookPayloadOpts 4-field shape ────────────────────

  it('CRITICAL SignWebhookPayloadOpts has 4 fields — body + secret + secretPrev? (V-359 dual-sign) + timestampSec? (test seam). The 4-field opts shape supports V-359 rotation + deterministic tests.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(/export interface SignWebhookPayloadOpts \{/);
    expect(p).toMatch(/body: string;/);
    expect(p).toMatch(/secret: string;/);
    expect(p).toMatch(/secretPrev\?: string;/);
    expect(p).toMatch(/Override "now" \(test seam\)\./);
    expect(p).toMatch(/timestampSec\?: number;/);
  });

  // ─── V-359 dual-sign framing ─────────────────────────────────

  it("CRITICAL V-359 dual-sign framing — 'V-359 — when set, sign with both the current AND the previous secret and emit two v1=… entries comma-separated. Used during the rotation grace period so the customer's verifier accepts either while they roll the new secret across their infra. The SDK verifier iterates over every v1=… entry and accepts the first match'. The dual-sign + verifier-iterates + grace-period framing is the V-359 rotation contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(/V-359 — when set, sign with both the current AND the previous/);
    expect(p).toMatch(/secret and emit two `v1=…` entries comma-separated\. Used during/);
    expect(p).toMatch(/the rotation grace period so the customer's verifier accepts/);
    expect(p).toMatch(/either while they roll the new secret across their infra\. The/);
    expect(p).toMatch(/SDK verifier iterates over every `v1=…` entry and accepts the/);
    expect(p).toMatch(/first match\./);
  });

  // ─── signWebhookPayload header format ────────────────────────

  it("CRITICAL signWebhookPayload JSDoc — 'Build the signed header value. The signed string is <timestamp>.<body>; inverse of verifyWebhookSignature in @driftstack/sdk. V-359 — when secretPrev is set, emits both signatures: t=<ts>,v1=<curr>,v1=<prev>'. The inverse-of-SDK + V-359 dual-emit framing is the wire-format contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(
      /Build the signed header value\. The signed string is `<timestamp>\.<body>`;/,
    );
    expect(p).toMatch(/inverse of `verifyWebhookSignature` in @driftstack\/sdk\./);
    expect(p).toMatch(/V-359 — when `secretPrev` is set, emits both signatures:/);
    expect(p).toMatch(/`t=<ts>,v1=<curr>,v1=<prev>`/);
  });

  // ─── Runtime: signWebhookPayload single-sign ─────────────────

  it('CRITICAL signWebhookPayload runtime — single-sign returns `t=<ts>,v1=<hex>`. The 2-part header is the Stripe-compat wire format.', () => {
    const secret = 'whsec_test';
    const body = '{"event":"test"}';
    const timestampSec = 1747370000;
    const result = signWebhookPayload({ body, secret, timestampSec });

    const expectedSig = createHmac('sha256', secret)
      .update(`${timestampSec}.${body}`)
      .digest('hex');
    expect(result).toBe(`t=${timestampSec},v1=${expectedSig}`);
  });

  it('CRITICAL signWebhookPayload runtime — V-359 dual-sign returns `t=<ts>,v1=<curr>,v1=<prev>`. Both signatures appear comma-separated; verifier accepts first match.', () => {
    const secret = 'whsec_curr';
    const secretPrev = 'whsec_prev';
    const body = 'payload';
    const timestampSec = 1747370000;
    const result = signWebhookPayload({ body, secret, secretPrev, timestampSec });

    const sigCurr = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
    const sigPrev = createHmac('sha256', secretPrev)
      .update(`${timestampSec}.${body}`)
      .digest('hex');
    expect(result).toBe(`t=${timestampSec},v1=${sigCurr},v1=${sigPrev}`);
  });

  it('CRITICAL signWebhookPayload omits secretPrev v1= entry when secretPrev is empty string. The empty-string guard prevents accidental dual-sign with no rotation in flight.', () => {
    const secret = 'whsec_curr';
    const body = 'payload';
    const timestampSec = 1747370000;
    const result = signWebhookPayload({ body, secret, secretPrev: '', timestampSec });

    const sigCurr = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
    expect(result).toBe(`t=${timestampSec},v1=${sigCurr}`);
  });

  it('CRITICAL signWebhookPayload defaults timestampSec to floor(Date.now() / 1000) when omitted. The unix-seconds-now default lets production callers omit the test-seam param.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(/const t = opts\.timestampSec \?\? Math\.floor\(Date\.now\(\) \/ 1000\);/);
  });

  it('CRITICAL signWebhookPayload signs `t.body` (timestamp + dot + body). Mechanically verified via source — drift would break SDK verifier round-trip.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(/const signed = `\$\{t\.toString\(\)\}\.\$\{opts\.body\}`;/);
    expect(p).toMatch(
      /const curr = createHmac\('sha256', opts\.secret\)\.update\(signed\)\.digest\('hex'\);/,
    );
  });

  // ─── base32Encode helper ─────────────────────────────────────

  it("CRITICAL base32Encode uses bit-shift accumulator (8-bit-byte→5-bit-base32 boundary handling). The standard 'value/bits accumulator' pattern is what produces RFC 4648 base32 output.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts'));
    expect(p).toMatch(/function base32Encode\(buf: Buffer\): string \{/);
    expect(p).toMatch(/let bits = 0;/);
    expect(p).toMatch(/let value = 0;/);
    expect(p).toMatch(/while \(bits >= 5\) \{/);
    expect(p).toMatch(/out \+= BASE32_ALPHABET\[\(value >>> \(bits - 5\)\) & 0x1f\];/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/webhook-signing-v359-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

// W388.C — drift guard for apps/server/src/lib/webhook-signing.ts.
// Outbound-webhook signing — load-bearing because customer SDK
// verifiers re-implement this format on their side; format drift
// silently invalidates every customer's webhook handler.
//
//   • Stripe-style header format pinned: X-Driftstack-Signature: t=
//     <unix-seconds>,v1=<hex-hmac>.
//   • HMAC-SHA256 of `<unix-seconds>.<raw body>` (raw bytes, not
//     re-stringified).
//   • Secret format: `whsec_<32 base32>` (matches SDK consumer
//     side; lowercase RFC 4648 base32 — same alphabet as api-keys
//     but distinct from mfa-totp uppercase).
//   • SECRET_BODY_BYTES = 20 → 32 base32 chars.
//   • SECRET_PREFIX_LEN = 12 (human-displayable prefix for UI).
//   • D-023 plaintext-storage framing (subscription-creation time).
//   • V-359 rotation grace: secretPrev → emits t=<ts>,v1=<curr>,
//     v1=<prev>; SDK verifier accepts first match.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W388.C apps/server/src/lib/webhook-signing.ts content parity', () => {
  const body = read(LIB);

  it('X-Driftstack-Signature header format pinned (matches SDK verifyWebhookSignature)', () => {
    expect(body).toMatch(/X-Driftstack-Signature: t=<unix-seconds>,v1=<hex-hmac>/);
    expect(body).toMatch(
      /Header format \(Stripe-style, matches the SDK's verifyWebhookSignature\):/,
    );
  });

  it('HMAC-SHA256 of "<unix-seconds>.<raw body>" framing pinned', () => {
    expect(body).toMatch(/hmac = HMAC-SHA256\(`<unix-seconds>\.<raw body>`, <secret-plaintext>\)/);
  });

  it('encrypted-at-rest framing keeps plaintext scoped to the delivery worker', () => {
    expect(body).toMatch(
      /Secrets are generated at subscription-creation time and stored in a\s*\n?\s*\/\/\s*versioned AES-GCM envelope\. The delivery worker receives plaintext only\s*\n?\s*\/\/\s*after repository-boundary decryption/,
    );
  });

  it('BASE32_ALPHABET = RFC 4648 lowercase (matches api-keys.ts, distinct from mfa-totp uppercase)', () => {
    expect(body).toMatch(/const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';/);
  });

  it('SECRET_BODY_BYTES = 20 (32 base32 chars after encoding)', () => {
    expect(body).toMatch(/const SECRET_BODY_BYTES = 20; \/\/ 32 base32 chars after encoding/);
  });

  it('SECRET_PREFIX_LEN = 12 (UI displayable prefix)', () => {
    expect(body).toMatch(
      /const SECRET_PREFIX_LEN = 12; \/\/ length of plaintext stored as secretPrefix for display/,
    );
  });

  it('generateWebhookSecret: returns `whsec_<32 base32>` format', () => {
    expect(body).toMatch(
      /export function generateWebhookSecret\(\): string \{\s*\n?\s*return `whsec_\$\{base32Encode\(randomBytes\(SECRET_BODY_BYTES\)\)\}`;\s*\n?\s*\}/,
    );
  });

  it('webhookSecretPrefix: slice(0, SECRET_PREFIX_LEN) — human-displayable', () => {
    expect(body).toMatch(
      /export function webhookSecretPrefix\(plaintext: string\): string \{\s*\n?\s*return plaintext\.slice\(0, SECRET_PREFIX_LEN\);\s*\n?\s*\}/,
    );
  });

  it('SignWebhookPayloadOpts: body + secret + optional secretPrev + optional timestampSec', () => {
    expect(body).toMatch(/body: string;/);
    expect(body).toMatch(/secret: string;/);
    expect(body).toMatch(/secretPrev\?: string;/);
    expect(body).toMatch(/timestampSec\?: number;/);
  });

  it('V-359 rotation grace framing: dual-sign with current + previous secret', () => {
    expect(body).toMatch(
      /V-359 — when set, sign with both the current AND the previous\s*\n?\s*\*\s*secret and emit two `v1=…` entries comma-separated\. Used during\s*\n?\s*\*\s*the rotation grace period/,
    );
    expect(body).toMatch(
      /SDK verifier iterates over every `v1=…` entry and accepts the\s*\n?\s*\*\s*first match/,
    );
  });

  it('signWebhookPayload: HMAC-SHA256 of "${t}.${body}" + emits t=...,v1=...', () => {
    expect(body).toMatch(/const signed = `\$\{t\.toString\(\)\}\.\$\{opts\.body\}`;/);
    expect(body).toMatch(
      /const curr = createHmac\('sha256', opts\.secret\)\.update\(signed\)\.digest\('hex'\);/,
    );
    expect(body).toMatch(/const parts = \[`t=\$\{t\.toString\(\)\}`, `v1=\$\{curr\}`\];/);
  });

  it('V-359 dual-emit when secretPrev !== undefined && secretPrev !== ""', () => {
    expect(body).toMatch(
      /if \(opts\.secretPrev !== undefined && opts\.secretPrev !== ''\) \{\s*\n?\s*const prev = createHmac\('sha256', opts\.secretPrev\)\.update\(signed\)\.digest\('hex'\);\s*\n?\s*parts\.push\(`v1=\$\{prev\}`\);/,
    );
  });

  it('output joined by comma: t=<ts>,v1=<curr>,v1=<prev> rotation format', () => {
    expect(body).toMatch(/return parts\.join\(','\);/);
    expect(body).toMatch(/`t=<ts>,v1=<curr>,v1=<prev>`/);
  });

  it('base32Encode helper: bit-shift 5-bit groups + tail-bits handling', () => {
    expect(body).toMatch(/function base32Encode\(buf: Buffer\): string/);
    expect(body).toMatch(/while \(bits >= 5\) \{/);
    expect(body).toMatch(/out \+= BASE32_ALPHABET\[\(value >>> \(bits - 5\)\) & 0x1f\];/);
    expect(body).toMatch(
      /if \(bits > 0\) \{[\s\S]+?out \+= BASE32_ALPHABET\[\(value << \(5 - bits\)\) & 0x1f\];/,
    );
  });

  it('imports: createHmac + randomBytes from node:crypto only', () => {
    expect(body).toMatch(/import \{ createHmac, randomBytes \} from 'node:crypto';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

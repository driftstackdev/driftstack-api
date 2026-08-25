// W716 — server-side webhook-signing canonical-format parity.
// Forty-third in the cross-SDK drift-guard series (W649 + W675-
// W716).
//
// Pins apps/server/src/lib/webhook-signing.ts as the AUTHORITATIVE
// signer. The corresponding cross-SDK side (W674 + W678) verifies
// the WIRE format on the verifier path. This guard pins the
// SIGNER side:
//
//   Header: X-Driftstack-Signature: t=<unix-seconds>,v1=<hex-hmac>
//   Signed string: `<unix-seconds>.<raw body>`
//   HMAC: HMAC-SHA256(signedString, secretPlaintext)
//
// V-359 rotation mode: when secretPrev is set, emit BOTH HMACs as
// two v1=... entries:
//   X-Driftstack-Signature: t=<ts>,v1=<curr>,v1=<prev>
//
// CRITICAL invariants:
//   1. Secret format: `whsec_<32 base32 chars>` from 20 random bytes
//      (160 bits — adequate-but-not-overkill entropy per D-023).
//   2. base32 alphabet is RFC 4648 lowercase (a-z + 2-7) — drift
//      to uppercase would break customer secrets that landed in
//      lowercase prior to a hypothetical change.
//   3. Signed string is `<timestamp>.<body>` with a LITERAL DOT
//      separator (Stripe convention; the SDK verifier splits on it).
//   4. v1 is the version marker (allows future v2 with rotation).
//   5. V-359 dual-sign emits BOTH v1 entries in parts.join(',')
//      order: current first, then previous.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SIGNING = resolve(REPO_ROOT, 'apps/server/src/lib/webhook-signing.ts');

describe('W716 server-side webhook-signing canonical-format parity', () => {
  it('webhook-signing.ts file exists', () => {
    expect(existsSync(SIGNING), `missing ${SIGNING}`).toBe(true);
  });

  it("CRITICAL Stripe-style header format pinned — `X-Driftstack-Signature: t=<unix-seconds>,v1=<hex-hmac>`. Drift to any other shape would break every customer's webhook verifier in the wild. Matches cross-SDK W674 + W678.", () => {
    const src = read(SIGNING);
    expect(src).toMatch(/Header format \(Stripe-style/);
    expect(src).toMatch(/X-Driftstack-Signature: t=<unix-seconds>,v1=<hex-hmac>/);
  });

  it('CRITICAL signed-string format pinned — `<unix-seconds>.<raw body>` with literal DOT separator. The dot is what lets the SDK verifier split the signed input; drift to a different separator would break verification.', () => {
    const src = read(SIGNING);
    expect(src).toMatch(/`<unix-seconds>\.<raw body>`/);
    expect(src).toMatch(/const signed = `\$\{t\.toString\(\)\}\.\$\{opts\.body\}`/);
  });

  it("CRITICAL HMAC-SHA256 algorithm pinned (NOT SHA1, NOT SHA512). Stripe + canonical Driftstack convention. Drift to SHA1 would silently weaken signatures; SHA512 would break every customer's verifier.", () => {
    const src = read(SIGNING);
    expect(src).toMatch(/hmac = HMAC-SHA256\(`<unix-seconds>\.<raw body>`, <secret-plaintext>\)/);
    expect(src).toMatch(/createHmac\('sha256', opts\.secret\)/);
  });

  it("CRITICAL hex encoding on HMAC output pinned — `.digest('hex')`. Drift to base64 would break the v1= regex match in cross-SDK verifiers.", () => {
    const src = read(SIGNING);
    expect(src).toMatch(/\.update\(signed\)\.digest\('hex'\)/);
  });

  it('CRITICAL encrypted secret storage framing keeps delivery-worker plaintext boundary explicit', () => {
    const src = read(SIGNING);
    expect(src).toMatch(/stored in a\s*\/\/ versioned AES-GCM envelope/);
    expect(src).toMatch(/delivery worker receives plaintext only/);
    expect(src).toMatch(/repository-boundary decryption/);
  });

  it('CRITICAL secret format pinned — `whsec_<32 base32 chars>` from 20 random bytes (160 bits entropy). The `whsec_` prefix is what makes secrets identifiable in customer logs; drift to dropping would let customers paste raw base32 strings without recognizing them as secrets.', () => {
    const src = read(SIGNING);
    expect(src).toMatch(/Generate a fresh webhook signing secret in the form `whsec_<32 base32>`/);
    expect(src).toMatch(/SECRET_BODY_BYTES = 20/);
    expect(src).toMatch(/32 base32 chars after encoding/);
    expect(src).toMatch(/return `whsec_\$\{base32Encode\(randomBytes\(SECRET_BODY_BYTES\)\)\}`/);
  });

  it('CRITICAL RFC 4648 lowercase base32 alphabet pinned — `abcdefghijklmnopqrstuvwxyz234567`. Drift to uppercase or a different alphabet would invalidate every existing webhook secret on rotation/verification.', () => {
    const src = read(SIGNING);
    expect(src).toMatch(/const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'/);
  });

  it('CRITICAL SECRET_PREFIX_LEN = 12 pinned for the display-prefix. The 12-char prefix is what dashboards show as `whsec_abc12345...` so customers can identify rotated secrets without exposing the full plaintext. Drift to a longer prefix would silently expose more secret bytes.', () => {
    const src = read(SIGNING);
    expect(src).toMatch(/SECRET_PREFIX_LEN = 12/);
    expect(src).toMatch(
      /export function webhookSecretPrefix\(plaintext: string\): string \{\s*return plaintext\.slice\(0, SECRET_PREFIX_LEN\);/,
    );
  });

  it('CRITICAL V-359 dual-sign rotation framing pinned. The dual-sign during the rotation grace period (W702 24h) is what lets customers roll the new secret across their verifier infra without dropped deliveries. Drift to single-sign-only would break every verifier during rollover.', () => {
    const src = read(SIGNING);

    expect(src).toMatch(
      /V-359 — when set, sign with both the current AND the previous\s*\*\s*secret and emit two `v1=…` entries comma-separated/,
    );
    expect(src).toMatch(
      /Used during\s*\*\s*the rotation grace period so the customer's verifier accepts/,
    );
    expect(src).toMatch(
      /The\s*\*\s*SDK verifier iterates over every `v1=…` entry and accepts the\s*\*\s*first match/,
    );
  });

  it('CRITICAL V-359 dual-sign emission order pinned — current FIRST, then previous. The `parts.push(...)` after the curr-only baseline is what ensures current comes first; SDK verifiers can short-circuit on first-match for performance.', () => {
    const src = read(SIGNING);

    expect(src).toMatch(/const parts = \[`t=\$\{t\.toString\(\)\}`, `v1=\$\{curr\}`\]/);
    expect(src).toMatch(
      /if \(opts\.secretPrev !== undefined && opts\.secretPrev !== ''\) \{\s*const prev = createHmac\('sha256', opts\.secretPrev\)\.update\(signed\)\.digest\('hex'\);\s*parts\.push\(`v1=\$\{prev\}`\)/,
    );
  });

  it("CRITICAL final header construction pinned — `parts.join(',')`. The comma separator is what matches Stripe's convention + the SDK verifier's split regex; drift to semicolon/space would silently mis-format.", () => {
    const src = read(SIGNING);
    expect(src).toMatch(/return parts\.join\(','\)/);
  });

  it('CRITICAL timestampSec test seam pinned — `opts.timestampSec ?? Math.floor(Date.now() / 1000)`. Without the test seam, tests have to mock Date.now globally; drift to dropping would make signing tests harder to write deterministically.', () => {
    const src = read(SIGNING);
    expect(src).toMatch(/Override "now" \(test seam\)/);
    expect(src).toMatch(/const t = opts\.timestampSec \?\? Math\.floor\(Date\.now\(\) \/ 1000\)/);
  });

  it('CRITICAL inverse-of-SDK-verifier framing pinned — "inverse of `verifyWebhookSignature` in @driftstack/sdk". The inverse relationship is what tells engineers the SDK has a matching verifier; drift to dropping would let one side change without the other.', () => {
    const src = read(SIGNING);
    expect(src).toMatch(/inverse of `verifyWebhookSignature` in @driftstack\/sdk/);
  });

  it('CRITICAL base32 encoding implementation pinned — 5-bit grouping with high-bit carry. The standard RFC 4648 base32 encoding (NOT Crockford base32) is what matches customer expectations. Drift to Crockford (no I/L/O/U) would silently produce different secrets.', () => {
    const src = read(SIGNING);

    // 5-bit grouping with the high-byte left-shift.
    expect(src).toMatch(/value = \(value << 8\) \| byte/);
    expect(src).toMatch(/bits \+= 8/);
    expect(src).toMatch(/while \(bits >= 5\)/);
    expect(src).toMatch(/out \+= BASE32_ALPHABET\[\(value >>> \(bits - 5\)\) & 0x1f\]/);

    // Tail-byte handling (left-shift to align).
    expect(src).toMatch(
      /if \(bits > 0\) \{\s*out \+= BASE32_ALPHABET\[\(value << \(5 - bits\)\) & 0x1f\]/,
    );
  });

  it('CRITICAL SignWebhookPayloadOpts 3-field shape pinned — body + secret + secretPrev? + timestampSec?. The optional secretPrev gates V-359 dual-sign; drift to making it required would force every callsite to pass empty string.', () => {
    const src = read(SIGNING);
    expect(src).toMatch(
      /export interface SignWebhookPayloadOpts \{\s*body: string;\s*secret: string;/,
    );
    expect(src).toMatch(/secretPrev\?: string;/);
    expect(src).toMatch(/timestampSec\?: number;/);
  });

  it('CRITICAL randomBytes from node:crypto (not Math.random!) pinned. The CSPRNG randomBytes is what gives the secret 160-bit entropy; drift to Math.random would silently weaken every webhook secret to predictable.', () => {
    const src = read(SIGNING);
    expect(src).toMatch(/import \{ createHmac, randomBytes \} from 'node:crypto'/);
    expect(src).toMatch(/randomBytes\(SECRET_BODY_BYTES\)/);
  });

  it('Server webhook-signing 5-invariant cluster — Stripe-style header + signed-string with dot + HMAC-SHA256 + V-359 dual-sign + base32 alphabet + parts.join(",") + 20-byte secret entropy. Drift on any would fragment the customer-facing webhook signing contract.', () => {
    const src = read(SIGNING);

    expect(src).toMatch(/Stripe-style/);
    expect(src).toMatch(/`\$\{t\.toString\(\)\}\.\$\{opts\.body\}`/);
    expect(src).toMatch(/'sha256'/);
    expect(src).toMatch(/V-359/);
    expect(src).toMatch(/'abcdefghijklmnopqrstuvwxyz234567'/);
    expect(src).toMatch(/parts\.join\(','\)/);
    expect(src).toMatch(/SECRET_BODY_BYTES = 20/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/server-webhook-signing-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

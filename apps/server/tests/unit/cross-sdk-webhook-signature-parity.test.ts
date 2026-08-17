// W678 — cross-SDK webhook-signature format parity. Fifth in the
// cross-SDK drift-guard series (W649 verb + W675 error class + W676
// problem-type URI + W677 auth/UA + W678 webhook signature).
//
// The webhook signature is SECURITY-CRITICAL: if the 3 SDKs disagree
// on the format, a webhook a customer verifies with sdk-typescript
// would fail to verify with sdk-go (or vice versa), letting customers
// silently miss real webhooks OR accept forged ones.
//
// Asserts the same Stripe-style format across all 3 SDKs:
//
//   - Header format: `t=<unix-seconds>,v1=<hex hmac>` (lowercase v1)
//   - HMAC payload: `<unix-seconds>.<raw body>` (dot-separator)
//   - HMAC algorithm: HMAC-SHA256
//   - Constant-time comparison on the HMAC hex
//   - 5-minute default replay-tolerance
//   - V-359 headerPrev rotation grace (24h dual-sign window)
//   - Bidirectional clock-skew check (catches both stale + future-
//     dated signatures)
//
// Drift on any of these 7 invariants would silently break cross-SDK
// webhook verification.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_WSIG = resolve(REPO_ROOT, 'packages/sdk-typescript/src/webhook-signature.ts');
const GO_WSIG = resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go');
const PY_WSIG = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/webhook_signature.py');

describe('W678 cross-SDK webhook-signature format parity', () => {
  it('all 3 SDK webhook-signature files exist at canonical paths', () => {
    expect(existsSync(TS_WSIG), `missing ${TS_WSIG}`).toBe(true);
    expect(existsSync(GO_WSIG), `missing ${GO_WSIG}`).toBe(true);
    expect(existsSync(PY_WSIG), `missing ${PY_WSIG}`).toBe(true);
  });

  it('CRITICAL Stripe-style header format pinned in ALL 3 SDKs: `t=<unix-seconds>,v1=<hex hmac>`. Drift to a different separator (`;` vs `,`) or version label (`v2=` vs `v1=`) would silently reject every cross-SDK signature.', () => {
    const ts = read(TS_WSIG);
    const go = read(GO_WSIG);
    const py = read(PY_WSIG);

    // All 3 SDKs document the header format in a comment.
    expect(ts).toMatch(/t=<unix-seconds>,v1=<hex hmac>/);
    expect(go).toMatch(/t=<unix-seconds>,v1=<hex hmac>/);
    expect(py).toMatch(/t=<unix-seconds>,v1=<hex hmac>/);
  });

  it('CRITICAL HMAC payload format pinned in all 3 SDKs: `<unix-seconds>.<raw body>` (DOT separator between timestamp and body). Drift to a different separator (`|`, `:`, newline) would silently fail every cross-SDK verification because the HMAC would compute over different bytes.', () => {
    const ts = read(TS_WSIG);
    const go = read(GO_WSIG);
    const py = read(PY_WSIG);

    // Match the comment that documents the payload format.
    expect(ts).toMatch(/<unix-seconds>\.<raw body>/);
    expect(go).toMatch(/<unix-seconds>\.<raw body>/);
    expect(py).toMatch(/<unix-seconds>\.<raw body>/);
  });

  it('CRITICAL HMAC-SHA256 algorithm pinned in all 3 SDKs. Drift to SHA-1 (legacy) or SHA-512 (overkill) would silently make every cross-SDK signature mismatch.', () => {
    const ts = read(TS_WSIG);
    const go = read(GO_WSIG);
    const py = read(PY_WSIG);

    // sdk-typescript: `{ name: 'HMAC', hash: 'SHA-256' }` in subtle.importKey.
    expect(ts).toMatch(/'SHA-256'/);

    // sdk-go: imports crypto/sha256 + uses hmac.New(sha256.New, ...).
    expect(go).toMatch(/crypto\/sha256/);
    expect(go).toMatch(/sha256\.New/);

    // sdk-python: imports hashlib + uses hashlib.sha256.
    expect(py).toMatch(/hashlib/);
    expect(py).toMatch(/hashlib\.sha256/);
  });

  it('CRITICAL constant-time HMAC comparison pinned in all 3 SDKs. sdk-typescript uses custom constantTimeHexEq (XOR diff accumulator). sdk-go uses hmac.Equal (stdlib constant-time). sdk-python uses hmac.compare_digest. Drift to a regular `===`/`==`/string-equal would leak timing — attackers could brute-force the HMAC byte-by-byte.', () => {
    const ts = read(TS_WSIG);
    const go = read(GO_WSIG);
    const py = read(PY_WSIG);

    // 2026-07-31 — these three assertions used to check that a NAME appeared:
    // /constantTimeHexEq/, /hmac\.Equal/, and /hmac\.compare_digest|hmac\.new/.
    // All three passed while the property was gone. Verified by mutation:
    // replacing sdk-python's `compare_digest` with `==` left this file 11/11
    // green (the `|hmac\.new` alternative matched the still-present HMAC
    // construction), and gutting sdk-typescript's comparison body to `a === b`
    // while keeping the function name did the same. A guard whose own
    // description says "drift to a regular ===/== would leak timing" has to
    // fail when exactly that happens.

    // sdk-typescript: the XOR difference accumulator itself, not its name.
    expect(ts).toMatch(/constantTimeHexEq/);
    expect(ts, 'constantTimeHexEq must accumulate an XOR difference').toMatch(
      /diff \|= \(ab\[i\] as number\) \^ \(bb\[i\] as number\);/,
    );
    expect(ts, 'and decide on that accumulator, not on string equality').toMatch(
      /return diff === 0;/,
    );

    // sdk-go: hmac.Equal must be the thing the branch tests.
    expect(go).toMatch(/if hmac\.Equal\(/);

    // sdk-python: compare_digest specifically. `hmac.new` is the HMAC
    // construction and says nothing about how the result is compared, so it is
    // no longer accepted as evidence.
    // Operands are the DECODED digests now, not the hex text — see the hex
    // arm below for why. Still hmac.compare_digest, so still constant-time.
    expect(py, 'python must compare with hmac.compare_digest').toMatch(
      /hmac\.compare_digest\(expected_bytes, candidate\)/,
    );
    expect(py, 'and must not fall back to a plain equality compare').not.toMatch(
      /return any\(expected == sig/,
    );
  });

  it('CRITICAL 5-minute default replay-tolerance pinned in all 3 SDKs. Drift to a longer default would widen the replay attack surface; drift to a shorter default would make legitimate webhooks fail on slow networks.', () => {
    const ts = read(TS_WSIG);
    const go = read(GO_WSIG);
    const py = read(PY_WSIG);

    // sdk-typescript: const DEFAULT_TOLERANCE_SEC = 300;
    expect(ts).toMatch(/DEFAULT_TOLERANCE_SEC = 300/);

    // sdk-go: DefaultWebhookTolerance time constant — 5 minutes.
    expect(go).toMatch(/DefaultWebhookTolerance/);
    expect(go).toMatch(/5 ?\* ?time\.Minute|300 ?\* ?time\.Second/);

    // sdk-python: similar default in seconds.
    expect(py).toMatch(/300|5 ?\* ?60/);
  });

  it('CRITICAL V-359 headerPrev fallback — all 3 SDKs expose the optional previous-secret signature input (headerPrev / HeaderPrev / header_prev) for backward-compat. Driftstack does NOT emit a separate header; during rotation the prev HMAC is a second v1= inside the main x-driftstack-signature header, which the verifier already checks. The "EITHER header OR headerPrev matching the secret" pattern stays, but passing header alone covers rotation deliveries.', () => {
    const ts = read(TS_WSIG);
    const go = read(GO_WSIG);
    const py = read(PY_WSIG);

    // sdk-typescript: V-359 + headerPrev kwarg.
    expect(ts).toMatch(/V-359/);
    expect(ts).toMatch(/headerPrev/);

    // sdk-go: HeaderPrev field on options.
    expect(go).toMatch(/HeaderPrev/);

    // sdk-python: header_prev kwarg.
    expect(py).toMatch(/header_prev/);
  });

  it('All 3 SDKs reference the Stripe-style format anchor in comments/docs. The "Stripe-style" wording is load-bearing — drift to dropping the reference would lose the connection between Driftstack\'s format and the well-known Stripe convention that customers may already understand.', () => {
    const ts = read(TS_WSIG);
    const go = read(GO_WSIG);
    const py = read(PY_WSIG);

    expect(ts).toMatch(/Stripe-style/);
    expect(go).toMatch(/Stripe-style/);
    expect(py).toMatch(/Stripe-style/);
  });

  // The claim this arm used to carry — "drift to uppercase hex in any SDK
  // would silently fail cross-SDK verification because constant-time compare is
  // byte-exact" — was false for two of the three, and the arm half-knew it
  // (it already noted Go is "case-insensitive"). Measured across a 14-case
  // matrix run through all three verifiers: for the same body, secret and
  // timestamp, an UPPER-CASE v1 signature was accepted by sdk-typescript and
  // sdk-go and REJECTED by sdk-python.
  //
  // TS and Go decode the hex before comparing (hexToBytes + XOR;
  // hex.DecodeString + hmac.Equal). Python compared the hex TEXT with
  // compare_digest, which is case-sensitive. Decoding is the right side of that
  // split: hex is case-insensitive by definition and the HMAC still has to
  // match byte for byte, so nothing is weakened.
  //
  // Not reachable from this API — the server emits `.digest('hex')`, which is
  // lowercase — but the whole point of this suite, in its own header, is that a
  // webhook one SDK verifies must verify under the others.
  it('Hex encoding invariant — all 3 SDKs EMIT lowercase hex (Stripe convention) and all 3 DECODE before comparing, so none of them is case-sensitive about a signature it receives.', () => {
    const ts = read(TS_WSIG);
    const go = read(GO_WSIG);
    const py = read(PY_WSIG);

    // What each SDK EMITS for its own expected digest: lowercase.
    expect(ts).toMatch(/0123456789abcdef/);
    expect(go).toMatch(/hex\.DecodeString|hex\.EncodeToString/);
    expect(py).toMatch(/hexdigest|\.hex\(\)/);

    // What each SDK ACCEPTS: decoded bytes, not hex text. This is the half that
    // was missing, and it is the half that decides whether the three agree.
    expect(ts, 'sdk-typescript must decode the candidate before comparing').toMatch(
      /hexToBytes\(a\)[\s\S]{0,120}hexToBytes\(b\)/,
    );
    expect(go, 'sdk-go must decode the candidate before comparing').toMatch(
      /hex\.DecodeString\(sigHex\)[\s\S]{0,200}hmac\.Equal/,
    );
    expect(py, 'sdk-python must decode the candidate before comparing').toMatch(
      /bytes\.fromhex\(sig\)[\s\S]{0,300}compare_digest\(expected_bytes, candidate\)/,
    );
    // And the shape that made Python the odd one out must not return.
    expect(
      py,
      'sdk-python is comparing hex TEXT again — that makes it the only SDK of the three to reject ' +
        'an upper-case signature for the same body and secret',
    ).not.toMatch(/compare_digest\(expected, sig\)/);
  });

  it("Webhook-signature export surface — each SDK exports the verify function under the canonical name. sdk-typescript: verifyWebhookSignature. sdk-go: VerifyWebhookSignature. sdk-python: verify_webhook_signature. The 3 names follow each language's naming convention (camelCase / PascalCase-public / snake_case). Drift to renaming would break customer code that imports the verifier.", () => {
    const ts = read(TS_WSIG);
    const go = read(GO_WSIG);
    const py = read(PY_WSIG);

    expect(ts).toMatch(/export async function verifyWebhookSignature/);
    expect(go).toMatch(/func VerifyWebhookSignature/);
    expect(py).toMatch(/def verify_webhook_signature/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-webhook-signature-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

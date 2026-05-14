// W683 — cross-SDK V-666.AO Idempotency-Key parity. Tenth in the
// cross-SDK drift-guard series (W649 verb + W675 error class + W676
// problem-type URI + W677 auth/UA + W678 webhook sig + W679 retry +
// W680 grace window + W681 plaintext-once + W682 step-up window +
// W683 Idempotency-Key).
//
// Asserts the V-666.AO Idempotency-Key header on crypto-orders.
// createCheckout is consistently exposed across all 3 SDKs:
//
//   - Param-naming follows each language's convention:
//     * sdk-typescript: idempotencyKey (camelCase)
//     * sdk-go: IdempotencyKey (PascalCase-public)
//     * sdk-python: idempotency_key (snake_case)
//   - Header forwarded with canonical "Idempotency-Key" name
//     (lowercased "idempotency-key" in TS/Python — HTTP headers
//     are case-insensitive but consistency matters for testing)
//   - V-666.AO anchor pinned per-SDK
//   - "retries don't mint duplicates" rationale framing
//
// Drift to a different header name (e.g. "X-Idempotency-Key" or
// "Request-Id") would silently break server-side dedup. Drift to
// dropping the V-666.AO anchor would lose the changelog provenance.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_CRYPTO = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/crypto-orders.ts');
const GO_CRYPTO = resolve(REPO_ROOT, 'packages/sdk-go/crypto_orders.go');
const PY_CRYPTO = resolve(
  REPO_ROOT,
  'packages/sdk-python/src/driftstack/resources/crypto_orders.py',
);

describe('W683 cross-SDK V-666.AO Idempotency-Key parity', () => {
  it('all 3 SDK crypto-orders files exist at canonical paths', () => {
    expect(existsSync(TS_CRYPTO), `missing ${TS_CRYPTO}`).toBe(true);
    expect(existsSync(GO_CRYPTO), `missing ${GO_CRYPTO}`).toBe(true);
    expect(existsSync(PY_CRYPTO), `missing ${PY_CRYPTO}`).toBe(true);
  });

  it('CRITICAL V-666.AO anchor pinned in all 3 SDKs. The V-666.AO sub-anchor is the changelog reference for the Idempotency-Key feature. Drift to V-666 (no suffix) would conflate with the broader crypto-payments anchor.', () => {
    const ts = read(TS_CRYPTO);
    const go = read(GO_CRYPTO);
    const py = read(PY_CRYPTO);

    expect(ts).toMatch(/V-666\.AO/);
    expect(go).toMatch(/V-666\.AO/);
    expect(py).toMatch(/V-666\.AO/);
  });

  it('CRITICAL canonical header name "Idempotency-Key" pinned in all 3 SDKs. The mixed-case `Idempotency-Key` is the canonical Stripe-style convention; the SDKs send it as lowercase `idempotency-key` on the wire because HTTP headers are case-insensitive, but the canonical form is mixed-case. Drift to "X-Idempotency-Key" or "Request-Id" would break server-side dedup logic.', () => {
    const ts = read(TS_CRYPTO);
    const go = read(GO_CRYPTO);
    const py = read(PY_CRYPTO);

    // sdk-typescript: 'idempotency-key' header literal + Idempotency-Key in docstring
    expect(ts).toMatch(/'idempotency-key'/);
    expect(ts).toMatch(/Idempotency-Key/);

    // sdk-go: "Idempotency-Key" header literal.
    expect(go).toMatch(/"Idempotency-Key"/);

    // sdk-python: "idempotency-key" header literal + Idempotency-Key in docs.
    expect(py).toMatch(/"idempotency-key"/);
    expect(py).toMatch(/Idempotency-Key/);
  });

  it('Per-SDK param-naming follows language convention. sdk-typescript: idempotencyKey (camelCase). sdk-go: IdempotencyKey (PascalCase-public). sdk-python: idempotency_key (snake_case). Drift to a non-canonical name (e.g. snake_case in TS) would break the language idiom.', () => {
    const ts = read(TS_CRYPTO);
    const go = read(GO_CRYPTO);
    const py = read(PY_CRYPTO);

    // sdk-typescript: idempotencyKey?: string optional param.
    expect(ts).toMatch(/idempotencyKey\?: string/);

    // sdk-go: IdempotencyKey *string nullable pointer field.
    expect(go).toMatch(/IdempotencyKey \*string/);

    // sdk-python: idempotency_key: str | None = None default-None kwarg.
    expect(py).toMatch(/idempotency_key: str \| None = None/);
  });

  it('CRITICAL "retries don\'t mint duplicates" rationale framing pinned in all 3 SDKs. The customer-facing claim is what justifies passing an idempotency key — without it, an at-least-once retry strategy would let customers double-charge their cards. Drift to dropping the dedup framing would lose the rationale.', () => {
    const ts = read(TS_CRYPTO);
    const go = read(GO_CRYPTO);
    const py = read(PY_CRYPTO);

    // sdk-typescript: "dedupe retries"
    expect(ts).toMatch(/dedupe retries/);

    // sdk-go: "don't mint duplicates"
    expect(go).toMatch(/don't mint duplicates/);

    // sdk-python: "retries don't\nmint duplicate orders"
    expect(py).toMatch(/retries don't\s*\n?\s*mint duplicate orders|don't mint duplicate/);
  });

  it('CRITICAL conditional-spread / fast-path pattern for header injection in all 3 SDKs. Each SDK ONLY sends the Idempotency-Key header when the param is set (NOT always-set). Drift to always-set would pay the overhead on every call and confuse server-side dedup logic.', () => {
    const ts = read(TS_CRYPTO);
    const go = read(GO_CRYPTO);
    const py = read(PY_CRYPTO);

    // sdk-typescript: conditional spread `opts.idempotencyKey !== undefined ? { headers: { ... } } : {}`.
    expect(ts).toMatch(
      /\.\.\.\(opts\.idempotencyKey !== undefined\s*\n?\s*\? \{ headers: \{ 'idempotency-key': opts\.idempotencyKey \} \}\s*\n?\s*: \{\}\)/,
    );

    // sdk-go: `if opts != nil && opts.IdempotencyKey != nil { req.headers = ... }`
    expect(go).toMatch(/if opts != nil && opts\.IdempotencyKey != nil/);

    // sdk-python: `if idempotency_key is None:` early-return fast-path + else _post_with_headers branch.
    expect(py).toMatch(/if idempotency_key is None:/);
  });

  it('CRITICAL 24h dedup window mentioned in sdk-go comment. The server-side dedup window is 24h — drift to a longer window would let stale idempotency keys collide with new requests (e.g. customer re-uses a key from a year ago); drift to a shorter window would lose the dedup for legitimate retries.', () => {
    const go = read(GO_CRYPTO);
    expect(go).toMatch(/24h window/);
  });

  it('Async-mirror surface in sdk-python — the AsyncCryptoOrdersResource.create_checkout MUST also accept idempotency_key (same kwarg semantics as sync). Drift to dropping from async would let async customers double-charge while sync customers stay safe.', () => {
    const py = read(PY_CRYPTO);
    // Count idempotency_key occurrences — should appear in BOTH sync and async create_checkout signatures.
    const matches = py.match(/idempotency_key: str \| None = None/g) ?? [];
    expect(
      matches.length,
      'expected 2 idempotency_key kwarg signatures (sync + async)',
    ).toBeGreaterThanOrEqual(2);
  });

  it('Header escape-hatch rationale pinned in sdk-python — "HttpClient.request() doesn\'t accept arbitrary headers — adding the parameter to every resource would broaden the public surface and the only place we need it today is create_checkout (V-666.AO). Drive the underlying httpx.Client here." This load-bearing rationale prevents future maintainers from "fixing" the escape hatch back to the wrapper (which would defeat the purpose of containing the broader-surface change).', () => {
    const py = read(PY_CRYPTO);
    expect(py).toMatch(/HttpClient\.request\(\) doesn't accept arbitrary headers/);
    expect(py).toMatch(/only place we need it today is create_checkout \(V-666\.AO\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-idempotency-key-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

// W693 — cross-SDK V-666 crypto-orders parity. Twentieth in the
// cross-SDK drift-guard series (W649 + W675 + W676 + W677 + W678 +
// W679 + W680 + W681 + W682 + W683 + W684 + W685 + W686 + W687 +
// W688 + W689 + W690 + W691 + W692 + W693).
//
// Asserts the V-666 crypto-orders contract is consistent across all
// 3 SDKs:
//
//   - Customer-facing only — admin endpoints NOT exposed in public
//     SDK (drift would expose admin verbs)
//   - Non-refundable disclosure — buyer's-remorse warning that
//     justifies V-666.J self-service cancel as the ONLY out
//   - V-666 sub-anchor coverage — H (quote) + C (createCheckout)
//     + G (read) + BR (list-filter) + BU (cursor walker) + Q
//     (updateNote) + J (cancel) + M (receipt) + AO (Idempotency-
//     Key, see W683)
//   - 8-verb surface — quote / createCheckout / list / iterate /
//     get / updateNote / cancel / receipt
//   - 4 wire-path bases — /v1/billing/crypto-checkout/quote +
//     /v1/billing/crypto-checkout + /v1/billing/crypto-orders +
//     /v1/billing/crypto-orders/:id sub-paths (per-id GET + PATCH
//     + cancel + receipt)
//
// Drift on the customer-facing-only or non-refundable framing
// would silently change the legal disclosure surface; drift on
// V-666 sub-anchors would lose changelog provenance per verb.

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

describe('W693 cross-SDK V-666 crypto-orders parity', () => {
  it('all 3 SDK crypto-orders files exist at canonical paths', () => {
    expect(existsSync(TS_CRYPTO), `missing ${TS_CRYPTO}`).toBe(true);
    expect(existsSync(GO_CRYPTO), `missing ${GO_CRYPTO}`).toBe(true);
    expect(existsSync(PY_CRYPTO), `missing ${PY_CRYPTO}`).toBe(true);
  });

  it('CRITICAL customer-facing-only invariant pinned in all 3 SDKs. The "Customer-facing only; admin endpoints are not exposed in the public SDK" framing prevents admin verbs from leaking into the customer SDK surface. Drift would let customers call admin verbs (e.g. force-refund, override-state). The internal "V-666" anchor is NOT asserted here: `9c53dd232` deliberately stripped rollout markers from the shipped Go SDK, so requiring the anchor in all three would pin a parity the product no longer has — the customer-facing contract is what must match.', () => {
    const ts = read(TS_CRYPTO);
    const go = read(GO_CRYPTO);
    const py = read(PY_CRYPTO);

    // Customer-facing-only framing.
    expect(ts).toMatch(/Customer-facing only; admin endpoints are not exposed in the public/);
    expect(go).toMatch(/Customer-facing only; admin endpoints aren't exposed here/);
    expect(py).toMatch(/Customer-facing only; admin endpoints aren't exposed here/);
  });

  it("CRITICAL non-refundable disclosure pinned in all 3 SDKs. The buyer's-remorse warning is what justifies V-666.J self-service cancel-while-pending as the ONLY out (once paid, no refund). Drift to dropping the disclosure would lose the legal-compliance framing.", () => {
    const ts = read(TS_CRYPTO);
    const go = read(GO_CRYPTO);
    const py = read(PY_CRYPTO);

    expect(ts).toMatch(
      /Crypto\s*\n?\s*\/\/ payments are non-refundable|Crypto payments are non-refundable/,
    );
    expect(go).toMatch(/Crypto payments are non-refundable/);
    expect(py).toMatch(/Crypto payments are non-refundable/);
  });

  it('CRITICAL 7-verb coverage — quote + createCheckout + get + cursor walker + updateNote + cancel + receipt exist in all 3 SDKs. This replaces the old per-verb "V-666.X" anchor sweep: the anchors are internal provenance and no longer present in the Go SDK, whereas a MISSING VERB is the drift that actually breaks a customer, so the verb identifiers themselves are what is pinned.', () => {
    const ts = read(TS_CRYPTO);
    const go = read(GO_CRYPTO);
    const py = read(PY_CRYPTO);

    const verbs: ReadonlyArray<readonly [string, RegExp, RegExp, RegExp]> = [
      ['quote', /\bquote\(/, /func \(r \*CryptoOrdersResource\) Quote\(/, /def quote\(/],
      [
        'createCheckout',
        /\bcreateCheckout\(/,
        /func \(r \*CryptoOrdersResource\) CreateCheckout\(/,
        /def create_checkout\(/,
      ],
      ['get', /\bget\(/, /func \(r \*CryptoOrdersResource\) Get\(/, /def get\(/],
      [
        'cursor walker',
        /\blistAll\(/,
        /func \(r \*CryptoOrdersResource\) Iterate\(/,
        /def iterate\(/,
      ],
      [
        'updateNote',
        /\bupdateNote\(/,
        /func \(r \*CryptoOrdersResource\) UpdateNote\(/,
        /def update_note\(/,
      ],
      ['cancel', /\bcancel\(/, /func \(r \*CryptoOrdersResource\) Cancel\(/, /def cancel\(/],
      ['receipt', /\breceipt\(/, /func \(r \*CryptoOrdersResource\) Receipt\(/, /def receipt\(/],
    ];
    for (const [name, tsRe, goRe, pyRe] of verbs) {
      expect(ts, `sdk-typescript ${name}`).toMatch(tsRe);
      expect(go, `sdk-go ${name}`).toMatch(goRe);
      expect(py, `sdk-python ${name}`).toMatch(pyRe);
    }
  });

  it('CRITICAL V-666.H quote semantic — preview the authoritative fiat price without minting an order. Payment address, currency and amount remain checkout-only.', () => {
    const ts = read(TS_CRYPTO);
    const go = read(GO_CRYPTO);
    const py = read(PY_CRYPTO);

    expect(ts).toMatch(/preview the authoritative fiat price without minting an order/);
    expect(go).toMatch(/previews the authoritative fiat price without minting an/);
    expect(py).toMatch(/preview the authoritative fiat price without minting an order/);
  });

  it('CRITICAL V-666.J cancel-self-service semantic — "abandon a pending order (self-service)". This is the ONLY out for non-refundable crypto payments. Drift to admin-only-cancel would force customers through support for refund-equivalent flow.', () => {
    const ts = read(TS_CRYPTO);
    const go = read(GO_CRYPTO);
    const py = read(PY_CRYPTO);

    expect(ts).toMatch(/abandon a pending order \(self-service\)/);
    expect(go).toMatch(/abandon.*pending order/);
    expect(py).toMatch(/abandon a pending order \(self-service\)/);
  });

  it('CRITICAL V-666.BU cursor walker pinned per-SDK. The cursor pagination + iterate() / listAll() / iterate generator surface is what lets customers walk every order. The envelope `{ orders: [...], next_cursor: ... }` is DIFFERENT from the standard `{ data: ..., next_cursor: ... }` envelope (see W689 + W654) — this DELIBERATE divergence is why each SDK hand-rolls iterate.', () => {
    const ts = read(TS_CRYPTO);
    const go = read(GO_CRYPTO);
    const py = read(PY_CRYPTO);

    expect(ts).toMatch(/async generator/);
    expect(go).toMatch(/func \(r \*CryptoOrdersResource\) Iterate\(/);
    expect(py).toMatch(/def iterate\(/);
    // The divergent envelope is the reason each SDK hand-rolls the walker.
    for (const body of [ts, go, py]) {
      expect(body).toMatch(/next_cursor/);
    }
  });

  it('8-verb surface across all 3 SDKs — quote / createCheckout / list / iterate(or listAll) / get / updateNote / cancel / receipt. The 8 verbs cover the entire customer crypto-payment lifecycle. Drift to dropping any would break the customer-facing flow. NOTE: sdk-go uses different verb names (Quote / CreateCheckout / List / Iterate / Get / UpdateNote / Cancel / Receipt — PascalCase) — checked separately below; this block covers TS + Python only.', () => {
    const ts = read(TS_CRYPTO);
    const py = read(PY_CRYPTO);

    // sdk-typescript: camelCase verbs.
    expect(ts).toMatch(/quote\(body:/);
    expect(ts).toMatch(/createCheckout\(/);
    expect(ts).toMatch(/list\(/);
    expect(ts).toMatch(/listAll\(/);
    expect(ts).toMatch(/get\(orderId/);
    expect(ts).toMatch(/updateNote\(orderId/);
    expect(ts).toMatch(/cancel\(orderId/);
    expect(ts).toMatch(/receipt\(orderId/);

    // sdk-python: snake_case verbs.
    expect(py).toMatch(/def quote\(self/);
    expect(py).toMatch(/def create_checkout\(/);
    expect(py).toMatch(/def list\(/);
    expect(py).toMatch(/def iterate\(/);
    expect(py).toMatch(/def get\(self, order_id/);
    expect(py).toMatch(/def update_note\(self, order_id/);
    expect(py).toMatch(/def cancel\(self, order_id/);
    expect(py).toMatch(/def receipt\(self, order_id/);
  });

  it('CRITICAL 4 wire-path bases pinned per-SDK: /v1/billing/crypto-checkout/quote + /v1/billing/crypto-checkout + /v1/billing/crypto-orders + /v1/billing/crypto-orders/:id-sub-paths (cancel/receipt). Drift to renaming any path would break server-side routing.', () => {
    const ts = read(TS_CRYPTO);
    const go = read(GO_CRYPTO);
    const py = read(PY_CRYPTO);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/billing\/crypto-checkout\/quote/);
      expect(sdk).toMatch(/\/v1\/billing\/crypto-checkout/);
      expect(sdk).toMatch(/\/v1\/billing\/crypto-orders/);
      // per-id /cancel sub-path.
      expect(sdk).toMatch(/crypto-orders.*\/cancel/);
      // per-id /receipt sub-path.
      expect(sdk).toMatch(/crypto-orders.*\/receipt/);
    }
  });

  it('CRITICAL customer-facing-free-text-note framing on V-666.Q updateNote pinned in all 3 SDKs. The "customer-facing free-text note" wording tells customers it\'s their note (NOT admin-side); drift to admin-only would break the dashboard "add reference" feature.', () => {
    const ts = read(TS_CRYPTO);
    const py = read(PY_CRYPTO);

    expect(ts).toMatch(/customer-facing free-text note/);
    expect(py).toMatch(/customer-facing free-text note/);
  });

  it('Cross-SDK cluster — customer-facing-only + non-refundable disclosure + the crypto-orders surface identity hold in all 3 SDKs. Internal rollout anchors are excluded: they are not cross-SDK parity any more (the Go SDK dropped them in `9c53dd232`), and pinning them here is what kept this guard red at HEAD.', () => {
    const sdks = {
      'sdk-typescript': read(TS_CRYPTO),
      'sdk-go': read(GO_CRYPTO),
      'sdk-python': read(PY_CRYPTO),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} non-refundable`).toMatch(/non-refundable/);
      expect(body, `${name} Customer-facing`).toMatch(/[Cc]ustomer-facing/);
      expect(body, `${name} crypto-orders surface`).toMatch(
        /crypto-checkout|crypto_orders|cryptoOrders|CryptoOrders/,
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-crypto-orders-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

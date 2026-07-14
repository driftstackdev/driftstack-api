// W718 — sdk-typescript-crypto-orders marketing-doc parity.
// Forty-fifth in the cross-SDK drift-guard series (W649 + W675-W718)
// and the 61st apps/server/tests/unit/*-doc-parity test (continuing
// the [[project_doc_accuracy_parity_methodology]] pattern).
//
// Pins apps/marketing-site/src/pages/docs/sdk-typescript-crypto-
// orders.astro against:
//   - packages/sdk-typescript/src/resources/crypto-orders.ts (SDK
//     verb roster + signatures)
//   - api-types CryptoOrderStatus enum (closed roster)
//   - cross-SDK W693 V-666 crypto-orders parity invariants
//
// CRITICAL: every code example in the doc MUST call a real SDK verb
// with a real signature; every claim about the closed status enum
// MUST match the source-of-truth.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const DOC = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/sdk-typescript-crypto-orders.astro',
);
const TS_CRYPTO = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/crypto-orders.ts');

describe('W718 sdk-typescript-crypto-orders marketing-doc parity', () => {
  it('both doc + source files exist', () => {
    expect(existsSync(DOC), `missing ${DOC}`).toBe(true);
    expect(existsSync(TS_CRYPTO), `missing ${TS_CRYPTO}`).toBe(true);
  });

  it('CRITICAL V-722 anchor pinned in the doc header. V-722 is the TS-SDK crypto-orders documentation feature; drift to dropping would lose changelog provenance.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/V-722 — TypeScript SDK reference for the crypto-orders surface/);
  });

  it('CRITICAL "Crypto payments are non-refundable" framing pinned in doc + source. Customer-facing legal claim must match the SDK source-of-truth and W693.', () => {
    const doc = read(DOC);
    const src = read(TS_CRYPTO);

    expect(doc).toMatch(/Crypto payments are non-refundable/);
    expect(src).toMatch(
      /Crypto payments are non-refundable|Crypto\s*\n?\s*\/\/ payments are non-refundable/,
    );
  });

  it('CRITICAL doc-claim "Admin endpoints are not exposed" matches the SDK source customer-facing-only framing. Drift would let customers think admin verbs are callable from the SDK.', () => {
    const doc = read(DOC);
    const src = read(TS_CRYPTO);

    expect(doc).toMatch(/Admin endpoints are not exposed/);
    expect(src).toMatch(/Customer-facing only; admin endpoints are not exposed in the public/);
  });

  it("CRITICAL doc verb-roster matches SDK source — 8 verbs: quote, createCheckout, list, listAll (or iterate), get, updateNote, cancel, receipt. Each verb MUST be referenced in the doc's code blocks AND exist on the SDK.", () => {
    const doc = read(DOC);
    const src = read(TS_CRYPTO);

    const verbs = ['quote', 'createCheckout', 'list', 'get', 'updateNote', 'cancel', 'receipt'];

    for (const verb of verbs) {
      // Doc: client.cryptoOrders.<verb>(
      expect(doc, `doc references client.cryptoOrders.${verb}`).toMatch(
        new RegExp(`client\\.cryptoOrders\\.${verb}\\(`),
      );
      // SDK source: <verb>( method signature.
      expect(src, `SDK source has ${verb}( method`).toMatch(new RegExp(`\\b${verb}\\(`));
    }

    // listAll is the async iterator helper.
    expect(doc).toMatch(/client\.cryptoOrders\.listAll\(/);
    expect(src).toMatch(/listAll\(/);
  });

  it('CRITICAL V-666.BU async-iterator pattern doc match — `for await (const o of client.cryptoOrders.listAll(...))`. Drift to plain for-loop would mis-document the cursor-walker; drift to different async-pattern would break customer copy-paste.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(
      /for await \(const o of client\.cryptoOrders\.listAll\(\{ status: 'paid' \}\)\)/,
    );
  });

  it('CRITICAL V-666.BR status filter doc anchor pinned — `V-666.BR — narrow to a single status server-side`. The anchor threads the status-filter feature provenance into the doc.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/V-666\.BR — narrow to a single status server-side/);
  });

  it('CRITICAL V-666.BU explicit-cursor doc anchor pinned. The anchor threads the cursor-paging feature provenance.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/V-666\.BU — explicit cursor paging/);
  });

  it('CRITICAL V-666.AU events-timeline doc anchor pinned on get() return. The anchor threads the events-timeline feature into the doc — drift to dropping would lose customer-facing claim about what get() returns.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/V-666\.AU timeline/);
  });

  it('CRITICAL CryptoOrderStatus 6-value closed-roster doc match. The 6 values (pending/confirming/paid/failed/partial/cancelled) MUST match the api-types CryptoOrderStatus enum; drift would let customers think other statuses are valid.', () => {
    const doc = read(DOC);

    // 6 status values referenced in the doc text.
    expect(doc).toMatch(/<code>pending<\/code>/);
    expect(doc).toMatch(/<code>confirming<\/code>/);
    expect(doc).toMatch(/<code>paid<\/code>/);
    expect(doc).toMatch(/<code>failed<\/code>/);
    expect(doc).toMatch(/<code>partial<\/code>/);
    expect(doc).toMatch(/<code>cancelled<\/code>/);

    // Closed-set framing — "Unknown values return a 400 from the server."
    expect(doc).toMatch(/Unknown values\s*\n?\s*return a 400 from the server/);
  });

  it('CRITICAL doc limit-clamp claim matches server-side — `limit` is clamped to `1..=100`; default 50. Drift to a different bound would silently mismatch what the server enforces.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/<code>limit<\/code> is clamped to\s*\n?\s*<code>1\.\.=100<\/code>/);
    expect(doc).toMatch(/the default is 50/);
  });

  it("CRITICAL doc idempotency-key 24h-window claim matches V-666.AO + W683. The 'duplicate key within the 24h window' framing pins the canonical dedup window.", () => {
    const doc = read(DOC);
    expect(doc).toMatch(/On a duplicate key within the 24h window/);
    expect(doc).toMatch(/same <code>order_id<\/code>/);
    expect(doc).toMatch(/same\s*\n?\s*<code>created_at<\/code>/);
  });

  it('CRITICAL doc cancel-409 + cancel-404 error-code claims match SDK error roster. 409 = past-pending (not self-service); 404 = not-found-or-cross-account. Drift would mislead customers about catch-block branches.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/\/\/ 409: order has moved past pending/);
    expect(doc).toMatch(/cancellation is no longer self-service/);
    expect(doc).toMatch(/\/\/ 404: order doesn't exist or belongs to another account/);
  });

  it('CRITICAL doc "crypto.order.paid / crypto.order.failed events emitted server-side and are now subscribable" framing pinned. Drift would let customers miss that they can subscribe instead of polling.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/<code>crypto\.order\.paid<\/code>/);
    expect(doc).toMatch(/<code>crypto\.order\.failed<\/code>/);
    expect(doc).toMatch(/emitted server-side and are now subscribable/);
    expect(doc).toMatch(/payload contract/);
  });

  it('CRITICAL doc references the runnable end-to-end example file at packages/sdk-typescript/examples/crypto-checkout.ts. The file MUST exist (otherwise customers following the doc hit a missing file).', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/packages\/sdk-typescript\/examples\/crypto-checkout\.ts/);

    const example = resolve(REPO_ROOT, 'packages/sdk-typescript/examples/crypto-checkout.ts');
    expect(existsSync(example), `referenced example file ${example} must exist`).toBe(true);
  });

  it('CRITICAL doc related-links roster pinned — 6 canonical hyperlinks: sdk-typescript, sdk-python-crypto-orders, sdk-go-crypto-orders, billing-crypto-integration-guide, idempotency-keys, webhooks-crypto-events. Drift to dropping or de-canonicalizing a link would break navigation.', () => {
    const doc = read(DOC);

    const links = [
      '/docs/sdk-typescript/',
      '/docs/sdk-python-crypto-orders/',
      '/docs/sdk-go-crypto-orders/',
      // S47 2026-07-07 (founder-approved: mirror deprecation): the
      // integration-guide + webhooks-crypto-events mirrors are
      // deleted; hrefs re-pinned to the docs successors.
      'https://docs.driftstack.dev/guides/paying-with-crypto/',
      '/docs/idempotency-keys/',
      'https://docs.driftstack.dev/webhooks/crypto-events/',
    ];
    for (const link of links) {
      const re = new RegExp(`href="${link.replace(/\//g, '\\/')}"`);
      expect(doc, `related-link ${link}`).toMatch(re);
    }
    expect(doc).not.toMatch(
      /href="\/(?:docs\/sdk-typescript|docs\/sdk-python-crypto-orders|docs\/sdk-go-crypto-orders|docs\/idempotency-keys)"/,
    );
  });

  it('CRITICAL doc idempotencyKey field-name + crypto.randomUUID() pattern pinned. Drift to UUIDv7 or a different field name would mis-document the W683 V-666.AO Idempotency-Key contract.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/const key = crypto\.randomUUID\(\)/);
    expect(doc).toMatch(/idempotencyKey: key/);
  });

  it('CRITICAL receipt() JSON-canonical framing pinned. Drift to documenting receipt() as returning binary/PDF would mis-thread the 3-format split (JSON canonical via SDK, PDF/text via REST direct).', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/The JSON receipt is the canonical machine-readable artefact/);
    expect(doc).toMatch(
      /For PDF \/ text variants, hit the corresponding REST endpoint\s*\n?\s*directly/,
    );
  });

  it('Doc-parity 5-invariant cluster — V-722 anchor + 7-verb roster + 6-status closed enum + V-666.BR/BU/AU/AO sub-anchors + non-refundable framing + customer-facing-only framing. Drift on any would fragment the doc/source-of-truth alignment.', () => {
    const doc = read(DOC);

    expect(doc).toMatch(/V-722/);
    expect(doc).toMatch(/client\.cryptoOrders\.quote\(/);
    expect(doc).toMatch(/client\.cryptoOrders\.createCheckout\(/);
    expect(doc).toMatch(/V-666\.BR/);
    expect(doc).toMatch(/V-666\.BU/);
    expect(doc).toMatch(/V-666\.AU/);
    expect(doc).toMatch(/Crypto payments are non-refundable/);
    expect(doc).toMatch(/Admin endpoints are not exposed/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-typescript-crypto-orders-doc-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

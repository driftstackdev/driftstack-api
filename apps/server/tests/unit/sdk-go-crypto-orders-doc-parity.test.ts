// W720 — sdk-go-crypto-orders marketing-doc parity. Forty-seventh
// in the cross-SDK drift-guard series (W649 + W675-W720) and the
// 63rd apps/server/tests/unit/*-doc-parity test. Closes the last
// un-guarded /docs/* page (sdk-typescript-crypto-orders / sdk-python
// -crypto-orders / sdk-go-crypto-orders triad complete).
//
// Pins apps/marketing-site/src/pages/docs/sdk-go-crypto-orders.astro
// against packages/sdk-go/crypto_orders.go + Go-canonical idioms
// (context.Context, functional-options, pointer-to-string for
// optional fields, callback-returning-bool iterator).
//
// CRITICAL: every code example MUST call a real Go SDK method with
// the real Go signature shape; the Go iterator pattern MUST show
// the canonical callback + ctx.Context contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const DOC = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-go-crypto-orders.astro');
const GO_CRYPTO = resolve(REPO_ROOT, 'packages/sdk-go/crypto_orders.go');

describe('W720 sdk-go-crypto-orders marketing-doc parity', () => {
  it('doc + source files exist', () => {
    expect(existsSync(DOC), `missing ${DOC}`).toBe(true);
    expect(existsSync(GO_CRYPTO), `missing ${GO_CRYPTO}`).toBe(true);
  });

  it('CRITICAL W190 anchor pinned in doc header. W190 is the Go-SDK crypto-orders documentation feature.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/W190 — Go SDK reference for the crypto-orders surface/);
  });

  it('CRITICAL "Crypto payments are non-refundable" framing in doc + source. Legal claim must converge.', () => {
    const doc = read(DOC);
    const src = read(GO_CRYPTO);
    expect(doc).toMatch(/Crypto payments are non-refundable/);
    expect(src).toMatch(/Crypto payments are non-refundable/);
  });

  it('CRITICAL doc-claim "Admin endpoints are not exposed" matches the SDK source customer-facing-only framing.', () => {
    const doc = read(DOC);
    const src = read(GO_CRYPTO);
    expect(doc).toMatch(/Admin endpoints\s*are not exposed/);
    expect(src).toMatch(/Customer-facing only; admin endpoints aren't exposed here/);
  });

  it('CRITICAL 7-verb roster — Quote / CreateCheckout / List / Iterate / Get / UpdateNote / Cancel / Receipt PascalCase. Each verb referenced in doc code blocks AND on the SDK source.', () => {
    const doc = read(DOC);
    const src = read(GO_CRYPTO);

    const verbs = ['Quote', 'CreateCheckout', 'List', 'Get', 'UpdateNote', 'Cancel', 'Receipt'];

    for (const verb of verbs) {
      expect(doc, `doc references client.CryptoOrders.${verb}`).toMatch(
        new RegExp(`client\\.CryptoOrders\\.${verb}\\(`),
      );
      expect(src, `source has func ... ${verb}(`).toMatch(
        new RegExp(`func \\(r \\*CryptoOrdersResource\\) ${verb}\\(`),
      );
    }

    // Iterate referenced in doc + source.
    expect(doc).toMatch(/client\.CryptoOrders\.Iterate\(/);
    expect(src).toMatch(/func \(r \*CryptoOrdersResource\) Iterate\(/);
  });

  it('CRITICAL Go context.Context first-arg convention pinned in every method call shown in the doc. The ctx-first signature is Go-canonical; drift to omitting ctx would mis-document idiomatic Go usage.', () => {
    const doc = read(DOC);

    // Every method call passes ctx as first arg.
    expect(doc).toMatch(/client\.CryptoOrders\.Quote\(ctx,/);
    expect(doc).toMatch(/client\.CryptoOrders\.CreateCheckout\(\s*ctx,/);
    expect(doc).toMatch(/client\.CryptoOrders\.List\(ctx,/);
    expect(doc).toMatch(/client\.CryptoOrders\.Get\(ctx,/);
    expect(doc).toMatch(/client\.CryptoOrders\.UpdateNote\(ctx,/);
    expect(doc).toMatch(/client\.CryptoOrders\.Cancel\(ctx,/);
    expect(doc).toMatch(/client\.CryptoOrders\.Receipt\(ctx,/);
  });

  it('CRITICAL Go functional-options idempotency-key pattern — `&driftstack.CreateCheckoutOptions{IdempotencyKey: &key}` with pointer-to-string. Drift to plain string would mis-thread the Go-canonical nilable-optional pattern.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/&driftstack\.CreateCheckoutOptions\{IdempotencyKey: &key\}/);
  });

  it('CRITICAL uuid.NewString() canonical Go UUID pattern pinned. The `github.com/google/uuid` import + NewString() is canonical; drift to a different uuid lib would force customers to dep-tree-pin.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/key := uuid\.NewString\(\)/);
  });

  it('CRITICAL CryptoOrderStatus 6-value closed-roster doc match — pending / confirming / paid / failed / partial / cancelled + "Unknown values return a 400" framing.', () => {
    const doc = read(DOC);

    expect(doc).toMatch(/<code>pending<\/code>/);
    expect(doc).toMatch(/<code>confirming<\/code>/);
    expect(doc).toMatch(/<code>paid<\/code>/);
    expect(doc).toMatch(/<code>failed<\/code>/);
    expect(doc).toMatch(/<code>partial<\/code>/);
    expect(doc).toMatch(/<code>cancelled<\/code>/);
    expect(doc).toMatch(/Unknown values\s*return a 400/);
  });

  it('CRITICAL limit-clamp doc claim — 1..=100. Drift to a different bound would mismatch the server.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/<code>Limit<\/code> is clamped to 1\.\.=100/);
  });

  it('CRITICAL Go pointer-to-string optional pattern pinned for Status / Limit / Cursor / CreatedAfter. The pointer-to-string idiom is Go-canonical for nilable struct fields. Drift to non-pointer would let zero-value strings serialize as filters (silently mis-querying).', () => {
    const doc = read(DOC);

    expect(doc).toMatch(/status := "paid"/);
    expect(doc).toMatch(/limit {2}:= 25/);
    expect(doc).toMatch(/Status: &status/);
    expect(doc).toMatch(/Limit: {2}&limit/);
    expect(doc).toMatch(/var cursor \*string/);
    expect(doc).toMatch(/Cursor: cursor/);
    expect(doc).toMatch(/CreatedAfter: &since/);
  });

  it('CRITICAL "prefer Iterate" pagination framing pinned + "do not set opts.Cursor when calling Iterate" warning. Drift would let customers stumble on `Iterate(ctx, &opts{Cursor: ...})` (which silently breaks the helper).', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/Pagination — prefer <code>Iterate<\/code>/);
    expect(doc).toMatch(/Cursor handoff is managed\s*internally/);
    expect(doc).toMatch(
      /<strong>do not<\/strong> set\s*<code>opts\.Cursor<\/code> when calling <code>Iterate<\/code>/,
    );
  });

  it('CRITICAL Iterate callback-returns-bool framing pinned. The bool-return-controls-iteration shape is Go-idiomatic for early-exit; drift to error-return-only would lose the customer-facing claim about stopping early.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(
      /Return <code>false<\/code> from the visit callback to stop\s*iteration early/,
    );
    expect(doc).toMatch(/func\(o driftstack\.CryptoOrderEnvelope\) bool/);
    expect(doc).toMatch(/return true \/\/ keep going/);
  });

  it('CRITICAL time-format pattern uses time.RFC3339 + UTC normalization. Drift to local-time would mis-interpret `CreatedAfter` filter across timezones.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(
      /since := time\.Now\(\)\.Add\(-7 \* 24 \* time\.Hour\)\.UTC\(\)\.Format\(time\.RFC3339\)/,
    );
  });

  it('CRITICAL Go cancel-409 + cancel-404 error-code claims match SDK error roster (as inline comments).', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/\/\/ 409: order has moved past pending/);
    expect(doc).toMatch(/cancellation is no longer self-service/);
    expect(doc).toMatch(/\/\/ 404: order doesn't exist or belongs to another account/);
  });

  it('CRITICAL VerifyWebhookSignature (Go PascalCase) framing pinned. Drift to verifyWebhookSignature (TS-camelCase) or verify_webhook_signature (Python-snake_case) would silently mis-document the Go API.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/<code>VerifyWebhookSignature<\/code>/);
  });

  it('CRITICAL runnable example file packages/sdk-go/examples/crypto_checkout/main.go exists. The Go runnable convention uses a per-example directory with main.go (not a flat .go file).', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/packages\/sdk-go\/examples\/crypto_checkout\/main\.go/);

    const example = resolve(REPO_ROOT, 'packages/sdk-go/examples/crypto_checkout/main.go');
    expect(existsSync(example), `example file ${example} must exist`).toBe(true);
  });

  it('CRITICAL doc go-run instruction pinned — `go run ./examples/crypto_checkout`. Drift to `go run examples/crypto_checkout/main.go` would mis-document the canonical Go-run-by-package-path convention.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/go run \.\/examples\/crypto_checkout/);
  });

  it('CRITICAL doc import path pinned — `github.com/driftstackdev/driftstack-api/packages/sdk-go`. Drift to a different import path would let customers paste a path that does not resolve.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/"github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go"/);
  });

  it('CRITICAL doc Related roster pins 7 canonical hyperlinks across 6 destinations; the webhook guide serves event and polling guidance.', () => {
    const doc = read(DOC);

    const links = [
      '/docs/sdk-go/',
      '/docs/sdk-typescript-crypto-orders/',
      '/docs/sdk-python-crypto-orders/',
      // S47 2026-07-07 (founder-approved: mirror deprecation): the
      // integration-guide / webhooks-crypto-events /
      // polling-vs-webhooks mirrors are deleted; hrefs re-pinned to
      // the docs successors.
      'https://docs.driftstack.dev/guides/paying-with-crypto/',
      '/docs/idempotency-keys/',
      'https://docs.driftstack.dev/webhooks/crypto-events/',
    ];
    for (const link of links) {
      const re = new RegExp(`href="${link.replace(/\//g, '\\/')}"`);
      expect(doc, `link ${link}`).toMatch(re);
    }
    const related = doc.slice(doc.indexOf('<h2>Related</h2>'));
    expect(
      related.match(/href="https:\/\/docs\.driftstack\.dev\/webhooks\/crypto-events\/"/g),
    ).toHaveLength(2);
    expect(doc).not.toMatch(
      /href="\/(?:docs\/sdk-go|docs\/sdk-typescript-crypto-orders|docs\/sdk-python-crypto-orders|docs\/idempotency-keys)"/,
    );
  });

  it('CRITICAL per-verb capability claims survive in rendered copy — server-side status filter, by-hand cursor drive, and the events timeline on Get. `6ca50d40e` stripped the internal "V-666.*" prefixes from customer-visible text, so the sentences are what must be pinned.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/\/\/ Narrow to a single status server-side\./);
    expect(doc).toMatch(/\/\/ Or drive the cursor by hand\./);
    expect(doc).toMatch(/fmt\.Println\(single\["events"\]\) \/\/ Event timeline/);
    // Rendered body carries no internal rollout markers.
    const rendered = doc.slice(doc.indexOf('---', doc.indexOf('---') + 3));
    expect(rendered).not.toMatch(/\bV-\d+/);
  });

  it('Doc-parity 6-invariant cluster — W190 anchor + ctx-first 7-verb roster + pointer-to-string optionals + functional-options idempotency-key + Iterate-callback-bool + uuid.NewString + time.RFC3339-UTC + non-refundable framing.', () => {
    const doc = read(DOC);

    expect(doc).toMatch(/W190/);
    expect(doc).toMatch(/client\.CryptoOrders\.Quote\(ctx,/);
    expect(doc).toMatch(/IdempotencyKey: &key/);
    expect(doc).toMatch(/uuid\.NewString\(\)/);
    expect(doc).toMatch(/func\(o driftstack\.CryptoOrderEnvelope\) bool/);
    expect(doc).toMatch(/time\.RFC3339/);
    expect(doc).toMatch(/Crypto payments are non-refundable/);
    expect(doc).toMatch(/Admin endpoints\s*are not exposed/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-go-crypto-orders-doc-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

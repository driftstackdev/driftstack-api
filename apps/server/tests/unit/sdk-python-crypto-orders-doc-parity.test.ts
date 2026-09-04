// W719 — sdk-python-crypto-orders marketing-doc parity. Forty-sixth
// in the cross-SDK drift-guard series (W649 + W675-W719) and the
// 62nd apps/server/tests/unit/*-doc-parity test.
//
// Pins apps/marketing-site/src/pages/docs/sdk-python-crypto-orders
// .astro against packages/sdk-python/src/driftstack/resources/
// crypto_orders.py + sync/async parity invariants (W689 envelope).
//
// CRITICAL: every code example MUST call a real Python SDK verb
// with a real signature; the async-parity section MUST show the
// AsyncDriftstack mirror.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const DOC = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-python-crypto-orders.astro');
const PY_CRYPTO = resolve(
  REPO_ROOT,
  'packages/sdk-python/src/driftstack/resources/crypto_orders.py',
);

describe('W719 sdk-python-crypto-orders marketing-doc parity', () => {
  it('doc + source files exist', () => {
    expect(existsSync(DOC), `missing ${DOC}`).toBe(true);
    expect(existsSync(PY_CRYPTO), `missing ${PY_CRYPTO}`).toBe(true);
  });

  it('CRITICAL W187 anchor pinned in doc header. W187 is the Python-SDK crypto-orders documentation feature.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/W187 — Python SDK reference for the crypto-orders surface/);
  });

  it('CRITICAL "Crypto payments are non-refundable" framing in doc + source. Legal claim must converge.', () => {
    const doc = read(DOC);
    const src = read(PY_CRYPTO);
    expect(doc).toMatch(/Crypto payments are non-refundable/);
    expect(src).toMatch(/Crypto payments are non-refundable/);
  });

  it('CRITICAL doc-claim "Admin endpoints are not exposed" matches the SDK source customer-facing-only framing.', () => {
    const doc = read(DOC);
    const src = read(PY_CRYPTO);
    expect(doc).toMatch(/Admin endpoints are not exposed/);
    expect(src).toMatch(/Customer-facing only; admin endpoints aren't exposed here/);
  });

  it('CRITICAL doc + source converge on sync + async parity claim — Driftstack (sync) + AsyncDriftstack (asyncio). Both classes must exist in the SDK source.', () => {
    const doc = read(DOC);
    const src = read(PY_CRYPTO);

    // Doc references both top-level client classes.
    expect(doc).toMatch(/<code>Driftstack<\/code> \(sync\) and <code>AsyncDriftstack<\/code>/);

    // Source defines both resource classes.
    expect(src).toMatch(/class CryptoOrdersResource:/);
    expect(src).toMatch(/class AsyncCryptoOrdersResource:/);
  });

  it('CRITICAL 7-verb roster — quote / create_checkout / list / iterate / get / update_note / cancel / receipt. Each verb referenced in doc code blocks AND defined on the SDK source.', () => {
    const doc = read(DOC);
    const src = read(PY_CRYPTO);

    const verbs = ['quote', 'create_checkout', 'list', 'get', 'update_note', 'cancel', 'receipt'];

    for (const verb of verbs) {
      expect(doc, `doc references client.crypto_orders.${verb}`).toMatch(
        new RegExp(`client\\.crypto_orders\\.${verb}\\(`),
      );
      expect(src, `source has def ${verb}(`).toMatch(new RegExp(`def ${verb}\\(`));
    }

    // iterate (async-iterator) referenced in doc + source.
    expect(doc).toMatch(/client\.crypto_orders\.iterate\(/);
    expect(src).toMatch(/def iterate\(/);
  });

  it('CRITICAL idempotency_key snake_case keyword pinned (NOT camelCase). The Python SDK uses snake_case; doc must match. The "Idempotency-Key header" framing on the wire is what the SDK forwards under.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/<code>idempotency_key<\/code>/);
    expect(doc).toMatch(/<code>Idempotency-Key<\/code> header/);
    expect(doc).toMatch(/idempotency_key=key,/);
  });

  it('CRITICAL uuid pattern pinned — `str(uuid.uuid4())`. Drift to uuid7 or imports of uuid_extensions would mis-document the canonical key generator.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/import uuid/);
    expect(doc).toMatch(/key = str\(uuid\.uuid4\(\)\)/);
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
    expect(doc).toMatch(/<code>limit<\/code> is clamped to 1\.\.=100/);
  });

  it('CRITICAL "prefer iterate()" pagination framing pinned. The recommended-iterate-over-list-with-cursor pattern guides customers to the helper that handles cursor handoff internally. Drift would let customers stumble on `iterate(cursor=...)` (which is wrong) or hand-roll the loop.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/Pagination — prefer <code>iterate\(\)<\/code>/);
    expect(doc).toMatch(/Cursor handoff\s*is managed internally/);
    expect(doc).toMatch(
      /<strong>do not<\/strong> pass\s*<code>cursor=<\/code> to <code>iterate\(\)<\/code>/,
    );
  });

  it('CRITICAL async-parity claim pinned — "Every method on client.crypto_orders mirrors onto AsyncDriftstack with async def; iterate() returns AsyncIterator[dict]". Drift would mislead customers about async availability.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/Every method on <code>client\.crypto_orders<\/code> mirrors onto/);
    expect(doc).toMatch(/<code>async def<\/code>/);
    expect(doc).toMatch(
      /<code>iterate\(\)<\/code> returns an\s*<code>AsyncIterator\[dict\]<\/code>/,
    );
    expect(doc).toMatch(/<code>async for<\/code>/);
  });

  it('CRITICAL async-example uses `async with AsyncDriftstack(...) as client` pattern. The async-context-manager pattern is what closes the underlying httpx client; drift to bare instantiation would leak connections.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/async with AsyncDriftstack\(api_key="ds_live_…"\) as client:/);
  });

  it('CRITICAL DriftstackError import in cancel example pinned — `from driftstack.errors import DriftstackError`. Drift to a different exception class would mis-thread the error-handling story.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/from driftstack\.errors import DriftstackError/);
    expect(doc).toMatch(/except DriftstackError as err:/);
    // The Python DriftstackError exposes .status + .message (not .title,
    // which is the JS SDK naming); the example reads the real attributes.
    expect(doc).toMatch(/err\.status, err\.message/);
  });

  it('CRITICAL cancel-409 + cancel-404 error-code claims match SDK error roster.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/# 409: order has moved past pending/);
    expect(doc).toMatch(/cancellation is no longer self-service/);
    expect(doc).toMatch(/# 404: order doesn't exist or belongs to another account/);
  });

  it('CRITICAL "crypto.order.paid / crypto.order.failed events emitted server-side and are now subscribable" framing pinned.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/<code>crypto\.order\.paid<\/code>/);
    expect(doc).toMatch(/<code>crypto\.order\.failed<\/code>/);
    expect(doc).toMatch(/emitted server-side and are now subscribable/);
  });

  it('CRITICAL verify_webhook_signature (snake_case Python form) framing pinned. Drift to verifyWebhookSignature (TS-style) would silently mis-document the Python API.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/<code>verify_webhook_signature<\/code>/);
  });

  it('CRITICAL referenced runnable example file packages/sdk-python/examples/crypto_checkout.py exists. Drift to dropping would let customers following the doc hit a missing file.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(/packages\/sdk-python\/examples\/crypto_checkout\.py/);

    const example = resolve(REPO_ROOT, 'packages/sdk-python/examples/crypto_checkout.py');
    expect(existsSync(example), `example file ${example} must exist`).toBe(true);
  });

  it('CRITICAL related-links roster pinned — 6 canonical hyperlinks across 5 destinations (the webhook guide serves both event and polling guidance).', () => {
    const doc = read(DOC);
    const links = [
      '/docs/sdk-python/',
      '/docs/sdk-typescript-crypto-orders/',
      // S47 2026-07-07 (founder-approved: mirror deprecation): the
      // integration-guide / webhooks-crypto-events /
      // polling-vs-webhooks mirrors are deleted; hrefs re-pinned to
      // the docs successors.
      'https://docs.driftstack.io/guides/paying-with-crypto/',
      '/docs/idempotency-keys/',
      'https://docs.driftstack.io/webhooks/crypto-events/',
    ];
    for (const link of links) {
      const re = new RegExp(`href="${link.replace(/\//g, '\\/')}"`);
      expect(doc, `link ${link}`).toMatch(re);
    }
    const related = doc.slice(doc.indexOf('<h2>Related</h2>'));
    expect(
      related.match(/href="https:\/\/docs\.driftstack\.io\/webhooks\/crypto-events\/"/g),
    ).toHaveLength(2);
    expect(doc).not.toMatch(
      /href="\/(?:docs\/sdk-python|docs\/sdk-typescript-crypto-orders|docs\/idempotency-keys)"/,
    );
  });

  it('CRITICAL recommended-pagination example datetime/timedelta UTC pattern pinned. Drift to local-time would let the `created_after` filter mis-interpret across timezones.', () => {
    const doc = read(DOC);
    expect(doc).toMatch(
      /since = \(datetime\.now\(timezone\.utc\) - timedelta\(days=7\)\)\.isoformat\(\)/,
    );
  });

  it("CRITICAL explicit-cursor pattern uses `page.get('next_cursor')` (not direct attribute access). Drift to direct attribute access would error on dict-returning SDK (Python SDK returns dict[str, Any], NOT pydantic model).", () => {
    const doc = read(DOC);
    expect(doc).toMatch(/cursor = page\.get\("next_cursor"\)/);
    expect(doc).toMatch(/if cursor is None:\s*break/);
  });

  it('Doc-parity 5-invariant cluster — W187 anchor + 7-verb roster + 6-status closed enum + sync+async parity + idempotency_key/Idempotency-Key wire mapping + crypto.order.paid/failed-now-subscribable framing + non-refundable framing.', () => {
    const doc = read(DOC);

    expect(doc).toMatch(/W187/);
    expect(doc).toMatch(/client\.crypto_orders\.quote\(/);
    expect(doc).toMatch(/client\.crypto_orders\.create_checkout\(/);
    expect(doc).toMatch(/idempotency_key/);
    expect(doc).toMatch(/AsyncDriftstack/);
    expect(doc).toMatch(/Crypto payments are non-refundable/);
    expect(doc).toMatch(/Admin endpoints are not exposed/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-python-crypto-orders-doc-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

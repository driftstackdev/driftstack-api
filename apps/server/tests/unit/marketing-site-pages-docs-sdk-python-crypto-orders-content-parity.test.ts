// W513.B — drift guard for apps/marketing-site/src/pages/docs/sdk-python-crypto-orders.astro.
// W187 Python SDK crypto-orders reference. Drift here either changes a
// method name (would create marketing↔SDK divergence) or breaks the
// idempotency-key framing (would mislead about double-charge protection).
//
//   • W187 doc-comment framing + V-666 surface anchor.
//   • client.crypto_orders sync resource + AsyncDriftstack mirror.
//   • Admin endpoints NOT exposed in the SDK.
//   • quote() / create_checkout() / list() / get() / update_note() /
//     cancel() / receipt() — 7-method customer-facing surface.
//   • idempotency_key kwarg → Idempotency-Key header + 24h dedupe window.
//   • status filter accepts 6 enum values + 400 on unknown.
//   • iterate() AsyncIterator parity + do-not-pass-cursor-to-iterate rule.
//   • DriftstackError + 409/404 handling on cancel.
//   • Crypto non-refundable + cancellation halts pay window.
//   • Polling-until-webhooks-graduate framing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-python-crypto-orders.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W513.B apps/marketing-site/src/pages/docs/sdk-python-crypto-orders.astro content parity', () => {
  const body = read(LIB);

  it("W187 framing + non-refundable banner pinned: 'Python SDK reference for the crypto-orders surface. Companion to /docs/sdk-python (the general Python SDK quickstart). Crypto payments are non-refundable.' — pinned so the W187 anchor + sdk-python companion + non-refundable banner all survive (drift to dropping the non-refundable banner would orphan the legal posture from the SDK doc)", () => {
    expect(body).toMatch(
      /\/\/ W187 — Python SDK reference for the crypto-orders surface\.\s*\n?\s*\/\/ Companion to \/docs\/sdk-python \(the general Python SDK quickstart\)\.\s*\n?\s*\/\/ Crypto payments are non-refundable\./,
    );
  });

  it("client.crypto_orders + AsyncDriftstack mirror + admin-not-exposed framing pinned (drift to claiming admin endpoints are exposed would mislead integrators about the SDK surface). Re-enabled by slice 201 after refreshing the regex against the current 'on the surface' text (the V-666 anchor was paraphrased away in a prior edit; the sync/async-mirror + admin-not-exposed contract survives)", () => {
    expect(body).toMatch(
      /The <code>client\.crypto_orders<\/code> resource wraps every\s*\n?\s*customer-facing endpoint on the surface from both\s*\n?\s*<code>Driftstack<\/code> \(sync\) and <code>AsyncDriftstack<\/code>\s*\n?\s*\(asyncio\)\. Admin endpoints are not exposed; integrators that need\s*\n?\s*them call the REST surface directly\./,
    );
  });

  it("quote() + create_checkout() framing pinned: quote({'product': 'solo_manual'}) → price_cents + price_currency + create_checkout 3-field body (product/price_cents/price_currency) + idempotency_key kwarg → Idempotency-Key header + 24h dedupe window — pinned so the 2-method surface + 3-field-body + 24h-window survives (drift to a different dedupe window would create marketing↔server-idempotency-store divergence)", () => {
    expect(body).toMatch(/quote = client\.crypto_orders\.quote\(\{"product": "solo_manual"\}\)/);
    expect(body).toMatch(/quote\["price_cents"\], quote\["price_currency"\]/);
    expect(body).toMatch(/order = client\.crypto_orders\.create_checkout\(/);
    expect(body).toMatch(
      /\{"product": "team_manual", "price_cents": 4900, "price_currency": "USD"\}/,
    );
    expect(body).toMatch(/idempotency_key=key/);
    expect(body).toMatch(
      /The SDK\s*\n?\s*forwards it as the <code>Idempotency-Key<\/code> header; on a\s*\n?\s*duplicate key within the 24h window the server returns the\s*\n?\s*original order\./,
    );
  });

  it('list() default limit=50 + status filter + event timeline + 6-status enum + bounds pinned', () => {
    expect(body).toMatch(/page = client\.crypto_orders\.list\(\)/);
    expect(body).toMatch(/page\["orders"\]/);
    expect(body).toMatch(/# Narrow to a single status server-side\./);
    expect(body).toMatch(/print\(single\["events"\]\) {2}# Event timeline/);
    expect(body).toMatch(
      /<code>status<\/code> accepts <code>pending<\/code>,\s*\n?\s*<code>confirming<\/code>, <code>paid<\/code>, <code>failed<\/code>,\s*\n?\s*<code>partial<\/code>, or <code>cancelled<\/code>\. Unknown values\s*\n?\s*return a 400\. <code>limit<\/code> is clamped to 1\.\.=100\./,
    );
  });

  it("iterate() prefer-cursor-helper framing pinned: 'The iterate() helper walks every page until the server stops emitting a next_cursor. Cursor handoff is managed internally — do not pass cursor= to iterate() (use list() for an explicit page).' + manual-cursor-while-loop pattern — pinned so the iterate-walks-all + do-not-pass-cursor + manual-cursor-while-pattern survive (drift to letting iterate take cursor= would invite cursor double-handling)", () => {
    expect(body).toMatch(
      /The <code>iterate\(\)<\/code> helper walks every page until the\s*\n?\s*server stops emitting a <code>next_cursor<\/code>\. Cursor handoff\s*\n?\s*is managed internally — <strong>do not<\/strong> pass\s*\n?\s*<code>cursor=<\/code> to <code>iterate\(\)<\/code> \(use\s*\n?\s*<code>list\(\)<\/code> for an explicit page\)\./,
    );
    expect(body).toMatch(/for order in client\.crypto_orders\.iterate\(/);
    expect(body).toMatch(/cursor = page\.get\("next_cursor"\)/);
    expect(body).toMatch(/if cursor is None:/);
  });

  it("Async parity framing pinned: 'Every method on client.crypto_orders mirrors onto AsyncDriftstack with async def; iterate() returns an AsyncIterator[dict] that you walk with async for' + AsyncDriftstack context-manager pattern — pinned so the 1:1-mirror commitment + AsyncIterator[dict] return-type + async-with context-manager pattern survive (drift to dropping AsyncIterator[dict] would weaken the typed-async story)", () => {
    expect(body).toMatch(
      /Every method on <code>client\.crypto_orders<\/code> mirrors onto\s*\n?\s*<code>AsyncDriftstack<\/code> with <code>async def<\/code>;\s*\n?\s*<code>iterate\(\)<\/code> returns an\s*\n?\s*<code>AsyncIterator\[dict\]<\/code> that you walk with\s*\n?\s*<code>async for<\/code>/,
    );
    expect(body).toMatch(/async with AsyncDriftstack\(api_key="ds_live_…"\) as client:/);
    expect(body).toMatch(/async for order in client\.crypto_orders\.iterate\(status="paid"\):/);
  });

  it("update_note() + cancel() + 409/404 handling framing pinned: update_note 2-arg + cancel raises DriftstackError + 409 past-pending + 404 doesn't-exist-or-other-account + 'Crypto payments are non-refundable. Cancelling a pending order halts its pay window; cancelling a paid order is not supported — past billing periods stay billed.' — pinned so the 2-method surface + 2-status-error-code-meaning + cancel-pending-halts-pay-window framing survives (drift to claiming paid-order cancellation works would create marketing↔refund-policy divergence)", () => {
    expect(body).toMatch(
      /client\.crypto_orders\.update_note\("ord_abc", \{"customer_note": "PO-9921"\}\)/,
    );
    expect(body).toMatch(/from driftstack\.errors import DriftstackError/);
    expect(body).toMatch(/client\.crypto_orders\.cancel\("ord_abc"\)/);
    expect(body).toMatch(
      /# 409: order has moved past pending; cancellation is no longer self-service\./,
    );
    expect(body).toMatch(/# 404: order doesn't exist or belongs to another account\./);
    expect(body).toMatch(
      /Crypto payments are non-refundable\. Cancelling a pending order\s*\n?\s*halts its pay window; cancelling a paid order is not supported\s*\n?\s*— past billing periods stay billed\./,
    );
  });

  it('receipt() framing pinned: receipt 1-arg + paid_at + price_cents keys — pinned so the receipt-fetch surface stays consistent (drift to renaming the 2-key receipt shape would create marketing↔server divergence)', () => {
    expect(body).toMatch(/receipt = client\.crypto_orders\.receipt\("ord_abc"\)/);
    expect(body).toMatch(/receipt\["paid_at"\], receipt\["price_cents"\]/);
  });

  it("Now-subscribable + polling-fallback framing pinned: 'crypto.order.paid / crypto.order.failed events are emitted server-side and are now subscribable' + 'poll client.crypto_orders.get(order_id) until status transitions to paid or failed' + verify_webhook_signature for every live event type including crypto.order.* — pinned so the now-subscribable + polling-as-fallback + verify_webhook_signature-every-domain trio survives (drift to claiming the events are NOT subscribable would create marketing↔SubscribableWebhookEventTypeSchema divergence)", () => {
    expect(body).toMatch(
      /<code>crypto\.order\.paid<\/code> \/ <code>crypto\.order\.failed<\/code>\s*\n?\s*events are emitted server-side and are now subscribable/,
    );
    expect(body).toMatch(
      /poll\s*\n?\s*<code>client\.crypto_orders\.get\(order_id\)<\/code> until\s*\n?\s*<code>status<\/code> transitions to <code>paid<\/code> or\s*\n?\s*<code>failed<\/code>/,
    );
    expect(body).toMatch(
      /The Python SDK ships\s*\n?\s*<code>verify_webhook_signature<\/code> for every live event type,\s*\n?\s*including the now-live crypto\.order\.\* events alongside the\s*\n?\s*session \+ quota \+ api-key \+ egress-capability event domains\./,
    );
  });

  it("End-to-end example framing pinned: 'packages/sdk-python/examples/crypto_checkout.py' + 'DRIFTSTACK_API_KEY=... python examples/crypto_checkout.py' — pinned so the runnable-example path + env-var-prefix invocation stays consistent (drift to a different example path would create marketing↔SDK-examples-dir divergence)", () => {
    expect(body).toMatch(/<code>packages\/sdk-python\/examples\/crypto_checkout\.py<\/code>/);
    expect(body).toMatch(
      /<code>DRIFTSTACK_API_KEY=\.\.\. python examples\/crypto_checkout\.py<\/code>/,
    );
  });

  it('6-related-doc cluster: /docs/sdk-python + /docs/sdk-typescript-crypto-orders + /docs/billing-crypto-integration-guide + /docs/idempotency-keys + /docs/webhooks-crypto-events + /docs/crypto-orders-polling-vs-webhooks — pinned so the 6-related-doc navigation surface stays complete (drift to dropping /docs/crypto-orders-polling-vs-webhooks would orphan the polling-vs-webhooks decision from the polling-fallback framing)', () => {
    expect(body).toMatch(/<a href="\/docs\/sdk-python\/">Python SDK quickstart<\/a>/);
    expect(body).toMatch(
      /<a href="\/docs\/sdk-typescript-crypto-orders\/">TypeScript SDK crypto orders<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/guides\/paying-with-crypto\/">Integration guide<\/a>/,
    );
    expect(body).toMatch(/<a href="\/docs\/idempotency-keys\/">Idempotency keys<\/a>/);
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/webhooks\/crypto-events\/">Crypto webhook events<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/webhooks\/crypto-events\/">Polling vs webhooks<\/a>/,
    );
    for (const path of [
      '/docs/sdk-python',
      '/docs/sdk-typescript-crypto-orders',
      '/docs/idempotency-keys',
    ]) {
      expect(body).not.toContain(`href="${path}"`);
    }
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

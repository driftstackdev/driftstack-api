// W510.A — drift guard for apps/marketing-site/src/pages/docs/sdk-typescript-crypto-orders.astro.
// V-722 TypeScript SDK crypto-orders reference. Drift here either
// changes the SDK method-name surface (would create marketing↔SDK
// divergence) or weakens the crypto-non-refundable cancellation framing.
//
//   • V-722 doc-comment framing.
//   • client.cryptoOrders 7-method surface: quote / createCheckout /
//     list / get / updateNote / cancel / receipt.
//   • Idempotency-Key pairing on createCheckout with 24h window.
//   • V-666.BR status filter (6-state enum) + V-666.BU cursor + V-666.AU
//     events timeline + listAll() async iterator.
//   • Cancel 409 (past-pending) / 404 (not-found-or-other-account).
//   • Crypto non-refundable + /legal/refunds cross-reference.
//   • crypto.order.paid / failed are now subscribable (2026-05-22 —
//     wired end-to-end via WebhooksService emitter sink).
//   • End-to-end example at packages/sdk-typescript/examples/
//     crypto-checkout.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/sdk-typescript-crypto-orders.astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W510.A apps/marketing-site/src/pages/docs/sdk-typescript-crypto-orders.astro content parity', () => {
  const body = read(LIB);

  it("V-722 framing pinned: 'TypeScript SDK reference for the crypto-orders surface. Companion to /docs/sdk-typescript (the general SDK quickstart). Crypto payments are non-refundable.' — pinned so the V-722 anchor + the companion-to-sdk-typescript cross-reference + the explicit 'crypto non-refundable' commitment in the doc-comment all survive (drift to softening 'non-refundable' would let customer expectations drift from the legal posture)", () => {
    expect(body).toMatch(
      /\/\/ V-722 — TypeScript SDK reference for the crypto-orders surface\.\s*\n?\s*\/\/ Companion to \/docs\/sdk-typescript \(the general SDK quickstart\)\.\s*\n?\s*\/\/ Crypto payments are non-refundable\./,
    );
  });

  it('client.cryptoOrders 7-method surface: quote + createCheckout + list + get + updateNote + cancel + receipt — pinned so the 7-method SDK surface stays consistent (drift to adding/removing a method would create marketing↔SDK divergence; drift to renaming any method name would orphan customer code from the new identifier)', () => {
    expect(body).toMatch(/client\.cryptoOrders\.quote\(\{ product: 'solo_manual' \}\)/);
    expect(body).toMatch(/client\.cryptoOrders\.createCheckout\(/);
    expect(body).toMatch(/await client\.cryptoOrders\.list\(\);/);
    expect(body).toMatch(/await client\.cryptoOrders\.get\('ord_abc123def456'\);/);
    expect(body).toMatch(/client\.cryptoOrders\.updateNote\('ord_abc',/);
    expect(body).toMatch(/await client\.cryptoOrders\.cancel\('ord_abc'\);/);
    expect(body).toMatch(/await client\.cryptoOrders\.receipt\('ord_abc'\);/);
  });

  it('quote is an authoritative fiat-price preview; crypto amount and address arrive only with checkout creation', () => {
    expect(body).toMatch(
      /Preview a tier's authoritative fiat price without minting an\s*\n?\s*order\. The exact crypto amount and deposit address are returned\s*\n?\s*only when you create the checkout:/,
    );
    expect(body).not.toMatch(/pay range|once NowPayments is wired up/i);
  });

  it("Idempotency-Key pairing on createCheckout pinned: 'Always pair the call with an idempotencyKey so accidental double-submits don't mint duplicate orders' + 'On a duplicate key within the 24h window, the SDK returns the original order — same order_id, same created_at.' — pinned so the always-pair-with-key + 24h-window + same-order_id-same-created_at-on-replay commitment all survive (drift to dropping 24h window would create marketing↔server divergence with /docs/idempotency-keys)", () => {
    expect(body).toMatch(
      /Always pair the call with an <code>idempotencyKey<\/code> so\s*\n?\s*accidental double-submits don't mint duplicate orders/,
    );
    expect(body).toMatch(
      /On a duplicate key within the 24h window, the SDK returns the\s*\n?\s*original order — same <code>order_id<\/code>, same\s*\n?\s*<code>created_at<\/code>\./,
    );
  });

  it('status filter, cursor paging, and event timeline examples stay explicit without internal labels', () => {
    expect(body).toMatch(/\/\/ Narrow to a single status server-side\./);
    expect(body).toMatch(/\/\/ Explicit cursor paging\./);
    expect(body).toMatch(/single\.events\); \/\/ Event timeline/);
  });

  it("6-state status filter enum: pending + confirming + paid + failed + partial + cancelled + 'limit clamped to 1..=100; the default is 50.' — pinned so the 6-state enum (consistent with admin CSV + docs/crypto-orders-polling-vs-webhooks) + the limit-default-50-with-1-100-range survive (drift to dropping a state would orphan that status from filterable view; drift to a different limit default would create marketing↔SDK divergence)", () => {
    expect(body).toMatch(
      /<code>status<\/code> accepts <code>pending<\/code>,\s*\n?\s*<code>confirming<\/code>, <code>paid<\/code>, <code>failed<\/code>,\s*\n?\s*<code>partial<\/code>, or <code>cancelled<\/code>\./,
    );
    expect(body).toMatch(
      /<code>limit<\/code> is clamped to\s*\n?\s*<code>1\.\.=100<\/code>; the default is 50\./,
    );
  });

  it("listAll async-iterator helper pinned: 'for await (const o of client.cryptoOrders.listAll({ status: 'paid' }))' — pinned so the async-iterator helper for cursor-walked iteration survives (drift to dropping listAll() would force customers to write the cursor walk loop themselves; consistent with the /docs/crypto-orders-polling-vs-webhooks listAll() framing)", () => {
    expect(body).toMatch(
      /for await \(const o of client\.cryptoOrders\.listAll\(\{ status: 'paid' \}\)\) \{/,
    );
  });

  it("Cancel 409/404 error framing pinned: '409: order has moved past pending; cancellation is no longer self-service.' + '404: order doesn't exist or belongs to another account.' — pinned so the 2-error-case cancel semantics survive (drift to dropping 404 'belongs to another account' would re-introduce the enumeration leak; drift to a different status for past-pending cancellation would create marketing↔server divergence)", () => {
    expect(body).toMatch(
      /\/\/ 409: order has moved past pending; cancellation is no longer self-service\./,
    );
    expect(body).toMatch(/\/\/ 404: order doesn't exist or belongs to another account\./);
  });

  it("Crypto non-refundable framing pinned: 'Crypto payments are non-refundable. Cancelling a pending order halts its pay window; cancelling a paid order is not supported — past billing periods stay billed.' + /legal/refunds cross-reference — pinned so the non-refundable commitment + the pending-vs-paid cancel-semantics + the /legal/refunds anchor all survive (drift to dropping the legal cross-reference would orphan the SDK doc from the contractual posture)", () => {
    expect(body).toMatch(
      /Crypto payments are non-refundable\. Cancelling a pending\s*\n?\s*order halts its pay window; cancelling a paid order is not\s*\n?\s*supported — past billing periods stay billed\. See\s*\n?\s*<a href="\/legal\/refunds\/">\/legal\/refunds<\/a>\./,
    );
  });

  it("crypto.order.* now-subscribable + verifyWebhookSignature for every live event type pinned: 'crypto.order.paid / crypto.order.failed events are emitted server-side and are now subscribable' + 'The SDK ships verifyWebhookSignature for every live event type, including the now-live crypto.order.* events alongside the session + quota + api-key + egress-capability event domains.' — pinned so the now-subscribable framing + the verifyWebhookSignature-every-domain commitment survive (drift to dropping any live-domain would let customers miss a webhook event family)", () => {
    expect(body).toMatch(
      /<code>crypto\.order\.paid<\/code> \/ <code>crypto\.order\.failed<\/code>\s*\n?\s*events are emitted server-side and are now subscribable/,
    );
    expect(body).toMatch(
      /<code>verifyWebhookSignature<\/code> for every live event type,\s*\n?\s*including the now-live crypto\.order\.\* events alongside the\s*\n?\s*session \+ quota \+ api-key \+ egress-capability event domains\./,
    );
  });

  it("End-to-end example pinned: 'packages/sdk-typescript/examples/crypto-checkout.ts' + 'DRIFTSTACK_API_KEY=... npx tsx examples/crypto-checkout.ts' — pinned so the runnable-example path + the env-var + tsx-runner invocation survive (drift to a different example path would create marketing↔SDK-repo divergence; drift to dropping the env-var name would let customers wonder which variable the example reads)", () => {
    expect(body).toMatch(/<code>packages\/sdk-typescript\/examples\/crypto-checkout\.ts<\/code>/);
    expect(body).toMatch(
      /Run with <code>DRIFTSTACK_API_KEY=\.\.\. npx tsx examples\/crypto-checkout\.ts<\/code>/,
    );
  });

  it('6-related-doc cluster pinned: /docs/sdk-typescript + /docs/sdk-python-crypto-orders + /docs/sdk-go-crypto-orders + /docs/billing-crypto-integration-guide + /docs/idempotency-keys + /docs/webhooks-crypto-events — pinned so the 6-related-doc navigation surface stays complete (drift to dropping the Python/Go SDK cross-references would orphan multi-language customers; drift to dropping /docs/idempotency-keys would orphan the idempotency anchor)', () => {
    expect(body).toMatch(
      /<li><a href="\/docs\/sdk-typescript\/">TypeScript SDK quickstart<\/a><\/li>/,
    );
    expect(body).toMatch(
      /<li><a href="\/docs\/sdk-python-crypto-orders\/">Python SDK crypto orders<\/a><\/li>/,
    );
    expect(body).toMatch(
      /<li><a href="\/docs\/sdk-go-crypto-orders\/">Go SDK crypto orders<\/a><\/li>/,
    );
    expect(body).toMatch(
      // S47 2026-07-07 (founder-approved: mirror deprecation): deleted-mirror hrefs re-pinned to the docs successors.
      /<li><a href="https:\/\/docs\.driftstack\.dev\/guides\/paying-with-crypto\/">Integration guide<\/a><\/li>/,
    );
    expect(body).toMatch(/<li><a href="\/docs\/idempotency-keys\/">Idempotency keys<\/a><\/li>/);
    expect(body).toMatch(
      /<li><a href="https:\/\/docs\.driftstack\.dev\/webhooks\/crypto-events\/">Crypto webhook events<\/a><\/li>/,
    );
    expect(body).not.toMatch(
      /href="\/(?:legal\/refunds|docs\/sdk-typescript|docs\/sdk-python-crypto-orders|docs\/sdk-go-crypto-orders|docs\/idempotency-keys)"/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

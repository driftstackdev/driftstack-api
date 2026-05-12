// W363.A — drift guard for /docs/webhooks-crypto-events. V-716.
// The server-side W220.A parity test already pins the negative
// claim (crypto.order.paid/failed NOT in
// SubscribableWebhookEventTypeSchema). This complementary guard
// pins the positive surface claims so the page stays accurate
// about the planned event shape + the polling alternative today.
//
// Pinned:
//   • Negative claim: crypto.order.paid + crypto.order.failed are
//     NOT subscribable today (matches schema source-of-truth).
//   • Polling-alternative endpoint GET
//     /v1/billing/crypto-orders/:id registered server-side.
//   • Planned crypto.order.paid payload fields (order_id,
//     product, price_cents, price_currency, payment_id, paid_at)
//     pinned for forward-planning integrators.
//   • Planned crypto.order.failed payload fields + reason set
//     (ipn / expired / swept) pinned.
//   • failed.payment_id field type "string | null" pinned
//     (orders swept before receiving IPN may have no payment_id).
//   • Cross-links resolve: /docs/webhooks, /docs/billing-crypto-
//     overview, /docs/crypto-orders-polling-vs-webhooks,
//     /legal/refunds, /changelog, /api-reference.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/webhooks-crypto-events.astro');
const BILLING_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W363.A /docs/webhooks-crypto-events parity', () => {
  const body = read(PAGE);
  const subscribable = new Set<string>(
    (SubscribableWebhookEventTypeSchema._def as { values: readonly string[] }).values,
  );

  it('central claim: crypto.order.paid + crypto.order.failed NOT subscribable today', () => {
    expect(subscribable.has('crypto.order.paid')).toBe(false);
    expect(subscribable.has('crypto.order.failed')).toBe(false);
    expect(body).toMatch(/these events are not yet on the\s+public webhook subscription list/);
    expect(body).toMatch(
      /<code class="font-mono">events: \["crypto\.order\.paid"\]<\/code>\s+is rejected today/,
    );
  });

  it('polling alternative GET /v1/billing/crypto-orders/:id registered server-side', () => {
    expect(body).toMatch(/<code>GET \/v1\/billing\/crypto-orders\/&lt;order_id&gt;<\/code>/);
    expect(existsSync(BILLING_ROUTE)).toBe(true);
    expect(read(BILLING_ROUTE)).toContain("'/v1/billing/crypto-orders/:order_id'");
  });

  it('planned crypto.order.paid payload fields pinned (forward-planning)', () => {
    for (const field of [
      'order_id',
      'product',
      'price_cents',
      'price_currency',
      'payment_id',
      'paid_at',
    ]) {
      expect(body).toMatch(new RegExp(`<td><code>${field}<\\/code><\\/td>`));
    }
  });

  it('planned crypto.order.failed reason set (ipn / expired / swept) pinned', () => {
    // reason values cited as <li> bullets.
    expect(body).toMatch(/<li><code>ipn<\/code>/);
    expect(body).toMatch(/<li><code>expired<\/code>/);
    expect(body).toMatch(/<li><code>swept<\/code>/);
    // Also surfaced as the type-row "One of …" copy.
    expect(body).toMatch(
      /One of <code>ipn<\/code>,\s*<code>expired<\/code>,\s*<code>swept<\/code>/,
    );
  });

  it('failed.payment_id is "string | null" (orders swept before IPN may have no payment_id)', () => {
    expect(body).toMatch(/<td><code>payment_id<\/code><\/td>\s*<td>string \| null<\/td>/);
    expect(body).toMatch(
      /<code>null<\/code> for\s+orders that never received an IPN before being swept \/\s+expired/,
    );
  });

  it('idempotency claim: applying the same terminal IPN twice will NOT re-fire crypto.order.paid', () => {
    expect(body).toMatch(/Idempotent: applying the same terminal\s+IPN twice will not re-fire/);
  });

  it('all cross-links resolve (/docs/webhooks, /docs/billing-crypto-overview, polling-vs-webhooks, /legal/refunds)', () => {
    for (const [href, path] of [
      ['/docs/webhooks', 'apps/marketing-site/src/pages/docs/webhooks.astro'],
      [
        '/docs/billing-crypto-overview',
        'apps/marketing-site/src/pages/docs/billing-crypto-overview.astro',
      ],
      [
        '/docs/crypto-orders-polling-vs-webhooks',
        'apps/marketing-site/src/pages/docs/crypto-orders-polling-vs-webhooks.astro',
      ],
      ['/legal/refunds', 'apps/marketing-site/src/pages/legal/refunds.md'],
    ] as const) {
      expect(body).toContain(href);
      expect(existsSync(resolve(REPO_ROOT, path)), `missing: ${path}`).toBe(true);
    }
    expect(body).toContain('/changelog');
    expect(body).toContain('/api-reference');
  });

  it('"how to be notified" copy points at SubscribableWebhookEventTypeSchema (schema-name pinned)', () => {
    // When the events graduate, the schema-name reference is the
    // anchor customers will grep for.
    expect(body).toContain('SubscribableWebhookEventTypeSchema');
  });
});

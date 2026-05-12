// W230.A — drift-guard for /docs/billing-crypto-overview. Pins the
// claims about receipt endpoints + the crypto.order.paid webhook
// status. The previous revision implied the event was a normal
// customer-subscribable webhook; in fact the event is emitted
// server-side but isn't in SubscribableWebhookEventTypeSchema yet.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'billing-crypto-overview.astro',
);
const ROUTE_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'billing-crypto-orders.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W230.A billing-crypto-overview doc parity', () => {
  const doc = read(DOC_PATH);
  const route = read(ROUTE_PATH);
  const subscribable = new Set(
    (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).map((v) => v),
  );

  it('crypto.order.paid is not framed as a live subscribable webhook today', () => {
    const isSubscribable = subscribable.has('crypto.order.paid');
    if (!isSubscribable) {
      // Doc must caveat that the event isn't subscribable yet.
      expect(doc).toMatch(/not yet on the subscribable webhook event list/i);
      expect(doc).toMatch(/poll/i);
      // The previous casual "if you have webhooks configured" framing.
      expect(doc).not.toMatch(/if you\s+have webhooks configured/);
    }
  });

  it('receipt endpoints in the doc match the route registrations', () => {
    for (const suffix of ['/receipt', '/receipt.txt', '/receipt.pdf']) {
      expect(route, `route should register ${suffix}`).toContain(
        `'/v1/billing/crypto-orders/:order_id${suffix}'`,
      );
      expect(doc, `doc should reference ${suffix}`).toContain(suffix);
    }
  });

  it('crypto payments are flagged as non-refundable', () => {
    expect(doc).toMatch(/non-refundable/);
    expect(doc).toMatch(/\/legal\/refunds/);
  });
});

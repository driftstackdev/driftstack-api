// W232.A — drift-guard for /docs/billing-crypto-integration-guide.
// Same theme as W220.A / W230.A: the page used to frame
// crypto.order.* events as a live, subscribable webhook integration,
// when they're emitted server-side but not in
// SubscribableWebhookEventTypeSchema yet. This guard fails if anyone
// reverts the framing to "register a webhook + handle the event" so
// long as the enum stays gated.

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
  'billing-crypto-integration-guide.astro',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W232.A billing-crypto-integration-guide doc parity', () => {
  const doc = read(DOC_PATH);
  const subscribable = new Set(
    (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).map((v) => v),
  );

  it('switches to polling when crypto.order.* events are not subscribable', () => {
    const live = subscribable.has('crypto.order.paid');
    if (!live) {
      // Doc must NOT show a "register a webhook + case 'crypto.order.paid'"
      // pattern when the event isn't on the subscribable list.
      expect(doc).not.toMatch(/case 'crypto\.order\.paid'/);
      expect(doc).not.toMatch(/Register a webhook endpoint that subscribes to/i);
      // And must direct readers to poll.
      expect(doc).toMatch(/poll/i);
      expect(doc).toMatch(/\/v1\/billing\/crypto-orders\//);
    }
  });

  it('still references the idempotency-key header on checkout', () => {
    expect(doc).toMatch(/idempotency-key/i);
    expect(doc).toMatch(/\/docs\/idempotency-keys/);
  });

  it('receipt endpoints in the doc match the route convention', () => {
    for (const suffix of ['/receipt', '/receipt.txt', '/receipt.pdf']) {
      expect(doc).toContain(suffix);
    }
  });
});

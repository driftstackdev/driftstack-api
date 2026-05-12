// W242.B — drift-guard for /docs/crypto-orders-polling-vs-webhooks.
// The previous revision presented webhooks (push) as a shipped option
// for crypto-order state changes; in reality `crypto.order.*` is not
// in SubscribableWebhookEventTypeSchema, so webhooks aren't
// deliverable. This guard fails if the doc reasserts the "subscribe"
// framing while the enum stays gated.

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
  'crypto-orders-polling-vs-webhooks.astro',
);

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('W242.B crypto-orders-polling-vs-webhooks doc parity', () => {
  const doc = read();
  const live = new Set(
    (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).map((v) => v),
  );
  const cryptoPaidLive = live.has('crypto.order.paid');

  it('reflects current subscribable status for crypto.order.paid', () => {
    if (!cryptoPaidLive) {
      // Doc must flag webhooks as roadmap.
      expect(doc).toMatch(/not yet/i);
      // And cross-link to the roadmap doc.
      expect(doc).toMatch(/\/docs\/webhooks-crypto-events/);
    } else {
      // Once shipped, no "not yet" caveat.
      expect(doc).not.toMatch(/not yet/i);
    }
  });

  it('keeps polling as a first-class shipped path regardless of gating', () => {
    expect(doc).toMatch(/<h2>Today: polling<\/h2>|Polling cadence/);
    // Sample polling code stays in.
    expect(doc).toMatch(/client\.cryptoOrders\.(get|listAll)/);
  });

  it('does not present webhook subscription as a current shipped option for crypto orders', () => {
    if (!cryptoPaidLive) {
      // Forbidden framings that paint webhooks as live for crypto:
      expect(doc).not.toMatch(/When webhooks are the right call/i);
      expect(doc).not.toMatch(/Sub-second once the IPN lands/i);
    }
  });
});

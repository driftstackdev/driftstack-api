// W233.A — drift-guard for /docs/billing-crypto-troubleshooting.
// Pins the order-id placeholder convention and the crypto.order
// webhook framing.

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
  'billing-crypto-troubleshooting.astro',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W233.A billing-crypto-troubleshooting doc parity', () => {
  const doc = read(DOC_PATH);
  const subscribable = new Set(
    (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).map((v) => v),
  );

  it('receipt URLs use the ord_ prefix in placeholders', () => {
    expect(doc).toMatch(/\/v1\/billing\/crypto-orders\/ord_/);
    // Rule out the stale bare-`ORD` placeholder.
    expect(doc).not.toMatch(/\/v1\/billing\/crypto-orders\/ORD(?:\/|$)/);
  });

  it('crypto.order webhook link points at the roadmap reference, not /docs/webhooks', () => {
    if (!subscribable.has('crypto.order.paid')) {
      const block = doc.split('<h2>Related</h2>')[1] ?? '';
      expect(block).toMatch(/\/docs\/webhooks-crypto-events/);
      expect(block).not.toMatch(/href="\/docs\/webhooks"><code>crypto\.order\.paid<\/code>/);
    }
  });
});

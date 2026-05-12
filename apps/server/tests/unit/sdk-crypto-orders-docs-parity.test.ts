// W237.A — drift-guard for the three SDK crypto-orders docs
// (sdk-typescript-crypto-orders, sdk-python-crypto-orders,
// sdk-go-crypto-orders). All three previously claimed the
// `crypto.order.paid` event was a subscribable webhook — it isn't
// today. This guard fails if any of them silently regress to the
// "subscribe to the webhook" framing while the enum stays gated.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOCS = ['sdk-typescript-crypto-orders', 'sdk-python-crypto-orders', 'sdk-go-crypto-orders'];

function read(name: string): string {
  return readFileSync(
    join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', `${name}.astro`),
    'utf8',
  );
}

describe('W237.A SDK crypto-orders docs parity', () => {
  const subscribable = new Set(
    (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).map((v) => v),
  );
  const live = subscribable.has('crypto.order.paid');

  for (const name of DOCS) {
    it(`${name} reflects current subscribable status`, () => {
      const doc = read(name);
      if (!live) {
        // Doc must caveat the event isn't subscribable yet + direct
        // readers to poll.
        expect(doc).toMatch(/not yet subscribable/i);
        expect(doc).toMatch(/poll/i);
        // And NOT include the "subscribe to the webhook" framing.
        expect(doc).not.toMatch(/subscribe to the\s+<code>crypto\.order\.paid<\/code> webhook/i);
      } else {
        // Once the events graduate, the doc should drop the caveat.
        expect(doc).not.toMatch(/not yet subscribable/i);
      }
    });
  }
});

// W220.A — drift-guard between /docs/webhooks-crypto-events and the
// actual SubscribableWebhookEventTypeSchema.
//
// crypto.order.paid / crypto.order.failed are emitted server-side
// (services/crypto-orders.ts calls webhooks.enqueueEvent with those
// literals), but they are NOT in the SubscribableWebhookEventTypeSchema
// today, so POST /v1/webhooks with `events: ["crypto.order.paid"]`
// is rejected with a 400. The previous doc described the integration
// as if it were live; this test fails if anyone re-introduces the
// live-integration framing while the enum is still gated.
//
// The test also auto-relaxes once the enum is expanded — at that
// point, the page must be rewritten to drop the "not yet" framing,
// and the second assertion below will fail until it does.

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
  'webhooks-crypto-events.astro',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W220.A webhooks-crypto-events doc parity', () => {
  const doc = read(DOC_PATH);
  // Build a set from the discriminator schema.
  const subscribable = new Set(
    (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).map((v) => v),
  );

  it('flags crypto.order.* events as not-yet-subscribable when the enum excludes them', () => {
    const cryptoEventsInEnum =
      subscribable.has('crypto.order.paid') && subscribable.has('crypto.order.failed');
    if (cryptoEventsInEnum) {
      // Enum has been expanded — doc should NO LONGER flag these as
      // roadmap. Force a rewrite at that point.
      expect(doc).not.toMatch(/not yet on the public webhook subscription list/i);
      expect(doc).not.toMatch(/Planned event shape/);
    } else {
      // Today: doc must clearly mark these as not-yet-live.
      expect(doc).toMatch(/not yet/i);
      expect(doc).toMatch(/400/);
      // And direct readers to the polling alternative.
      expect(doc).toMatch(/\/v1\/billing\/crypto-orders/);
    }
  });

  it('doc does not show a working POST /v1/webhooks subscription example with crypto.order.* events', () => {
    // Hard-block the previous shape: an integrator pasting this
    // would hit 400. Tolerate the literal `"events": ["crypto.order.paid", "crypto.order.failed"]`
    // only inside a curl block that's clearly marked as planned —
    // we look for `events: ["crypto.order.paid"]` immediately after
    // a curl POST line as the canonical fail pattern.
    expect(doc).not.toMatch(
      /curl[^\n]*\/v1\/webhooks[\s\S]{0,300}"events":\s*\[\s*"crypto\.order\.paid"/,
    );
  });
});

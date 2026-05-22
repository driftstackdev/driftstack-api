// W250.C — stability guard for SubscribableWebhookEventTypeSchema.
// A downstream change that removed any of the eight shipped events
// would silently break:
//   - SDK webhook verifiers (TS/Python/Go)
//   - /docs/webhooks event-type table
//   - /docs/api-changelog references
//   - /docs/security event-type claims
//
// This guard fails fast if any current event leaves the enum and
// forces the change to land alongside SDK + doc updates.
//
// Eight shipped: the original 5 (session.completed, session.failed,
// quota.warning_80pct, quota.exceeded, api_key.revoked) plus the
// Arc 5 EGRESS eg.7 addition session.egress_capability_changed plus
// the V-666 crypto-order pair (crypto.order.paid + crypto.order.failed)
// wired end-to-end 2026-05-22.

import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

describe('W250.C SubscribableWebhookEventTypeSchema stability', () => {
  const live = new Set(
    (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).map((v) => v),
  );

  it('contains every event currently shipped to customers', () => {
    for (const evt of [
      'session.completed',
      'session.failed',
      'quota.warning_80pct',
      'quota.exceeded',
      'api_key.revoked',
      // Arc 5 EGRESS eg.7 — subscribable so customers can hook
      // proxy-health visibility into their own observability.
      'session.egress_capability_changed',
      // V-666 crypto-order events — wired end-to-end 2026-05-22.
      // CryptoOrdersService.applyIpnStatus → WebhooksService.enqueueEvent
      // on pending/confirming/partial → paid|failed terminal transitions.
      'crypto.order.paid',
      'crypto.order.failed',
    ]) {
      expect(live.has(evt), `missing event ${evt}`).toBe(true);
    }
  });

  it('does NOT yet include events that are emitted server-side but customer-roadmap', () => {
    // These are emitted by the server (W245) but not yet
    // subscribable. The guard is dual-purpose: when they graduate,
    // bump the array below + run a sweep of dependent docs.
    for (const evt of ['incident.created', 'incident.updated', 'incident.resolved']) {
      expect(live.has(evt), `event ${evt} graduated — review dependent docs (W245/W249)`).toBe(
        false,
      );
    }
  });

  it('exposes exactly the documented number of live events', () => {
    // Eight shipped today (5 original + Arc 5 EGRESS eg.7 + V-666
    // crypto.order.paid/failed). Increment if/when the schema grows;
    // this is intentionally tight so a silent enum addition fails CI.
    expect(live.size).toBe(8);
  });
});

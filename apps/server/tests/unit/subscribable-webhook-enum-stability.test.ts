// W250.C — stability guard for SubscribableWebhookEventTypeSchema.
// A downstream change that removed any of the eight emitted events
// would silently break:
//   - SDK webhook verifiers (TS/Python/Go)
//   - /docs/webhooks event-type table
//   - /docs/api-changelog references
//   - /docs/security event-type claims
//
// This guard fails fast if any current event leaves the enum and
// forces the change to land alongside SDK + doc updates.
//
// Eight shipped: session.completed, session.failed, api_key.revoked, the
// Arc 5 EGRESS eg.7 addition session.egress_capability_changed plus
// the V-666 crypto-order pair (crypto.order.paid + crypto.order.failed)
// wired end-to-end 2026-05-22 plus W393 + A3 W1364.

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
      'api_key.revoked',
      // Arc 5 EGRESS eg.7 — subscribable so customers can hook
      // proxy-health visibility into their own observability.
      'session.egress_capability_changed',
      // V-666 crypto-order events — wired end-to-end 2026-05-22.
      // CryptoOrdersService.applyIpnStatus → WebhooksService.enqueueEvent
      // on pending/confirming/partial → paid|failed terminal transitions.
      'crypto.order.paid',
      'crypto.order.failed',
      // W393 challenge-handling — subscribable challenge alerts.
      'session.challenge_detected',
      // A3 W1364 — profile save-back failure (stale-restore warning).
      'session.profile_save_failed',
    ]) {
      expect(live.has(evt), `missing event ${evt}`).toBe(true);
    }
  });

  it('excludes internal incident events and silent quota placeholders', () => {
    for (const evt of [
      'incident.created',
      'incident.updated',
      'incident.resolved',
      'quota.warning_80pct',
      'quota.exceeded',
    ]) {
      expect(live.has(evt), `event ${evt} graduated — review dependent docs (W245/W249)`).toBe(
        false,
      );
    }
  });

  it('exposes exactly the documented number of live events', () => {
    // Eight emitted customer events (3 core + Arc 5 EGRESS eg.7 + V-666
    // crypto.order.paid/failed + W393 session.challenge_detected + A3 W1364
    // session.profile_save_failed). Increment if/when the schema grows; this
    // is intentionally tight so a silent enum addition fails CI.
    expect(live.size).toBe(8);
  });
});

// W250.C — stability guard for SubscribableWebhookEventTypeSchema.
// A downstream change that removed any of the five shipped events
// would silently break:
//   - SDK webhook verifiers (TS/Python/Go)
//   - /docs/webhooks event-type table
//   - /docs/api-changelog references
//   - /docs/security event-type claims
//
// This guard fails fast if any current event leaves the enum and
// forces the change to land alongside SDK + doc updates.

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
    ]) {
      expect(live.has(evt), `missing event ${evt}`).toBe(true);
    }
  });

  it('does NOT yet include events that are emitted server-side but customer-roadmap', () => {
    // These are emitted by the server (W229/W237/W245) but not yet
    // subscribable. The guard is dual-purpose: when they graduate,
    // bump the array below + run a sweep of dependent docs.
    for (const evt of [
      'crypto.order.paid',
      'crypto.order.failed',
      'incident.created',
      'incident.updated',
      'incident.resolved',
    ]) {
      expect(live.has(evt), `event ${evt} graduated — review dependent docs (W242/W245/W249)`).toBe(
        false,
      );
    }
  });

  it('exposes exactly the documented number of live events', () => {
    // Five shipped today. Increment if/when the schema grows; this
    // is intentionally tight so a silent enum addition fails CI.
    expect(live.size).toBe(5);
  });
});

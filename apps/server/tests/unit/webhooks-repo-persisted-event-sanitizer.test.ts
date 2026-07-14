import { describe, expect, it } from 'vitest';

import { sanitizePersistedWebhookEvents } from '../../src/db/webhooks-repo.js';

describe('persisted webhook event sanitizer', () => {
  it('removes the two historical never-emitted quota subscriptions', () => {
    expect(
      sanitizePersistedWebhookEvents([
        'quota.warning_80pct',
        'session.completed',
        'quota.exceeded',
        'session.failed',
      ]),
    ).toEqual(['session.completed', 'session.failed']);
  });

  it('preserves every current customer event in order', () => {
    const events = [
      'session.completed',
      'session.failed',
      'api_key.revoked',
      'session.egress_capability_changed',
      'crypto.order.paid',
      'crypto.order.failed',
      'session.challenge_detected',
      'session.profile_save_failed',
    ] as const;

    expect(sanitizePersistedWebhookEvents(events)).toEqual(events);
  });

  it('fails closed on any other unrecognized persisted value', () => {
    expect(() => sanitizePersistedWebhookEvents(['future.unknown'])).toThrow();
  });
});

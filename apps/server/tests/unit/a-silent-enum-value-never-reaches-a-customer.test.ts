// V-897 — `webhook_event_type` holds two values that are not customer contract,
// and one function is what keeps them off the wire.
//
// V-896 established why `quota.warning_80pct` and `quota.exceeded` are absent
// from the customer documentation: they are never emitted, retained only for
// migration compatibility, and — per `webhooks-repo.ts` — "must be removed
// whenever a persisted endpoint is materialized". `sanitizePersistedWebhookEvents`
// is that removal.
//
// `subscribable-webhook-enum-stability` already guards the SUBSCRIBABLE list, so
// a customer cannot select these when creating an endpoint. That is a different
// boundary. This one is about rows that already exist: an endpoint persisted
// before the values went silent still carries them in its `events` column, and
// the only thing standing between that row and a customer response is this
// filter. Nothing exercised it — the two apparent hits in the suite are a
// comment listing event names and an unrelated `quota_exceeded` outcome string.
//
// Behavioural rather than textual on purpose. A pin on the filter's source line
// would pass if somebody rewrote the function to return its input unchanged;
// calling it with a silent value cannot.

import { describe, expect, it } from 'vitest';
import { sanitizePersistedWebhookEvents } from '../../src/db/webhooks-repo.js';

/** The two enum values retained for migration compatibility only. */
const SILENT = ['quota.warning_80pct', 'quota.exceeded'] as const;

describe('V-897 a silent enum value never reaches a customer', () => {
  it('CRITICAL a persisted row carrying a silent value materializes without it. This is the case the function exists for: an endpoint created before these values went quiet still has them in its `events` column, and returning them would show a customer an event type the contract says does not exist.', () => {
    const out = sanitizePersistedWebhookEvents(['session.completed', ...SILENT, 'api_key.revoked']);
    expect(out, 'silent values dropped, real ones kept in order').toEqual([
      'session.completed',
      'api_key.revoked',
    ]);
  });

  it('CRITICAL each silent value is dropped on its own, not just as a pair. Filtering on a set makes that obvious; a hand-rolled check that tested for one and forgot the other would pass the arm above only if both happened to be present together.', () => {
    for (const v of SILENT) {
      expect(
        sanitizePersistedWebhookEvents(['session.failed', v]),
        `${v} must not survive materialization`,
      ).toEqual(['session.failed']);
    }
  });

  it('CRITICAL a row carrying ONLY silent values materializes empty rather than throwing. The values parse fine against the enum, so a filter placed after the schema parse would still be correct here — but an endpoint whose whole subscription went silent must degrade to no events, not to a 500 on read.', () => {
    expect(sanitizePersistedWebhookEvents([...SILENT])).toEqual([]);
  });

  it('CRITICAL an unrecognised value still fails closed. The docblock distinguishes the two silent values, which are dropped, from "any other unknown value", which fails through the canonical schema. Dropping the unknown instead would silently discard a real event type after a bad migration, which is the more expensive mistake.', () => {
    expect(() => sanitizePersistedWebhookEvents(['session.completed', 'not.an.event'])).toThrow();
  });

  it('CRITICAL an ordinary subscription passes through untouched, so the filter cannot become a no-op in the other direction. Without this a function that returned [] would satisfy every arm above.', () => {
    const live = ['session.completed', 'session.failed', 'test.ping'];
    expect(sanitizePersistedWebhookEvents(live)).toEqual(live);
  });
});

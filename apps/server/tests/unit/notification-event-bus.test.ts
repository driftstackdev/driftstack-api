// 2026-05-20 — unit tests for the GUI panel NotificationEventBus.
// Mirrors agent-session-event-bus.test.ts in shape: subscribe /
// publish / unsubscribe lifecycle + handler-throw isolation + per-
// accountId scoping (cross-account leakage forbidden by construction).

import { describe, expect, it } from 'vitest';
import {
  NotificationEventBus,
  type NotificationEvent,
  type NotificationEventHandler,
} from '../../src/services/notification-event-bus.js';

function makeCostAlertEvent(accountId: string): NotificationEvent {
  return {
    kind: 'cost.threshold_alert',
    accountId,
    severity: 'warn',
    billingCycle: '2026-05',
    previousState: 'under-soft',
    currentState: 'between-soft-and-hard',
    totalCents: 12_500,
    thresholdSoftCents: 10_000,
    thresholdHardCents: 25_000,
    at: '2026-05-20T22:00:00.000Z',
  };
}

describe('NotificationEventBus', () => {
  it('delivers to subscribers on the matching accountId', () => {
    const bus = new NotificationEventBus();
    const received: NotificationEvent[] = [];
    bus.subscribe('acc_a', (e) => received.push(e));
    bus.publish(makeCostAlertEvent('acc_a'));
    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe('cost.threshold_alert');
  });

  it('does NOT cross-fan to other accounts — publish to acc_b never reaches acc_a subscriber', () => {
    const bus = new NotificationEventBus();
    const receivedA: NotificationEvent[] = [];
    bus.subscribe('acc_a', (e) => receivedA.push(e));
    bus.publish(makeCostAlertEvent('acc_b'));
    expect(receivedA).toHaveLength(0);
  });

  it('drops publishes with no live subscribers — no error, just floor', () => {
    const bus = new NotificationEventBus();
    expect(() => bus.publish(makeCostAlertEvent('acc_a'))).not.toThrow();
    expect(bus.subscriberCount('acc_a')).toBe(0);
  });

  it('unsubscribe stops delivery to the returned function', () => {
    const bus = new NotificationEventBus();
    const received: NotificationEvent[] = [];
    const unsub = bus.subscribe('acc_a', (e) => received.push(e));
    bus.publish(makeCostAlertEvent('acc_a'));
    unsub();
    bus.publish(makeCostAlertEvent('acc_a'));
    expect(received).toHaveLength(1);
  });

  it('subscriberCount reflects add + remove lifecycle', () => {
    const bus = new NotificationEventBus();
    expect(bus.subscriberCount('acc_a')).toBe(0);
    const h1: NotificationEventHandler = () => undefined;
    const h2: NotificationEventHandler = () => undefined;
    const off1 = bus.subscribe('acc_a', h1);
    const off2 = bus.subscribe('acc_a', h2);
    expect(bus.subscriberCount('acc_a')).toBe(2);
    off1();
    expect(bus.subscriberCount('acc_a')).toBe(1);
    off2();
    expect(bus.subscriberCount('acc_a')).toBe(0);
  });

  it('handler throw on one subscriber does NOT block sibling handlers or the publisher', () => {
    const bus = new NotificationEventBus();
    const recordedAfterThrow: NotificationEvent[] = [];
    bus.subscribe('acc_a', () => {
      throw new Error('boom');
    });
    bus.subscribe('acc_a', (e) => recordedAfterThrow.push(e));
    expect(() => bus.publish(makeCostAlertEvent('acc_a'))).not.toThrow();
    expect(recordedAfterThrow).toHaveLength(1);
  });

  it('idempotent unsubscribe — calling twice does not throw', () => {
    const bus = new NotificationEventBus();
    const unsub = bus.subscribe('acc_a', () => undefined);
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it('all 4 v0 event kinds are deliverable end-to-end (compile + runtime check)', () => {
    const bus = new NotificationEventBus();
    const received: NotificationEvent[] = [];
    bus.subscribe('acc_a', (e) => received.push(e));

    bus.publish({
      kind: 'cost.threshold_alert',
      accountId: 'acc_a',
      severity: 'critical',
      billingCycle: '2026-05',
      previousState: null,
      currentState: 'over-hard',
      totalCents: 30_000,
      thresholdSoftCents: 10_000,
      thresholdHardCents: 25_000,
      at: '2026-05-20T22:00:00.000Z',
    });
    bus.publish({
      kind: 'incident.broadcast',
      accountId: 'acc_a',
      incidentId: 'inc_x',
      severity: 'major',
      title: 'API degraded',
      at: '2026-05-20T22:00:00.000Z',
    });
    bus.publish({
      kind: 'audit.high_severity',
      accountId: 'acc_a',
      action: 'api_key.revoked',
      actorType: 'customer',
      targetResourceId: 'key_y',
      at: '2026-05-20T22:00:00.000Z',
    });
    bus.publish({
      kind: 'session.errored',
      accountId: 'acc_a',
      sessionId: 'ses_z',
      errorClass: 'driver_error',
      at: '2026-05-20T22:00:00.000Z',
    });

    expect(received).toHaveLength(4);
    expect(received.map((e) => e.kind)).toEqual([
      'cost.threshold_alert',
      'incident.broadcast',
      'audit.high_severity',
      'session.errored',
    ]);
  });

  // ── S45 2026-07-07 — publishBroadcast (platform-wide fan-out) ──────

  describe('publishBroadcast (S45)', () => {
    const broadcastFrame = {
      kind: 'incident.broadcast' as const,
      incidentId: 'inc_abc',
      severity: 'major' as const,
      title: 'API degraded',
      at: '2026-07-07T12:00:00.000Z',
    };

    it('fans out to every subscribed account, stamping each copy with the subscriber own accountId', () => {
      const bus = new NotificationEventBus();
      const receivedA: NotificationEvent[] = [];
      const receivedB: NotificationEvent[] = [];
      bus.subscribe('acc_a', (e) => receivedA.push(e));
      bus.subscribe('acc_b', (e) => receivedB.push(e));

      bus.publishBroadcast(broadcastFrame);

      expect(receivedA).toHaveLength(1);
      expect(receivedB).toHaveLength(1);
      expect(receivedA[0]).toEqual({ ...broadcastFrame, accountId: 'acc_a' });
      expect(receivedB[0]).toEqual({ ...broadcastFrame, accountId: 'acc_b' });
    });

    it('is a no-op with zero subscribers (events with no live subscribers drop on the floor)', () => {
      const bus = new NotificationEventBus();
      expect(() => bus.publishBroadcast(broadcastFrame)).not.toThrow();
    });

    it('a throwing handler on one account does not block delivery to other accounts', () => {
      const bus = new NotificationEventBus();
      const receivedB: NotificationEvent[] = [];
      bus.subscribe('acc_a', () => {
        throw new Error('boom');
      });
      bus.subscribe('acc_b', (e) => receivedB.push(e));

      bus.publishBroadcast(broadcastFrame);

      expect(receivedB).toHaveLength(1);
    });

    it('an unsubscribed account receives nothing on later broadcasts', () => {
      const bus = new NotificationEventBus();
      const receivedA: NotificationEvent[] = [];
      const unsubscribe = bus.subscribe('acc_a', (e) => receivedA.push(e));
      bus.publishBroadcast(broadcastFrame);
      unsubscribe();
      bus.publishBroadcast(broadcastFrame);
      expect(receivedA).toHaveLength(1);
    });

    it('a handler that unsubscribes ANOTHER account mid-broadcast does not break the fan-out (key-set snapshot)', () => {
      const bus = new NotificationEventBus();
      const receivedC: NotificationEvent[] = [];
      let unsubC: (() => void) | null = null;
      // acc_a's handler tears down acc_c's subscription while the
      // broadcast is iterating — the snapshot means acc_c either got
      // its copy already or is skipped harmlessly by publish()'s own
      // per-account lookup; nothing throws.
      bus.subscribe('acc_a', () => {
        unsubC?.();
      });
      unsubC = bus.subscribe('acc_c', (e) => receivedC.push(e));

      expect(() => bus.publishBroadcast(broadcastFrame)).not.toThrow();
      // Map iteration order = insertion order: acc_a runs first and
      // removes acc_c, so acc_c's copy is dropped — same semantics as
      // an SSE client disconnecting mid-publish.
      expect(receivedC).toHaveLength(0);
    });
  });
});

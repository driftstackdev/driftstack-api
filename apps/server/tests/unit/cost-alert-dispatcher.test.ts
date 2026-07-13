// V-541.C — unit tests for CostAlertDispatcher.

import { describe, expect, it, vi } from 'vitest';
import {
  CostAlertDispatcher,
  type AlertSink,
  type CostAlertPayload,
} from '../../src/services/cost-alert-dispatcher.js';
import { CostMonitoringService, type UsageAggregator } from '../../src/services/cost-monitoring.js';
import type { CostRates, UsageInputs } from '../../src/lib/cost-estimator.js';

const RATES: CostRates = {
  computeCentsPerMinute: 1,
  storageCentsPerGbMonth: 2,
  egressCentsPerGb: 5,
  emailCentsPerSend: 1,
  llmCentsPer1kInputTokens: 30,
  llmCentsPer1kOutputTokens: 150,
};

function makeFixture(rows: Map<string, UsageInputs>): {
  dispatcher: CostAlertDispatcher;
  capturedAlerts: CostAlertPayload[];
} {
  const aggregator: UsageAggregator = {
    aggregateForAccount: ({ accountId }) => Promise.resolve(rows.get(accountId) ?? null),
  };
  const service = new CostMonitoringService({
    aggregator,
    rates: RATES,
    tierThresholds: {
      solo_manual: { softCents: 100, hardCents: 200 },
      api_builder: { softCents: 1000, hardCents: 2000 },
    },
    resolveTier: () => Promise.resolve('solo_manual'),
  });
  const capturedAlerts: CostAlertPayload[] = [];
  const sink: AlertSink = (alert) => {
    capturedAlerts.push(alert);
    return Promise.resolve();
  };
  return {
    dispatcher: new CostAlertDispatcher({ service, sendAlert: sink }),
    capturedAlerts,
  };
}

const EMPTY: UsageInputs = {
  sessionMinutes: 0,
  storageGbMonths: 0,
  egressGb: 0,
  emailSends: 0,
  llmInputTokens: 0,
  llmOutputTokens: 0,
};

describe('V-541.C dispatcher — first evaluation (no prior state)', () => {
  it('fires critical alert when account starts over-hard', async () => {
    const rows = new Map([['a', { ...EMPTY, sessionMinutes: 1_000 }]]);
    const { dispatcher, capturedAlerts } = makeFixture(rows);
    const r = await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(r.alertsFired).toBe(1);
    expect(capturedAlerts[0]?.severity).toBe('critical');
    expect(capturedAlerts[0]?.previous_state).toBeNull();
  });

  it('fires warn alert when account starts between-soft-and-hard', async () => {
    const rows = new Map([['a', { ...EMPTY, sessionMinutes: 150 }]]); // 150 → between 100/200
    const { dispatcher, capturedAlerts } = makeFixture(rows);
    const r = await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(r.alertsFired).toBe(1);
    expect(capturedAlerts[0]?.severity).toBe('warn');
  });

  it('skips when account starts under-soft (no alert needed)', async () => {
    const rows = new Map([['a', { ...EMPTY, sessionMinutes: 10 }]]);
    const { dispatcher, capturedAlerts } = makeFixture(rows);
    const r = await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(r.alertsFired).toBe(0);
    expect(r.alertsSkipped).toBe(1);
    expect(capturedAlerts).toEqual([]);
  });

  it('skips accounts with no usage in cycle', async () => {
    const { dispatcher } = makeFixture(new Map());
    const r = await dispatcher.evaluate({
      accountIds: ['a', 'b'],
      billingCycle: '2026-05',
    });
    expect(r.alertsFired).toBe(0);
    expect(r.alertsSkipped).toBe(0); // no summaries returned at all
  });
});

describe('V-541.C dispatcher — transitions across evaluations', () => {
  it('escalation: under-soft → between → over-hard fires two separate alerts', async () => {
    const rows = new Map<string, UsageInputs>([['a', { ...EMPTY, sessionMinutes: 10 }]]);
    const { dispatcher, capturedAlerts } = makeFixture(rows);
    await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(capturedAlerts).toHaveLength(0);

    rows.set('a', { ...EMPTY, sessionMinutes: 150 });
    await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(capturedAlerts).toHaveLength(1);
    expect(capturedAlerts[0]?.severity).toBe('warn');
    expect(capturedAlerts[0]?.previous_state).toBe('under-soft');

    rows.set('a', { ...EMPTY, sessionMinutes: 1_000 });
    await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(capturedAlerts).toHaveLength(2);
    expect(capturedAlerts[1]?.severity).toBe('critical');
    expect(capturedAlerts[1]?.previous_state).toBe('between-soft-and-hard');
  });

  it('recovery: over-hard → under-soft fires a resolved alert', async () => {
    const rows = new Map<string, UsageInputs>([['a', { ...EMPTY, sessionMinutes: 1_000 }]]);
    const { dispatcher, capturedAlerts } = makeFixture(rows);
    await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(capturedAlerts[0]?.severity).toBe('critical');

    rows.set('a', { ...EMPTY, sessionMinutes: 10 });
    await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(capturedAlerts[1]?.severity).toBe('resolved');
    expect(capturedAlerts[1]?.previous_state).toBe('over-hard');
    expect(capturedAlerts[1]?.current_state).toBe('under-soft');
  });

  it('steady state: no transition → no alert', async () => {
    const rows = new Map<string, UsageInputs>([['a', { ...EMPTY, sessionMinutes: 150 }]]);
    const { dispatcher, capturedAlerts } = makeFixture(rows);
    await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(capturedAlerts).toHaveLength(1); // initial warn
    await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(capturedAlerts).toHaveLength(1); // no new alert
  });

  it('reset() clears prior state — first eval after reset fires again', async () => {
    const rows = new Map<string, UsageInputs>([['a', { ...EMPTY, sessionMinutes: 1_000 }]]);
    const { dispatcher, capturedAlerts } = makeFixture(rows);
    await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(capturedAlerts).toHaveLength(1);
    dispatcher.reset();
    await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(capturedAlerts).toHaveLength(2);
  });

  it('does NOT advance remembered state when a send fails — next eval retries the transition (no silently-dropped page)', async () => {
    // Regression guard: lastState must be advanced only AFTER a successful
    // send. If it were advanced before the await (mark-before-send), a
    // transient sink failure would record the transition as delivered, and
    // the next run would see prior === current and never re-send — a
    // permanently-missed threshold page. The design biases toward a duplicate
    // over a drop, so the failed transition must re-fire once the channel
    // recovers.
    const rows = new Map<string, UsageInputs>([['a', { ...EMPTY, sessionMinutes: 1_000 }]]); // over-hard
    const aggregator: UsageAggregator = {
      aggregateForAccount: ({ accountId }) => Promise.resolve(rows.get(accountId) ?? null),
    };
    const service = new CostMonitoringService({
      aggregator,
      rates: RATES,
      tierThresholds: { solo_manual: { softCents: 100, hardCents: 200 } },
      resolveTier: () => Promise.resolve('solo_manual'),
    });
    let calls = 0;
    const captured: CostAlertPayload[] = [];
    const sink: AlertSink = (alert) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('postmark down'));
      captured.push(alert);
      return Promise.resolve();
    };
    const dispatcher = new CostAlertDispatcher({ service, sendAlert: sink });
    // First eval (W378): the send rejects but is caught per-account — evaluate
    // RESOLVES with alertsErrored=1 (no throw), and lastState is NOT advanced.
    const r1 = await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(r1.alertsFired).toBe(0);
    expect(r1.alertsErrored).toBe(1);
    expect(r1.errors[0]?.message).toContain('postmark down');
    expect(captured).toHaveLength(0);
    // Second eval (channel recovered): the same transition is re-detected
    // because its state was never advanced → the critical alert is delivered.
    const r2 = await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(r2.alertsFired).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.severity).toBe('critical');
    expect(captured[0]?.previous_state).toBeNull();
    expect(captured[0]?.current_state).toBe('over-hard');
  });
});

describe('V-541.C dispatcher — payload shape', () => {
  it('carries account_id, tier, severity, prior + current state, total + thresholds', async () => {
    const rows = new Map([['acc_test', { ...EMPTY, sessionMinutes: 250 }]]);
    const { dispatcher, capturedAlerts } = makeFixture(rows);
    await dispatcher.evaluate({ accountIds: ['acc_test'], billingCycle: '2026-05' });
    const alert = capturedAlerts[0];
    expect(alert?.account_id).toBe('acc_test');
    expect(alert?.tier).toBe('solo_manual');
    expect(alert?.severity).toBe('critical');
    expect(alert?.previous_state).toBeNull();
    expect(alert?.current_state).toBe('over-hard');
    expect(alert?.total_cents).toBe(250);
    expect(alert?.threshold_soft_cents).toBe(100);
    expect(alert?.threshold_hard_cents).toBe(200);
    expect(alert?.billing_cycle).toBe('2026-05');
  });

  it('sendAlert is awaited; a send rejection is caught per-account (W378 — isolated, no longer bubbles out of evaluate)', async () => {
    const rows = new Map([['a', { ...EMPTY, sessionMinutes: 1_000 }]]);
    const aggregator: UsageAggregator = {
      aggregateForAccount: ({ accountId }) => Promise.resolve(rows.get(accountId) ?? null),
    };
    const service = new CostMonitoringService({
      aggregator,
      rates: RATES,
      tierThresholds: { solo_manual: { softCents: 100, hardCents: 200 } },
      resolveTier: () => Promise.resolve('solo_manual'),
    });
    const sink: AlertSink = vi.fn(() => Promise.reject(new Error('postmark down')));
    const dispatcher = new CostAlertDispatcher({ service, sendAlert: sink });
    // The send IS awaited (the rejection is observed → counted), but it is
    // caught per-account: evaluate RESOLVES (does not reject), so one failing
    // sink can't abort later accounts or — since the nightly job re-arms after
    // evaluate returns — kill the recompute chain.
    const r = await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(sink).toHaveBeenCalledOnce();
    expect(r.alertsFired).toBe(0);
    expect(r.alertsErrored).toBe(1);
    expect(r.errors[0]?.accountId).toBe('a');
  });

  it('returns bounded credential-safe sink diagnostics for nightly logging', async () => {
    const rows = new Map([['a', { ...EMPTY, sessionMinutes: 1_000 }]]);
    const aggregator: UsageAggregator = {
      aggregateForAccount: ({ accountId }) => Promise.resolve(rows.get(accountId) ?? null),
    };
    const service = new CostMonitoringService({
      aggregator,
      rates: RATES,
      tierThresholds: { solo_manual: { softCents: 100, hardCents: 200 } },
      resolveTier: () => Promise.resolve('solo_manual'),
    });
    const sink: AlertSink = () =>
      Promise.reject(
        new Error(
          `postmark failed https://mail.invalid/send?api_key=API_SECRET Authorization: Bearer BEARER_SECRET ${'x'.repeat(5_000)}`,
        ),
      );
    const dispatcher = new CostAlertDispatcher({ service, sendAlert: sink });

    const result = await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    const message = result.errors[0]?.message ?? '';
    expect(message.length).toBeLessThanOrEqual(500);
    expect(message).toContain('[redacted]');
    expect(message).not.toContain('API_SECRET');
    expect(message).not.toContain('BEARER_SECRET');
  });
});

describe('V-541.C dispatcher — billing-cycle rollover (threshold state is per-cycle)', () => {
  it('does NOT fire a spurious resolved when a new cycle starts under-soft after the prior cycle ended over-hard', async () => {
    const rows = new Map<string, UsageInputs>([['a', { ...EMPTY, sessionMinutes: 1_000 }]]); // over-hard
    const { dispatcher, capturedAlerts } = makeFixture(rows);
    // Cycle 2026-05: account is over-hard → one critical alert.
    const r1 = await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(r1.alertsFired).toBe(1);
    expect(capturedAlerts[0]?.severity).toBe('critical');
    // New billing cycle 2026-06: spend resets (under-soft). The prior cycle's
    // 'over-hard' state must NOT carry over and fire a spurious 'resolved'.
    rows.set('a', { ...EMPTY, sessionMinutes: 10 }); // under-soft
    const r2 = await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-06' });
    expect(r2.alertsFired).toBe(0);
    expect(capturedAlerts).toHaveLength(1); // still just the cycle-1 critical
  });

  it('still fires a genuine WITHIN-cycle resolved when spend drops in the same cycle', async () => {
    const rows = new Map<string, UsageInputs>([['a', { ...EMPTY, sessionMinutes: 1_000 }]]); // over-hard
    const { dispatcher, capturedAlerts } = makeFixture(rows);
    await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' }); // critical
    rows.set('a', { ...EMPTY, sessionMinutes: 10 }); // under-soft, SAME cycle
    const r2 = await dispatcher.evaluate({ accountIds: ['a'], billingCycle: '2026-05' });
    expect(r2.alertsFired).toBe(1);
    expect(capturedAlerts[1]?.severity).toBe('resolved');
  });
});

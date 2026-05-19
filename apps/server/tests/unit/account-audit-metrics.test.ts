// Arc 7 obs.10 — `driftstack_account_audit_emit_total{prefix,actor_type}`
// counter emitted by AccountAuditService.record(). Sweeps a
// representative set of action prefixes + actor types and the
// cardinality-cap invariant (action prefix is the namespace, not
// the full action name).

import { describe, expect, it, beforeEach } from 'vitest';
import {
  AccountAuditService,
  auditActionPrefix,
  type AccountAuditEntryRow,
  type AccountAuditRepo,
  type RecordAccountAuditInput,
} from '../../src/services/account-audit.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';

class FakeAuditRepo implements AccountAuditRepo {
  insert(input: RecordAccountAuditInput): Promise<AccountAuditEntryRow> {
    return Promise.resolve({
      id: 'aud_x',
      accountId: input.accountId,
      actorType: input.actorType,
      actorAccountId: input.actorAccountId ?? null,
      actorKeyId: input.actorKeyId ?? null,
      action: input.action,
      targetResourceId: input.targetResourceId ?? null,
      payload: input.payload ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      timestamp: new Date(),
    });
  }
  list(): Promise<never> {
    throw new Error('unused');
  }
}

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.accountAuditEmitTotal, 'Customer-facing audit log emissions.', [
    'prefix',
    'actor_type',
  ]);
  return m;
}

describe('Arc 7 obs.10 — account_audit_emit_total counter', () => {
  let metrics: MetricsRegistry;
  let service: AccountAuditService;

  beforeEach(() => {
    metrics = makeRegistry();
    service = new AccountAuditService(new FakeAuditRepo(), metrics);
  });

  it('increments prefix="api_key", actor_type="customer" on api_key.minted', async () => {
    await service.record({
      accountId: 'acc_1',
      actorType: 'customer',
      action: 'api_key.minted',
    });
    expect(
      metrics.getValue(METRIC_NAMES.accountAuditEmitTotal, {
        prefix: 'api_key',
        actor_type: 'customer',
      }),
    ).toBe(1);
  });

  it('increments prefix="agent_session" for the multi-dot action name (pair_mode.takeover)', async () => {
    await service.record({
      accountId: 'acc_1',
      actorType: 'customer',
      action: 'agent_session.pair_mode.takeover',
    });
    expect(
      metrics.getValue(METRIC_NAMES.accountAuditEmitTotal, {
        prefix: 'agent_session',
        actor_type: 'customer',
      }),
    ).toBe(1);
    // Sanity: the FULL action name did NOT leak into the prefix label.
    expect(
      metrics.getValue(METRIC_NAMES.accountAuditEmitTotal, {
        prefix: 'agent_session.pair_mode.takeover',
        actor_type: 'customer',
      }),
    ).toBe(0);
  });

  it('separates the staff actor_type from customer in the label set', async () => {
    // Picks actions from two different prefixes that exist in the
    // current AccountAuditActionSchema: subscription.* (customer side)
    // and admin.* (staff side). Earlier this test used billing.* names
    // that were dropped/never-merged; CI typecheck flagged the
    // discrepancy 2026-05-19.
    await service.record({
      accountId: 'acc_1',
      actorType: 'customer',
      action: 'subscription.tier_changed',
    });
    await service.record({
      accountId: 'acc_1',
      actorType: 'staff',
      action: 'admin.refund_recorded',
    });
    expect(
      metrics.getValue(METRIC_NAMES.accountAuditEmitTotal, {
        prefix: 'subscription',
        actor_type: 'customer',
      }),
    ).toBe(1);
    expect(
      metrics.getValue(METRIC_NAMES.accountAuditEmitTotal, {
        prefix: 'admin',
        actor_type: 'staff',
      }),
    ).toBe(1);
  });

  it('omitting the metrics registry is a silent no-op', async () => {
    const bare = new AccountAuditService(new FakeAuditRepo());
    await expect(
      bare.record({
        accountId: 'acc_1',
        actorType: 'customer',
        action: 'api_key.minted',
      }),
    ).resolves.toBeDefined();
  });

  it('Prometheus exposition format includes the new metric', async () => {
    await service.record({
      accountId: 'acc_1',
      actorType: 'customer',
      action: 'session.created',
    });
    const rendered = metrics.render();
    expect(rendered).toContain('# TYPE driftstack_account_audit_emit_total counter');
    expect(rendered).toMatch(
      /driftstack_account_audit_emit_total\{prefix="session",actor_type="customer"\} 1/,
    );
  });

  it('auditActionPrefix helper extracts the top-level namespace', () => {
    expect(auditActionPrefix('api_key.minted')).toBe('api_key');
    expect(auditActionPrefix('agent_session.pair_mode.takeover')).toBe('agent_session');
    expect(auditActionPrefix('session')).toBe('session'); // no dot — return as-is
    expect(auditActionPrefix('')).toBe(''); // edge case: empty string
  });
});

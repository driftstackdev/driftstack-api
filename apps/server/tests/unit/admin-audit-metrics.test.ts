// Arc 7 obs.11 — `driftstack_admin_audit_emit_total{prefix}` counter
// emitted by AdminAuditService.record(). Same shape as obs.10 but
// scoped to the admin surface (staff actor implicit).

import { describe, expect, it, beforeEach } from 'vitest';
import {
  AdminAuditService,
  type AdminAuditLogRow,
  type AdminAuditLogRepo,
  type NewAdminAuditLogInput,
  type ListAuditFilters,
  type ListAuditPage,
} from '../../src/services/admin-audit.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';

class FakeAdminAuditRepo implements AdminAuditLogRepo {
  insert(input: NewAdminAuditLogInput): Promise<AdminAuditLogRow> {
    return Promise.resolve({
      id: 'aau_x',
      adminAccountId: input.adminAccountId,
      adminKeyId: input.adminKeyId,
      action: input.action,
      targetAccountId: input.targetAccountId ?? null,
      targetResourceId: input.targetResourceId ?? null,
      inputPayload: input.inputPayload ?? null,
      result: input.result,
      ipAddress: input.ipAddress ?? null,
      timestamp: new Date(),
    });
  }
  list(_filters: ListAuditFilters): Promise<ListAuditPage> {
    throw new Error('unused');
  }
}

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.adminAuditEmitTotal, 'Admin audit log emissions.', ['prefix']);
  return m;
}

const COMMON: Pick<NewAdminAuditLogInput, 'adminAccountId' | 'adminKeyId' | 'result'> = {
  adminAccountId: 'acc_staff',
  adminKeyId: 'key_staff',
  result: 'ok',
};

describe('Arc 7 obs.11 — admin_audit_emit_total counter', () => {
  let metrics: MetricsRegistry;
  let service: AdminAuditService;

  beforeEach(() => {
    metrics = makeRegistry();
    service = new AdminAuditService(new FakeAdminAuditRepo(), metrics);
  });

  it('increments prefix="account" on account.tier_changed', async () => {
    await service.record({ ...COMMON, action: 'account.tier_changed' });
    expect(metrics.getValue(METRIC_NAMES.adminAuditEmitTotal, { prefix: 'account' })).toBe(1);
  });

  it('increments prefix="incident" across the incident lifecycle actions', async () => {
    await service.record({ ...COMMON, action: 'incident.created' });
    await service.record({ ...COMMON, action: 'incident.updated' });
    await service.record({ ...COMMON, action: 'incident.resolved' });
    expect(metrics.getValue(METRIC_NAMES.adminAuditEmitTotal, { prefix: 'incident' })).toBe(3);
  });

  it('increments prefix="webhook_delivery" on replay + requeue (distinct from incident bucket)', async () => {
    await service.record({ ...COMMON, action: 'webhook_delivery.replayed' });
    await service.record({ ...COMMON, action: 'webhook_delivery.requeued' });
    expect(metrics.getValue(METRIC_NAMES.adminAuditEmitTotal, { prefix: 'webhook_delivery' })).toBe(
      2,
    );
    expect(metrics.getValue(METRIC_NAMES.adminAuditEmitTotal, { prefix: 'incident' })).toBe(0);
  });

  it('omitting the metrics registry is a silent no-op', async () => {
    const bare = new AdminAuditService(new FakeAdminAuditRepo());
    await expect(bare.record({ ...COMMON, action: 'account.suspended' })).resolves.toBeDefined();
  });

  it('Prometheus exposition format includes the new metric', async () => {
    await service.record({ ...COMMON, action: 'refund.recorded' });
    const rendered = metrics.render();
    expect(rendered).toContain('# TYPE driftstack_admin_audit_emit_total counter');
    expect(rendered).toMatch(/driftstack_admin_audit_emit_total\{prefix="refund"\} 1/);
  });
});

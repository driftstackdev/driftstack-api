// AdminAuditService + InMemoryAdminAuditLogRepo unit tests. The
// production invariants — append-only, filterable list, deterministic
// ordering — are pinned here so future commits that try to add an
// update/delete path fail at the type level (the methods don't exist).

import { describe, expect, it } from 'vitest';
import { AdminAuditService } from '../../src/services/admin-audit.js';
import { InMemoryAdminAuditLogRepo } from '../integration/_helpers/in-memory-admin-audit-repo.js';

const ADMIN = '00000000-0000-4000-8000-00000000a001';
const ADMIN_KEY = '00000000-0000-4000-8000-00000000a002';
const TARGET_A = '00000000-0000-4000-8000-00000000b001';
const TARGET_B = '00000000-0000-4000-8000-00000000b002';

function newService(): {
  service: AdminAuditService;
  repo: InMemoryAdminAuditLogRepo;
} {
  const repo = new InMemoryAdminAuditLogRepo();
  const service = new AdminAuditService(repo);
  return { service, repo };
}

describe('AdminAuditService.record', () => {
  it('inserts a row with all required fields populated', async () => {
    const { service, repo } = newService();
    const row = await service.record({
      adminAccountId: ADMIN,
      adminKeyId: ADMIN_KEY,
      action: 'account.tier_changed',
      targetAccountId: TARGET_A,
      targetResourceId: null,
      inputPayload: { from: 'free', to: 'builder' },
      result: 'success',
      ipAddress: '127.0.0.1',
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(row.action).toBe('account.tier_changed');
    expect(row.adminAccountId).toBe(ADMIN);
    expect(row.targetAccountId).toBe(TARGET_A);
    expect(row.inputPayload).toEqual({ from: 'free', to: 'builder' });
    expect(row.result).toBe('success');
    expect(row.timestamp).toBeInstanceOf(Date);
    expect(repo.getAll()).toHaveLength(1);
  });

  it('records error results so failed admin actions are still audited', async () => {
    const { service, repo } = newService();
    await service.record({
      adminAccountId: ADMIN,
      adminKeyId: ADMIN_KEY,
      action: 'webhook_delivery.replayed',
      targetResourceId: 'wdl_00000000-0000-4000-8000-000000000999',
      result: 'error: not_found',
    });
    const all = repo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.result).toBe('error: not_found');
  });

  it('writes nullable fields as null when omitted', async () => {
    const { service, repo } = newService();
    await service.record({
      adminAccountId: ADMIN,
      adminKeyId: ADMIN_KEY,
      action: 'account.suspended',
      targetAccountId: TARGET_A,
      result: 'success',
      // ipAddress, targetResourceId, inputPayload all omitted
    });
    const r = repo.getAll()[0];
    expect(r?.ipAddress).toBeNull();
    expect(r?.targetResourceId).toBeNull();
    expect(r?.inputPayload).toBeNull();
  });
});

describe('AdminAuditService.list — filters', () => {
  async function seedThree(service: AdminAuditService): Promise<void> {
    await service.record({
      adminAccountId: ADMIN,
      adminKeyId: ADMIN_KEY,
      action: 'account.tier_changed',
      targetAccountId: TARGET_A,
      result: 'success',
    });
    await new Promise((r) => setTimeout(r, 2));
    await service.record({
      adminAccountId: ADMIN,
      adminKeyId: ADMIN_KEY,
      action: 'account.suspended',
      targetAccountId: TARGET_B,
      result: 'success',
    });
    await new Promise((r) => setTimeout(r, 2));
    await service.record({
      adminAccountId: ADMIN,
      adminKeyId: ADMIN_KEY,
      action: 'webhook_delivery.replayed',
      targetResourceId: 'wdl_x',
      result: 'success',
    });
  }

  it('returns rows ordered by timestamp DESC', async () => {
    const { service } = newService();
    await seedThree(service);
    const page = await service.list({ limit: 10 });
    expect(page.items).toHaveLength(3);
    // Most recent first.
    expect(page.items[0]?.action).toBe('webhook_delivery.replayed');
    expect(page.items[2]?.action).toBe('account.tier_changed');
  });

  it('filters by action', async () => {
    const { service } = newService();
    await seedThree(service);
    const page = await service.list({ limit: 10, action: 'account.suspended' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.targetAccountId).toBe(TARGET_B);
  });

  it('filters by targetAccountId', async () => {
    const { service } = newService();
    await seedThree(service);
    const page = await service.list({ limit: 10, targetAccountId: TARGET_A });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.action).toBe('account.tier_changed');
  });

  it('filters by adminAccountId', async () => {
    const { service } = newService();
    await seedThree(service);
    const page = await service.list({ limit: 10, adminAccountId: ADMIN });
    expect(page.items).toHaveLength(3);
    const page2 = await service.list({
      limit: 10,
      adminAccountId: '00000000-0000-4000-8000-00000000fff1',
    });
    expect(page2.items).toHaveLength(0);
  });

  it('paginates via cursor (limit + nextCursor round-trip)', async () => {
    const { service } = newService();
    await seedThree(service);

    const p1 = await service.list({ limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await service.list({ limit: 2, cursor: p1.nextCursor ?? undefined });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
  });

  it('filters by from/to time range', async () => {
    const { service } = newService();
    await service.record({
      adminAccountId: ADMIN,
      adminKeyId: ADMIN_KEY,
      action: 'account.tier_changed',
      targetAccountId: TARGET_A,
      result: 'success',
    });
    // Wait so the captured `mid` is strictly after row 1's timestamp at
    // millisecond precision, then again so row 2 is strictly after `mid`.
    await new Promise((r) => setTimeout(r, 5));
    const mid = new Date();
    await new Promise((r) => setTimeout(r, 5));
    await service.record({
      adminAccountId: ADMIN,
      adminKeyId: ADMIN_KEY,
      action: 'account.suspended',
      targetAccountId: TARGET_B,
      result: 'success',
    });

    const before = await service.list({ limit: 10, to: mid });
    expect(before.items).toHaveLength(1);
    expect(before.items[0]?.action).toBe('account.tier_changed');

    const after = await service.list({ limit: 10, from: mid });
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.action).toBe('account.suspended');
  });
});

describe('AdminAuditService — append-only invariant', () => {
  it('exposes only insert + list (no update/delete)', () => {
    const { service } = newService();
    // Compile-time + runtime: no other public mutating methods exist.
    const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter(
      (k) => k !== 'constructor',
    );
    expect(keys.sort()).toEqual(['list', 'record']);
  });
});

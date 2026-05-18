// AI-A — unit tests for InMemoryAgentSessionsRepo.
//
// Covers the contract for follow-up Drizzle impl (AI-A.c): create
// mints id + zeros transcript + sets tokenBudgetRemaining =
// tokenBudgetTotal; appendTranscript is append-only + bumps updatedAt;
// debitTokens floors at 0 (no negative budget); closeWithReason sets
// status + reason; get/listByAccount; rejection on unknown id.

import { describe, expect, it } from 'vitest';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';

function fixed(date: string): () => Date {
  return () => new Date(date);
}

describe('AI-A InMemoryAgentSessionsRepo', () => {
  it('create: mints `agt_inmem_<counter>` id, transcript empty, budget remaining = total, status active, no closedReason', async () => {
    const repo = new InMemoryAgentSessionsRepo(fixed('2026-05-16T00:00:00Z'));
    const rec = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 10_000 });
    expect(rec.id).toBe('agt_inmem_00000001');
    expect(rec.accountId).toBe('acc_1');
    expect(rec.transcript).toEqual([]);
    expect(rec.tokenBudgetTotal).toBe(10_000);
    expect(rec.tokenBudgetRemaining).toBe(10_000);
    expect(rec.status).toBe('active');
    expect(rec.closedReason).toBeNull();
    expect(rec.driftstackSessionId).toBeNull();
  });

  it('create: monotonic counter (00000001, 00000002, …)', async () => {
    const repo = new InMemoryAgentSessionsRepo(fixed('2026-05-16T00:00:00Z'));
    const a = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 1 });
    const b = await repo.create({ accountId: 'acc_2', tokenBudgetTotal: 1 });
    expect(a.id).toBe('agt_inmem_00000001');
    expect(b.id).toBe('agt_inmem_00000002');
  });

  it('create: pre-attached driftstackSessionId is preserved on the record', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const rec = await repo.create({
      accountId: 'acc_1',
      tokenBudgetTotal: 100,
      driftstackSessionId: 'ses_xyz',
    });
    expect(rec.driftstackSessionId).toBe('ses_xyz');
  });

  it('get: returns null for unknown id (does NOT throw)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    expect(await repo.get('agt_inmem_99999999')).toBeNull();
  });

  it('listByAccount: filters by accountId; returns empty array for accounts with no agent sessions', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 1 });
    await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 1 });
    await repo.create({ accountId: 'acc_2', tokenBudgetTotal: 1 });
    const acc1 = await repo.listByAccount('acc_1');
    const acc2 = await repo.listByAccount('acc_2');
    const acc3 = await repo.listByAccount('acc_3');
    expect(acc1).toHaveLength(2);
    expect(acc2).toHaveLength(1);
    expect(acc3).toEqual([]);
  });

  it('appendTranscript: append-only, ordered, bumps updatedAt; previous transcript array is NOT mutated', async () => {
    let now = new Date('2026-05-16T00:00:00Z');
    const repo = new InMemoryAgentSessionsRepo(() => now);
    const initial = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });

    now = new Date('2026-05-16T00:01:00Z');
    const r1 = await repo.appendTranscript(initial.id, {
      at: '2026-05-16T00:01:00Z',
      role: 'user',
      body: 'hi',
    });
    expect(r1.transcript).toHaveLength(1);
    expect(r1.transcript[0]?.body).toBe('hi');
    expect(r1.updatedAt.toISOString()).toBe('2026-05-16T00:01:00.000Z');

    now = new Date('2026-05-16T00:02:00Z');
    const r2 = await repo.appendTranscript(initial.id, {
      at: '2026-05-16T00:02:00Z',
      role: 'agent',
      body: 'plan',
    });
    expect(r2.transcript).toHaveLength(2);
    expect(r2.transcript[1]?.role).toBe('agent');

    // Initial record's transcript ref must NOT have been mutated.
    expect(initial.transcript).toHaveLength(0);
  });

  it('appendTranscript: rejects on unknown id (NOT a no-op — callers need to know)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    await expect(
      repo.appendTranscript('agt_inmem_99999999', { at: 'x', role: 'user', body: 'x' }),
    ).rejects.toThrow(/AgentSession .* not found/);
  });

  it('debitTokens: subtracts from remaining + floors at 0 (no negative budget)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const r0 = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 1000 });
    const r1 = await repo.debitTokens(r0.id, 300);
    expect(r1.tokenBudgetRemaining).toBe(700);
    const r2 = await repo.debitTokens(r0.id, 600);
    expect(r2.tokenBudgetRemaining).toBe(100);
    // Over-debit floors at 0, not negative.
    const r3 = await repo.debitTokens(r0.id, 999);
    expect(r3.tokenBudgetRemaining).toBe(0);
  });

  it('debitTokens: rejects on unknown id', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    await expect(repo.debitTokens('agt_inmem_99999999', 10)).rejects.toThrow();
  });

  it('closeWithReason: sets status closed + closedReason + bumps updatedAt; preserves transcript + remaining budget snapshot', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const r0 = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.appendTranscript(r0.id, { at: 'x', role: 'user', body: 'hi' });
    await repo.debitTokens(r0.id, 25);
    const closed = await repo.closeWithReason(r0.id, 'customer-closed');
    expect(closed.status).toBe('closed');
    expect(closed.closedReason).toBe('customer-closed');
    expect(closed.transcript).toHaveLength(1);
    expect(closed.tokenBudgetRemaining).toBe(75);
  });

  it('closeWithReason: rejects on unknown id', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    await expect(repo.closeWithReason('agt_inmem_99999999', 'x')).rejects.toThrow();
  });

  // v2-#19 — Stripe-pattern idempotency-key + closedAt hardening.
  it('v2-#19 create: idempotencyKey + createdByUserId default to NULL on the record when caller omits them; closedAt is NULL while active', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const rec = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    expect(rec.idempotencyKey).toBeNull();
    expect(rec.createdByUserId).toBeNull();
    expect(rec.closedAt).toBeNull();
  });

  it('v2-#19 create: idempotencyKey + createdByUserId persist when supplied; round-trip via findByIdempotencyKey and listByAccount', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const rec = await repo.create({
      accountId: 'acc_1',
      tokenBudgetTotal: 100,
      idempotencyKey: 'idem-abc',
      createdByUserId: 'usr_team_member_1',
    });
    expect(rec.idempotencyKey).toBe('idem-abc');
    expect(rec.createdByUserId).toBe('usr_team_member_1');
    const looked = await repo.findByIdempotencyKey('acc_1', 'idem-abc');
    expect(looked?.id).toBe(rec.id);
  });

  it('v2-#19 findByIdempotencyKey: scoped per-account — customer A "key=foo" does NOT collide with customer B "key=foo"', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const a = await repo.create({
      accountId: 'acc_A',
      tokenBudgetTotal: 1,
      idempotencyKey: 'shared',
    });
    const b = await repo.create({
      accountId: 'acc_B',
      tokenBudgetTotal: 1,
      idempotencyKey: 'shared',
    });
    expect(a.id).not.toBe(b.id);
    expect((await repo.findByIdempotencyKey('acc_A', 'shared'))?.id).toBe(a.id);
    expect((await repo.findByIdempotencyKey('acc_B', 'shared'))?.id).toBe(b.id);
    expect(await repo.findByIdempotencyKey('acc_C', 'shared')).toBeNull();
    expect(await repo.findByIdempotencyKey('acc_A', 'other')).toBeNull();
  });

  it('v2-#19 closeWithReason: sets closedAt to now on first close; re-closing leaves the original closedAt intact (first-close wins)', async () => {
    let now = new Date('2026-05-16T00:00:00Z');
    const repo = new InMemoryAgentSessionsRepo(() => now);
    const r0 = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    expect(r0.closedAt).toBeNull();

    now = new Date('2026-05-16T00:10:00Z');
    const first = await repo.closeWithReason(r0.id, 'customer-closed');
    expect(first.closedAt?.toISOString()).toBe('2026-05-16T00:10:00.000Z');

    now = new Date('2026-05-16T00:20:00Z');
    const reClosed = await repo.closeWithReason(r0.id, 'budget-exhausted');
    // Reason updates to the latest close call but closedAt is sticky.
    expect(reClosed.closedReason).toBe('budget-exhausted');
    expect(reClosed.closedAt?.toISOString()).toBe('2026-05-16T00:10:00.000Z');
    expect(reClosed.updatedAt.toISOString()).toBe('2026-05-16T00:20:00.000Z');
  });
});

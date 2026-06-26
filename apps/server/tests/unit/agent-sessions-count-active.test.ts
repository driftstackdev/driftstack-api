import { describe, expect, it } from 'vitest';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';

// audit we0i8bkgm #8 — countActive backs the per-account concurrent-session cap.
// It must count ONLY active sessions (closed ones don't hold a slot) and stay
// scoped to the account (one account's sessions never inflate another's count).
describe('AgentSessionsRepo.countActive (per-account active-session cap, audit #8)', () => {
  it('counts only active sessions, scoped to the account', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    // acc_a: 3 created, 1 later closed → 2 active.
    const a1 = await repo.create({ accountId: 'acc_a', tokenBudgetTotal: 1000 });
    await repo.create({ accountId: 'acc_a', tokenBudgetTotal: 1000 });
    await repo.create({ accountId: 'acc_a', tokenBudgetTotal: 1000 });
    await repo.closeWithReason(a1.id, 'customer-closed');
    // acc_b: 1 active — must NOT leak into acc_a's count.
    await repo.create({ accountId: 'acc_b', tokenBudgetTotal: 1000 });

    expect(await repo.countActive('acc_a')).toBe(2);
    expect(await repo.countActive('acc_b')).toBe(1);
    expect(await repo.countActive('acc_unknown')).toBe(0);
  });
});

// audit #8 (atomicity) — createIfUnderActiveCap closes the count-then-create
// TOCTOU: it counts active + inserts as one unit, returning null at/over the
// cap. The Drizzle impl does this under a per-account advisory xact lock so
// concurrent same-account creates can't all pass a stale count and overshoot;
// the in-memory impl is naturally atomic (single-threaded count+create) and is
// the contract double the route test exercises.
describe('AgentSessionsRepo.createIfUnderActiveCap (cap atomicity, audit #8)', () => {
  it('creates while under the cap and returns null once at the cap', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const cap = 3;
    const first = await repo.createIfUnderActiveCap(
      { accountId: 'acc_x', tokenBudgetTotal: 1000 },
      cap,
    );
    const second = await repo.createIfUnderActiveCap(
      { accountId: 'acc_x', tokenBudgetTotal: 1000 },
      cap,
    );
    const third = await repo.createIfUnderActiveCap(
      { accountId: 'acc_x', tokenBudgetTotal: 1000 },
      cap,
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    // 4th is over the cap → null, and no row is created (count stays at the cap).
    const fourth = await repo.createIfUnderActiveCap(
      { accountId: 'acc_x', tokenBudgetTotal: 1000 },
      cap,
    );
    expect(fourth).toBeNull();
    expect(await repo.countActive('acc_x')).toBe(cap);
  });

  it('frees a slot for a new create once an active session closes', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const cap = 1;
    const created = await repo.createIfUnderActiveCap(
      { accountId: 'acc_y', tokenBudgetTotal: 1000 },
      cap,
    );
    expect(created).not.toBeNull();
    // At the cap → blocked.
    expect(
      await repo.createIfUnderActiveCap({ accountId: 'acc_y', tokenBudgetTotal: 1000 }, cap),
    ).toBeNull();
    // Close the only active session → the slot frees → a new create succeeds.
    await repo.closeWithReason(created!.id, 'customer-closed');
    expect(
      await repo.createIfUnderActiveCap({ accountId: 'acc_y', tokenBudgetTotal: 1000 }, cap),
    ).not.toBeNull();
  });

  it('scopes the cap per account (one account at cap never blocks another)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const cap = 1;
    expect(
      await repo.createIfUnderActiveCap({ accountId: 'acc_p', tokenBudgetTotal: 1000 }, cap),
    ).not.toBeNull();
    // acc_p is at the cap…
    expect(
      await repo.createIfUnderActiveCap({ accountId: 'acc_p', tokenBudgetTotal: 1000 }, cap),
    ).toBeNull();
    // …but acc_q is independent and can still create.
    expect(
      await repo.createIfUnderActiveCap({ accountId: 'acc_q', tokenBudgetTotal: 1000 }, cap),
    ).not.toBeNull();
  });
});

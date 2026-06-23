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

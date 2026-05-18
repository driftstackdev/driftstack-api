// Arc 1 sub-slice 6.3 (v2-#6) — BundledLlmService unit tests.
//
// Service is a thin wrapper around the repo; the value is in pinning
// the wire shape (consent + monthlyCapUsdCents) that the route's
// resolution chain depends on. The Drizzle path is exercised by
// integration tests via the agent-sessions route.

import { describe, expect, it } from 'vitest';
import { BundledLlmService, InMemoryBundledLlmRepo } from '../../src/services/bundled-llm.js';

const ACCOUNT_ID = '00000000-0000-0000-0000-000000000aaa';

describe('Arc 1 v2-#6 sub-slice 6.3 BundledLlmService', () => {
  it('findSettings returns null when no row exists (caller treats as consent=false)', async () => {
    const svc = new BundledLlmService(new InMemoryBundledLlmRepo());
    expect(await svc.findSettings(ACCOUNT_ID)).toBeNull();
  });

  it('findSettings round-trips consent + monthlyCapUsdCents from the repo', async () => {
    const repo = new InMemoryBundledLlmRepo();
    repo.set(ACCOUNT_ID, { consent: true, monthlyCapUsdCents: 5000 });
    const svc = new BundledLlmService(repo);
    expect(await svc.findSettings(ACCOUNT_ID)).toEqual({
      consent: true,
      monthlyCapUsdCents: 5000,
    });
  });

  it('per-account isolation: account A consent does NOT leak to account B', async () => {
    const repo = new InMemoryBundledLlmRepo();
    repo.set('acc_A', { consent: true, monthlyCapUsdCents: 2000 });
    const svc = new BundledLlmService(repo);
    expect((await svc.findSettings('acc_A'))?.consent).toBe(true);
    expect(await svc.findSettings('acc_B')).toBeNull();
  });

  // Arc 1 sub-slice 6.5 (v2-#6) — monthly soft-cap sweep.
  it('v2-#6 sub-slice 6.5 sumMonthlySpendCents returns 0 with no prior bundled-LLM spend', async () => {
    const svc = new BundledLlmService(new InMemoryBundledLlmRepo());
    expect(
      await svc.sumMonthlySpendCents({
        accountId: 'acc_clean',
        now: new Date('2026-05-18T10:00:00Z'),
      }),
    ).toBe(0);
  });

  it('v2-#6 sub-slice 6.5 sumMonthlySpendCents sums rows from the current calendar month only — prior-month spend ignored', async () => {
    const repo = new InMemoryBundledLlmRepo();
    // Mid-April spend — should NOT count for May's sum.
    repo.addSpend('acc_1', new Date('2026-04-15T10:00:00Z'), 1500);
    // Two May spends — should sum to 30 cents.
    repo.addSpend('acc_1', new Date('2026-05-01T00:00:00Z'), 10);
    repo.addSpend('acc_1', new Date('2026-05-17T23:59:00Z'), 20);
    const svc = new BundledLlmService(repo);
    expect(
      await svc.sumMonthlySpendCents({
        accountId: 'acc_1',
        now: new Date('2026-05-18T00:00:00Z'),
      }),
    ).toBe(30);
  });

  it('v2-#6 sub-slice 6.5 month-boundary at midnight UTC — start-of-month spend (00:00:00.000) IS counted; spend at 23:59:59 prior month is NOT', async () => {
    const repo = new InMemoryBundledLlmRepo();
    repo.addSpend('acc_2', new Date('2026-04-30T23:59:59Z'), 99);
    repo.addSpend('acc_2', new Date('2026-05-01T00:00:00.000Z'), 7);
    const svc = new BundledLlmService(repo);
    expect(
      await svc.sumMonthlySpendCents({
        accountId: 'acc_2',
        now: new Date('2026-05-15T12:00:00Z'),
      }),
    ).toBe(7);
  });
});

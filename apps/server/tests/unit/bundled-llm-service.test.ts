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
});

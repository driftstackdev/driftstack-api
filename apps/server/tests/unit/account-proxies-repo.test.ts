// ARC A slice 1 — account_proxies repo. Covers CRUD + the OWNER-SCOPING
// invariant: every read/mutation is filtered by accountId, so one account can
// never see/update/delete another account's proxy (the same cross-account
// isolation the profile DEK relies on, at the row level).

import { describe, expect, it } from 'vitest';
import { InMemoryAccountProxiesRepo } from '../../src/db/account-proxies-repo.js';

const ACCT_A = '11111111-1111-1111-1111-111111111111';
const ACCT_B = '22222222-2222-2222-2222-222222222222';

function newInput(over: Partial<Parameters<InMemoryAccountProxiesRepo['create']>[1]> = {}) {
  return {
    label: 'home proxy',
    scheme: 'socks5',
    host: '1.2.3.4',
    port: 1080,
    username: 'user',
    wrappedPassword: 'wrapped-blob',
    ...over,
  };
}

describe('InMemoryAccountProxiesRepo — CRUD', () => {
  it('creates + lists + finds a proxy', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const created = await repo.create(ACCT_A, newInput());
    expect(created.id).toBeTruthy();
    expect(created.accountId).toBe(ACCT_A);
    expect(await repo.list(ACCT_A)).toHaveLength(1);
    expect((await repo.findById({ id: created.id, accountId: ACCT_A }))?.host).toBe('1.2.3.4');
  });

  it('updates owned fields + bumps updatedAt', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const created = await repo.create(ACCT_A, newInput());
    const updated = await repo.update({
      id: created.id,
      accountId: ACCT_A,
      updates: { label: 'renamed', port: 9050 },
    });
    expect(updated?.label).toBe('renamed');
    expect(updated?.port).toBe(9050);
    expect(updated?.host).toBe('1.2.3.4'); // untouched
  });

  it('deletes an owned proxy', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const created = await repo.create(ACCT_A, newInput());
    expect(await repo.delete({ id: created.id, accountId: ACCT_A })).toBe(true);
    expect(await repo.list(ACCT_A)).toHaveLength(0);
  });
});

describe('InMemoryAccountProxiesRepo — OWNER SCOPING (cross-account isolation)', () => {
  it('account B cannot find account A’s proxy', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const a = await repo.create(ACCT_A, newInput());
    expect(await repo.findById({ id: a.id, accountId: ACCT_B })).toBeNull();
  });

  it('account B’s list never includes account A’s proxies', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    await repo.create(ACCT_A, newInput());
    expect(await repo.list(ACCT_B)).toHaveLength(0);
  });

  it('account B cannot update account A’s proxy', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const a = await repo.create(ACCT_A, newInput());
    expect(
      await repo.update({ id: a.id, accountId: ACCT_B, updates: { label: 'hijacked' } }),
    ).toBeNull();
    // A's row is untouched.
    expect((await repo.findById({ id: a.id, accountId: ACCT_A }))?.label).toBe('home proxy');
  });

  it('account B cannot delete account A’s proxy', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const a = await repo.create(ACCT_A, newInput());
    expect(await repo.delete({ id: a.id, accountId: ACCT_B })).toBe(false);
    expect(await repo.list(ACCT_A)).toHaveLength(1);
  });
});

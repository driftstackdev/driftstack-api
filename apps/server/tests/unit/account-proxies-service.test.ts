// ARC A slice 4 — AccountProxiesService.resolveForDispatch security tests.
//
// resolveForDispatch is the sensitive path: it decrypts a stored proxy password
// (owner-scoped TMK) and re-asserts the SSRF host-guard before the proxy is
// injected into a session dispatch. Covered here: owner-scoping (B can't resolve
// A's proxy), password unwrap, SSRF fail-closed, http-scheme skip, no-key
// behaviour.

import { describe, expect, it } from 'vitest';
import { InMemoryAccountProxiesRepo } from '../../src/db/account-proxies-repo.js';
import { AccountProxiesService, UnsafeProxyHostError } from '../../src/services/account-proxies.js';
import { wrapAccountSecret } from '../../src/lib/profile-key-hierarchy.js';

const MASTER = Buffer.alloc(32, 7);
const ACCT_A = '11111111-1111-1111-1111-111111111111';
const ACCT_B = '22222222-2222-2222-2222-222222222222';

async function seed(
  repo: InMemoryAccountProxiesRepo,
  accountId: string,
  over: Partial<Parameters<InMemoryAccountProxiesRepo['create']>[1]> = {},
) {
  return repo.create(accountId, {
    label: 'p',
    scheme: 'socks5',
    host: '203.0.113.10',
    port: 1080,
    username: 'user',
    wrappedPassword: wrapAccountSecret(MASTER, accountId, Buffer.from('hunter2', 'utf8')),
    ...over,
  });
}

describe('AccountProxiesService.resolveForDispatch', () => {
  it('resolves a socks5 proxy and unwraps the password under the owner TMK', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A);
    const cfg = await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_A });
    expect(cfg).not.toBeNull();
    expect(cfg?.host).toBe('203.0.113.10');
    expect(cfg?.port).toBe(1080);
    expect(cfg?.username).toBe('user');
    expect(cfg?.password).toBe('hunter2');
    expect(cfg?.require_remote_dns).toBe(true);
  });

  it('OWNER SCOPING: account B cannot resolve account A’s proxy (null, never decrypts)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A);
    expect(await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_B })).toBeNull();
  });

  it('unknown id → null', async () => {
    const svc = new AccountProxiesService(new InMemoryAccountProxiesRepo(), MASTER);
    expect(await svc.resolveForDispatch({ proxyId: 'nope', accountId: ACCT_A })).toBeNull();
  });

  it('SSRF FAIL-CLOSED: a stored private/loopback host throws UnsafeProxyHostError', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.5', 'localhost', '::1']) {
      const row = await seed(repo, ACCT_A, { host });
      await expect(svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_A })).rejects.toThrow(
        UnsafeProxyHostError,
      );
    }
  });

  it('http-scheme proxy is not dispatch-injectable yet → null', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A, { scheme: 'http' });
    expect(await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_A })).toBeNull();
  });

  it('no master key → resolves without a password (can’t unwrap)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, null);
    const row = await seed(repo, ACCT_A);
    const cfg = await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_A });
    expect(cfg?.password).toBeUndefined();
    expect(cfg?.host).toBe('203.0.113.10');
  });

  it('a proxy with no stored password resolves without one', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A, { wrappedPassword: null, username: null });
    const cfg = await svc.resolveForDispatch({ proxyId: row.id, accountId: ACCT_A });
    expect(cfg?.password).toBeUndefined();
    expect(cfg?.username).toBeUndefined();
  });
});

describe('AccountProxiesService.findOwned', () => {
  it('returns the row for the owner, null cross-account', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const svc = new AccountProxiesService(repo, MASTER);
    const row = await seed(repo, ACCT_A);
    expect((await svc.findOwned(row.id, ACCT_A))?.id).toBe(row.id);
    expect(await svc.findOwned(row.id, ACCT_B)).toBeNull();
  });
});

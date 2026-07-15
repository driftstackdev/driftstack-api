// ARC A slice 1 — account_proxies repo. Covers CRUD + the OWNER-SCOPING
// invariant: every read/mutation is filtered by accountId, so one account can
// never see/update/delete another account's proxy (the same cross-account
// isolation the profile DEK relies on, at the row level).

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryAccountProxiesRepo } from '../../src/db/account-proxies-repo.js';
import { wrapAccountSecret } from '../../src/lib/profile-key-hierarchy.js';
import {
  ACCOUNT_PROXY_SECRET_V2_PREFIX,
  readAccountProxySecret,
} from '../../src/lib/account-proxy-secret-encryption.js';

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
    id: over.id ?? randomUUID(),
  };
}

describe('InMemoryAccountProxiesRepo — CRUD', () => {
  it('creates + lists + finds a proxy', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const input = newInput();
    const created = await repo.create(ACCT_A, input);
    expect(created.id).toBe(input.id);
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

  it('expectedScheme makes an update lose safely after a concurrent scheme transition', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const created = await repo.create(ACCT_A, newInput());
    await repo.update({
      id: created.id,
      accountId: ACCT_A,
      expectedScheme: 'socks5',
      updates: { scheme: 'wireguard' },
    });
    await expect(
      repo.update({
        id: created.id,
        accountId: ACCT_A,
        expectedScheme: 'socks5',
        updates: { wrappedPassword: 'must-not-land' },
      }),
    ).resolves.toBeNull();
    expect((await repo.findById({ id: created.id, accountId: ACCT_A }))?.wrappedPassword).not.toBe(
      'must-not-land',
    );
  });

  it('createIfUnderLimit enforces an exact account-local cap', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    await expect(repo.createIfUnderLimit(ACCT_A, newInput(), 1)).resolves.not.toBeNull();
    await expect(repo.createIfUnderLimit(ACCT_A, newInput(), 1)).resolves.toBeNull();
    await expect(repo.createIfUnderLimit(ACCT_B, newInput(), 1)).resolves.not.toBeNull();
    expect(await repo.list(ACCT_A)).toHaveLength(1);
    expect(await repo.list(ACCT_B)).toHaveLength(1);
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

// OVPN/WG arc (0082) — the additive VPN-config columns. socks5/http rows are
// behavior-identical (wrappedSecret null, config {}); VPN rows carry the secret
// payload + non-secret structured fields. The secret stays opaque at this layer.
describe('InMemoryAccountProxiesRepo — VPN config columns (wrappedSecret + config)', () => {
  it('a socks5 proxy defaults to wrappedSecret=null + config={} (behavior-identical)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const created = await repo.create(ACCT_A, newInput());
    expect(created.wrappedSecret).toBeNull();
    expect(created.config).toEqual({});
  });

  it('a wireguard proxy round-trips its wrappedSecret + config (non-secret fields)', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const created = await repo.create(
      ACCT_A,
      newInput({
        scheme: 'wireguard',
        wrappedPassword: null,
        wrappedSecret: 'wrapped-private-key-blob',
        config: {
          peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
          endpoint: 'vpn.example.com:51820',
          allowed_ips: '0.0.0.0/0',
        },
      }),
    );
    const found = await repo.findById({ id: created.id, accountId: ACCT_A });
    expect(found?.scheme).toBe('wireguard');
    expect(found?.wrappedSecret).toBe('wrapped-private-key-blob');
    expect(found?.config).toMatchObject({ endpoint: 'vpn.example.com:51820' });
  });
});

describe('InMemoryAccountProxiesRepo — bounded secret migration', () => {
  it('converts mixed nullable legacy wrappers without moving timestamps', async () => {
    const repo = new InMemoryAccountProxiesRepo();
    const masterKey = Buffer.alloc(32, 71);
    const passwordId = randomUUID();
    const vpnId = randomUUID();
    const passwordRow = await repo.create(
      ACCT_A,
      newInput({
        id: passwordId,
        wrappedPassword: wrapAccountSecret(masterKey, ACCT_A, Buffer.from('hunter2')),
      }),
    );
    const vpnRow = await repo.create(
      ACCT_A,
      newInput({
        id: vpnId,
        scheme: 'wireguard',
        wrappedPassword: null,
        wrappedSecret: wrapAccountSecret(
          masterKey,
          ACCT_A,
          Buffer.from('yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk='),
        ),
      }),
    );

    await expect(repo.migrateSecretEnvelopes(masterKey, 10)).resolves.toEqual({
      scanned: 2,
      converted: 2,
      remaining: 0,
    });
    const migratedPassword = await repo.findById({ id: passwordId, accountId: ACCT_A });
    const migratedVpn = await repo.findById({ id: vpnId, accountId: ACCT_A });
    expect(migratedPassword?.wrappedPassword).toContain(ACCOUNT_PROXY_SECRET_V2_PREFIX);
    expect(migratedVpn?.wrappedSecret).toContain(ACCOUNT_PROXY_SECRET_V2_PREFIX);
    expect(migratedPassword?.updatedAt).toEqual(passwordRow.updatedAt);
    expect(migratedVpn?.updatedAt).toEqual(vpnRow.updatedAt);
    expect(
      readAccountProxySecret(
        masterKey,
        { accountId: ACCT_A, proxyId: passwordId, slot: 'password' },
        migratedPassword!.wrappedPassword!,
      ),
    ).toBe('hunter2');
  });
});

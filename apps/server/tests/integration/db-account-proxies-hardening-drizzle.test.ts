// Real-Postgres proof for record-bound proxy credentials, whole-page migration,
// exact-CAS loss and the transaction-serialized per-account creation cap.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DrizzleAccountProxiesRepo,
  type NewAccountProxyRow,
} from '../../src/db/account-proxies-repo.js';
import {
  ACCOUNT_PROXY_SECRET_V2_PREFIX,
  encryptAccountProxySecret,
  readAccountProxySecret,
} from '../../src/lib/account-proxy-secret-encryption.js';
import { wrapAccountSecret } from '../../src/lib/profile-key-hierarchy.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const TEST_SCHEMA = `account_proxy_hardening_${randomUUID().replaceAll('-', '')}`;
const MASTER = Buffer.alloc(32, 91);
const WRONG_MASTER = Buffer.alloc(32, 92);
const WG_KEY = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;

function dbFor(sqlClient: ReturnType<typeof postgres>) {
  return drizzle(sqlClient) as unknown as ReturnType<typeof drizzle<typeof schema>>;
}

function repoFor(sqlClient: ReturnType<typeof postgres>): DrizzleAccountProxiesRepo {
  return new DrizzleAccountProxiesRepo({
    client: sqlClient,
    db: dbFor(sqlClient),
    close: async () => {},
  });
}

async function insertProxy(args: {
  id: string;
  accountId: string;
  scheme: string;
  wrappedPassword?: string | null;
  wrappedSecret?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}): Promise<void> {
  const createdAt = args.createdAt ?? new Date('2026-07-14T21:20:00.000Z');
  const updatedAt = args.updatedAt ?? new Date('2026-07-14T21:21:00.000Z');
  await client!`
    INSERT INTO account_proxies (
      id, account_id, label, scheme, host, port, username,
      wrapped_password, wrapped_secret, config, created_at, updated_at
    ) VALUES (
      ${args.id}, ${args.accountId}, 'test proxy', ${args.scheme}, 'proxy.example.com', 1080, NULL,
      ${args.wrappedPassword ?? null}, ${args.wrappedSecret ?? null}, '{}'::jsonb,
      ${createdAt.toISOString()}::timestamptz, ${updatedAt.toISOString()}::timestamptz
    )
  `;
}

function newInput(index: number): NewAccountProxyRow {
  return {
    id: randomUUID(),
    label: `proxy-${index.toString()}`,
    scheme: 'socks5',
    host: `proxy-${index.toString()}.example.com`,
    port: 1080 + index,
    username: null,
    wrappedPassword: null,
  };
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  admin = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await admin`SELECT 1`;
  } catch (error) {
    await admin.end({ timeout: 1 }).catch(() => {});
    admin = null;
    throw error;
  }
  await admin.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  await admin.unsafe(`
    CREATE TABLE "${TEST_SCHEMA}".account_proxies (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      label text NOT NULL,
      scheme text NOT NULL DEFAULT 'socks5',
      host text NOT NULL,
      port integer NOT NULL,
      username text,
      wrapped_password text,
      wrapped_secret text,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  client = postgres(DB_URL, {
    max: 5,
    connection: { search_path: TEST_SCHEMA },
  });
  const [current] = await client<Array<{ value: string }>>`SELECT current_schema() AS value`;
  expect(current?.value).toBe(TEST_SCHEMA);
});

beforeEach(async () => {
  if (client) await client`TRUNCATE account_proxies`;
});

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await admin.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB_TESTS)('account proxy hardening (Drizzle path, real Postgres)', () => {
  it('preserves bytes/timestamps on wrong key, migrates mixed nullable rows, and rejects relocation', async () => {
    if (!client) return;
    const repo = repoFor(client);
    const wrongRepo = repoFor(client);
    const accountA = randomUUID();
    const accountB = randomUUID();
    const passwordId = '00000000-0000-4000-8000-000000000001';
    const vpnId = '00000000-0000-4000-8000-000000000002';
    const createdAt = new Date('2026-07-14T21:22:00.000Z');
    const updatedAt = new Date('2026-07-14T21:23:00.000Z');
    const legacyPassword = wrapAccountSecret(MASTER, accountA, Buffer.from('hunter2'));
    const legacyVpn = wrapAccountSecret(MASTER, accountA, Buffer.from(WG_KEY));
    await insertProxy({
      id: passwordId,
      accountId: accountA,
      scheme: 'socks5',
      wrappedPassword: legacyPassword,
      createdAt,
      updatedAt,
    });
    await insertProxy({
      id: vpnId,
      accountId: accountA,
      scheme: 'wireguard',
      wrappedSecret: legacyVpn,
      createdAt,
      updatedAt,
    });

    await expect(wrongRepo.migrateSecretEnvelopes(WRONG_MASTER, 500)).rejects.toThrow();
    const beforeMigration = await client<
      Array<{
        id: string;
        wrapped_password: string | null;
        wrapped_secret: string | null;
        created_at: Date;
        updated_at: Date;
      }>
    >`SELECT id, wrapped_password, wrapped_secret, created_at, updated_at FROM account_proxies ORDER BY id`;
    expect(beforeMigration[0]?.wrapped_password).toBe(legacyPassword);
    expect(beforeMigration[1]?.wrapped_secret).toBe(legacyVpn);
    expect(
      beforeMigration.every(
        (row) => new Date(String(row.created_at)).toISOString() === createdAt.toISOString(),
      ),
    ).toBe(true);
    expect(
      beforeMigration.every(
        (row) => new Date(String(row.updated_at)).toISOString() === updatedAt.toISOString(),
      ),
    ).toBe(true);

    await expect(repo.migrateSecretEnvelopes(MASTER, 500)).resolves.toEqual({
      scanned: 2,
      converted: 2,
      remaining: 0,
    });
    const passwordRow = await repo.findById({ id: passwordId, accountId: accountA });
    const vpnRow = await repo.findById({ id: vpnId, accountId: accountA });
    expect(passwordRow?.wrappedPassword).toContain(ACCOUNT_PROXY_SECRET_V2_PREFIX);
    expect(vpnRow?.wrappedSecret).toContain(ACCOUNT_PROXY_SECRET_V2_PREFIX);
    expect(passwordRow?.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(passwordRow?.updatedAt.toISOString()).toBe(updatedAt.toISOString());
    expect(
      readAccountProxySecret(
        MASTER,
        { accountId: accountA, proxyId: passwordId, slot: 'password' },
        passwordRow!.wrappedPassword!,
      ),
    ).toBe('hunter2');
    expect(
      readAccountProxySecret(
        MASTER,
        { accountId: accountA, proxyId: vpnId, slot: 'wireguard-private-key' },
        vpnRow!.wrappedSecret!,
      ),
    ).toBe(WG_KEY);
    await expect(wrongRepo.migrateSecretEnvelopes(WRONG_MASTER, 500)).rejects.toThrow();

    const sameAccountId = randomUUID();
    const crossAccountId = randomUUID();
    const crossSlotId = randomUUID();
    await insertProxy({ id: sameAccountId, accountId: accountA, scheme: 'socks5' });
    await insertProxy({ id: crossAccountId, accountId: accountB, scheme: 'socks5' });
    await insertProxy({ id: crossSlotId, accountId: accountA, scheme: 'wireguard' });
    await client`
      UPDATE account_proxies SET wrapped_password = ${passwordRow!.wrappedPassword}
      WHERE id IN (${sameAccountId}, ${crossAccountId})
    `;
    await client`
      UPDATE account_proxies SET wrapped_secret = ${passwordRow!.wrappedPassword}
      WHERE id = ${crossSlotId}
    `;
    const relocated = await repo.list(accountA);
    const sameAccount = relocated.find((row) => row.id === sameAccountId)!;
    const crossSlot = relocated.find((row) => row.id === crossSlotId)!;
    const crossAccount = await repo.findById({ id: crossAccountId, accountId: accountB });
    expect(() =>
      readAccountProxySecret(
        MASTER,
        { accountId: accountA, proxyId: sameAccountId, slot: 'password' },
        sameAccount.wrappedPassword!,
      ),
    ).toThrow();
    expect(() =>
      readAccountProxySecret(
        MASTER,
        { accountId: accountB, proxyId: crossAccountId, slot: 'password' },
        crossAccount!.wrappedPassword!,
      ),
    ).toThrow();
    expect(() =>
      readAccountProxySecret(
        MASTER,
        { accountId: accountA, proxyId: crossSlotId, slot: 'wireguard-private-key' },
        crossSlot.wrappedSecret!,
      ),
    ).toThrow();
  });

  it('prevalidates the whole page and rejects invalid scheme/secret state before any write', async () => {
    if (!client) return;
    const repo = repoFor(client);
    const accountId = randomUUID();
    const validId = '00000000-0000-4000-8000-000000000011';
    const wrongKeyId = '00000000-0000-4000-8000-000000000012';
    await insertProxy({
      id: validId,
      accountId,
      scheme: 'socks5',
      wrappedPassword: wrapAccountSecret(MASTER, accountId, Buffer.from('valid-password')),
    });
    await insertProxy({
      id: wrongKeyId,
      accountId,
      scheme: 'socks5',
      wrappedPassword: wrapAccountSecret(WRONG_MASTER, accountId, Buffer.from('wrong-key')),
    });
    await expect(repo.migrateSecretEnvelopes(MASTER, 500)).rejects.toThrow();
    const after = await client<Array<{ wrapped_password: string }>>`
      SELECT wrapped_password FROM account_proxies ORDER BY id
    `;
    expect(after).toHaveLength(2);
    expect(
      after.every((row) => !row.wrapped_password.startsWith(ACCOUNT_PROXY_SECRET_V2_PREFIX)),
    ).toBe(true);

    await client`TRUNCATE account_proxies`;
    const invalidId = randomUUID();
    const invalidSecret = wrapAccountSecret(MASTER, accountId, Buffer.from(WG_KEY));
    await insertProxy({
      id: invalidId,
      accountId,
      scheme: 'socks5',
      wrappedSecret: invalidSecret,
    });
    await expect(repo.migrateSecretEnvelopes(MASTER, 500)).rejects.toThrow(/cannot carry/);
    const [invalidAfter] = await client<Array<{ wrapped_secret: string }>>`
      SELECT wrapped_secret FROM account_proxies WHERE id = ${invalidId}
    `;
    expect(invalidAfter?.wrapped_secret).toBe(invalidSecret);
  });

  it('loses exact wrapper CAS safely to a concurrent v2 successor', async () => {
    if (!client) return;
    const accountId = randomUUID();
    const id = randomUUID();
    const updatedAt = new Date('2026-07-14T21:24:00.000Z');
    await insertProxy({
      id,
      accountId,
      scheme: 'socks5',
      wrappedPassword: wrapAccountSecret(MASTER, accountId, Buffer.from('legacy-password')),
      updatedAt,
    });
    const successor = encryptAccountProxySecret(
      MASTER,
      { accountId, proxyId: id, slot: 'password' },
      'successor-password',
    );
    const blocker = postgres(DB_URL, {
      max: 1,
      connection: { search_path: TEST_SCHEMA },
    });
    const migratorClient = postgres(DB_URL, {
      max: 1,
      connection: { search_path: TEST_SCHEMA },
    });
    const [backend] = await migratorClient<Array<{ pid: number }>>`
      SELECT pg_backend_pid()::int AS pid
    `;
    const migratorRepo = repoFor(migratorClient);
    let migration: Promise<{ scanned: number; converted: number; remaining: number }> | null = null;
    let blocked = false;
    try {
      await blocker`BEGIN`;
      await blocker`SELECT id FROM account_proxies WHERE id = ${id} FOR UPDATE`;
      migration = migratorRepo.migrateSecretEnvelopes(MASTER, 500);
      void migration.catch(() => {});
      for (let attempt = 0; attempt < 100; attempt++) {
        const [activity] = await client<Array<{ waiting: boolean }>>`
          SELECT wait_event_type = 'Lock' AS waiting
          FROM pg_stat_activity
          WHERE pid = ${backend!.pid} AND state = 'active'
          LIMIT 1
        `;
        if (activity?.waiting === true) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await blocker`
        UPDATE account_proxies SET wrapped_password = ${successor} WHERE id = ${id}
      `;
      await blocker`COMMIT`;
      await expect(migration).resolves.toEqual({ scanned: 1, converted: 0, remaining: 0 });
      expect(blocked).toBe(true);
      const [after] = await client<Array<{ wrapped_password: string; updated_at: Date }>>`
        SELECT wrapped_password, updated_at FROM account_proxies WHERE id = ${id}
      `;
      expect(after?.wrapped_password).toBe(successor);
      expect(new Date(String(after!.updated_at)).toISOString()).toBe(updatedAt.toISOString());
    } finally {
      await blocker`ROLLBACK`.catch(() => {});
      await migratorClient.end({ timeout: 5 });
      await blocker.end({ timeout: 5 });
    }
  });

  it('serializes a five-way limit-1 race and exact-conditions the expected scheme', async () => {
    if (!client) return;
    const repo = repoFor(client);
    const accountId = randomUUID();
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((index) => repo.createIfUnderLimit(accountId, newInput(index), 1)),
    );
    expect(results.filter((row) => row !== null)).toHaveLength(1);
    expect(results.filter((row) => row === null)).toHaveLength(4);
    expect(await repo.list(accountId)).toHaveLength(1);
    const winner = results.find((row) => row !== null)!;
    await expect(
      repo.update({
        id: winner.id,
        accountId,
        expectedScheme: 'socks5',
        updates: { scheme: 'wireguard', wrappedPassword: null },
      }),
    ).resolves.not.toBeNull();
    await expect(
      repo.update({
        id: winner.id,
        accountId,
        expectedScheme: 'socks5',
        updates: { wrappedPassword: 'must-not-land' },
      }),
    ).resolves.toBeNull();
    expect((await repo.findById({ id: winner.id, accountId }))?.wrappedPassword).toBeNull();
  });
});

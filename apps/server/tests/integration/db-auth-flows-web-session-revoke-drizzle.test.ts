// Real-Postgres proof that a web-session revoke is an atomic claim across
// pooled API connections. This is the cross-process backstop for refresh-token
// rotation: only the transaction that flips revoked_at NULL→timestamp may mint.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAuthFlowsRepo } from '../../src/db/auth-flows-repo.js';
import { DrizzleAccountAuthRepo } from '../../src/db/auth-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 5 });
  try {
    await client`SELECT 1 FROM web_sessions LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const accountId of seeded) {
    await client`DELETE FROM web_sessions WHERE account_id = ${accountId}`.catch(() => {});
    await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'web-session revoke first-winner claim (Drizzle path, real Postgres)',
  () => {
    it('returns true to exactly one concurrent revoker', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAuthFlowsRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`refresh-claim-${accountId}@test.local`})`;
      const session = await repo.insertWebSession({
        accountId,
        tokenHash: `hash-${randomUUID()}`,
        authEpoch: 0,
        expiresAt: new Date(Date.now() + 60_000),
        issuedFromIp: null,
        userAgent: null,
      });
      expect(session).not.toBeNull();
      if (!session) throw new Error('expected live session insert');

      const results = await Promise.all([
        repo.revokeWebSession(session.id, new Date()),
        repo.revokeWebSession(session.id, new Date()),
      ]);
      expect(results.sort()).toEqual([false, true]);
    });

    it('waits for a password epoch bump and refuses the stale successor', async () => {
      if (!dbReachable || !client) return;
      const pg = client;
      const db = drizzle(pg) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAuthFlowsRepo({ client: pg, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await pg`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`refresh-epoch-${accountId}@test.local`})`;

      let passwordUpdated!: () => void;
      let releaseReset!: () => void;
      const updateVisible = new Promise<void>((resolve) => {
        passwordUpdated = resolve;
      });
      const holdReset = new Promise<void>((resolve) => {
        releaseReset = resolve;
      });
      const reset = pg.begin(async (tx) => {
        await tx`
          UPDATE accounts
          SET password_hash = 'reset-won', auth_epoch = auth_epoch + 1
          WHERE id = ${accountId}
        `;
        passwordUpdated();
        await holdReset;
      });
      await updateVisible;

      let insertSettled = false;
      const insert = repo
        .insertWebSession({
          accountId,
          tokenHash: `stale-hash-${randomUUID()}`,
          authEpoch: 0,
          expiresAt: new Date(Date.now() + 60_000),
          issuedFromIp: null,
          userAgent: 'stolen-browser',
        })
        .then((row) => {
          insertSettled = true;
          return row;
        });

      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(insertSettled).toBe(false);
      } finally {
        releaseReset();
      }
      await reset;
      await expect(insert).resolves.toBeNull();

      const rows = await pg`SELECT id FROM web_sessions WHERE account_id = ${accountId}`;
      expect(rows).toHaveLength(0);
    });

    it('makes an already-minted prior-epoch session inactive immediately after password change', async () => {
      if (!dbReachable || !client) return;
      const pg = client;
      const db = drizzle(pg) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAuthFlowsRepo({ client: pg, db, close: async () => {} });
      const runtimeAuthRepo = new DrizzleAccountAuthRepo({ client: pg, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await pg`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`refresh-epoch-read-${accountId}@test.local`})`;
      const tokenHash = `epoch-read-${randomUUID()}`;
      const session = await repo.insertWebSession({
        accountId,
        tokenHash,
        authEpoch: 0,
        expiresAt: new Date(Date.now() + 60_000),
        issuedFromIp: null,
        userAgent: null,
      });
      expect(session).not.toBeNull();
      expect(await repo.findActiveWebSession({ tokenHash, now: new Date() })).not.toBeNull();
      expect(
        await runtimeAuthRepo.findActiveWebSession({ tokenHash, now: new Date() }),
      ).not.toBeNull();

      const updated = await repo.setPassword(accountId, 'new-password-hash');
      expect(updated?.authEpoch).toBe(1);
      expect(await repo.findActiveWebSession({ tokenHash, now: new Date() })).toBeNull();
      expect(await runtimeAuthRepo.findActiveWebSession({ tokenHash, now: new Date() })).toBeNull();
    });
  },
);

// Real-Postgres proof that one scoped ready→busy claim owns every direct
// driver operation and that operation settlement shares one terminal order
// with serialized destroy. Independent max:1 clients make the row-lock/CAS
// behavior load-bearing instead of relying on one JavaScript process.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleSessionRepo } from '../../src/db/sessions-repo.js';
import type * as schema from '../../src/db/schema.js';
import type { NewSessionInput } from '../../src/services/sessions.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

type SqlClient = ReturnType<typeof postgres>;

let dbReachable = false;
let admin: SqlClient | null = null;
const clients: SqlClient[] = [];
const seededAccountIds: string[] = [];

function openRepo(applicationName = 'driftstack-session-operation-owner-test'): DrizzleSessionRepo {
  const client = postgres(DB_URL, {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 2,
    connection: { application_name: applicationName },
  });
  clients.push(client);
  const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return new DrizzleSessionRepo({ client, db, close: async () => {} });
}

async function waitForLockWaiters(applicationName: string, expected: number): Promise<number> {
  if (!admin) throw new Error('real PostgreSQL setup failed');
  let count = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await admin<Array<{ count: number }>>`
      SELECT count(*)::int AS count
        FROM pg_stat_activity
       WHERE application_name = ${applicationName}
         AND state = 'active'
         AND wait_event_type = 'Lock'
    `;
    count = Number(row?.count ?? 0);
    if (count >= expected) return count;
    await sleep(20);
  }
  return count;
}

async function destroyedEventCount(sessionId: string): Promise<number> {
  if (!admin) throw new Error('real PostgreSQL setup failed');
  const [row] = await admin<Array<{ count: number }>>`
    SELECT count(*)::int AS count
      FROM session_events
     WHERE session_id = ${sessionId}
       AND type = 'destroyed'
  `;
  return Number(row?.count ?? 0);
}

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  admin = postgres(DB_URL, { max: 2 });
  try {
    await admin`SELECT 1 FROM sessions LIMIT 0`;
    dbReachable = true;
  } catch {
    await admin.end({ timeout: 1 }).catch(() => {});
    admin = null;
  }
});

afterAll(async () => {
  // End every contender first. If a RED assertion interrupted a transaction,
  // postgres-js's bounded end forcibly releases that connection/row lock before
  // the admin cleanup tries to delete the seeded row.
  await Promise.all(clients.splice(0).map((client) => client.end({ timeout: 2 }).catch(() => {})));
  if (admin) {
    for (const accountId of seededAccountIds) {
      await admin`DELETE FROM sessions WHERE account_id = ${accountId}`.catch(() => {});
      await admin`DELETE FROM api_keys WHERE account_id = ${accountId}`.catch(() => {});
      await admin`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
  }
  if (admin) await admin.end({ timeout: 2 });
});

async function seedAccountWithKey(): Promise<{ accountId: string; apiKeyId: string }> {
  if (!admin) throw new Error('real PostgreSQL setup failed');
  const accountId = randomUUID();
  const apiKeyId = randomUUID();
  seededAccountIds.push(accountId);
  await admin`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`operation-owner-${accountId}@test.local`})`;
  await admin`
    INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
    VALUES (
      ${apiKeyId},
      ${accountId},
      'operation-owner',
      ${`owner_${accountId.slice(0, 8)}`},
      ${`hash_${accountId}`}
    )
  `;
  return { accountId, apiKeyId };
}

function sessionInput(accountId: string, apiKeyId: string): NewSessionInput {
  return {
    accountId,
    apiKeyId,
    driverSessionId: `drv_${randomUUID()}`,
    archetype: 'iphone17_ios18_7_safari26_4',
    purpose: 'production_customer',
    label: null,
    metadata: null,
  };
}

async function readySession(repo: DrizzleSessionRepo): Promise<{
  accountId: string;
  session: Awaited<ReturnType<DrizzleSessionRepo['insertSession']>>;
}> {
  const { accountId, apiKeyId } = await seedAccountWithKey();
  const inserted = await repo.insertSession(sessionInput(accountId, apiKeyId));
  await repo.updateSessionStatus(inserted.id, 'ready');
  const session = await repo.findSession(inserted.id, accountId);
  if (!session) throw new Error('ready session disappeared');
  return { accountId, session };
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'session operation ownership (Drizzle path, real Postgres)',
  () => {
    it('elects exactly one of nine independent claims and admits a successor only after release', async () => {
      if (!dbReachable || !admin) throw new Error('real PostgreSQL setup failed');
      const seedRepo = openRepo();
      const { accountId, session } = await readySession(seedRepo);
      const applicationName = `session-owner-claim-${randomUUID()}`;
      const contenders = Array.from({ length: 9 }, () => openRepo(applicationName));
      const blocker = await admin.reserve();
      let transactionOpen = false;
      let claims: Promise<
        Awaited<ReturnType<DrizzleSessionRepo['claimSessionOperation']>>[]
      > | null = null;
      try {
        await blocker`BEGIN`;
        transactionOpen = true;
        await blocker`SELECT id FROM sessions WHERE id = ${session.id} FOR UPDATE`;

        claims = Promise.all(
          contenders.map((repo) => repo.claimSessionOperation(session.id, accountId)),
        );
        void claims.catch(() => {});
        expect(await waitForLockWaiters(applicationName, contenders.length)).toBe(
          contenders.length,
        );

        await blocker`COMMIT`;
        transactionOpen = false;
        const outcomes = await claims;
        expect(outcomes.filter((outcome) => outcome.kind === 'claimed')).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.kind === 'conflict')).toHaveLength(8);
        expect(
          outcomes
            .filter((outcome) => outcome.kind === 'conflict')
            .map((outcome) => (outcome.kind === 'conflict' ? outcome.status : null)),
        ).toEqual(Array(8).fill('busy'));

        const winner = outcomes.find((outcome) => outcome.kind === 'claimed');
        if (!winner || winner.kind !== 'claimed') throw new Error('operation owner missing');
        await expect(
          seedRepo.settleSessionOperation({
            id: session.id,
            accountId,
            driverSessionId: winner.session.driverSessionId,
          }),
        ).resolves.toBe(true);
        await expect(seedRepo.claimSessionOperation(session.id, accountId)).resolves.toMatchObject({
          kind: 'claimed',
          session: { status: 'busy' },
        });
      } finally {
        if (transactionOpen) await blocker`ROLLBACK`.catch(() => {});
        await claims?.catch(() => {});
        blocker.release();
      }
    });

    it('makes close-first hold the row lock and defeat both success and failure settlement', async () => {
      if (!dbReachable) throw new Error('real PostgreSQL setup failed');
      for (const settlement of ['success', 'failure'] as const) {
        const ownerRepo = openRepo();
        const closeRepo = openRepo();
        const settlingApplicationName = `session-owner-settle-${randomUUID()}`;
        const settlingRepo = openRepo(settlingApplicationName);
        const { accountId, session } = await readySession(ownerRepo);
        await expect(ownerRepo.claimSessionOperation(session.id, accountId)).resolves.toMatchObject(
          {
            kind: 'claimed',
          },
        );

        let closeEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
          closeEntered = resolve;
        });
        let releaseClose!: () => void;
        const closeGate = new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
        let closeCalls = 0;
        const close = closeRepo.destroySessionSerialized(
          {
            id: session.id,
            accountId,
            destroyedAt: new Date('2026-07-17T19:00:00.000Z'),
            event: { type: 'destroyed', payload: null, durationMs: null },
          },
          async () => {
            closeCalls += 1;
            closeEntered();
            await closeGate;
          },
        );
        void close.catch(() => {});
        let settle: Promise<
          boolean | Awaited<ReturnType<typeof settlingRepo.failSessionOperation>>
        > | null = null;
        let closeReleased = false;
        const release = (): void => {
          if (closeReleased) return;
          closeReleased = true;
          releaseClose();
        };
        try {
          await entered;
          settle =
            settlement === 'success'
              ? settlingRepo.settleSessionOperation({
                  id: session.id,
                  accountId,
                  driverSessionId: session.driverSessionId,
                })
              : settlingRepo.failSessionOperation({
                  id: session.id,
                  accountId,
                  driverSessionId: session.driverSessionId,
                  erroredAt: new Date('2026-07-17T19:00:01.000Z'),
                });
          void settle.catch(() => {});
          expect(await waitForLockWaiters(settlingApplicationName, 1)).toBe(1);
          release();

          await expect(close).resolves.toMatchObject({ kind: 'destroyed' });
          if (settlement === 'success') await expect(settle).resolves.toBe(false);
          else await expect(settle).resolves.toBeNull();
          expect(closeCalls).toBe(1);
          expect(await destroyedEventCount(session.id)).toBe(1);
          await expect(ownerRepo.findSession(session.id, accountId)).resolves.toMatchObject({
            status: 'destroyed',
          });
        } finally {
          release();
          await Promise.allSettled([close, ...(settle === null ? [] : [settle])]);
        }
      }
    });

    it('makes a failure-first election terminal and leaves later serialized close inert', async () => {
      if (!dbReachable) throw new Error('real PostgreSQL setup failed');
      const ownerRepo = openRepo();
      const closeRepo = openRepo();
      const { accountId, session } = await readySession(ownerRepo);
      await ownerRepo.claimSessionOperation(session.id, accountId);
      await expect(
        ownerRepo.failSessionOperation({
          id: session.id,
          accountId,
          driverSessionId: session.driverSessionId,
          erroredAt: new Date('2026-07-17T19:01:00.000Z'),
        }),
      ).resolves.toMatchObject({ status: 'errored' });

      let closeCalls = 0;
      await expect(
        closeRepo.destroySessionSerialized(
          {
            id: session.id,
            accountId,
            destroyedAt: new Date('2026-07-17T19:01:01.000Z'),
            event: { type: 'destroyed', payload: null, durationMs: null },
          },
          () => {
            closeCalls += 1;
            return Promise.resolve();
          },
        ),
      ).resolves.toMatchObject({ kind: 'already_terminal', session: { status: 'errored' } });
      expect(closeCalls).toBe(0);
      expect(await destroyedEventCount(session.id)).toBe(0);
    });

    it('classifies scoped outcomes and keeps state timestamps monotonic without releasing busy', async () => {
      if (!dbReachable) throw new Error('real PostgreSQL setup failed');
      const repo = openRepo();
      const { accountId, session } = await readySession(repo);
      await expect(repo.claimSessionOperation(session.id, randomUUID())).resolves.toEqual({
        kind: 'not_found',
      });
      await expect(repo.claimSessionOperation(randomUUID(), accountId)).resolves.toEqual({
        kind: 'not_found',
      });

      const creatingAccount = await seedAccountWithKey();
      const creating = await repo.insertSession(
        sessionInput(creatingAccount.accountId, creatingAccount.apiKeyId),
      );
      await expect(
        repo.claimSessionOperation(creating.id, creatingAccount.accountId),
      ).resolves.toEqual({ kind: 'conflict', status: 'creating' });

      const claimed = await repo.claimSessionOperation(session.id, accountId);
      expect(claimed).toMatchObject({ kind: 'claimed', session: { status: 'busy' } });
      await expect(repo.claimSessionOperation(session.id, accountId)).resolves.toEqual({
        kind: 'conflict',
        status: 'busy',
      });

      const wrongDriverSessionId = `drv_wrong_${randomUUID()}`;
      await expect(
        repo.settleSessionOperation({
          id: session.id,
          accountId,
          driverSessionId: wrongDriverSessionId,
        }),
      ).resolves.toBe(false);
      await expect(
        repo.failSessionOperation({
          id: session.id,
          accountId,
          driverSessionId: wrongDriverSessionId,
          erroredAt: new Date('2026-07-17T19:02:00.000Z'),
        }),
      ).resolves.toBeNull();
      await repo.touchSessionLastStateAt({
        id: session.id,
        accountId,
        driverSessionId: wrongDriverSessionId,
        lastStateAt: new Date('2026-07-17T19:02:03.000Z'),
      });
      await repo.updateSessionStatus(session.id, 'ready', {
        lastStateAt: new Date('2026-07-17T19:02:04.000Z'),
      });
      await expect(repo.findSession(session.id, accountId)).resolves.toMatchObject({
        status: 'busy',
        lastStateAt: null,
      });

      const newer = new Date('2026-07-17T19:02:02.000Z');
      const older = new Date('2026-07-17T19:02:01.000Z');
      await repo.touchSessionLastStateAt({
        id: session.id,
        accountId,
        driverSessionId: session.driverSessionId,
        lastStateAt: newer,
      });
      await repo.touchSessionLastStateAt({
        id: session.id,
        accountId,
        driverSessionId: session.driverSessionId,
        lastStateAt: older,
      });
      await expect(repo.findSession(session.id, accountId)).resolves.toMatchObject({
        status: 'busy',
        lastStateAt: newer,
      });
      await expect(
        repo.settleSessionOperation({
          id: session.id,
          accountId,
          driverSessionId: session.driverSessionId,
        }),
      ).resolves.toBe(true);
      const destroyedAt = new Date('2026-07-17T19:02:05.000Z');
      await repo.updateSessionStatus(session.id, 'destroyed', { destroyedAt });
      await expect(repo.claimSessionOperation(session.id, accountId)).resolves.toMatchObject({
        kind: 'terminal',
        session: { status: 'destroyed', destroyedAt },
      });
    });
  },
);

// Real-Postgres proof that every session-destroy source shares one row-lock
// winner. The callback stands in for the bounded, idempotent driver teardown;
// only the transaction holding the row lock may invoke it. The terminal update
// and destroyed event commit together on success. A driver error still commits
// the terminal slot release, but never records a successful destroyed event.

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

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededAccountIds: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 8 });
  try {
    await client`SELECT 1 FROM session_events LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const accountId of seededAccountIds) {
    await client`DELETE FROM sessions WHERE account_id = ${accountId}`.catch(() => {});
    await client`DELETE FROM api_keys WHERE account_id = ${accountId}`.catch(() => {});
    await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

async function seedAccountWithKey(): Promise<{ accountId: string; apiKeyId: string }> {
  if (!client) throw new Error('real PostgreSQL setup failed');
  const accountId = randomUUID();
  const apiKeyId = randomUUID();
  seededAccountIds.push(accountId);
  await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`destroy-race-${accountId}@test.local`})`;
  await client`
    INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
    VALUES (
      ${apiKeyId},
      ${accountId},
      'destroy-race',
      ${`destroy_${accountId.slice(0, 8)}`},
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

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'serialized session destroy (Drizzle path, real Postgres)',
  () => {
    it('elects one callback/event/timestamp winner across five customer/admin contenders', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });
      const { accountId, apiKeyId } = await seedAccountWithKey();
      const session = await repo.insertSession(sessionInput(accountId, apiKeyId));
      await repo.updateSessionStatus(session.id, 'ready');
      let driverCalls = 0;
      const candidateTimes = Array.from(
        { length: 5 },
        (_, index) => new Date(Date.UTC(2026, 6, 14, 13, 0, 0, index)),
      );

      const outcomes = await Promise.all(
        candidateTimes.map((destroyedAt, index) =>
          repo.destroySessionSerialized(
            {
              id: session.id,
              // Alternate customer-scoped and explicit admin-unscoped callers.
              accountId: index % 2 === 0 ? accountId : null,
              destroyedAt,
              event: {
                type: 'destroyed',
                payload: { contender: index },
                durationMs: null,
              },
            },
            async () => {
              driverCalls += 1;
              await sleep(25);
            },
          ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.kind === 'destroyed')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.kind === 'already_terminal')).toHaveLength(4);
      expect(driverCalls).toBe(1);
      const persistedTimes = outcomes.flatMap((outcome) =>
        outcome.kind === 'not_found' || outcome.session.destroyedAt === null
          ? []
          : [outcome.session.destroyedAt.toISOString()],
      );
      expect(persistedTimes).toHaveLength(5);
      expect(new Set(persistedTimes).size).toBe(1);

      const [stored] = await client`
        SELECT status, destroyed_at
          FROM sessions
         WHERE id = ${session.id}
      `;
      expect(stored?.status).toBe('destroyed');
      expect(new Date(String(stored?.destroyed_at)).toISOString()).toBe(persistedTimes[0]);
      const [eventCount] = await client`
        SELECT count(*)::int AS count
          FROM session_events
         WHERE session_id = ${session.id}
           AND type = 'destroyed'
      `;
      expect(eventCount?.count).toBe(1);
    });

    it('commits terminal release without a success event on driver error; retry is inert', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });
      const { accountId, apiKeyId } = await seedAccountWithKey();
      const session = await repo.insertSession(sessionInput(accountId, apiKeyId));
      await repo.updateSessionStatus(session.id, 'ready');
      const driverError = new Error('bounded teardown failed');

      const failed = await repo.destroySessionSerialized(
        {
          id: session.id,
          accountId,
          destroyedAt: new Date('2026-07-14T13:01:00.000Z'),
          event: { type: 'destroyed', payload: null, durationMs: null },
        },
        () => Promise.reject(driverError),
      );

      expect(failed.kind).toBe('driver_error');
      if (failed.kind !== 'driver_error') throw new Error('driver failure was not preserved');
      expect(failed.error).toBe(driverError);
      expect(failed.session.status).toBe('destroyed');
      const [eventCount] = await client`
        SELECT count(*)::int AS count
          FROM session_events
         WHERE session_id = ${session.id}
           AND type = 'destroyed'
      `;
      expect(eventCount?.count).toBe(0);

      let retryDriverCalls = 0;
      const retry = await repo.destroySessionSerialized(
        {
          id: session.id,
          accountId,
          destroyedAt: new Date('2026-07-14T13:02:00.000Z'),
          event: { type: 'destroyed', payload: null, durationMs: null },
        },
        () => {
          retryDriverCalls += 1;
          return Promise.resolve();
        },
      );
      expect(retry.kind).toBe('already_terminal');
      expect(retryDriverCalls).toBe(0);
    });

    it('fails closed for the wrong customer account without invoking the callback', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });
      const { accountId, apiKeyId } = await seedAccountWithKey();
      const session = await repo.insertSession(sessionInput(accountId, apiKeyId));
      let driverCalls = 0;

      const result = await repo.destroySessionSerialized(
        {
          id: session.id,
          accountId: randomUUID(),
          destroyedAt: new Date(),
          event: { type: 'destroyed', payload: null, durationMs: null },
        },
        () => {
          driverCalls += 1;
          return Promise.resolve();
        },
      );

      expect(result).toEqual({ kind: 'not_found' });
      expect(driverCalls).toBe(0);
      expect((await repo.findSession(session.id, accountId))?.status).toBe('creating');
    });
  },
);

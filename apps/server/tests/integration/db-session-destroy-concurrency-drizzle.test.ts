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

    it('keeps a destroy-winning reservation terminal and makes the blocked activation CAS lose', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });
      const { accountId, apiKeyId } = await seedAccountWithKey();
      const reservationDriverSessionId = `reserving:${randomUUID()}`;
      const realDriverSessionId = `drv_real_${randomUUID()}`;
      const session = await repo.insertSession({
        ...sessionInput(accountId, apiKeyId),
        driverSessionId: reservationDriverSessionId,
      });

      let signalDestroyEntered!: () => void;
      const destroyEntered = new Promise<void>((resolve) => {
        signalDestroyEntered = resolve;
      });
      let releaseDestroy!: () => void;
      const destroyRelease = new Promise<void>((resolve) => {
        releaseDestroy = resolve;
      });
      const destroyPromise = repo.destroySessionSerialized(
        {
          id: session.id,
          accountId,
          destroyedAt: new Date('2026-07-14T23:37:00.000Z'),
          event: { type: 'destroyed', payload: { source: 'race-proof' }, durationMs: null },
        },
        async (locked) => {
          // Destroy acquired row authority before create could activate, so it
          // sees only the exact placeholder. The service later cleans up the
          // real worker by its newly-returned id.
          expect(locked.driverSessionId).toBe(reservationDriverSessionId);
          signalDestroyEntered();
          await destroyRelease;
        },
      );
      await destroyEntered;

      let activationSettled = false;
      const activationPromise = repo
        .activateSessionReservation({
          id: session.id,
          reservationDriverSessionId,
          driverSessionId: realDriverSessionId,
        })
        .finally(() => {
          activationSettled = true;
        });
      // The activation UPDATE must wait behind destroy's row lock, not observe
      // or overwrite an uncommitted transition.
      await sleep(20);
      expect(activationSettled).toBe(false);
      releaseDestroy();

      const [destroyed, activated] = await Promise.all([destroyPromise, activationPromise]);
      expect(destroyed.kind).toBe('destroyed');
      expect(activated).toBeNull();
      const [stored] = await client`
        SELECT status, driver_session_id, destroyed_at
          FROM sessions
         WHERE id = ${session.id}
      `;
      expect(stored?.status).toBe('destroyed');
      expect(stored?.driver_session_id).toBe(reservationDriverSessionId);
      expect(stored?.destroyed_at).not.toBeNull();
      const [eventCount] = await client`
        SELECT count(*)::int AS count
          FROM session_events
         WHERE session_id = ${session.id}
           AND type = 'destroyed'
      `;
      expect(eventCount?.count).toBe(1);
    });

    it('commits real driver id + ready atomically when activation wins, so later destroy targets the real worker', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });
      const { accountId, apiKeyId } = await seedAccountWithKey();
      const reservationDriverSessionId = `reserving:${randomUUID()}`;
      const realDriverSessionId = `drv_real_${randomUUID()}`;
      const session = await repo.insertSession({
        ...sessionInput(accountId, apiKeyId),
        driverSessionId: reservationDriverSessionId,
      });

      const activated = await repo.activateSessionReservation({
        id: session.id,
        reservationDriverSessionId,
        driverSessionId: realDriverSessionId,
      });
      expect(activated).toMatchObject({ status: 'ready', driverSessionId: realDriverSessionId });

      let destroyedDriverSessionId: string | null = null;
      const destroyed = await repo.destroySessionSerialized(
        {
          id: session.id,
          accountId,
          destroyedAt: new Date('2026-07-14T23:38:00.000Z'),
          event: { type: 'destroyed', payload: null, durationMs: null },
        },
        (locked) => {
          destroyedDriverSessionId = locked.driverSessionId;
          return Promise.resolve();
        },
      );
      expect(destroyed.kind).toBe('destroyed');
      expect(destroyedDriverSessionId).toBe(realDriverSessionId);
    });

    it('projects direct event and serialized-destroy callers before durable write or browser teardown', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });
      const { accountId, apiKeyId } = await seedAccountWithKey();
      const sentinel = 'PRIVATE_DB_EVENT_4b7d31';
      const session = await repo.insertSession(sessionInput(accountId, apiKeyId));
      await repo.updateSessionStatus(session.id, 'ready');

      await repo.recordEvent({
        sessionId: session.id,
        type: 'navigated',
        payload: {
          url: `https://user:${sentinel}@customer.example/private/${sentinel}`,
          final_url: `https://customer.example/final?token=${sentinel}`,
          status: 200,
          extension: sentinel,
        },
        durationMs: 12,
      });

      let destroyCalls = 0;
      await expect(
        repo.destroySessionSerialized(
          {
            id: session.id,
            accountId,
            destroyedAt: new Date('2026-07-17T12:00:00.000Z'),
            event: {
              type: 'destroyed',
              payload: { reason: sentinel, detail: sentinel },
              durationMs: null,
            },
          },
          () => {
            destroyCalls += 1;
            return Promise.resolve();
          },
        ),
      ).resolves.toMatchObject({ kind: 'destroyed' });
      expect(destroyCalls).toBe(1);

      const stored = (await client`
        SELECT type, payload, duration_ms
          FROM session_events
         WHERE session_id = ${session.id}
         ORDER BY type
      `) as Array<{ type: string; payload: Record<string, unknown>; duration_ms: number | null }>;
      expect(stored).toHaveLength(2);
      expect(stored.find((event) => event.type === 'navigated')).toEqual({
        type: 'navigated',
        payload: {
          requested_origin: 'https://customer.example',
          final_origin: 'https://customer.example',
          status: 200,
        },
        duration_ms: 12,
      });
      expect(stored.find((event) => event.type === 'destroyed')).toEqual({
        type: 'destroyed',
        payload: {
          reason_code: 'unspecified',
          auto_destroyed: false,
          by_admin: false,
          max_session_minutes: null,
        },
        duration_ms: null,
      });
      expect(JSON.stringify(stored)).not.toContain(sentinel);
    });

    it('rejects an unknown direct destroy event before external teardown and row mutation', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });
      const { accountId, apiKeyId } = await seedAccountWithKey();
      const session = await repo.insertSession(sessionInput(accountId, apiKeyId));
      await repo.updateSessionStatus(session.id, 'ready');
      let destroyCalls = 0;

      await expect(
        repo.destroySessionSerialized(
          {
            id: session.id,
            accountId,
            destroyedAt: new Date('2026-07-17T12:01:00.000Z'),
            event: {
              type: 'future_secret_event',
              payload: { secret: 'must-not-persist' },
              durationMs: null,
            } as never,
          },
          () => {
            destroyCalls += 1;
            return Promise.resolve();
          },
        ),
      ).rejects.toThrow('Unknown session event type.');
      expect(destroyCalls).toBe(0);
      expect(await repo.findSession(session.id, accountId)).toMatchObject({
        status: 'ready',
        destroyedAt: null,
      });
    });
  },
);

// Durable direct-operation fences against real Postgres (slice 1 of
// docs/internal/durable-direct-operation-design.md).
//
// These fences exist because a direct login runs to a 600,000 ms producer wall
// that no default public path survives, so the customer's connection WILL drop
// mid-flight and they WILL retry. Every assertion here is about what must not
// happen when they do: no second credential submission, no two live operations
// on one session, no late worker overwriting a settled outcome or mutating a
// successor session that reused the driver id.
//
// Asserted against Postgres rather than a fake, deliberately. All three fences
// ARE database objects — two partial unique indexes and a compare-and-set — and
// a fake that agrees with the repository proves nothing about whether the index
// exists or its predicate is right.

import { randomUUID, createHash } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleSessionOperationsRepo } from '../../src/db/session-operations-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/** The producer wall the design forbids the API from re-inventing. */
const PRODUCER_DEADLINE_MS = 600_000;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededAccounts: string[] = [];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM session_operations LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
});

afterAll(async () => {
  if (client) {
    for (const accountId of seededAccounts) {
      await client`DELETE FROM session_operations WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM api_keys WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

/** One account + api key + session, torn down in afterAll. */
async function seedSession(): Promise<{ accountId: string; sessionId: string }> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  seededAccounts.push(accountId);
  await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`session-op-${accountId}@test.local`})`;
  const apiKeyId = randomUUID();
  await client`
    INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
    VALUES (${apiKeyId}, ${accountId}, 'session-operations-fence-test', ${`ds_t_${accountId.slice(0, 6)}`}, ${sha256(apiKeyId)})`;
  const sessionId = randomUUID();
  await client`
    INSERT INTO sessions (id, account_id, api_key_id, driver_session_id)
    VALUES (${sessionId}, ${accountId}, ${apiKeyId}, ${`drv_${sessionId}`})`;
  return { accountId, sessionId };
}

function repoOf(): DrizzleSessionOperationsRepo {
  if (!client) throw new Error('no client');
  const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return new DrizzleSessionOperationsRepo({ client, db, close: async () => {} });
}

function admitArgs(
  accountId: string,
  sessionId: string,
  overrides: Partial<{
    driverIncarnationId: string;
    idempotencyKeyHash: string | null;
    requestFingerprint: string;
  }> = {},
): Parameters<DrizzleSessionOperationsRepo['admit']>[0] {
  return {
    accountId,
    sessionId,
    driverIncarnationId: overrides.driverIncarnationId ?? randomUUID(),
    kind: 'login',
    idempotencyKeyHash:
      overrides.idempotencyKeyHash === undefined ? null : overrides.idempotencyKeyHash,
    requestFingerprint: overrides.requestFingerprint ?? sha256('body-a'),
    deadlineAt: new Date(Date.now() + PRODUCER_DEADLINE_MS),
  };
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'session-operation fences against real Postgres',
  () => {
    it('CRITICAL FENCE 1 — concurrent admissions on ONE session produce exactly one operation. Two live operations would mean two credential submissions racing on the same browser.', async () => {
      if (!dbReachable || !client) return;
      const repo = repoOf();
      const { accountId, sessionId } = await seedSession();

      const results = await Promise.all(
        Array.from({ length: 8 }, () => repo.admit(admitArgs(accountId, sessionId))),
      );

      expect(results.filter((r) => r.kind === 'admitted')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'session_busy')).toHaveLength(7);
      const [{ count }] = await client`
        SELECT count(*)::int AS count FROM session_operations WHERE session_id = ${sessionId}`;
      expect(count).toBe(1);
    });

    it('CRITICAL FENCE 1 — the exclusion is on LIVE operations only, so a session can run another operation once the first settles, and its history is unbounded.', async () => {
      if (!dbReachable || !client) return;
      const repo = repoOf();
      const { accountId, sessionId } = await seedSession();

      for (let i = 0; i < 3; i += 1) {
        const admitted = await repo.admit(admitArgs(accountId, sessionId));
        expect(admitted.kind).toBe('admitted');
        if (admitted.kind !== 'admitted') return;
        const settled = await repo.settle({
          id: admitted.operation.id,
          driverIncarnationId: admitted.operation.driverIncarnationId,
          status: 'cancelled',
          settledAt: new Date(),
          resultExpiresAt: null,
        });
        expect(settled.kind).toBe('settled');
      }

      const [{ count }] = await client`
        SELECT count(*)::int AS count FROM session_operations WHERE session_id = ${sessionId}`;
      expect(count).toBe(3);
    });

    it('CRITICAL FENCE 2 — a retry with the same Idempotency-Key returns the SAME operation and creates no second row. This is the fence that makes retrying after a dropped connection safe.', async () => {
      if (!dbReachable || !client) return;
      const repo = repoOf();
      const { accountId, sessionId } = await seedSession();
      const key = sha256('customer-retry-key');

      const first = await repo.admit(admitArgs(accountId, sessionId, { idempotencyKeyHash: key }));
      expect(first.kind).toBe('admitted');
      const retry = await repo.admit(admitArgs(accountId, sessionId, { idempotencyKeyHash: key }));

      expect(retry.kind).toBe('replayed');
      if (first.kind !== 'admitted' || retry.kind !== 'replayed') return;
      expect(retry.operation.id).toBe(first.operation.id);
      const [{ count }] = await client`
        SELECT count(*)::int AS count FROM session_operations WHERE account_id = ${accountId}`;
      expect(count).toBe(1);
    });

    it('CRITICAL FENCE 2 in ISOLATION — a retry AFTER the first operation settled still replays instead of submitting the credentials a second time. This is the case that actually exercises the idempotency index: while the first operation is live, fence 1 blocks the insert on its own, so the test above would still pass with the idempotency index dropped. Verified by dropping it — only this case reds.', async () => {
      if (!dbReachable || !client) return;
      const repo = repoOf();
      const { accountId, sessionId } = await seedSession();
      const key = sha256('key-reused-after-completion');

      const first = await repo.admit(admitArgs(accountId, sessionId, { idempotencyKeyHash: key }));
      if (first.kind !== 'admitted') throw new Error('expected admitted');
      await repo.settle({
        id: first.operation.id,
        driverIncarnationId: first.operation.driverIncarnationId,
        status: 'succeeded',
        result: { submitted: true, logged_in: true },
        settledAt: new Date(),
        resultExpiresAt: null,
      });

      // The session is free again, so fence 1 cannot help here. Only the
      // account-scoped idempotency index stops a second login being submitted.
      const retry = await repo.admit(admitArgs(accountId, sessionId, { idempotencyKeyHash: key }));

      expect(retry.kind).toBe('replayed');
      if (retry.kind !== 'replayed') return;
      expect(retry.operation.id).toBe(first.operation.id);
      expect(retry.operation.status).toBe('succeeded');
      const [{ count }] = await client`
        SELECT count(*)::int AS count FROM session_operations WHERE account_id = ${accountId}`;
      expect(count).toBe(1);
    });

    it('CRITICAL FENCE 2 — the same key with a DIFFERENT body is a conflict, never a silent replay of the wrong request. Returning the first result for a second, different login would report the wrong outcome.', async () => {
      if (!dbReachable || !client) return;
      const repo = repoOf();
      const { accountId, sessionId } = await seedSession();
      const key = sha256('reused-key');

      await repo.admit(
        admitArgs(accountId, sessionId, {
          idempotencyKeyHash: key,
          requestFingerprint: sha256('body-a'),
        }),
      );
      const reused = await repo.admit(
        admitArgs(accountId, sessionId, {
          idempotencyKeyHash: key,
          requestFingerprint: sha256('body-b'),
        }),
      );

      expect(reused.kind).toBe('idempotency_key_reused');
    });

    it('FENCE 2 is account-scoped — one customer’s key can never collide with another’s', async () => {
      if (!dbReachable) return;
      const repo = repoOf();
      const a = await seedSession();
      const b = await seedSession();
      const sharedKey = sha256('a-key-both-customers-happened-to-pick');

      const first = await repo.admit(
        admitArgs(a.accountId, a.sessionId, { idempotencyKeyHash: sharedKey }),
      );
      const second = await repo.admit(
        admitArgs(b.accountId, b.sessionId, { idempotencyKeyHash: sharedKey }),
      );

      expect(first.kind).toBe('admitted');
      expect(second.kind).toBe('admitted');
    });

    it('CRITICAL FENCE 3 — a result from a SUPERSEDED driver incarnation is discarded, not applied. Driver ids are reused across restarts, so without this a late result would settle a successor session’s operation.', async () => {
      if (!dbReachable) return;
      const repo = repoOf();
      const { accountId, sessionId } = await seedSession();
      const incarnation = randomUUID();

      const admitted = await repo.admit(
        admitArgs(accountId, sessionId, { driverIncarnationId: incarnation }),
      );
      if (admitted.kind !== 'admitted') throw new Error('expected admitted');
      await repo.markRunning(admitted.operation.id, incarnation);

      const late = await repo.settle({
        id: admitted.operation.id,
        driverIncarnationId: randomUUID(), // a DIFFERENT driver lifetime
        status: 'succeeded',
        result: { submitted: true, logged_in: true },
        settledAt: new Date(),
        resultExpiresAt: null,
      });

      expect(late.kind).toBe('superseded');
      const still = await repo.getForAccount(accountId, admitted.operation.id);
      expect(still?.status).toBe('running');
      expect(still?.result).toBeNull();
    });

    it('CRITICAL FENCE 3 — terminal is terminal: exactly one settle wins even when many race, and the losers do not overwrite the winner.', async () => {
      if (!dbReachable) return;
      const repo = repoOf();
      const { accountId, sessionId } = await seedSession();
      const incarnation = randomUUID();
      const admitted = await repo.admit(
        admitArgs(accountId, sessionId, { driverIncarnationId: incarnation }),
      );
      if (admitted.kind !== 'admitted') throw new Error('expected admitted');
      await repo.markRunning(admitted.operation.id, incarnation);

      const settles = await Promise.all(
        Array.from({ length: 6 }, (_unused, i) =>
          repo.settle({
            id: admitted.operation.id,
            driverIncarnationId: incarnation,
            status: 'succeeded',
            result: { submitted: true, writer: i },
            settledAt: new Date(),
            resultExpiresAt: null,
          }),
        ),
      );

      expect(settles.filter((s) => s.kind === 'settled')).toHaveLength(1);
      expect(settles.filter((s) => s.kind === 'superseded')).toHaveLength(5);

      // And a later failure cannot reopen or rewrite the settled outcome.
      const afterwards = await repo.settle({
        id: admitted.operation.id,
        driverIncarnationId: incarnation,
        status: 'failed',
        error: { type: 'https://errors.driftstack.dev/driver-contract-violation' },
        settledAt: new Date(),
        resultExpiresAt: null,
      });
      expect(afterwards.kind).toBe('superseded');
      const final = await repo.getForAccount(accountId, admitted.operation.id);
      expect(final?.status).toBe('succeeded');
      expect(final?.error).toBeNull();
    });

    it('CRITICAL cross-account reads return nothing — the same answer as an id that never existed, so a 404 cannot be distinguished from a 403 and existence is never confirmed.', async () => {
      if (!dbReachable) return;
      const repo = repoOf();
      const owner = await seedSession();
      const stranger = await seedSession();
      const admitted = await repo.admit(admitArgs(owner.accountId, owner.sessionId));
      if (admitted.kind !== 'admitted') throw new Error('expected admitted');

      await expect(
        repo.getForAccount(stranger.accountId, admitted.operation.id),
      ).resolves.toBeNull();
      await expect(
        repo.getForAccount(owner.accountId, admitted.operation.id),
      ).resolves.not.toBeNull();
      await expect(repo.getForAccount(owner.accountId, randomUUID())).resolves.toBeNull();
    });

    it('retention drops the payload and KEEPS the status, so an expired result still answers "did my login succeed?"', async () => {
      if (!dbReachable) return;
      const repo = repoOf();
      const { accountId, sessionId } = await seedSession();
      const incarnation = randomUUID();
      const admitted = await repo.admit(
        admitArgs(accountId, sessionId, { driverIncarnationId: incarnation }),
      );
      if (admitted.kind !== 'admitted') throw new Error('expected admitted');
      const settledAt = new Date(Date.now() - 60_000);
      await repo.settle({
        id: admitted.operation.id,
        driverIncarnationId: incarnation,
        status: 'succeeded',
        result: { submitted: true, logged_in: true },
        settledAt,
        resultExpiresAt: new Date(settledAt.getTime() + 1_000),
      });

      expect(await repo.purgeExpiredResults(new Date())).toBeGreaterThanOrEqual(1);
      const purged = await repo.getForAccount(accountId, admitted.operation.id);
      expect(purged?.status).toBe('succeeded');
      expect(purged?.result).toBeNull();
      expect(purged?.settledAt).not.toBeNull();
    });

    describe('the database rejects states the repository must never be able to write', () => {
      it('CRITICAL refuses a terminal row with no settled_at, and a live row carrying a result. These CHECKs are what make "unsettled success" unrepresentable rather than merely unwritten.', async () => {
        if (!dbReachable || !client) return;
        const { accountId, sessionId } = await seedSession();
        const base = {
          accountId,
          sessionId,
          incarnation: randomUUID(),
          fingerprint: sha256('body'),
          deadline: new Date(Date.now() + PRODUCER_DEADLINE_MS).toISOString(),
        };

        await expect(
          client`INSERT INTO session_operations
            (account_id, session_id, driver_incarnation_id, kind, status, request_fingerprint, deadline_at)
            VALUES (${base.accountId}, ${base.sessionId}, ${base.incarnation}, 'login', 'succeeded', ${base.fingerprint}, ${base.deadline})`,
        ).rejects.toThrow(/session_operations_terminal_shape/);

        await expect(
          client`INSERT INTO session_operations
            (account_id, session_id, driver_incarnation_id, kind, status, request_fingerprint, deadline_at, result)
            VALUES (${base.accountId}, ${base.sessionId}, ${base.incarnation}, 'login', 'running', ${base.fingerprint}, ${base.deadline}, ${JSON.stringify({ submitted: true })}::jsonb)`,
        ).rejects.toThrow(/session_operations_terminal_shape/);

        await expect(
          client`INSERT INTO session_operations
            (account_id, session_id, driver_incarnation_id, kind, status, request_fingerprint, deadline_at)
            VALUES (${base.accountId}, ${base.sessionId}, ${base.incarnation}, 'navigate', 'queued', ${base.fingerprint}, ${base.deadline})`,
        ).rejects.toThrow(/session_operations_kind/);

        await expect(
          client`INSERT INTO session_operations
            (account_id, session_id, driver_incarnation_id, kind, status, request_fingerprint, deadline_at)
            VALUES (${base.accountId}, ${base.sessionId}, ${base.incarnation}, 'login', 'queued', 'not-a-sha256', ${base.deadline})`,
        ).rejects.toThrow(/session_operations_request_fingerprint_shape/);
      });
    });
  },
);

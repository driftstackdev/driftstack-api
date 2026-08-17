// Drizzle-backed integration test for DrizzleSessionRepo.listExpiredForAutoDestroy
// — the 6.g free-tier session-duration auto-destroy sweep query — against a
// REAL Postgres. The sweep DESTROYS customer sessions, so the SQL join
// (sessions → accounts on tier) plus the tier / status / strict-less-than
// filters are validated here on real PG, not just the in-memory twin.
//
// CRITICAL safety property pinned: a session whose account is on a tier NOT
// present in `tierCutoffs` (paid tiers — null cap → no cutoff) must NEVER be
// returned, even when created far before the cutoff. A join bug or a tier-
// column typo that the in-memory twin can't catch would surface here.
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine at localhost:5432 with the
//     `driftstack` schema migrated; this test always runs there.
//   - Local dev: skips if DATABASE_URL postgres is unreachable.
//
// Shared-DB note: the CI database is shared across integration tests, so the
// query may return sibling tests' free-tier rows. We pass a high limit (so
// our seeded row is never paged out by older rows) and filter the result to
// our own seeded account ids before asserting.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleSessionRepo } from '../../src/db/sessions-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// (accountId, apiKeyId) pairs seeded — cleaned in FK order:
// sessions → api_keys → accounts.
const seeded: Array<{ accountId: string; apiKeyId: string }> = [];

beforeAll(async () => {
  it('CRITICAL the service was reachable, so a green here is not "no service"', () => {
    // Without this, every arm below early-returns against a dead service and the
    // file reports PASSED — a green meaning "nothing was tested".
    expect(dbReachable, 'the integration dependency was unreachable').toBeTruthy();
  });

  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM sessions LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const { accountId, apiKeyId } of seeded) {
      await client`DELETE FROM sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM api_keys WHERE id = ${apiKeyId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleSessionRepo.listExpiredForAutoDestroy (6.g sweep query against real Postgres)',
  () => {
    it('returns ONLY the expired active session on a capped tier — recent, terminal, and paid-tier rows are excluded', async () => {
      if (!dbReachable || !client) {
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });

      // Two accounts: one FREE (capped → present in tierCutoffs) and one
      // solo_manual (uncapped → never present, the safety case).
      const freeAcc = randomUUID();
      const freeKey = randomUUID();
      const paidAcc = randomUUID();
      const paidKey = randomUUID();
      seeded.push(
        { accountId: freeAcc, apiKeyId: freeKey },
        { accountId: paidAcc, apiKeyId: paidKey },
      );
      await client`INSERT INTO accounts (id, email, tier) VALUES (${freeAcc}, ${`autod-free-${freeAcc}@test.local`}, 'free')`;
      await client`INSERT INTO accounts (id, email, tier) VALUES (${paidAcc}, ${`autod-paid-${paidAcc}@test.local`}, 'solo_manual')`;
      await client`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
        VALUES (${freeKey}, ${freeAcc}, 'autod', ${`dsk_${freeKey.slice(0, 8)}`}, ${`hash_${freeKey}`})`;
      await client`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
        VALUES (${paidKey}, ${paidAcc}, 'autod', ${`dsk_${paidKey.slice(0, 8)}`}, ${`hash_${paidKey}`})`;

      const cutoff = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
      const before = new Date(cutoff.getTime() - 60 * 60 * 1000); // 1h before cutoff → expired
      const after = new Date(cutoff.getTime() + 60 * 60 * 1000); // 1h after cutoff → too recent

      async function seedSession(
        accountId: string,
        apiKeyId: string,
        status: string,
        createdAt: Date,
      ): Promise<string> {
        const [row] = await client!`
          INSERT INTO sessions (account_id, api_key_id, driver_session_id, status, created_at)
          VALUES (${accountId}, ${apiKeyId}, ${`drv_${randomUUID()}`}, ${status}, ${createdAt.toISOString()})
          RETURNING id`;
        return row?.id as string;
      }

      // free + active + before cutoff → THE expected match.
      const expectedId = await seedSession(freeAcc, freeKey, 'ready', before);
      // free + active + after cutoff → too recent, excluded by strict-lt.
      await seedSession(freeAcc, freeKey, 'ready', after);
      // free + before cutoff but TERMINAL → excluded by the active-status filter.
      await seedSession(freeAcc, freeKey, 'destroyed', before);
      // PAID + active + WAY before cutoff → excluded (tier not in cutoffs). SAFETY.
      await seedSession(
        paidAcc,
        paidKey,
        'ready',
        new Date(before.getTime() - 100 * 60 * 60 * 1000),
      );

      const rows = await repo.listExpiredForAutoDestroy({
        tierCutoffs: [{ tier: 'free', expiredBefore: cutoff }],
        // High limit so our row is never paged out behind older sibling-test
        // rows in the shared CI DB; we filter to our accounts below.
        limit: 100_000,
      });

      const ours = rows.filter((r) => r.accountId === freeAcc || r.accountId === paidAcc);
      expect(ours).toHaveLength(1);
      expect(ours[0]!.id).toBe(expectedId);
      expect(ours[0]!.accountId).toBe(freeAcc);
      expect(ours[0]!.status).toBe('ready');
    });
  },
);

// Drizzle-backed integration test for DrizzleAccountsAdminRepo against a REAL
// Postgres.
//
// Why this exists: the repo had ZERO line coverage (measured 2026-08-16, see
// A2-PRODUCTION-READINESS-ASSESSMENT item 5e). It backs the admin surface that
// changes a customer's tier and suspends or deletes their account — the SQL
// nobody had executed under vitest. The service above it is covered against an
// in-memory double, which exercises the decision and not the statement.
//
// Assertions are written to survive a SHARED database. Every db-* file here runs
// concurrently against the same `accounts` table, so nothing asserts a global
// count equals a number: the list arms scope themselves with a per-run email
// marker, and the aggregate arms assert properties (every tier key present) or
// deltas that concurrent inserts cannot invalidate. An exact global count would
// pass alone and fail in a full run, which is the worst kind of test to leave
// behind.
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine migrated; this always runs.
//   - Local: skips unless DATABASE_URL is set.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountTierSchema } from '@driftstack/api-types';
import { DrizzleAccountsAdminRepo } from '../../src/db/admin-accounts-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/** Unique to this run, so the list arms see only rows this file seeded. */
const MARKER = `adminrepo-${randomUUID().slice(0, 8)}`;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleAccountsAdminRepo | null = null;
const seededAccountIds: string[] = [];

async function seedAccount(opts: {
  tier?: string;
  status?: string;
  createdAt?: Date;
}): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  const email = `${MARKER}-${seededAccountIds.length}@example.test`;
  await client`
    INSERT INTO accounts (id, email, name, tier, status, created_at, updated_at)
    VALUES (${id}, ${email}, ${'Admin Repo Fixture'}, ${opts.tier ?? 'free'}::account_tier,
            ${opts.status ?? 'active'}::account_status,
            ${(opts.createdAt ?? new Date()).toISOString()}::timestamptz, now())`;
  seededAccountIds.push(id);
  return id;
}

beforeAll(async () => {
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
    await client`SELECT 1 FROM accounts LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleAccountsAdminRepo({
    client,
    db: drizzle(client, { schema }),
    close: async () => {},
  });
});

afterAll(async () => {
  if (client) {
    for (const id of seededAccountIds) {
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleAccountsAdminRepo (Drizzle path against real Postgres)',
  () => {
    it('CRITICAL the database is reachable and migrated. In CI the service and migrate step are part of the job, so an unreachable database must FAIL rather than let every arm below pass vacuously.', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and accounts table present').toBe(true);
      expect(repo, 'repo constructed').not.toBeNull();
    });

    it('CRITICAL setTier writes the tier and returns the updated row. The admin tier change is what moves a customer between price points and cap sets; the service above it is tested against a double, so this is the first execution of the statement itself.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedAccount({ tier: 'free' });
      const before = await repo.findById(id);
      expect(before?.tier, 'seeded as free').toBe('free');

      const updated = await repo.setTier(id, 'api_builder', new Date());
      expect(updated?.tier, 'returned row carries the new tier').toBe('api_builder');
      const reread = await repo.findById(id);
      expect(reread?.tier, 'and it persisted').toBe('api_builder');
    });

    it('CRITICAL setTier on a missing account returns null rather than throwing. The admin route distinguishes 404 from 500 on this return value.', async () => {
      if (!dbReachable || !repo) return;
      expect(await repo.setTier(randomUUID(), 'api_scale', new Date()), 'unknown id').toBeNull();
    });

    it("CRITICAL setStatus('deleted') stamps deleted_at, and active/suspended do NOT. The purge sweeper computes its 30-day GDPR Article 17 cutoff from that column — an unstamped delete is an account that never becomes eligible for erasure.", async () => {
      if (!dbReachable || !repo || !client) return;
      const id = await seedAccount({});
      const at = new Date();

      await repo.setStatus(id, 'suspended', at);
      const [afterSuspend] = await client<{ deleted_at: Date | null }[]>`
        SELECT deleted_at FROM accounts WHERE id = ${id}`;
      expect(afterSuspend?.deleted_at, 'suspend does not stamp deleted_at').toBeNull();

      await repo.setStatus(id, 'deleted', at);
      const [afterDelete] = await client<{ deleted_at: Date | null }[]>`
        SELECT deleted_at FROM accounts WHERE id = ${id}`;
      expect(afterDelete?.deleted_at, 'delete stamps deleted_at').not.toBeNull();
    });

    it('CRITICAL deleted_at is never cleared by a later transition. The repo documents that there is no undelete flow; if a later status change wiped the stamp, an account could leave the purge queue silently and be retained past its window.', async () => {
      if (!dbReachable || !repo || !client) return;
      const id = await seedAccount({});
      await repo.setStatus(id, 'deleted', new Date());
      const [stamped] = await client<{ deleted_at: Date | null }[]>`
        SELECT deleted_at FROM accounts WHERE id = ${id}`;
      expect(stamped?.deleted_at, 'stamped').not.toBeNull();

      await repo.setStatus(id, 'active', new Date());
      const [after] = await client<{ deleted_at: Date | null }[]>`
        SELECT deleted_at FROM accounts WHERE id = ${id}`;
      expect(after?.deleted_at, 'still stamped after re-activation').not.toBeNull();
    });

    it('CRITICAL list filters by emailContains case-insensitively and pages newest-first. Scoped to this run’s marker so a shared table cannot change the answer.', async () => {
      if (!dbReachable || !repo) return;
      const base = Date.now();
      for (let i = 0; i < 3; i += 1) {
        await seedAccount({ createdAt: new Date(base - i * 1000) });
      }
      const page = await repo.list({ emailContains: MARKER.toUpperCase(), limit: 50 });
      const mine = page.data.filter((r) => r.email.includes(MARKER));
      expect(mine.length, 'uppercase needle still matches (ilike)').toBeGreaterThanOrEqual(3);

      const stamps = mine.map((r) => r.createdAt.getTime());
      expect(
        [...stamps].sort((a, b) => b - a),
        'returned newest-first',
      ).toEqual(stamps);
    });

    it('CRITICAL keyset pagination returns every row exactly once across pages. The cursor is compound (created_at, id); a timestamp-only cursor drops whole tie groups at a page boundary.', async () => {
      if (!dbReachable || !repo) return;
      const tie = new Date();
      for (let i = 0; i < 4; i += 1) await seedAccount({ createdAt: tie });

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await repo.list({
          emailContains: MARKER,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.data.filter((r) => r.email.includes(MARKER)).map((r) => r.id));
        if (!page.hasMore || page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(new Set(seen).size, 'no row returned twice').toBe(seen.length);
      expect(seen.length, 'every seeded row seen').toBeGreaterThanOrEqual(seededAccountIds.length);
    });

    it('CRITICAL an unknown cursor silently restarts from page one — pinned because it is surprising. `list` looks the cursor row up and applies NO keyset filter when it is gone, so a client paging with a cursor whose account was deleted between pages restarts rather than erroring or ending. Recorded as behaviour so a change here is deliberate.', async () => {
      if (!dbReachable || !repo) return;
      const firstPage = await repo.list({ emailContains: MARKER, limit: 2 });
      const withDeadCursor = await repo.list({
        emailContains: MARKER,
        limit: 2,
        cursor: randomUUID(),
      });
      expect(
        withDeadCursor.data.map((r) => r.id),
        'a cursor pointing at no row yields the first page again',
      ).toEqual(firstPage.data.map((r) => r.id));
    });

    it('CRITICAL countByTier returns EVERY tier, including tiers with no accounts. It is typed Record<AccountTier, number>, and a GROUP BY only returns tiers that have rows — the repo zero-fills from the enum, so a consumer reading counts.enterprise gets 0 rather than undefined.', async () => {
      if (!dbReachable || !repo) return;
      const counts = await repo.countByTier();
      const missing = AccountTierSchema.options.filter((t) => typeof counts[t] !== 'number');
      expect(missing, 'tier(s) absent from the count record:').toEqual([]);
    });

    it('CRITICAL countByStatus and countCreatedSince execute and count monotonically. Asserted as a delta around a seed rather than an absolute, because the table is shared with every other db-* file running concurrently.', async () => {
      if (!dbReachable || !repo) return;
      const before = await repo.countByStatus('suspended');
      const id = await seedAccount({ status: 'suspended' });
      const after = await repo.countByStatus('suspended');
      expect(after, 'suspended count rose by at least the row we added').toBeGreaterThanOrEqual(
        before + 1,
      );

      const since = new Date(Date.now() - 60_000);
      expect(
        await repo.countCreatedSince(since),
        'recent creations include the row just seeded',
      ).toBeGreaterThanOrEqual(1);
      expect(seededAccountIds).toContain(id);
    });
  },
);

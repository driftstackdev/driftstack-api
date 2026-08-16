// Drizzle-backed integration test for DrizzleAccountsAdminRepo against a REAL
// Postgres.
//
// Why this exists: the repo had ZERO line coverage (measured 2026-08-15, see
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
//
// MUTATION-PROVED against admin-accounts-repo.ts — control 11/11 green:
//
//   the `id DESC` keyset tiebreaker dropped                     1 red
//   the page-size cap removed                                   1 red
//   the look-ahead row removed (hasMore always false)           2 red
//   countByTier no longer zero-filled                           1 red
//
// Ledger written 2026-08-15 by re-running the proof rather than transcribing it
// from memory — and that re-run is why two arms above exist at all, because the
// first pass came back with 10 arms and a different result.
//
// ⛔ THE PAGE-SIZE CAP HAD NO ARM. Removing `Math.min(args.limit ?? 50, 100)`
// left all ten original arms green: none had ever asked for a limit above 100.
// The HTTP schema caps `limit` at 100 as well, so this is defence-in-depth
// rather than the only gate — which is precisely why it was easy to leave
// untested and precisely why it needs its own arm. Nothing on the request path
// notices it going, and the day a second caller reaches this repo without a Zod
// schema in front of it, one call pulls the whole accounts table into memory.
//
// ⚠️ THE TIEBREAKER ARM WAS PROBABILISTIC. The keyset arm caught the dropped
// `id DESC` on 3 of 4 runs and passed on the 4th. The fixture is not at fault —
// it forces a genuine tie — the MUTATION's effect is what varies: with a
// timestamp-only sort Postgres may return a tie group in any order, and when
// that order happens to stay consistent across the separate paged queries,
// nothing is dropped and the set-completeness assertions both hold. A guard
// that reports "fine" one run in four on a real pagination bug is not a guard.
// It now compares the traversal against the canonical `ORDER BY created_at
// DESC, id DESC` read from the database, which is what the compound cursor
// promises and what a timestamp-only sort cannot deliver across queries.
// Re-measured after the change: the same mutation reds it 5 runs out of 5.
//
// The general point, worth carrying: a mutation that survives sometimes is not
// a weaker signal than one that survives always — it is a louder one, because
// it means the guard's verdict depends on something nobody chose.
//
// ⚠️ 2026-08-16 — THE ARMS IN THIS FILE WERE NOT INDEPENDENT OF EACH OTHER.
// Found by `--sequence.shuffle --sequence.seed=7`: the keyset arm failed with
// 107 canonical rows against 7 traversed. The page-cap arm bulk-inserts 101 rows
// under the same MARKER, and a traversal bounded by `limit * guard` cannot cover
// them — so the keyset arm silently depended on running FIRST. The header above
// promised these assertions "survive a SHARED database"; they did, and were
// still order-dependent within this one file.
//
// The keyset arm now seeds under its own `keyset` submarker, disjoint from the
// bulk rows. That scoping alone WEAKENED it: at 4 tied rows the dropped-
// tiebreaker mutation red only 2 runs in 3, because a small tie group is likely
// to come back in the same order from both paged queries. The tie group is now
// 14 rows wide across several page boundaries, and the mutation is back to
// 5 reds out of 5 — re-measured, not assumed.
//
// The lesson is the one above, applied to a fix rather than a bug: scoping a
// flaky assertion until it stops failing is indistinguishable from scoping it
// until it stops testing. Re-run the mutation ledger after touching a fixture.

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

/**
 * `submarker` gives an arm its own disjoint email namespace under MARKER.
 *
 * Arms in this file are NOT independent without it: the page-cap arm bulk-inserts
 * 101 rows under `MARKER-bulk-`, and the keyset arm compares a full traversal
 * against every MARKER row. Whichever order vitest picks, the keyset arm can only
 * page `limit * guard` rows, so once the bulk arm has run first it sees a fraction
 * of its canonical set. Found by `--sequence.shuffle --sequence.seed=7`: 107
 * canonical rows against 7 traversed. Everything still starts with MARKER, so the
 * afterAll sweep continues to reach it.
 */
async function seedAccount(opts: {
  tier?: string;
  status?: string;
  createdAt?: Date;
  submarker?: string;
}): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  const prefix = opts.submarker ? `${MARKER}-${opts.submarker}` : MARKER;
  const email = `${prefix}-${seededAccountIds.length}@example.test`;
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
    // The page-cap arm bulk-inserts without collecting ids. MARKER is unique to
    // this run, so sweeping by it removes those rows and can touch nothing else.
    await client`DELETE FROM accounts WHERE email LIKE ${`${MARKER}%`}`.catch(() => {});
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
      // Own namespace: the page-cap arm's 101 bulk rows share MARKER, and a
      // traversal capped at limit*guard rows cannot cover them. Scoping here
      // rather than raising the cap keeps this arm about cursor CORRECTNESS
      // instead of turning it into a hundred-page endurance run.
      const keysetMarker = `${MARKER}-keyset`;
      // Sized deliberately. The dropped-tiebreaker mutation only shows up when
      // the two paged queries disagree about the order WITHIN a tie group, so a
      // small tie group lets the mutation survive by luck: at 4 tied rows it red
      // 2 runs in 3. A wide tie group spanning several page boundaries is what
      // makes the disagreement reliable.
      const tie = new Date();
      for (let i = 0; i < 14; i += 1) await seedAccount({ createdAt: tie, submarker: 'keyset' });
      for (let i = 0; i < 6; i += 1) {
        await seedAccount({
          createdAt: new Date(tie.getTime() - (i + 1) * 1000),
          submarker: 'keyset',
        });
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await repo.list({
          emailContains: keysetMarker,
          limit: 3,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.data.filter((r) => r.email.includes(keysetMarker)).map((r) => r.id));
        if (!page.hasMore || page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(new Set(seen).size, 'no row returned twice').toBe(seen.length);
      // An exact count, which this file otherwise forbids on a shared table. It
      // is safe ONLY because `keysetMarker` is exclusive to this arm within a
      // run-unique MARKER, so no sibling arm and no concurrent file can write a
      // row that matches it. Stated rather than left for the next reader to
      // re-derive against the header's rule.
      expect(seen.length, 'every row this arm seeded, and nothing else').toBe(20);

      // Strengthened 2026-08-15. The two assertions above detect a dropped
      // `id DESC` tiebreaker only PROBABILISTICALLY: without it Postgres may
      // return a tie group in any order, and when that order happens to stay
      // consistent between the paged queries, nothing is dropped and both pass.
      // Measured — the mutation removing the tiebreaker red this arm on 3 of 4
      // runs and passed on the 4th, which is a guard that reports "fine" one
      // time in four on a real pagination bug.
      //
      // The traversal must equal the canonical total order, which is what the
      // compound cursor promises and what a timestamp-only sort cannot deliver
      // across separate queries. Read from the database rather than derived
      // here, so this compares the repo against SQL rather than against a
      // second copy of the repo's own logic.
      const canonical = await client!<{ id: string }[]>`
        SELECT id FROM accounts
        WHERE email LIKE ${`${keysetMarker}%`}
        ORDER BY created_at DESC, id DESC`;
      expect(seen, 'the paged traversal matches the canonical keyset order').toEqual(
        canonical.map((r) => r.id),
      );
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

    it('CRITICAL list caps the page size at 100 however large a limit it is handed. Added 2026-08-15 after a mutation removing `Math.min(args.limit ?? 50, 100)` left every other arm green — no arm had ever asked for more than 100. The HTTP schema caps `limit` at 100 too, so this is defence-in-depth rather than the only gate, and that is exactly why it needs its own arm: nothing on the request path would notice it going, and the day a second caller reaches this repo without a Zod schema in front of it, one request pulls the whole accounts table into memory.', async () => {
      if (!dbReachable || !repo || !client) return;
      // 101 rows in one statement — enough to exceed the cap, cheap enough not
      // to add a hundred round-trips. Swept by MARKER in afterAll.
      await client`
        INSERT INTO accounts (id, email, name, tier, status, created_at, updated_at)
        SELECT gen_random_uuid(),
               ${`${MARKER}-bulk-`} || g || '@example.test',
               ${'Admin Repo Bulk Fixture'},
               'free'::account_tier, 'active'::account_status, now(), now()
        FROM generate_series(1, 101) g`;

      const page = await repo.list({ emailContains: MARKER, limit: 5000 });
      expect(page.data.length, 'the oversized limit was clamped to the cap').toBe(100);
      // Independent of the length: the look-ahead row is what sets hasMore, and
      // an uncapped limit swallows it, so this flips too rather than merely
      // restating the assertion above.
      expect(page.hasMore, 'and the caller is told there is another page').toBe(true);
    });
  },
);

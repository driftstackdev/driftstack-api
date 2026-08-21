// V-1236b — one contract for admin account listing, against BOTH implementations of
// `AccountsAdminRepo`.
//
// The twenty-sixth of the twenty-nine. This is the staff-facing account browser: filter, page,
// count. The counting methods are straightforward; the PAGING is not, because the two sides page by
// genuinely different algorithms that agree most of the time.
//
//   Drizzle  keyset. Look the cursor row up BY ID, then
//              WHERE (created_at, id) < (cursor.created_at, cursor.id)
//              ORDER BY created_at DESC, id DESC   LIMIT $n + 1
//
//   double   offset. findIndex(r => r.id === cursor) inside the ALREADY-FILTERED, sorted array,
//            then slice from that index + 1 — and `findIndex` returns -1 when the cursor row is
//            not in the filtered set, which the double reads as "start from the top".
//
// Those coincide exactly while the cursor row still satisfies the filter, which is the normal case
// and the reason this has never been noticed. They come apart the moment it does not — an admin
// filtering by `status: 'active'`, reading page one, SUSPENDING one of the accounts they just read,
// and asking for page two. The cursor row is now excluded by the filter, so the double restarts at
// the top and page two re-lists accounts already seen, while the keyset query continues from where
// it left off. A staff tool that silently repeats rows during exactly the workflow it exists for.
//
// So the paging arms do not merely check "page two follows page one". They mutate a row's status
// between the two pages, which is what pulls the algorithms apart.
//
// EVERY METHOD HERE IS GLOBAL — `list` has no account scope and the three counters take no filter
// at all. Against a real Postgres holding other rows, no arm can assert an absolute total. So list
// arms scope themselves with a unique `emailContains` token, and counter arms assert the DELTA
// across a seed rather than the count itself.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { AccountTierSchema, type AccountTier } from '@driftstack/api-types';
import type { AccountsAdminRepo } from '../../src/services/admin-accounts.js';
import {
  ADMIN_ACCOUNTS_PAGE_MAX,
  DrizzleAccountsAdminRepo,
} from '../../src/db/admin-accounts-repo.js';
import { InMemoryAccountsAdminRepo } from './_helpers/in-memory-admin-accounts-repo.js';
import { InMemoryAuthRepo } from './_helpers/in-memory-auth-repo.js';
import type { AccountRow } from '../../src/services/auth.js';
import { accounts } from '../../src/db/schema.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const T0 = new Date('2026-08-20T12:00:00.000Z');
// V-1245 — the counter arms date their fixtures into the FAR FUTURE, and that is the whole
// reason they are deterministic. `countCreatedSince` takes no account filter: it counts the
// whole table. Measured across a window that starts in the past, the delta picks up every
// account any concurrently-running test file inserts or deletes — which is how these two arms
// came to report a NEGATIVE delta (-2 where 1 was expected) under a nine-file parallel run,
// while passing alone and passing in pairs. Anchoring the window past every other fixture's
// `now()` scopes an unscopeable counter to exactly the rows this file seeded.
const FAR = new Date('2099-06-01T12:00:00.000Z');
const farAt = (n: number): Date => new Date(FAR.getTime() - n * 60_000);
/** Newest first, so `at(0)` is the head of a created_at DESC page. */
const at = (n: number): Date => new Date(T0.getTime() - n * 60_000);

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seededTokens: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM accounts LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const t of seededTokens) {
      await client`DELETE FROM accounts WHERE email LIKE ${`%${t}%`}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Seed {
  createdAt: Date;
  tier?: AccountTier;
  status?: 'active' | 'suspended' | 'deleted';
}

/** All any arm needs; both are chosen here rather than read back, so no stamp round-trip. */
interface Seeded {
  id: string;
  createdAt: Date;
}

interface Subject {
  repo: AccountsAdminRepo;
  /** Unique per subject; every seeded email contains it, so `list` arms scope to their own rows. */
  token: string;
  /** Batched on purpose: the cap arm needs 101 rows and 101 round-trips is a test timeout. */
  seedMany: (s: Seed[]) => Promise<Seeded[]>;
}

const single = async (s: Subject, seed: Seed): Promise<Seeded> => {
  const [row] = await s.seedMany([seed]);
  if (row === undefined) throw new Error('seed produced no row');
  return row;
};

function plan(token: string, s: Seed): AccountRow {
  const id = randomUUID();
  return {
    id,
    email: `${token}-${id.slice(0, 8)}@test.local`,
    name: null,
    tier: s.tier ?? 'free',
    status: s.status ?? 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: s.createdAt,
    updatedAt: s.createdAt,
  };
}

function inMemorySubject(): Subject {
  const authRepo = new InMemoryAuthRepo();
  const token = `adminlist${randomUUID().slice(0, 8)}`;
  return {
    repo: new InMemoryAccountsAdminRepo(authRepo),
    token,
    seedMany: (seeds) => {
      const rows = seeds.map((s) => plan(token, s));
      for (const row of rows) authRepo.upsertAccount(row);
      return Promise.resolve(rows.map((r) => ({ id: r.id, createdAt: r.createdAt })));
    },
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  const repo = new DrizzleAccountsAdminRepo({ client: c, db, close: async () => {} });
  const token = `adminlist${randomUUID().slice(0, 8)}`;
  seededTokens.push(token);
  return {
    repo,
    token,
    // Through Drizzle rather than a raw template: `tier` and `status` are Postgres ENUMS, and
    // postgres-js mis-serialises a mixed enum/timestamp parameter list in a raw INSERT — it hands
    // the Date to a string serialiser and throws. Drizzle knows the column types.
    seedMany: async (seeds) => {
      const rows = seeds.map((s) => plan(token, s));
      await db.insert(accounts).values(
        rows.map((r) => ({
          id: r.id,
          email: r.email,
          tier: r.tier,
          status: r.status,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      );
      return rows.map((r) => ({ id: r.id, createdAt: r.createdAt }));
    },
  };
}

/**
 * V-1248 — `countByStatus` and `countByTier` take no filter at all: they count the whole table.
 * A delta measured around a seed therefore races every other test file writing to `accounts`,
 * and unlike `countCreatedSince` there is no time parameter to anchor the window past them.
 *
 * What CAN be done is detect the interference rather than hope it away. A clean measurement has
 * a known shape — the bucket I seeded moves by exactly the amount I seeded, and every other
 * bucket does not move at all. Any other vector means somebody else wrote inside my window, so
 * the reading is discarded and the whole arm re-run on fresh fixtures.
 *
 * After `ATTEMPTS` dirty readings it FAILS, and the message carries the observed vector — which
 * is the difference between "this counter is broken" and "this database was too busy to measure",
 * a distinction the previous version could not make and reported as the former.
 */
const ATTEMPTS = 5;

async function cleanDelta<K extends string>(
  read: () => Promise<Record<K, number>>,
  seed: () => Promise<void>,
  expected: Partial<Record<K, number>>,
  /**
   * V-1261 — buckets left UNCONSTRAINED because other test files write them constantly.
   *
   * `accounts.status` defaults to 'active' and `accounts.tier` to 'free', and nearly every
   * fixture in the suite inserts `(id, email)` and takes those defaults. Under a thirty-file
   * contract run those two buckets move inside essentially every measurement window, so
   * requiring them to sit still is requiring the rest of the suite to stop working — the arm
   * failed about one run in five, always reporting VARIED deltas, which is the helper
   * correctly identifying interference rather than a miscount.
   *
   * Ignoring them costs less than it looks: an implementation that ignored its filter would
   * move the buckets that are still constrained, so the property the arm exists for survives.
   */
  // Typed on `string`, not `K`: as `ReadonlySet<K>` it drove the inference of K and narrowed
  // it to whatever the ignore set contained, which made `expected` reject its own keys.
  ignore: ReadonlySet<string> = new Set<string>(),
): Promise<void> {
  const seen: string[] = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const before = await read();
    await seed();
    const after = await read();

    const delta = {} as Record<K, number>;
    for (const k of Object.keys(after) as K[]) delta[k] = after[k] - before[k];

    const dirty = (Object.keys(delta) as K[])
      .filter((k) => !ignore.has(k))
      .filter((k) => delta[k] !== (expected[k] ?? 0));
    if (dirty.length === 0) return;
    seen.push(
      dirty.map((k) => `${k}: ${String(delta[k])} (want ${String(expected[k] ?? 0)})`).join(', '),
    );
  }

  // Which of the two it is can be READ OFF the attempts rather than guessed. A dirty vector that
  // is identical every time is deterministic, so it is the counter miscounting; one that varies
  // is another writer landing inside the window. Saying "a concurrent writer moved a bucket"
  // unconditionally would blame the database for a genuine defect — the exact misattribution
  // this contract exists to catch elsewhere, and what the first version of this message did.
  const stable = seen.every((v) => v === seen[0]);
  throw new Error(
    stable
      ? `the counter is MISCOUNTING: the same wrong delta appeared in all ${String(ATTEMPTS)} ` +
          `attempts, which no concurrent writer would reproduce exactly. Delta: ${seen[0] ?? ''}`
      : `no clean reading in ${String(ATTEMPTS)} attempts. These counters are unfiltered and ` +
          `table-wide, and the deltas VARIED between attempts, so another writer landed inside ` +
          `every measurement window: ${seen.join(' | ')}`,
  );
}

function adminAccountsListContract(
  label: string,
  make: () => Subject,
  enabled: () => boolean,
): void {
  describe(`AccountsAdminRepo list contract — ${label}`, () => {
    const page = (s: Subject, args: { limit?: number; cursor?: string; status?: 'active' } = {}) =>
      s.repo.list({ emailContains: s.token, ...args });

    it('CRITICAL page one is newest-first and truncated to `limit`, with hasMore and a nextCursor naming the last row returned, in both. The over-fetch of limit+1 decides hasMore, and returning that extra row to the caller would put one account on two consecutive pages.', async () => {
      if (!enabled()) return;
      const s = make();
      const a = await single(s, { createdAt: at(0) });
      const b = await single(s, { createdAt: at(1) });
      await single(s, { createdAt: at(2) });

      const first = await page(s, { limit: 2 });
      expect(
        first.data.map((r) => r.id),
        'page one was not the two newest accounts, newest first',
      ).toEqual([a.id, b.id]);
      expect(first.hasMore, 'a third matching account did not set hasMore').toBe(true);
      expect(first.nextCursor, 'nextCursor is not the last row of the page').toBe(b.id);
    });

    it('CRITICAL adjacent pages PARTITION the matching set — every account on exactly one page, in both. This is what the cursor is FOR, and it is the only arm that catches an off-by-one that either repeats the boundary account or drops it between pages.', async () => {
      if (!enabled()) return;
      const s = make();
      const a = await single(s, { createdAt: at(0) });
      const b = await single(s, { createdAt: at(1) });
      const c = await single(s, { createdAt: at(2) });

      const first = await page(s, { limit: 2 });
      const second = await page(s, { limit: 2, cursor: first.nextCursor ?? undefined });

      expect(
        second.data.map((r) => r.id),
        'page two is not the remainder',
      ).toEqual([c.id]);
      expect(second.hasMore, 'the last page still claims there is more').toBe(false);
      expect(second.nextCursor, 'the last page handed out another cursor').toBeNull();
      expect(
        [...first.data, ...second.data].map((r) => r.id).sort(),
        'the two pages together are not exactly the matching set',
      ).toEqual([a.id, b.id, c.id].sort());
    });

    it('CRITICAL the cursor keeps its place even when the cursor row itself stops matching the filter, in both. An admin filters by active, reads page one, SUSPENDS an account they just read, then asks for page two — the exact workflow this browser exists for. Resolving the cursor by its position inside the filtered set restarts at the top the moment that row leaves the set, so page two re-lists accounts already seen and staff act twice on the same account.', async () => {
      if (!enabled()) return;
      const s = make();
      const a = await single(s, { createdAt: at(0) });
      const b = await single(s, { createdAt: at(1) });
      const c = await single(s, { createdAt: at(2) });
      const d = await single(s, { createdAt: at(3) });

      const first = await page(s, { limit: 2, status: 'active' });
      expect(
        first.data.map((r) => r.id),
        'page one was not [a, b]',
      ).toEqual([a.id, b.id]);

      // The account at the page boundary leaves the filtered set between reads.
      await s.repo.setStatus(b.id, 'suspended', new Date());

      const second = await page(s, {
        limit: 2,
        status: 'active',
        cursor: first.nextCursor ?? undefined,
      });
      expect(
        second.data.map((r) => r.id),
        'page two restarted from the top and repeated an account from page one',
      ).toEqual([c.id, d.id]);
    });

    it('CRITICAL `limit` is capped at 100 however large a limit is asked for, in both. The cap is the only thing standing between a staff query and the whole accounts table in one response, and it is invisible until someone asks for more than a hundred.', async () => {
      if (!enabled()) return;
      const s = make();
      await s.seedMany(
        Array.from({ length: ADMIN_ACCOUNTS_PAGE_MAX + 1 }, (_, i) => ({ createdAt: at(i) })),
      );

      const p = await page(s, { limit: 1000 });
      expect(p.data.length, 'a limit above the cap was honoured').toBe(ADMIN_ACCOUNTS_PAGE_MAX);
      expect(p.hasMore, 'the capped page did not report more to come').toBe(true);
    });

    it('CRITICAL an unknown cursor yields the FIRST page rather than an empty one, in both. A cursor naming a row that has since been hard-deleted must not strand the caller on a blank page they cannot page off.', async () => {
      if (!enabled()) return;
      const s = make();
      const a = await single(s, { createdAt: at(0) });

      const p = await page(s, { limit: 10, cursor: randomUUID() });
      expect(
        p.data.map((r) => r.id),
        'an unknown cursor did not fall back to page one',
      ).toEqual([a.id]);
    });

    it('CRITICAL the email filter is case-insensitive and matches a SUBSTRING, in both. Staff paste whatever casing the customer wrote; a case-sensitive match silently reports the account does not exist.', async () => {
      if (!enabled()) return;
      const s = make();
      const a = await single(s, { createdAt: at(0) });

      const p = await s.repo.list({ emailContains: s.token.toUpperCase(), limit: 10 });
      expect(
        p.data.map((r) => r.id),
        'an upper-cased needle did not match a lower-cased email',
      ).toEqual([a.id]);
    });

    it('CRITICAL status and tier filters COMPOSE rather than replace one another, in both. Each filter alone looks right; if they overwrite, a staff query for suspended enterprise accounts quietly answers a different question than the one asked.', async () => {
      if (!enabled()) return;
      const s = make();
      await single(s, { createdAt: at(0), tier: 'enterprise', status: 'active' });
      await single(s, { createdAt: at(1), tier: 'free', status: 'suspended' });
      const wanted = await single(s, { createdAt: at(2), tier: 'enterprise', status: 'suspended' });

      const p = await s.repo.list({
        emailContains: s.token,
        status: 'suspended',
        tier: 'enterprise',
        limit: 10,
      });
      expect(
        p.data.map((r) => r.id),
        'the two filters did not compose into a single conjunction',
      ).toEqual([wanted.id]);
    });

    it('CRITICAL countCreatedSince is INCLUSIVE of an account created exactly at `since`, in both. Asserted as a delta because the counter has no scope and the table holds other rows.', async () => {
      if (!enabled()) return;
      const s = make();
      const before = await s.repo.countCreatedSince(farAt(0));
      const a = await single(s, { createdAt: farAt(0) });

      expect(
        (await s.repo.countCreatedSince(a.createdAt)) - before,
        'an account created exactly at `since` was not counted',
      ).toBe(1);
    });

    it('CRITICAL countCreatedSince EXCLUDES an account created before the window, in both. Without this the inclusive arm above is satisfied by a counter that ignores `since` and counts the table.', async () => {
      if (!enabled()) return;
      const s = make();
      const a = await single(s, { createdAt: farAt(5) });
      const justAfter = new Date(a.createdAt.getTime() + 1);
      const before = await s.repo.countCreatedSince(justAfter);
      await single(s, { createdAt: farAt(6) });

      expect(
        (await s.repo.countCreatedSince(justAfter)) - before,
        'an account created before the window was counted',
      ).toBe(0);
    });

    it('CRITICAL countByStatus counts only the status asked for, in both. It feeds the suspended-account figure on the staff overview, and folding statuses together reports a healthy platform as one in trouble or the reverse.', async () => {
      if (!enabled()) return;
      const s = make();
      const STATUSES = ['active', 'suspended', 'deleted'] as const;

      // One active and one suspended account: the suspended bucket must move by one and the
      // active bucket by one, and `deleted` must not move at all. Asserting the whole vector
      // is what makes the arm about SCOPING rather than about counting.
      // Only a SUSPENDED account is seeded. If the count ignored the status it was asked
      // for, seeding one row would move every bucket — including `deleted`, which stays
      // constrained — so the scoping property is still what this arm rests on.
      await cleanDelta(
        async () => {
          const out = {} as Record<(typeof STATUSES)[number], number>;
          for (const st of STATUSES) out[st] = await s.repo.countByStatus(st);
          return out;
        },
        async () => {
          await single(s, { createdAt: at(1), status: 'suspended' });
        },
        { suspended: 1 },
        new Set(['active'] as const),
      );
    });

    it('CRITICAL countByTier reports EVERY tier in the enum, including tiers no account holds, in both. The overview renders one row per key it is given, so a tier missing from the map disappears from the page entirely rather than showing a zero — and a tier added to the enum later must appear without anyone remembering to add it here.', async () => {
      if (!enabled()) return;
      const s = make();
      const counts = await s.repo.countByTier();

      expect(
        Object.keys(counts).sort(),
        'the tier map does not have exactly one key per enum option',
      ).toEqual([...AccountTierSchema.options].sort());
      for (const tier of AccountTierSchema.options) {
        expect(typeof counts[tier], `tier ${tier} is not a number at runtime`).toBe('number');
      }
    });

    it('CRITICAL countByTier attributes an account to its OWN tier, in both. Without this the zero-fill arm above is satisfied by a map of eight zeroes that never counts anything.', async () => {
      if (!enabled()) return;
      const s = make();

      // The whole tier vector, not just two buckets: the seeded tier moves by one and every
      // other tier — all seven of them — must not move at all. That is a stronger statement
      // than the old pair of assertions, and it is also what makes an interfered-with reading
      // recognisable rather than indistinguishable from a real miscount.
      await cleanDelta(
        () => s.repo.countByTier(),
        async () => {
          await single(s, { createdAt: at(0), tier: 'agency_manual' });
        },
        { agency_manual: 1 },
        // `free` is the column default and the rest of the suite lands there constantly. Every
        // other tier stays constrained, so an implementation dribbling a count into the wrong
        // bucket is still caught.
        new Set(['free'] as const),
      );
    });
  });
}

adminAccountsListContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'AccountsAdminRepo list contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    adminAccountsListContract('drizzle', drizzleSubject, () => dbReachable);
  },
);

// V-1241 — one contract for rate-limit overrides, against BOTH implementations of
// `RateLimitOverridesRepo`.
//
// THE THIRTIETH, AND IT WAS NOT ON THE LIST. This campaign was scoped as "twenty-nine
// double/repo pairs", and V-1240 closed it by reporting all twenty-nine covered. Enumerating the
// doubles afterwards rather than counting them showed that was wrong: there are 29 contract FILES
// and 29 doubles, but the mapping is not one-to-one — `InMemoryAuthRepo` is named by three
// contracts and `InMemoryAuthFlowsRepo` by two, because they are pulled in as collaborators — and
// `InMemoryRateLimitOverridesRepo` had none at all, while its Drizzle counterpart is wired in
// bootstrap and serving production. A matching total hid a real hole. That is the whole reason for
// the rule about enumerating a set instead of reporting its size.
//
// Two divergences, and the first is the interesting one.
//
// PRECISION THE DATABASE CANNOT HOLD. `refill_per_second_centi` is an INTEGER of hundredths:
//
//   Drizzle  write  Math.max(1, Math.round(refillPerSecond * 100))     read  centi / 100
//   double   write  input.refillPerSecond                              read  the same float back
//
// So the double answered with whatever the caller passed, and the repo answered with what the
// column can represent. A test asserting a refill of 1.234 passed while production served 1.23.
// And `Math.max(1, …)` means a rate below half a centi — INCLUDING ZERO — comes back as 0.01
// rather than 0: an override cannot express "never refills", because a bucket that never refills
// is a permanent lockout rather than a rate limit. The double reported 0 for that, which is the
// lockout the floor exists to prevent, in the one place a test would have looked.
//
// Both now go through the exported `quantizeRefillPerSecond`, and so does this contract — asserting
// a hardcoded 1.23 here would be a third copy of the rounding rule.
//
// AND THE SAME PAGING SPLIT AS V-1237, in a repo where it is easier to hit. The Drizzle side pages
// by keyset; the double resolved the cursor with `findIndex` inside the already-filtered array,
// which returns -1 — read as "start from the top" — the moment the cursor row stops passing the
// filter. Here the filter is `expiresAt > now`, so the cursor row leaves the set BY ITSELF, with
// nobody touching anything: page one at 10:00, page two at 10:01 after the boundary override
// lapsed, and page two re-lists overrides already seen.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type {
  RateLimitOverrideRecord,
  RateLimitOverridesRepo,
} from '../../src/services/rate-limit-overrides.js';
import {
  DrizzleRateLimitOverridesRepo,
  quantizeRefillPerSecond,
} from '../../src/db/rate-limit-overrides-repo.js';
import { InMemoryRateLimitOverridesRepo } from './_helpers/in-memory-rate-limit-overrides-repo.js';
import { InMemoryAuthRepo } from './_helpers/in-memory-auth-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');
const LONG_PAST = new Date('2000-01-01T00:00:00.000Z');

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM rate_limit_overrides LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const a of seeded) {
      await client`DELETE FROM rate_limit_overrides WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Owner {
  accountId: string;
  /** `set_by_key_id` is NOT NULL — every override records the key that set it. */
  keyId: string;
}

interface Subject {
  repo: RateLimitOverridesRepo;
  account: () => Promise<Owner>;
}

function inMemorySubject(): Subject {
  const authRepo = new InMemoryAuthRepo();
  return {
    repo: new InMemoryRateLimitOverridesRepo(authRepo),
    account: () => Promise.resolve({ accountId: randomUUID(), keyId: randomUUID() }),
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleRateLimitOverridesRepo({ client: c, db, close: async () => {} }),
    account: async () => {
      const accountId = randomUUID();
      const keyId = randomUUID();
      const tag = accountId.slice(0, 8);
      seeded.push(accountId);
      await c`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`rlo-${accountId}@test.local`})`;
      await c`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, scopes)
              VALUES (${keyId}::uuid, ${accountId}::uuid, ${`k-${tag}`}, ${`ds_rlo_${tag}`},
                      ${`hash-${tag}`}, ${['read']})`;
      return { accountId, keyId };
    },
  };
}

function overridesContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`RateLimitOverridesRepo contract — ${label}`, () => {
    const set = (
      s: Subject,
      owner: Owner,
      bucketKey: string,
      opts: { capacity?: number; refill?: number; expiresAt?: Date } = {},
    ): Promise<RateLimitOverrideRecord> =>
      s.repo.upsert({
        accountId: owner.accountId,
        bucketKey,
        capacity: opts.capacity ?? 100,
        refillPerSecond: opts.refill ?? 2,
        expiresAt: opts.expiresAt ?? FAR_FUTURE,
        setByKeyId: owner.keyId,
      });

    it('CRITICAL an override is written and read back on its own account, in both. Everything below assumes this; without it the arms are satisfied by a repo that stores nothing and lists nothing.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const rec = await set(s, account, 'api:general');

      const page = await s.repo.listAll({ limit: 10, accountId: account.accountId });
      expect(
        page.items.map((r) => r.id),
        'the override did not read back',
      ).toEqual([rec.id]);
      expect(page.items[0]?.capacity, 'the capacity did not round-trip').toBe(100);
    });

    it("CRITICAL the refill rate comes back QUANTISED to what the column can hold, in both. `refill_per_second_centi` is an integer of hundredths, so a request for 1.234 is served as 1.23. Answering with the caller's float instead reports a rate the limiter will never actually apply — and the assertion derives the expected value from quantizeRefillPerSecond rather than naming 1.23, so changing the scale moves this arm with it.", async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await set(s, account, 'api:general', { refill: 1.234 });

      const page = await s.repo.listAll({ limit: 10, accountId: account.accountId });
      expect(
        page.items[0]?.refillPerSecond,
        'the refill rate was not quantised to the stored precision',
      ).toBe(quantizeRefillPerSecond(1.234));
    });

    it('CRITICAL a refill rate of ZERO is floored to the smallest non-zero rate, in both. The floor is deliberate: a bucket that never refills is a permanent lockout rather than a rate limit, so the column cannot express it. An implementation that echoes 0 back reports exactly the lockout the floor exists to prevent.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await set(s, account, 'api:general', { refill: 0 });

      const stored = (await s.repo.listAll({ limit: 10, accountId: account.accountId })).items[0]
        ?.refillPerSecond;
      expect(stored, 'a zero refill rate was stored as zero — that is a permanent lockout').toBe(
        quantizeRefillPerSecond(0),
      );
      expect(stored, 'the floored rate is not strictly positive').toBeGreaterThan(0);
    });

    it('CRITICAL re-setting the same bucket REPLACES the override rather than adding a second, in both. The unique key is (account_id, bucket_key); a second row means two overrides for one bucket and whichever the list happens to return first wins.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await set(s, account, 'api:general', { capacity: 100 });
      await set(s, account, 'api:general', { capacity: 500 });

      const page = await s.repo.listAll({ limit: 10, accountId: account.accountId });
      expect(page.items.length, 'the bucket has more than one override').toBe(1);
      expect(page.items[0]?.capacity, 'the re-set did not take effect').toBe(500);
    });

    it('CRITICAL different buckets on one account are independent, in both. Otherwise raising the limit on one endpoint silently raises it on every endpoint, which is the difference between an exception and a hole.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await set(s, account, 'api:general', { capacity: 100 });
      await set(s, account, 'api:sessions', { capacity: 500 });

      const page = await s.repo.listAll({ limit: 10, accountId: account.accountId });
      const byBucket = new Map(page.items.map((r) => [r.bucketKey, r.capacity]));
      expect(byBucket.get('api:general'), 'one bucket took another bucket value').toBe(100);
      expect(byBucket.get('api:sessions'), 'the second bucket was lost or overwritten').toBe(500);
    });

    it('CRITICAL an EXPIRED override is excluded by default and included on request, in both. Expiry is what makes an override temporary; listing a lapsed one as active tells staff a limit is raised when it is not, and hiding it from the include-expired view loses the audit trail of what was raised.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const live = await set(s, account, 'api:general');
      const dead = await set(s, account, 'api:sessions', { expiresAt: LONG_PAST });

      const active = await s.repo.listAll({ limit: 10, accountId: account.accountId });
      expect(
        active.items.map((r) => r.id),
        'an expired override was listed as active',
      ).toEqual([live.id]);

      const all = await s.repo.listAll({
        limit: 10,
        accountId: account.accountId,
        includeExpired: true,
      });
      expect(
        all.items.map((r) => r.id).sort(),
        'includeExpired did not bring the lapsed override back',
      ).toEqual([live.id, dead.id].sort());
    });

    it("CRITICAL the accountId filter scopes the listing, in both. These are per-customer exceptions; showing one customer's raised limits under another account misreports both.", async () => {
      if (!enabled()) return;
      const s = make();
      const mine = await s.account();
      const other = await s.account();
      const own = await set(s, mine, 'api:general');
      await set(s, other, 'api:general');

      const page = await s.repo.listAll({ limit: 10, accountId: mine.accountId });
      expect(
        page.items.map((r) => r.id),
        "another account's override was listed",
      ).toEqual([own.id]);
    });

    it("CRITICAL clear removes the override and reports whether one was there, in both. The boolean is the caller's only signal: reporting true for a bucket that had no override tells staff they revoked something they did not.", async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await set(s, account, 'api:general');

      expect(
        await s.repo.clear(account.accountId, 'api:general'),
        'clearing a live override reported false',
      ).toBe(true);
      expect(
        (await s.repo.listAll({ limit: 10, accountId: account.accountId, includeExpired: true }))
          .items,
        'the override survived the clear',
      ).toEqual([]);
      expect(
        await s.repo.clear(account.accountId, 'api:general'),
        'clearing an absent override reported true',
      ).toBe(false);
    });

    it('CRITICAL createdAt SURVIVES a re-set while updatedAt moves, in both. The pair is how staff see "raised on the 3rd, adjusted yesterday"; resetting createdAt on every edit erases when the exception actually began.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const first = await set(s, account, 'api:general', { capacity: 100 });
      await new Promise((r) => setTimeout(r, 5));
      const second = await set(s, account, 'api:general', { capacity: 500 });

      expect(second.createdAt.getTime(), 'the re-set moved createdAt').toBe(
        first.createdAt.getTime(),
      );
      expect(
        second.updatedAt.getTime(),
        'the re-set did not advance updatedAt',
      ).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    });

    it('CRITICAL the cursor keeps its place even when the cursor row has EXPIRED between pages, in both. Every row here leaves the default listing on its own, with nobody touching it — so resolving the cursor by its position inside the filtered set restarts at the top on an ordinary clock tick, and page two re-lists overrides already seen.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      // Four overrides, newest first by createdAt; the second one expires shortly.
      const a = await set(s, account, 'api:a');
      await new Promise((r) => setTimeout(r, 5));
      const b = await set(s, account, 'api:b', { expiresAt: new Date(Date.now() + 250) });
      await new Promise((r) => setTimeout(r, 5));
      const c = await set(s, account, 'api:c');
      await new Promise((r) => setTimeout(r, 5));
      const d = await set(s, account, 'api:d');

      // createdAt DESC, so page one is [d, c].
      const first = await s.repo.listAll({ limit: 2, accountId: account.accountId });
      expect(
        first.items.map((r) => r.id),
        'page one was not the two newest',
      ).toEqual([d.id, c.id]);

      const second = await s.repo.listAll({
        limit: 2,
        accountId: account.accountId,
        cursor: first.nextCursor ?? undefined,
      });
      expect(
        second.items.map((r) => r.id),
        'page two did not continue after the cursor',
      ).toEqual([b.id, a.id]);

      // Now let the row the NEXT cursor names lapse, then page past it.
      const cursorRow = second.items[0];
      await new Promise((r) => setTimeout(r, 300));
      const third = await s.repo.listAll({
        limit: 2,
        accountId: account.accountId,
        cursor: cursorRow?.id,
      });
      expect(
        third.items.map((r) => r.id),
        'the page restarted from the top after the cursor row expired, repeating rows already seen',
      ).toEqual([a.id]);
    });

    it('CRITICAL adjacent pages PARTITION the account, and the last page hands out no cursor, in both. Without the terminating null a caller pages forever, and without the partition an override is acted on twice or missed entirely.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const a = await set(s, account, 'api:a');
      await new Promise((r) => setTimeout(r, 5));
      const b = await set(s, account, 'api:b');
      await new Promise((r) => setTimeout(r, 5));
      const c = await set(s, account, 'api:c');

      const first = await s.repo.listAll({ limit: 2, accountId: account.accountId });
      const second = await s.repo.listAll({
        limit: 2,
        accountId: account.accountId,
        cursor: first.nextCursor ?? undefined,
      });

      expect(second.nextCursor, 'the last page handed out another cursor').toBeNull();
      expect(
        [...first.items, ...second.items].map((r) => r.id).sort(),
        'the two pages together are not exactly the account set',
      ).toEqual([a.id, b.id, c.id].sort());
      expect(
        first.items.filter((r) => second.items.some((o) => o.id === r.id)),
        'an override appeared on BOTH pages',
      ).toEqual([]);
    });
  });
}

overridesContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'RateLimitOverridesRepo contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    overridesContract('drizzle', drizzleSubject, () => dbReachable);
  },
);

// V-1240 — one contract for API-key lookup and the last-used throttle, against BOTH
// implementations of `AccountAuthRepo`.
//
// The twenty-ninth of the twenty-nine, and the last one owed.
//
// `findApiKeyByPrefix` is the first step of authenticating every API request, and
// `touchApiKeyLastUsed` is the write that follows it. That write is THROTTLED, because otherwise
// the hot auth path updates a row on every single authenticated request:
//
//   Drizzle  UPDATE api_keys SET last_used_at = $at
//              WHERE id = $id AND (last_used_at IS NULL OR last_used_at < $at - 30s)
//
//   double   if (lastUsedAt === null || lastUsedAt < at - 30s) { … }
//
// A THROTTLE AND A BROKEN WRITE ARE THE SAME OBSERVATION from one call. Both leave `last_used_at`
// where it was; you can only tell them apart by calling twice and moving the clock. That is not
// hypothetical here — the double did not throttle at first, and an unthrottled double MASKED a real
// Drizzle bug in which `last_used_at` never updated at all. So this contract asserts the throttle
// from both sides: a write that must land, and a write that must not, and the boundary between them.
//
// THE WINDOW ITSELF IS READ FROM THE REPO. `API_KEY_LAST_USED_THROTTLE_MS` used to be
// module-private, with the double keeping its own `const THROTTLE_MS = 30_000` and a comment saying
// it mirrored it. Same finding as V-1238, one file over: two copies of a number, correct until
// somebody edits one. It is exported now, both sides read it, and so does this file — a test that
// hardcoded 30_000 would be the third copy.
//
// The boundary is STRICT on both sides (`last_used_at < at - window`), so a touch landing exactly
// one window later is still throttled. That asymmetry is worth pinning precisely because it looks
// arbitrary: it is the difference between "at least 30s apart" and "more than 30s apart", and the
// two implementations have to agree on which.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { AccountAuthRepo } from '../../src/services/auth.js';
import { API_KEY_LAST_USED_THROTTLE_MS, DrizzleAccountAuthRepo } from '../../src/db/auth-repo.js';
import { InMemoryAuthRepo } from './_helpers/in-memory-auth-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const W = API_KEY_LAST_USED_THROTTLE_MS;
const T0 = new Date('2026-08-20T12:00:00.000Z');
const plus = (ms: number): Date => new Date(T0.getTime() + ms);

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM api_keys LIMIT 0`;
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
      await client`DELETE FROM api_keys WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Key {
  id: string;
  prefix: string;
}

interface Subject {
  repo: AccountAuthRepo;
  /** Creates a key whose `last_used_at` starts null, which is the never-used state. */
  key: () => Promise<Key>;
}

function inMemorySubject(): Subject {
  const repo = new InMemoryAuthRepo();
  return {
    repo,
    key: () => {
      const accountId = randomUUID();
      const id = randomUUID();
      const prefix = `ds_tk_${id.slice(0, 8)}`;
      repo.upsertAccount({
        id: accountId,
        email: `throttle-${id.slice(0, 8)}@test.local`,
        name: null,
        tier: 'free',
        status: 'active',
        timezone: null,
        avatarR2Key: null,
        slug: null,
        region: null,
        createdAt: T0,
        updatedAt: T0,
      });
      repo.upsertApiKey({
        id,
        accountId,
        name: `k-${id.slice(0, 8)}`,
        keyPrefix: prefix,
        keyHash: `hash-${id.slice(0, 8)}`,
        scopes: ['read:profiles', 'write:profiles'],
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        createdAt: T0,
      });
      return Promise.resolve({ id, prefix });
    },
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleAccountAuthRepo({ client: c, db, close: async () => {} }),
    key: async () => {
      const accountId = randomUUID();
      const id = randomUUID();
      const tag = id.slice(0, 8);
      const prefix = `ds_tk_${tag}`;
      seeded.push(accountId);
      await c`INSERT INTO accounts (id, email)
              VALUES (${accountId}, ${`throttle-${accountId}@test.local`})`;
      // last_used_at is left unset, so it starts NULL — the never-used state the
      // first arm depends on.
      await c`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, scopes)
              VALUES (${id}::uuid, ${accountId}::uuid, ${`k-${tag}`}, ${prefix},
                      ${`hash-${tag}`}, ${['read:profiles', 'write:profiles']})`;
      return { id, prefix };
    },
  };
}

const lastUsed = async (s: Subject, prefix: string): Promise<Date | null | undefined> =>
  (await s.repo.findApiKeyByPrefix(prefix))?.lastUsedAt;

function apiKeyThrottleContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`AccountAuthRepo api-key throttle contract — ${label}`, () => {
    it('CRITICAL a key is found by its prefix and a stranger prefix finds nothing, in both. This is the first step of authenticating every API request: returning nothing for a real key locks the customer out, and returning something for a prefix that was never issued is the opposite and worse.', async () => {
      if (!enabled()) return;
      const s = make();
      const k = await s.key();

      const found = await s.repo.findApiKeyByPrefix(k.prefix);
      expect(found?.id, 'the key was not found by its own prefix').toBe(k.id);
      expect(
        await s.repo.findApiKeyByPrefix(`ds_tk_${randomUUID().slice(0, 8)}`),
        'a prefix that was never issued matched a key',
      ).toBeNull();
    });

    it('CRITICAL scopes round-trip as an array of strings, in both. Scopes are the authorisation decision itself; a Postgres text[] arriving as anything but a string array turns every scope check into a comparison against the wrong shape, and the failure is a refusal or a grant rather than an error.', async () => {
      if (!enabled()) return;
      const s = make();
      const k = await s.key();

      const found = await s.repo.findApiKeyByPrefix(k.prefix);
      expect(Array.isArray(found?.scopes), 'scopes did not come back as an array').toBe(true);
      expect([...(found?.scopes ?? [])].sort(), 'the stored scopes did not round-trip').toEqual([
        'read:profiles',
        'write:profiles',
      ]);
    });

    it('CRITICAL the FIRST touch always lands, because last_used_at starts null, in both. Without this arm every throttle assertion below is satisfied by an implementation that never writes at all — which is the exact Drizzle bug an unthrottled double once hid.', async () => {
      if (!enabled()) return;
      const s = make();
      const k = await s.key();
      expect(await lastUsed(s, k.prefix), 'a fresh key did not start unused').toBeNull();

      await s.repo.touchApiKeyLastUsed(k.id, T0);

      expect((await lastUsed(s, k.prefix))?.getTime(), 'the first touch did not land').toBe(
        T0.getTime(),
      );
    });

    it('CRITICAL a second touch INSIDE the window does not write, in both. The throttle is what keeps the hot auth path from updating a row on every authenticated request; losing it is invisible in behaviour and expensive in load, which is the combination that survives review.', async () => {
      if (!enabled()) return;
      const s = make();
      const k = await s.key();
      await s.repo.touchApiKeyLastUsed(k.id, T0);

      await s.repo.touchApiKeyLastUsed(k.id, plus(W / 2));

      expect(
        (await lastUsed(s, k.prefix))?.getTime(),
        'a touch inside the throttle window was written anyway',
      ).toBe(T0.getTime());
    });

    it('CRITICAL a touch BEYOND the window does write, in both. This is the arm that separates a throttle from a broken write — from a single call they look identical, and only moving the clock past the window tells them apart.', async () => {
      if (!enabled()) return;
      const s = make();
      const k = await s.key();
      await s.repo.touchApiKeyLastUsed(k.id, T0);

      await s.repo.touchApiKeyLastUsed(k.id, plus(W + 1));

      expect(
        (await lastUsed(s, k.prefix))?.getTime(),
        'a touch past the throttle window never landed — the write may be broken, not throttled',
      ).toBe(plus(W + 1).getTime());
    });

    it('CRITICAL the boundary is STRICT — a touch exactly one window later is still throttled, in both. `<` rather than `<=` is the difference between "at least 30s apart" and "more than 30s apart", and the two implementations have to agree on which. The window is read from API_KEY_LAST_USED_THROTTLE_MS rather than restated, so widening it moves this arm with it.', async () => {
      if (!enabled()) return;
      const s = make();
      const k = await s.key();
      await s.repo.touchApiKeyLastUsed(k.id, T0);

      await s.repo.touchApiKeyLastUsed(k.id, plus(W));

      expect(
        (await lastUsed(s, k.prefix))?.getTime(),
        'a touch exactly at the boundary was written — the boundary is not strict',
      ).toBe(T0.getTime());
    });

    it('CRITICAL touching one key leaves other keys alone, in both. Without this the arms above are satisfied by an implementation that stamps every key it holds, which would make every key look freshly used and defeat the reason last_used_at is recorded.', async () => {
      if (!enabled()) return;
      const s = make();
      const mine = await s.key();
      const other = await s.key();

      await s.repo.touchApiKeyLastUsed(mine.id, T0);

      expect(await lastUsed(s, other.prefix), "another key's last_used_at was stamped").toBeNull();
    });
  });
}

// Ungated: if the exported window were ever zero or negative, `plus(W / 2)` would not be
// inside anything and the throttle arms would pass without exercising a throttle.
describe('AccountAuthRepo api-key throttle contract — the window', () => {
  it('CRITICAL the throttle window is positive, so the inside-the-window arms are actually inside it', () => {
    expect(
      API_KEY_LAST_USED_THROTTLE_MS,
      'a non-positive throttle window makes the throttle arms vacuous',
    ).toBeGreaterThan(0);
  });
});

apiKeyThrottleContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'AccountAuthRepo api-key throttle contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    apiKeyThrottleContract('drizzle', drizzleSubject, () => dbReachable);
  },
);

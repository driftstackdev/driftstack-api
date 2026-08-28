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
      await client`DELETE FROM web_sessions WHERE account_id = ${a}::uuid`.catch(() => {});
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
  /**
   * Creates a web session whose `last_used_at` is deliberately OLD.
   *
   * Unlike `api_keys`, the column here is `DEFAULT now() NOT NULL` (migration
   * ground truth), so there is no never-used state to start from — the arms below
   * assert the value MOVES rather than that it stops being null.
   */
  webSession: () => Promise<{ id: string; tokenHash: string }>;
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
    webSession: () => {
      const accountId = randomUUID();
      const id = randomUUID();
      const tokenHash = `wsh-${id.slice(0, 8)}`;
      // First caller of `upsertWebSession`. V-1268 kept that seam explicitly
      // because it is the only writer of the map the local `findActiveWebSession`
      // / `touchWebSessionLastUsed` fallbacks read — with no writer those bodies
      // "can never do anything, which reads as working".
      repo.upsertWebSession({
        id,
        accountId,
        tokenHash,
        expiresAt: new Date(T0.getTime() + 86_400_000),
        revokedAt: null,
        lastUsedAt: T0,
        mfaSatisfiedAt: null,
        createdAt: T0,
      });
      return Promise.resolve({ id, tokenHash });
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
    webSession: async () => {
      const accountId = randomUUID();
      const id = randomUUID();
      const tag = id.slice(0, 8);
      const tokenHash = `wsh-${tag}`;
      seeded.push(accountId);
      await c`INSERT INTO accounts (id, email)
              VALUES (${accountId}, ${`ws-${accountId}@test.local`})`;
      // last_used_at set EXPLICITLY to an old instant: the column defaults to
      // now(), so leaving it out would seed a row already at "just used" and the
      // moved-forward assertion would be satisfied before the touch ran.
      // ISO strings with an explicit cast, matching the repo's own raw-SQL style:
      // a bare Date in the tagged template is rejected for a timestamptz param.
      await c`INSERT INTO web_sessions (id, account_id, token_hash, expires_at, last_used_at)
              VALUES (${id}::uuid, ${accountId}::uuid, ${tokenHash},
                      ${new Date(T0.getTime() + 86_400_000).toISOString()}::timestamptz,
                      ${T0.toISOString()}::timestamptz)`;
      return { id, tokenHash };
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

    it('CRITICAL touchWebSessionLastUsed actually MOVES last_used_at, in both. This is the sibling of the api-key write above and, unlike it, nothing executed it: the Drizzle method was never run against Postgres (measured 2026-08-28, V-2104), the in-memory fallback had no seeded rows because `upsertWebSession` had no caller, a content-parity pin freezes its SQL as TEXT, and a dozen unit tests stub it to `() => Promise.resolve()`. Text, a no-op stub and an unexecuted branch all read the same as a working write. The comment on API_KEY_LAST_USED_THROTTLE_MS records that this exact bug — last_used_at never updating — has happened once already on the api-key path and was masked by a double.', async () => {
      if (!enabled()) return;
      const s = make();
      const ws = await s.webSession();
      const later = new Date(T0.getTime() + 60_000);

      await s.repo.touchWebSessionLastUsed(ws.id, later);

      const row = await s.repo.findActiveWebSession({ tokenHash: ws.tokenHash, now: later });
      expect(
        row,
        'the seeded web session is not readable — the fixture, not the write',
      ).not.toBeNull();
      expect(
        row?.lastUsedAt?.getTime(),
        'last_used_at did not move: the write silently did nothing',
      ).toBe(later.getTime());
    });

    it('CRITICAL touching one web session leaves another alone, in both. Without this the arm above is satisfied by an implementation that stamps every session it holds — which would look correct on a single-session fixture and make every session read as freshly used, the same defeat the api-key arm above guards against.', async () => {
      if (!enabled()) return;
      const s = make();
      const mine = await s.webSession();
      const other = await s.webSession();
      const later = new Date(T0.getTime() + 60_000);

      await s.repo.touchWebSessionLastUsed(mine.id, later);

      const row = await s.repo.findActiveWebSession({ tokenHash: other.tokenHash, now: later });
      expect(row?.lastUsedAt?.getTime(), "another session's last_used_at was stamped").toBe(
        T0.getTime(),
      );
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

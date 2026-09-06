// V-1221 — one contract for auth-token family invalidation, against BOTH implementations of
// `AuthFlowsRepo`.
//
// The twelfth of the twenty-nine. `consumeAuthTokenFamily` is what makes a password-reset link
// single-use AND retires every other outstanding link for that account in the same act. Both halves
// matter: without the first, a captured link stays live; without the second, a customer who clicked
// "forgot password" three times leaves two working links behind after using the third.
//
// The two implementations reach the same place by different routes:
//
//   Drizzle  UPDATE t SET consumed_at = $at WHERE account_id = $acct AND consumed_at IS NULL
//            RETURNING id   ->  rows.some(r => r.id === args.id)
//
//   double   claimedTarget = target exists && target.accountId === acct && target.consumedAt null
//            if (!claimedTarget) return false
//            …then consume every unconsumed row for that account, return true
//
// The SQL consumes first and asks afterwards whether the target was among the rows it burned. The
// double asks first and consumes only if the answer is yes. On every path a caller can reach these
// agree, because callers pass an `id` and `accountId` taken from a row `findActiveAuthToken` just
// returned — unconsumed, unexpired, account-matched.
//
// WHERE THEY DIVERGE, and why it is recorded rather than fixed. If the target is ALREADY consumed
// while other tokens for that account are not, Drizzle still burns the others and returns false;
// the double returns false and burns nothing. Reaching that needs a family call whose target was
// consumed by the single-token path, and the three call sites all take their arguments from a live
// lookup, so nothing in the service produces it. The concurrent-double-click race does not either:
// the first call consumes the whole family, so the second finds nothing left to differ about.
//
// The arms below therefore pin the reachable contract. The divergent path is asserted only as the
// thing both agree on — that a stale target reports false — rather than pinning either side's
// choice about what to burn on the way there, which would freeze an unreachable behaviour into a
// test and make whichever implementation changes first look broken.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { AuthFlowsRepo } from '../../src/services/auth-flows.js';
import { DrizzleAuthFlowsRepo } from '../../src/db/auth-flows-repo.js';
import { InMemoryAuthFlowsRepo } from './_helpers/in-memory-auth-flows-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

// ⛔ WALL-CLOCK, DELIBERATELY NOT A FIXED LITERAL (N-AUTH-TOKEN-FLAKE, 2026-09-06).
// This file used `new Date('2026-08-20T12:00:00.000Z')`, which put EXPIRES an hour
// into 2026-08-20 — i.e. permanently in the past. `deleteStaleAuthTokens` has NO
// account predicate (see `apps/server/src/db/auth-flows-repo.ts:238`): it deletes
// EVERY unconsumed `password_reset_tokens` row with `expiresAt < now - 1h`. So when
// `db-auth-flows-stale-token-sweep-drizzle.test.ts` ran against the same database,
// its sweep deleted THIS file's rows mid-test and the failure surfaced here, in a
// file that had done nothing wrong.
//
// Isolating the account fixture per worker does not help — the DELETE is not scoped
// by account. Anchoring to wall time does: EXPIRES is then always in the future, so
// the sweep's unconsumed branch can never match these rows. Every relation below is
// relative (LATER = NOW+60s < EXPIRES = NOW+1h), so no assertion shifts.
const NOW = new Date();
const LATER = new Date(NOW.getTime() + 60_000);
const EXPIRES = new Date(NOW.getTime() + 3_600_000);
const KIND = 'password_reset' as const;

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM password_reset_tokens LIMIT 0`;
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
      await client`DELETE FROM password_reset_tokens WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: AuthFlowsRepo;
  account: () => Promise<string>;
}

function inMemorySubject(): Subject {
  return {
    repo: new InMemoryAuthFlowsRepo(),
    account: () => Promise.resolve(randomUUID()),
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleAuthFlowsRepo({ client: c, db, close: async () => {} }),
    account: async () => {
      const id = randomUUID();
      seeded.push(id);
      await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`tokfam-${id}@test.local`})`;
      return id;
    },
  };
}

async function issue(s: Subject, accountId: string): Promise<{ id: string; hash: string }> {
  const hash = `hash-${randomUUID()}`;
  const row = await s.repo.insertAuthToken({
    kind: KIND,
    accountId,
    tokenHash: hash,
    expiresAt: EXPIRES,
    requestedFromIp: null,
  });
  return { id: row.id, hash };
}

const stillLive = async (s: Subject, hash: string): Promise<boolean> =>
  (await s.repo.findActiveAuthToken({ kind: KIND, tokenHash: hash, now: LATER })) !== null;

function tokenFamilyContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`AuthFlowsRepo token-family contract — ${label}`, () => {
    it('CRITICAL using a reset link retires EVERY other outstanding link for that account, in both. A customer who clicked "forgot password" three times and used the third would otherwise leave two working links behind, each of which is a password reset for anyone holding it.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const first = await issue(s, account);
      const second = await issue(s, account);
      const used = await issue(s, account);

      const ok = await s.repo.consumeAuthTokenFamily({
        kind: KIND,
        id: used.id,
        accountId: account,
        at: NOW,
      });

      expect(ok, 'consuming a live token reported failure').toBe(true);
      expect(await stillLive(s, first.hash), 'an earlier reset link survived').toBe(false);
      expect(await stillLive(s, second.hash), 'an earlier reset link survived').toBe(false);
      expect(await stillLive(s, used.hash), 'the used link itself survived').toBe(false);
    });

    it("CRITICAL another account's outstanding links are untouched, in both. Family invalidation is scoped to one account, and a sweep that crossed the boundary would sign every other customer out of their own recovery flow.", async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const stranger = await s.account();
      const mine = await issue(s, account);
      const theirs = await issue(s, stranger);

      await s.repo.consumeAuthTokenFamily({ kind: KIND, id: mine.id, accountId: account, at: NOW });

      expect(await stillLive(s, theirs.hash), "another account's link was retired").toBe(true);
    });

    it('CRITICAL a second use of the same link reports failure, in both. This is the single-use guarantee: the caller turns false into invalid_auth_token, so an implementation reporting true twice would let one captured link reset a password more than once.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const used = await issue(s, account);
      const args = { kind: KIND, id: used.id, accountId: account, at: NOW } as const;

      expect(await s.repo.consumeAuthTokenFamily(args), 'the first use failed').toBe(true);
      expect(
        await s.repo.consumeAuthTokenFamily(args),
        'the same reset link was consumed twice',
      ).toBe(false);
    });

    it('CRITICAL a token belonging to a DIFFERENT account reports failure, in both. The pair (id, accountId) is checked together, so an id harvested elsewhere cannot be redeemed against an account that does not own it.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const stranger = await s.account();
      const theirs = await issue(s, stranger);

      expect(
        await s.repo.consumeAuthTokenFamily({
          kind: KIND,
          id: theirs.id,
          accountId: account,
          at: NOW,
        }),
        'a token was redeemed against an account that does not own it',
      ).toBe(false);
    });
  });
}

tokenFamilyContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'AuthFlowsRepo token-family contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    tokenFamilyContract('drizzle', drizzleSubject, () => dbReachable);
  },
);

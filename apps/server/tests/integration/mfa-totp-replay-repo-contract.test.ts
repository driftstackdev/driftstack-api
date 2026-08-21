// V-1220 — one contract for TOTP counter consumption, against BOTH implementations of `MfaRepo`.
//
// The eleventh of the twenty-nine. `consumeTotpCounter` is what stops a TOTP code being used twice
// inside its own validity window. A TOTP code is valid for a 30-second step, so without a
// monotonic counter claim, an attacker who observes a code — over a shoulder, in a screenshot, in a
// log — can replay it for the rest of that window. The claim is the whole defence.
//
// Both implementations express the same rule differently, which is exactly the pair worth pinning:
//
//   Drizzle  UPDATE … WHERE account_id = $1
//              AND (last_used_totp_counter IS NULL OR last_used_totp_counter < $counter)
//            RETURNING account_id            -> result.length > 0
//
//   double   if (r.lastUsedTotpCounter !== null && r.lastUsedTotpCounter >= args.counter)
//              return false
//
// One is a conditional UPDATE whose row count is the answer; the other is a guard clause. They
// agree today — `NULL or strictly less` against `not (non-null and >=)` — and nothing asserted it.
// The failure that matters is the boundary: `>` instead of `>=` in the double, or `<=` instead of
// `<` in the SQL, admits the SAME counter a second time and reopens the replay window without
// changing anything a normal test would look at.
//
// The arms are written as the four cases the predicate can face — first use, replay, rewind,
// advance — rather than as one happy path, because a rule stated as a comparison fails at exactly
// one of them and passing the other three looks like working.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { MfaRepo } from '../../src/services/mfa.js';
import { DrizzleMfaRepo } from '../../src/db/mfa-repo.js';
import { InMemoryMfaRepo } from './_helpers/in-memory-mfa-repo.js';
import type * as schema from '../../src/db/schema.js';
import { nextRevision } from '../../src/db/mfa-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const NOW = new Date('2026-08-20T12:00:00.000Z');
const COUNTER = 58_000_000;

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM account_mfa LIMIT 0`;
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
      await client`DELETE FROM account_mfa WHERE account_id = ${a}::uuid`.catch(() => {});
      // V-1270 — the revision arm seeds a live web session per account so the Drizzle
      // enrolment-completion path can find one. Deleted explicitly rather than relied on to
      // cascade, since the accounts DELETE below is itself best-effort.
      await client`DELETE FROM web_sessions WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: MfaRepo;
  /**
   * V-1270 — a LIVE web session for the account, which `completeEnrollmentIfPending` requires on
   * the Drizzle side: it re-reads the account's auth epoch under lock and demands an unrevoked,
   * unexpired session at that epoch. The double has no such check unless a session authority is
   * wired, so the fixture supplies a real row for one half and an id for the other.
   */
  session: (accountId: string) => Promise<string>;
  /** An account with a PENDING enrolment, whose `last_used_totp_counter` starts NULL. */
  enrolled: () => Promise<string>;
}

async function startEnrolment(repo: MfaRepo, accountId: string): Promise<void> {
  const tag = accountId.slice(0, 8);
  const row = await repo.startEnrollmentIfNotEnrolled({
    accountId,
    ciphertext: `ct-${tag}`,
    iv: `iv-${tag}`,
    tag: `tg-${tag}`,
    now: NOW,
  });
  if (row === null) throw new Error('enrolment fixture did not create a row');
}

function inMemorySubject(): Subject {
  const repo = new InMemoryMfaRepo();
  return {
    repo,
    session: () => Promise.resolve(randomUUID()),
    enrolled: async () => {
      const id = randomUUID();
      await startEnrolment(repo, id);
      return id;
    },
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  const repo = new DrizzleMfaRepo({ client: c, db, close: async () => {} });
  return {
    repo,
    session: async (accountId) => {
      const sessionId = randomUUID();
      const [row] = await c<{ auth_epoch: number }[]>`
        SELECT auth_epoch FROM accounts WHERE id = ${accountId}::uuid`;
      await c`INSERT INTO web_sessions (id, account_id, token_hash, auth_epoch, expires_at)
              VALUES (${sessionId}::uuid, ${accountId}::uuid, ${`th-${sessionId.slice(0, 8)}`},
                      ${row?.auth_epoch ?? 0}, now() + interval '1 day')`;
      return sessionId;
    },
    enrolled: async () => {
      const id = randomUUID();
      seeded.push(id);
      await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`mfa-contract-${id}@test.local`})`;
      await startEnrolment(repo, id);
      return id;
    },
  };
}

function totpReplayContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`MfaRepo TOTP counter contract — ${label}`, () => {
    it('CRITICAL replacing recovery codes advances the revision by the SHARED rule and rejects a stale token, in both. `updated_at` is the compare-and-swap token for MFA credentials — every conditional update matches on it — so the rule for advancing it decides whether a stale snapshot can collide with a fresh one. The double restated that rule inline in five places rather than reading it; the expected value here is computed with the same exported `nextRevision`, so this arm follows the rule instead of freezing it, and fails if either side invents its own.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.enrolled();

      // `enrolled()` only STARTS enrolment, so `enrolledAt` is still null and the swap below
      // would refuse for a reason that has nothing to do with the revision rule. Completing it
      // first is what puts the row in the state the CAS is written for — and it advances the
      // revision once by the same shared rule, which is why `previous` is read afterwards.
      const pending = await s.repo.findByAccount(account);
      const completed = await s.repo.completeEnrollmentIfPending({
        accountId: account,
        currentWebSessionId: await s.session(account),
        expectedUpdatedAt: pending?.updatedAt ?? new Date(0),
        hashes: ['hash-initial'],
        now: new Date((pending?.updatedAt ?? new Date(0)).getTime() + 1_000),
      });
      expect(completed, 'the enrolment fixture did not reach the enrolled state').toBe(true);

      const before = await s.repo.findByAccount(account);
      expect(before?.updatedAt, 'the enrolled row has no revision to swap on').toBeDefined();
      const previous = before?.updatedAt ?? new Date(0);
      // SAME INSTANT as the previous revision, deliberately. `nextRevision` is
      // `max(now, previous + step)`, so any `now` ahead of `previous` makes the step irrelevant
      // and the arm cannot see it — the first version passed its own mutation for exactly that
      // reason. Advancing when the clock has NOT is the whole property: two writes inside one
      // millisecond must still mint distinct compare-and-swap tokens.
      const at = new Date(previous.getTime());

      const swapped = await s.repo.replaceRecoveryCodesIfCurrent({
        accountId: account,
        expectedUpdatedAt: previous,
        hashes: ['hash-a', 'hash-b'],
        now: at,
      });
      expect(swapped, 'the compare-and-swap refused a token it had just been handed').toBe(true);

      const after = await s.repo.findByAccount(account);
      expect(
        after?.updatedAt.getTime(),
        'the revision did not advance by the shared rule — the two sides mint different tokens',
      ).toBe(nextRevision(at, previous).getTime());

      // The token just spent must not work again.
      expect(
        await s.repo.replaceRecoveryCodesIfCurrent({
          accountId: account,
          expectedUpdatedAt: previous,
          hashes: ['hash-c'],
          now: new Date(at.getTime() + 5_000),
        }),
        'a stale revision was accepted — the compare-and-swap is not gating',
      ).toBe(false);
    });

    it('CRITICAL the first counter is accepted when none has been used, in both. last_used_totp_counter starts NULL, and an implementation refusing NULL would lock every newly enrolled customer out of their own second factor.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.enrolled();

      expect(
        await s.repo.consumeTotpCounter({ accountId: account, counter: COUNTER, now: NOW }),
        'the first TOTP counter was refused',
      ).toBe(true);
    });

    it('CRITICAL the SAME counter is refused the second time, in both. This is the replay guard: a TOTP code is valid for a 30-second step, so an attacker who observes one has the rest of that window to reuse it, and a boundary written > instead of >= admits it while every other case still passes.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.enrolled();
      await s.repo.consumeTotpCounter({ accountId: account, counter: COUNTER, now: NOW });

      expect(
        await s.repo.consumeTotpCounter({ accountId: account, counter: COUNTER, now: NOW }),
        'the same TOTP counter was consumed twice — the code is replayable within its window',
      ).toBe(false);
    });

    it('CRITICAL an OLDER counter is refused, in both. Accepting a rewind would let a code captured earlier in the day be presented later, which is the replay window widened from thirty seconds to unbounded.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.enrolled();
      await s.repo.consumeTotpCounter({ accountId: account, counter: COUNTER, now: NOW });

      expect(
        await s.repo.consumeTotpCounter({ accountId: account, counter: COUNTER - 5, now: NOW }),
        'an older TOTP counter was accepted',
      ).toBe(false);
    });

    it('CRITICAL a NEWER counter is accepted, in both. Without this the three arms above are satisfied by an implementation that refuses everything after the first code, which locks the customer out on their next login instead.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.enrolled();
      await s.repo.consumeTotpCounter({ accountId: account, counter: COUNTER, now: NOW });

      expect(
        await s.repo.consumeTotpCounter({ accountId: account, counter: COUNTER + 1, now: NOW }),
        'the next TOTP step was refused',
      ).toBe(true);
    });

    it("CRITICAL consuming a counter for one account does not consume it for another, in both. The claim is per-enrolment; a shared counter would let one customer's successful login refuse another's identical step.", async () => {
      if (!enabled()) return;
      const s = make();
      const first = await s.enrolled();
      const second = await s.enrolled();
      await s.repo.consumeTotpCounter({ accountId: first, counter: COUNTER, now: NOW });

      expect(
        await s.repo.consumeTotpCounter({ accountId: second, counter: COUNTER, now: NOW }),
        "one account's TOTP counter blocked another account's",
      ).toBe(true);
    });
  });
}

totpReplayContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'MfaRepo TOTP counter contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    totpReplayContract('drizzle', drizzleSubject, () => dbReachable);
  },
);

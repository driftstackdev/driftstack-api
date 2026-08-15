// The profile cap's row lock is actually ACQUIRED — proven by forced ordering
// rather than by racing.
//
// `insertWithLimit` enforces a tier cap with count-then-insert inside one
// transaction, guarded by `SELECT … FROM accounts … FOR UPDATE` on the owning
// account row. Without that lock two transactions can both read `count < limit`
// and both insert, and the customer ends up over their cap.
//
// The existing 8-way race in `db-profiles-repo-keyset` cannot establish this, and
// widening its pool did not fix that. Measured three ways: deleting
// `.for('update')` leaves that file green at `max: 1`, green at `max: 8`, and a
// two-backend probe outside vitest also still accepted exactly one. The window
// between the count and the insert is narrow, so a race that misses it proves
// nothing — which is a statement about the TEST, not about the lock.
//
// So this file stops racing and forces the ordering instead. A separate session
// takes the same row lock and holds it inside an open transaction. If
// `insertWithLimit` really acquires that lock it MUST block; when the holder
// commits, it proceeds. There is no timing window to hit — the block is
// deterministic, and its absence is equally deterministic.
//
// That makes the mutation detectable in a way the race never was: with
// `.for('update')` removed the call sails past a held lock and settles
// immediately.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let holder: ReturnType<typeof postgres> | null = null;
let worker: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

/** A one-shot latch: `promise` settles when `fire()` is called. */
function gate(): { promise: Promise<void>; fire: () => void } {
  let fire: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    fire = (): void => {
      resolve();
    };
  });
  return { promise, fire };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  holder = postgres(DB_URL, { max: 1 });
  worker = postgres(DB_URL, { max: 1 });
  try {
    await holder`SELECT 1 FROM profiles LIMIT 0`;
  } catch {
    await holder.end({ timeout: 1 }).catch(() => {});
    await worker.end({ timeout: 1 }).catch(() => {});
    holder = null;
    worker = null;
  }
});

afterAll(async () => {
  if (holder) {
    for (const accountId of seeded) {
      await holder`DELETE FROM profiles WHERE account_id = ${accountId}`.catch(() => {});
      await holder`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await holder.end({ timeout: 5 });
  }
  if (worker) await worker.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'profile cap row lock is taken (real Postgres, forced ordering)',
  () => {
    it('CRITICAL insertWithLimit BLOCKS while another session holds the account row lock, and completes once it commits. Without that lock two callers both read count < limit and both insert, putting a customer over their tier cap — and no race-based test in this suite can tell, because the count-to-insert window is too narrow to hit reliably.', async () => {
      if (!holder || !worker) {
        if (process.env.CI) {
          throw new Error(
            'real-PG cap-lock test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const h = holder;
      const w = worker;
      const accountId = randomUUID();
      seeded.push(accountId);
      await h`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`cap-lock-${accountId}@test.local`})`;

      const repo = new DrizzleProfilesRepo({
        client: w,
        db: drizzle(w) as unknown as ReturnType<typeof drizzle<typeof schema>>,
        close: async () => {},
      });

      // Explicit choreography rather than a variable assigned inside the
      // callback. TypeScript will not narrow across that boundary — it types the
      // handle as `never` after a null check, and awaiting `never` is what the
      // lint rule for awaiting a non-Promise is there to catch.
      const lockTaken = gate();
      const release = gate();

      const holderTxn = h.begin(async (tx) => {
        // FOR KEY SHARE, deliberately — NOT the FOR UPDATE the repo takes.
        //
        // The lock mode is the whole experiment. An INSERT into `profiles` takes a
        // KEY SHARE lock on the referenced `accounts` row for its foreign key, and
        // KEY SHARE conflicts with FOR UPDATE. So a holder that took FOR UPDATE
        // would block the insert EITHER WAY — measured: that version passed
        // identically with `.for('update')` deleted, because it was observing the
        // FK's lock rather than the repo's.
        //
        // KEY SHARE separates them: it conflicts with the repo's FOR UPDATE (so the
        // guarded path blocks) and is compatible with the FK's own KEY SHARE (so an
        // unguarded path sails through). The assertion below is therefore about the
        // repo's lock and nothing else.
        await tx`SELECT id FROM accounts WHERE id = ${accountId} FOR KEY SHARE`;
        lockTaken.fire();
        await release.promise;
      });

      await lockTaken.promise;

      let settled = false;
      const pending = repo
        .insertWithLimit(
          {
            accountId,
            name: 'cap-lock-probe',
            archetype: 'iphone16pro_ios18_7_safari26_4',
            description: null,
          },
          1,
        )
        .then((r) => {
          settled = true;
          return r;
        });

      // Long enough that an UNBLOCKED insert would certainly have finished — the
      // same call completes in single-digit milliseconds when the row is free.
      // This asserts the ABSENCE of progress, so it needs slack, not precision.
      await delay(600);
      expect(
        settled,
        'insertWithLimit must be waiting on the account row lock, not proceeding past it',
      ).toBe(false);

      release.fire();
      await holderTxn;

      const result = await pending;
      expect(settled).toBe(true);
      expect('record' in result, 'it completes once the lock is free').toBe(true);

      const rows = await h<Array<{ id: string }>>`
        SELECT id FROM profiles WHERE account_id = ${accountId}`;
      expect(rows).toHaveLength(1);
    });
  },
);

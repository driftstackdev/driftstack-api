// MFA activation waits on the account authority row — the lock that serialises it
// against LOGIN, not against another MFA activation.
//
// `completeEnrollmentIfPending` takes two locks, and they do different jobs:
//
//   1. `pg_advisory_xact_lock(hashtext('mfa-credentials:<accountId>'))`
//      — serialises concurrent MFA activations for the same account;
//   2. `SELECT accounts … FOR UPDATE`
//      — the account AUTHORITY row, which web-session minting also locks.
//
// The source explains the second: "This serializes MFA activation with
// password/magic-link/OAuth/reset login: a mint that wins first is retired by the
// epoch advance below; a mint that loses observes the new epoch and refuses its
// stale snapshot."
//
// So the second lock protects a CROSS-PATH property. Losing it means an in-flight
// login mint can interleave with activation and survive on a stale snapshot —
// a session that should have been retired the moment MFA came on.
//
// Measured before writing this: `db-mfa-credential-issuance-concurrency` does not
// detect the FOR UPDATE's removal — 3 passed either way. That is correct rather
// than deficient. It races MFA against MFA, and the ADVISORY lock already
// serialises that, so the row lock is invisible to it. No MFA-vs-MFA test can
// exercise a lock whose purpose is MFA-vs-login.
//
// Forced ordering, with the holder standing in for the login mint's lock on the
// same row. KEY SHARE again: it conflicts with the repo's FOR UPDATE (guarded path
// blocks) and is compatible with what an unguarded path would take.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleMfaRepo } from '../../src/db/mfa-repo.js';
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
    await holder`SELECT 1 FROM account_mfa LIMIT 0`;
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
      await holder`DELETE FROM account_mfa WHERE account_id = ${accountId}`.catch(() => {});
      await holder`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await holder.end({ timeout: 5 });
  }
  if (worker) await worker.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'MFA activation waits on the account authority row (real Postgres, forced ordering)',
  () => {
    it('CRITICAL completeEnrollmentIfPending BLOCKS while a login-style holder has the account authority row, so activation and session minting cannot interleave. Without that wait a mint in flight keeps a snapshot taken before MFA came on — a session that should have been retired by the epoch advance survives it.', async () => {
      if (!holder || !worker) {
        if (process.env.CI) {
          throw new Error(
            'real-PG mfa-authority-lock test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const h = holder;
      const w = worker;
      const accountId = randomUUID();
      seeded.push(accountId);
      await h`
        INSERT INTO accounts (id, email, status)
        VALUES (${accountId}, ${`mfa-auth-${accountId}@test.local`}, 'active')`;

      const repo = new DrizzleMfaRepo({
        client: w,
        db: drizzle(w) as unknown as ReturnType<typeof drizzle<typeof schema>>,
        close: async () => {},
      });

      const lockTaken = gate();
      const release = gate();

      const holderTxn = h.begin(async (tx) => {
        // Stands in for web-session minting, which locks this same row. KEY SHARE
        // rather than FOR UPDATE so the assertion is about the repo's lock and not
        // about any lock the unguarded path would take anyway.
        await tx`SELECT id FROM accounts WHERE id = ${accountId} FOR KEY SHARE`;
        lockTaken.fire();
        await release.promise;
      });

      await lockTaken.promise;

      let settled = false;
      const pending = repo
        .completeEnrollmentIfPending({
          accountId,
          currentWebSessionId: randomUUID(),
          expectedUpdatedAt: new Date('2026-07-01T00:00:00.000Z'),
          hashes: ['a'.repeat(64)],
          now: new Date(),
        })
        .then((r) => {
          settled = true;
          return r;
        });

      // The call reaches the authority lock immediately — the advisory lock ahead
      // of it is uncontended here, which is deliberate: it isolates the row lock.
      // Asserting the ABSENCE of progress, so this wants slack, not precision.
      await delay(600);
      expect(
        settled,
        'completeEnrollmentIfPending must be waiting on the account authority row',
      ).toBe(false);

      release.fire();
      await holderTxn;

      // It proceeds once released. The verdict is `false` because no pending
      // enrollment row exists — irrelevant to the property under test, which is
      // that it WAITED. Asserted anyway so the arm cannot pass on a rejected
      // promise.
      await expect(pending).resolves.toBe(false);
      expect(settled).toBe(true);
    });
  },
);

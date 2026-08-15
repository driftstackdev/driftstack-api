// The token-debit row lock is actually ACQUIRED — forced ordering, not a race.
//
// `debitTokens` is a read-modify-write in application code: it SELECTs the row,
// computes `remaining - tokens` in JS, and writes the result back. Without the
// `FOR UPDATE` on that SELECT, two concurrent debits both read the same starting
// balance and the later UPDATE clobbers the earlier — one debit LOST, which is
// budget over-served and under-billed. The source says exactly that, and calls out
// that it was a bare read-modify-write before.
//
// `db-agent-sessions-concurrency-drizzle` races two debits and asserts
// 100-30-40 = 30, a value unreachable if a debit were lost. That assertion is the
// right SHAPE — it is self-evidencing rather than a bare count — and its pool is
// `max: 5`, so the calls genuinely can overlap. It still does not detect the
// lock's removal: measured, deleting `.for('update')` from `debitTokens` leaves
// that file at 10 passed. On localhost a whole transaction completes in under a
// millisecond, so the second SELECT lands after the first COMMIT and the lost
// update never materialises.
//
// That is the same conclusion the profile cap reached, and it generalises: a
// race-based test in this repo cannot be relied on to demonstrate a lock, because
// the round-trip is faster than the interleaving the defect needs. Forced ordering
// can.
//
// Lock mode, again, is the experiment. The holder takes FOR KEY SHARE on the
// agent_sessions row:
//   - it CONFLICTS with the repo's FOR UPDATE, so the guarded path blocks;
//   - an unguarded path does a plain SELECT (no lock) and then an UPDATE, which
//     takes FOR NO KEY UPDATE — compatible with KEY SHARE — so it sails through.
// A holder taking FOR UPDATE would block both and prove nothing, which is the trap
// that fooled the first version of the profile-cap test.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const TRANSCRIPT_KEY = Buffer.alloc(32, 7).toString('base64');

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
    await holder`SELECT 1 FROM agent_sessions LIMIT 0`;
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
      await holder`DELETE FROM agent_sessions WHERE account_id = ${accountId}`.catch(() => {});
      await holder`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await holder.end({ timeout: 5 });
  }
  if (worker) await worker.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'agent-session token debit takes its row lock (real Postgres, forced ordering)',
  () => {
    it('CRITICAL debitTokens BLOCKS while another session holds the row, and completes once it commits. It computes remaining-minus-tokens in application code, so without the lock two concurrent debits read the same balance and one is LOST — budget over-served and under-billed — and the race-based test cannot show it because a localhost transaction finishes faster than the window needs.', async () => {
      if (!holder || !worker) {
        if (process.env.CI) {
          throw new Error(
            'real-PG debit-lock test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const h = holder;
      const w = worker;
      const accountId = randomUUID();
      seeded.push(accountId);
      await h`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`debit-lock-${accountId}@test.local`})`;

      const repo = new DrizzleAgentSessionsRepo(
        {
          client: w,
          db: drizzle(w) as unknown as ReturnType<typeof drizzle<typeof schema>>,
          close: async () => {},
        },
        { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
      );
      const session = await repo.create({ accountId, tokenBudgetTotal: 100 });

      const lockTaken = gate();
      const release = gate();

      const holderTxn = h.begin(async (tx) => {
        // KEY SHARE, not FOR UPDATE — see the header. This conflicts with the
        // repo's FOR UPDATE and with nothing else the unguarded path would do.
        await tx`SELECT id FROM agent_sessions WHERE id = ${session.id} FOR KEY SHARE`;
        lockTaken.fire();
        await release.promise;
      });

      await lockTaken.promise;

      let settled = false;
      const pending = repo.debitTokens(session.id, 30).then((r) => {
        settled = true;
        return r;
      });

      // Asserting the ABSENCE of progress, so it wants slack rather than
      // precision: the same debit completes in single-digit milliseconds when the
      // row is free.
      await delay(600);
      expect(
        settled,
        'debitTokens must be waiting on the session row lock, not reading a balance past it',
      ).toBe(false);

      release.fire();
      await holderTxn;

      const debited = await pending;
      expect(settled).toBe(true);
      expect(debited.tokenBudgetRemaining, 'the debit lands once the lock is free').toBe(70);
    });
  },
);

// Only credit that has started, has not expired, is not revoked and is not held
// is spendable — judged on the database's clock.
//
// `spendableMicro` is what a new task could draw on. It must agree with the
// database's own reading of "spendable" (the debt-beside-free-credit check uses
// the same predicate), and "now" must be the DATABASE's now(), never this
// process's: every time decision in the credits design is taken on one clock.
//
// The clock is proven by an arm that tells the two apart. Inside a transaction
// Postgres' now() is fixed at the transaction's start, so a lot that starts a
// moment after that is not spendable for the rest of the transaction however
// long it runs — while a reader on this process's clock would see it start.
// The same lot is spendable to the next transaction. The lot is written from a
// second connection WHILE that transaction is open, starting at the second
// connection's clock_timestamp(): after the transaction's start by
// construction, and already past on the wall clock when it is read. So the arm
// needs no sleep and has no timing margin to lose on a slow machine (an earlier
// version started the lot 1.5 s ahead and failed if its first read came later).
//
// The boundaries are the ones the predicate states: `starts_at <= now()` and
// `now() < expires_at`, set to now() exactly.
//
// Not covered here: credit HELD by a running task (`remaining − held`). Nothing
// can hold credit until the reservation holds exist, and the database refuses
// any other write to `held_micro`; the arm for it belongs with the holds.

import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleCreditLedgerRepo } from '../../src/db/credit-ledger-repo.js';
import {
  MICRO,
  fundedLot,
  insertLot,
  newCreditAccount,
  openLedgerDatabase,
} from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_ledger_spendable';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let database: Database | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 2 });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await database?.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function repo(): DrizzleCreditLedgerRepo {
  if (database === null) throw new Error('isolated database unreachable');
  return new DrizzleCreditLedgerRepo(database);
}

describe.skipIf(!RUN_DB_TESTS)(
  'only started, unexpired, unrevoked credit is spendable, on the database clock',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      expect(database).not.toBeNull();
    });

    it('CRITICAL of six lots only the two live, funded ones count: a future-dated, an expired, a revoked and an empty lot add nothing, and neither does another account', async () => {
      const accountId = await newCreditAccount(db());
      await fundedLot(db(), accountId, { credits: 10 });
      await fundedLot(db(), accountId, { kind: 'top_up', credits: 5 });
      await fundedLot(db(), accountId, { credits: 20, starts: "now() + interval '1 hour'" });
      await fundedLot(db(), accountId, {
        credits: 30,
        starts: "now() - interval '2 days'",
        expires: "now() - interval '1 hour'",
      });
      const revoked = await fundedLot(db(), accountId, { credits: 40 });
      await db()`UPDATE credit_lots SET revoked_at = now() WHERE id = ${revoked}::uuid`;
      await insertLot(db(), accountId, { credits: 50 });

      const neighbour = await newCreditAccount(db());
      await fundedLot(db(), neighbour, { credits: 70 });

      expect(await repo().spendableMicro(accountId)).toBe(15 * MICRO);
      expect(await repo().spendableMicro(neighbour)).toBe(70 * MICRO);
      const nobody = await newCreditAccount(db());
      expect(await repo().spendableMicro(nobody), 'no lots at all').toBe(0);
    });

    it('CRITICAL a future-dated lot becomes spendable when its start passes on the database clock — and not inside a transaction that began before it', async () => {
      const accountId = await newCreditAccount(db());
      const r = repo();

      const inside = await r.transaction(async (tx) => {
        // The transaction has begun: its now() is fixed from here on.
        const before = await r.spendableMicro(accountId, tx);
        // Another connection adds a funded lot starting at ITS clock — after
        // this transaction's start, since this transaction has already run a
        // statement — and commits it.
        const lotId = await fundedLot(db(), accountId, {
          credits: 20,
          starts: 'clock_timestamp()',
        });
        const [clock] = await tx.execute<{ seen: boolean; ahead: boolean; passed: boolean }>(sql`
          SELECT count(*) = 1 AS seen,
                 bool_and(now() < starts_at) AS ahead,
                 bool_and(clock_timestamp() >= starts_at) AS passed
            FROM credit_lots WHERE id = ${lotId}`);
        const after = await r.spendableMicro(accountId, tx);
        return { before, after, clock };
      });
      // The instrument discriminates: this transaction SEES the committed lot,
      // its start is ahead of the transaction's now(), and the wall clock is
      // past it — so a reader on any clock but the transaction's would count it.
      expect(
        inside.clock,
        'the lot is visible, not yet started on now(), started on the wall clock',
      ).toEqual({
        seen: true,
        ahead: true,
        passed: true,
      });
      expect(
        { before: inside.before, after: inside.after },
        'now() is the transaction start, held for its length',
      ).toEqual({ before: 0, after: 0 });
      expect(await r.spendableMicro(accountId), 'a new transaction sees it started').toBe(
        20 * MICRO,
      );
    });

    it('CRITICAL the boundaries are the stated ones: a lot starting at now() exactly is spendable, a lot expiring at now() exactly is not', async () => {
      const accountId = await newCreditAccount(db());
      const r = repo();
      const seen = await r.transaction(async (tx) => {
        // Inserted in THIS transaction, so now() here is the instant compared.
        const [starting] = await tx.execute<{ id: string }>(sql`
          INSERT INTO credit_lots (account_id, kind, spend_rank, grant_key, granted_micro, starts_at, expires_at)
          VALUES (${accountId}, 'adjustment', 1, ${`edge:start:${accountId}`}, ${3 * MICRO},
                  now(), now() + interval '1 day')
          RETURNING id`);
        const [expiring] = await tx.execute<{ id: string }>(sql`
          INSERT INTO credit_lots (account_id, kind, spend_rank, grant_key, granted_micro, starts_at, expires_at)
          VALUES (${accountId}, 'adjustment', 1, ${`edge:expire:${accountId}`}, ${5 * MICRO},
                  now() - interval '1 day', now())
          RETURNING id`);
        for (const lot of [starting, expiring]) {
          if (lot === undefined) throw new Error('lot insert returned nothing');
          await r.append(
            {
              accountId,
              kind: 'grant',
              lotId: lot.id,
              amountMicro: lot === starting ? 3 * MICRO : 5 * MICRO,
              idempotencyKey: `grant:${lot.id}`,
            },
            tx,
          );
        }
        return r.spendableMicro(accountId, tx);
      });
      expect(seen, 'the lot starting at now() counts; the one expiring at now() does not').toBe(
        3 * MICRO,
      );
    });
  },
);

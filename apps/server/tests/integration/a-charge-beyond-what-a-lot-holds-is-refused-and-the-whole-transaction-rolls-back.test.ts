// A charge beyond what a lot holds is refused, and the whole transaction rolls
// back with it.
//
// A ledger row that takes more from a lot than it has left would drive
// `remaining_micro` below zero; the lot's CHECK refuses that, and because the
// row and its application are one statement, the row is refused with it. In a
// transaction that already wrote other rows, the refusal aborts the transaction
// and every earlier row goes too — so a multi-row movement (a settle walking
// several lots) can never land half-applied.
//
// The same bounds hold the other way: a lot never holds more than it was
// granted (a second grant is refused even under a new key), and an account's
// debt never goes below zero.
//
// The ceiling alone is not enough for that. Once part of a lot is spent there
// is room under it, and a second funding row under a new key would refill it:
// the lot would have given more than it was granted, and the refund clawback,
// which takes its share of `granted − expired`, would be computed on a number
// that is no longer what the lot received. So a lot is FUNDED ONCE: a second
// grant, proration grant or top-up row naming it is refused, checked after the
// lot's row lock so that two connections racing to fund it cannot both pass.
//
// Proven with raw SQL, then through the repository in a transaction of its own.
// A task charge needs a reservation that cannot exist yet, so the charge here is
// an expiry: the same lot CHECK decides both.

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleCreditLedgerRepo } from '../../src/db/credit-ledger-repo.js';
import { refusal } from './_helpers/database-refusal.js';
import {
  MICRO,
  debtOf,
  fundedLot,
  gate,
  insertLot,
  ledgerCount,
  newCreditAccount,
  openLedgerDatabase,
  remainingOf,
  repoRefusal,
  waitUntilBlocked,
} from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_ledger_bounds';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let database: Database | null = null;
/** Two connections of their own, one per racing writer. */
const racers: postgres.Sql[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 2 });
  for (let i = 0; i < 2; i += 1)
    racers.push(postgres(opened.url, { max: 1, onnotice: () => undefined }));
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await database?.close().catch(() => {});
  await Promise.all(racers.map((r) => r.end({ timeout: 5 }).catch(() => {})));
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function racer(i: 0 | 1): postgres.Sql {
  const r = racers[i];
  if (r === undefined) throw new Error('isolated database unreachable');
  return r;
}

function repo(): DrizzleCreditLedgerRepo {
  if (database === null) throw new Error('isolated database unreachable');
  return new DrizzleCreditLedgerRepo(database);
}

/**
 * The CHECK that names an over-charge. Remaining below zero breaks two lot
 * CHECKs at once — `remaining_micro >= 0` and `held_micro <= remaining_micro` —
 * and Postgres checks a table's constraints in name order, so it is
 * `credit_lots_held_bounds` that it reports. A lot granted more than its grant
 * breaks only `credit_lots_remaining_bounds`.
 */
const OVER_CHARGE = 'credit_lots_held_bounds';

async function take(
  sql: postgres.Sql | postgres.TransactionSql,
  accountId: string,
  lotId: string,
  credits: number,
  key: string,
): Promise<void> {
  await sql`
    INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
    VALUES (${accountId}::uuid, 'expiry', ${lotId}::uuid, ${-credits * MICRO}, ${key})`;
}

describe.skipIf(!RUN_DB_TESTS)(
  'a charge beyond what a lot holds is refused and the whole transaction rolls back',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      expect(database).not.toBeNull();
    });

    it('CRITICAL taking more than a lot has left is refused by the lot CHECK, and nothing moves', async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await fundedLot(db(), accountId, { credits: 10 });
      const refused = await refusal(() => take(db(), accountId, lotId, 11, 'over'));
      expect(refused).toMatchObject({ code: '23514', constraint: OVER_CHARGE });
      expect(await remainingOf(db(), lotId)).toBe(10 * MICRO);
      expect(await ledgerCount(db(), accountId), 'only the grant row').toBe(1);

      // The boundary: exactly what is left is accepted, and leaves nothing.
      await take(db(), accountId, lotId, 10, 'all');
      expect(await remainingOf(db(), lotId)).toBe(0);
      const again = await refusal(() => take(db(), accountId, lotId, 1, 'one-more'));
      expect(again.constraint).toBe(OVER_CHARGE);
    });

    it('CRITICAL in a transaction that already moved credit, an over-charge aborts the WHOLE transaction — the earlier rows are rolled back with it', async () => {
      const accountId = await newCreditAccount(db());
      const first = await fundedLot(db(), accountId, { credits: 10 });
      const second = await fundedLot(db(), accountId, { credits: 10 });

      const refused = await refusal(() =>
        db().begin(async (tx) => {
          await take(tx, accountId, first, 4, 'walk:1');
          await take(tx, accountId, second, 10, 'walk:2');
          // Inside the transaction both have applied.
          expect(await remainingOf(tx, first)).toBe(6 * MICRO);
          expect(await remainingOf(tx, second)).toBe(0);
          await take(tx, accountId, first, 7, 'walk:3');
        }),
      );
      expect(refused).toMatchObject({ code: '23514', constraint: OVER_CHARGE });
      expect(await remainingOf(db(), first), 'the first take rolled back').toBe(10 * MICRO);
      expect(await remainingOf(db(), second), 'the second take rolled back').toBe(10 * MICRO);
      expect(await ledgerCount(db(), accountId), 'only the two grant rows survive').toBe(2);
    });

    it('CRITICAL a lot never holds more than it was granted: a second grant is refused even under a new key', async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await fundedLot(db(), accountId, { credits: 10 });
      const refused = await refusal(
        () => db()`
          INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
          VALUES (${accountId}::uuid, 'grant', ${lotId}::uuid, ${MICRO}, 'grant-again')`,
      );
      expect(refused).toMatchObject({ code: '23514', constraint: 'credit_lots_remaining_bounds' });
      expect(await remainingOf(db(), lotId)).toBe(10 * MICRO);
    });

    it('CRITICAL a lot is funded ONCE: after part of it is spent, a second funding row under a new key is refused whatever its kind — the ceiling alone would let it refill, and the lot would have given more than it was granted', async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await fundedLot(db(), accountId, { credits: 10 });
      await take(db(), accountId, lotId, 4, 'spent');
      for (const kind of ['grant', 'proration_grant', 'top_up']) {
        const refused = await refusal(
          () => db()`
            INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
            VALUES (${accountId}::uuid, ${kind}, ${lotId}::uuid, ${4 * MICRO}, ${`again:${kind}`})`,
          `a second ${kind} into a lot with room for it`,
        );
        expect(refused.code, kind).toBe('23505');
        expect(refused.message, kind).toBe(`credit lot ${lotId} is already funded`);
      }
      expect(await remainingOf(db(), lotId), 'still 10 − 4').toBe(6 * MICRO);
      const [funded] = await db()<Array<{ n: string }>>`
        SELECT sum(lot_delta_micro)::text AS n FROM credit_ledger
         WHERE lot_id = ${lotId}::uuid AND lot_delta_micro > 0`;
      expect(Number(funded?.n), 'all the lot ever received').toBe(10 * MICRO);

      // Positive controls. The first funding row replayed under ITS key is a
      // no-op, not a refusal; another lot is funded as usual; and an admin
      // correction (an adjustment, not a funding row) may still move this lot.
      const replay = await db()`
        INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
        VALUES (${accountId}::uuid, 'grant', ${lotId}::uuid, ${10 * MICRO}, ${`grant:${lotId}`})
        ON CONFLICT (account_id, idempotency_key) DO NOTHING RETURNING id`;
      expect(replay).toHaveLength(0);
      const other = await fundedLot(db(), accountId, { credits: 3 });
      expect(await remainingOf(db(), other)).toBe(3 * MICRO);
      await db()`
        INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key, actor, reason)
        VALUES (${accountId}::uuid, 'adjustment', ${lotId}::uuid, ${MICRO}, 'correction', 'admin', 'correction')`;
      expect(await remainingOf(db(), lotId)).toBe(7 * MICRO);
    });

    it('CRITICAL RACE (two connections): two funding rows for one empty lot under different keys — the second waits for the first, then is refused, and the lot is funded once', async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await insertLot(db(), accountId, { credits: 10 });
      const fund = (sql: postgres.TransactionSql, key: string) => sql`
        INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
        VALUES (${accountId}::uuid, 'grant', ${lotId}::uuid, ${4 * MICRO}, ${key})`;
      const [pidRow] = await racer(1)<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      const secondPid = pidRow?.pid ?? -1;

      const firstWrote = gate();
      const release = gate();
      const first = racer(0).begin(async (tx) => {
        await fund(tx, 'fund:a');
        firstWrote.open();
        await release.opened;
      });
      await firstWrote.opened;
      const second = refusal(
        () => racer(1).begin((tx) => fund(tx, 'fund:b')),
        'a second funding row, racing the first',
      );
      try {
        await waitUntilBlocked(db(), secondPid);
      } finally {
        release.open();
      }
      await first;
      const refused = await second;
      expect(refused).toMatchObject({
        code: '23505',
        message: `credit lot ${lotId} is already funded`,
      });
      expect(await remainingOf(db(), lotId)).toBe(4 * MICRO);
      expect(await ledgerCount(db(), accountId)).toBe(1);
    });

    it('CRITICAL debt never goes below zero: forgiving or repaying more than is owed is refused', async () => {
      const accountId = await newCreditAccount(db());
      await db()`
        INSERT INTO credit_ledger (account_id, kind, debt_delta_micro, idempotency_key, reason)
        VALUES (${accountId}::uuid, 'debt_incurred', ${3 * MICRO}, 'owe', 'plan_change')`;
      const forgive = await refusal(
        () => db()`
          INSERT INTO credit_ledger (account_id, kind, debt_delta_micro, idempotency_key)
          VALUES (${accountId}::uuid, 'adjustment', ${-4 * MICRO}, 'forgive-too-much')`,
      );
      expect(forgive).toMatchObject({
        code: '23514',
        constraint: 'credit_accounts_debt_nonnegative',
      });
      expect(await debtOf(db(), accountId)).toBe(3 * MICRO);

      // Repaying from a lot: the lot has plenty, the debt does not. The lot is
      // funded inside the same transaction, because a funded lot committed on
      // its own would sit beside the debt, which the database refuses at COMMIT.
      const repay = await refusal(() =>
        db().begin(async (tx) => {
          const lotId = await fundedLot(tx, accountId, { credits: 10 });
          await tx`
            INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, debt_delta_micro, idempotency_key)
            VALUES (${accountId}::uuid, 'debt_repayment', ${lotId}::uuid, ${-4 * MICRO}, ${-4 * MICRO}, 'repay-too-much')`;
        }),
      );
      expect(repay).toMatchObject({
        code: '23514',
        constraint: 'credit_accounts_debt_nonnegative',
      });
      expect(await debtOf(db(), accountId)).toBe(3 * MICRO);
    });

    it('through the repository: an over-charge throws, and a repository transaction that wrote rows before it rolls them all back', async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await fundedLot(db(), accountId, { credits: 10 });
      const r = repo();

      const alone = await repoRefusal(() =>
        r.append({
          accountId,
          kind: 'expiry',
          lotId,
          amountMicro: 11 * MICRO,
          idempotencyKey: 'repo-over',
        }),
      );
      expect(alone).toMatchObject({ code: '23514', constraint: OVER_CHARGE });

      const inTransaction = await repoRefusal(() =>
        r.transaction(async (tx) => {
          await r.lockAccount(tx, accountId);
          const ok = await r.append(
            {
              accountId,
              kind: 'expiry',
              lotId,
              amountMicro: 4 * MICRO,
              idempotencyKey: 'repo-walk:1',
            },
            tx,
          );
          expect(ok.applied).toBe(true);
          await r.append(
            {
              accountId,
              kind: 'adjustment',
              lotId,
              lotDeltaMicro: -7 * MICRO,
              idempotencyKey: 'repo-walk:2',
            },
            tx,
          );
        }),
      );
      expect(inTransaction).toMatchObject({ code: '23514', constraint: OVER_CHARGE });
      expect(await remainingOf(db(), lotId)).toBe(10 * MICRO);
      expect(await ledgerCount(db(), accountId)).toBe(1);
    });
  },
);

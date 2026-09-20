// A lot expires into exactly one expiry row at its end.
//
// Included credits belong to their month. When the month's window ends, what is
// left of its lot is no longer spendable — every reader checks the term, so that
// is true the instant the term ends, with no job involved. What the refresh adds
// is the BOOKKEEPING: one `expiry` ledger row that takes the unspent remainder
// out of the lot, so the ledger still sums to the balances and a customer's
// history says where the credits went.
//
// One row, for exactly the remainder, once: a second refresh, a sweep and a
// boundary job all arriving together must not write it twice (that race is in
// two-refreshes-of-one-account-at-once-grant-the-month-exactly-once), and a lot
// whose term has NOT ended must not be touched. "Ended" and "spendable" are
// judged on the same clock and meet exactly: at the instant a lot's term ends it
// is both unspendable and expirable, with no instant that is neither.
//
// A lot part-held by a running task gives up only `remaining − held`, and the
// held part expires later, in a row of its own, once the task gives it back.
// Nothing WRITES a hold until reservations exist, so the arm that proves this
// places one the way the holds will — from inside a trigger, with the flag
// `credit_lots_guard` demands — rather than waiting for them. With holds always
// 0, `remaining − held` and `remaining` are the same number and the counted key
// `expiry:<lot>:<n>` is never asked for a second row: both would be free to
// disappear, and the second would lose the released credit outright.

import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fundedLot,
  newAccount,
  openLedgerDatabase,
  remainingOf,
} from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  grantsHarness,
  insertWindow,
  ledgerOf,
  newAccountOn,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_lot_expiry';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  harness = grantsHarness(opened.url);
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await harness?.database.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function h(): GrantsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}

/** A month window that has ENDED, with its funded monthly lot: last month's credits. */
async function endedMonth(accountId: string, credits: number): Promise<string> {
  const windowId = await insertWindow(db(), accountId, {
    start: "date_trunc('second', now()) - interval '31 days'",
    end: "date_trunc('second', now()) - interval '1 minute'",
    credits,
  });
  const [lot] = await db()<Array<{ id: string }>>`
    INSERT INTO credit_lots (account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at)
    SELECT account_id, 'monthly', 0, id, 'window:' || id, level_micro, window_start, window_end
      FROM credit_windows WHERE id = ${windowId}::uuid
    RETURNING id`;
  if (lot === undefined) throw new Error('lot insert returned nothing');
  await db()`
    INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
    SELECT account_id, 'grant', id, granted_micro, 'grant:' || id FROM credit_lots WHERE id = ${lot.id}::uuid`;
  return lot.id;
}

/**
 * Put `micro` of a lot under a running task's hold, the way the reservation
 * holds will (a later migration): from INSIDE a trigger, so `pg_trigger_depth()`
 * is 2 by the time `credit_lots_guard` sees the UPDATE, with the flag that guard
 * requires raised. Nothing else can move `held_micro` at all — which is why this
 * exists: with holds always 0, `remaining − held` and `remaining` are the same
 * number, and the clause `expireDueLots` subtracts would be free to disappear.
 *
 * ⛔ THIS IS THE BYPASS 0128's HEADER NAMES, used deliberately and only here.
 * It is closed in production by the role the application connects as, not by the
 * guard; a test owns its database, so it can stand in for the migration that has
 * not landed yet.
 */
async function holdOnLot(lotId: string, micro: number): Promise<void> {
  await db().begin(async (tx) => {
    await tx.unsafe(`CREATE TEMP TABLE hold_poke (n int) ON COMMIT DROP`);
    await tx.unsafe(
      `CREATE OR REPLACE FUNCTION pg_temp.place_hold() RETURNS trigger LANGUAGE plpgsql AS $fn$
       BEGIN
         PERFORM set_config('driftstack.credit_hold_apply', 'on', true);
         UPDATE credit_lots SET held_micro = ${String(micro)} WHERE id = '${lotId}'::uuid;
         PERFORM set_config('driftstack.credit_hold_apply', 'off', true);
         RETURN NEW;
       END $fn$`,
    );
    await tx.unsafe(
      `CREATE TRIGGER place_hold AFTER INSERT ON hold_poke
         FOR EACH ROW EXECUTE FUNCTION pg_temp.place_hold()`,
    );
    await tx.unsafe(`INSERT INTO hold_poke VALUES (1)`);
  });
}

describe.skipIf(!RUN_DB_TESTS)('a lot expires into exactly one expiry row at its end', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  it('CRITICAL monthly credits expire when their window ends: one expiry row for everything unspent, the lot left empty, and a second and third refresh write nothing more', async () => {
    const accountId = await newAccountOn(db(), 'api_starter');
    await h().ledger.ensureAccount(accountId);
    const lotId = await endedMonth(accountId, 3_000);

    const first = await h().grants.refreshCredits(accountId);
    expect(first.expired).toEqual([{ lotId, expiredMicro: 3_000 * MICRO }]);
    expect(await remainingOf(db(), lotId)).toBe(0);

    expect((await h().grants.refreshCredits(accountId)).expired).toEqual([]);
    expect((await h().grants.refreshCredits(accountId)).expired).toEqual([]);
    expect((await ledgerOf(db(), accountId)).filter((e) => e.kind === 'expiry')).toEqual([
      {
        kind: 'expiry',
        lot_id: lotId,
        lot_delta_micro: String(-3_000 * MICRO),
        debt_delta_micro: '0',
        idempotency_key: `expiry:${lotId}:1`,
      },
    ]);
  });

  it('CRITICAL a lot a running task is part way through gives up only what is FREE. The held part is credit the task may still be charged from: expiring it would take credit out of a lot that is about to be charged, and the charge would then drive the lot below zero and abort the turn. It expires later, in a SECOND row with a key of its own, when the hold is released — which is what the counted key is for', async () => {
    const accountId = await newAccountOn(db(), 'api_starter');
    await h().ledger.ensureAccount(accountId);
    const lotId = await endedMonth(accountId, 3_000);
    await holdOnLot(lotId, 1_200 * MICRO);

    const first = await h().grants.refreshCredits(accountId);
    expect(first.expired, 'only remaining − held').toEqual([
      { lotId, expiredMicro: 1_800 * MICRO },
    ]);
    expect(await remainingOf(db(), lotId), 'the held part is still in the lot').toBe(1_200 * MICRO);
    // While the hold stands there is nothing left to expire, however often it runs.
    expect((await h().grants.refreshCredits(accountId)).expired).toEqual([]);

    // The task finishes and gives its hold back. The rest expires now, under
    // `expiry:<lot>:2` — a fixed key per lot would silently write nothing here.
    await holdOnLot(lotId, 0);
    const second = await h().grants.refreshCredits(accountId);
    expect(second.expired, 'the released remainder expires too').toEqual([
      { lotId, expiredMicro: 1_200 * MICRO },
    ]);
    expect(await remainingOf(db(), lotId)).toBe(0);
    expect(
      (await ledgerOf(db(), accountId))
        .filter((e) => e.kind === 'expiry')
        .map((e) => `${e.idempotency_key}=${e.lot_delta_micro}`),
    ).toEqual([
      `expiry:${lotId}:1=${String(-1_800 * MICRO)}`,
      `expiry:${lotId}:2=${String(-1_200 * MICRO)}`,
    ]);
  });

  it('a lot that was partly spent gives up exactly what is left, not what it was granted', async () => {
    const accountId = await newAccount(db());
    await h().ledger.ensureAccount(accountId);
    const lotId = await fundedLot(db(), accountId, {
      credits: 100,
      starts: "now() - interval '20 days'",
      expires: "now() - interval '1 second'",
    });
    // 37.5 credits went somewhere while the lot was live.
    await h().ledger.append({
      accountId,
      kind: 'adjustment',
      lotId,
      lotDeltaMicro: -37_500_000,
      idempotencyKey: 'spent-while-live',
    });

    const { expired } = await h().grants.refreshCredits(accountId);
    expect(expired).toEqual([{ lotId, expiredMicro: 62_500_000 }]);
    expect(await remainingOf(db(), lotId)).toBe(0);
  });

  it('CRITICAL a lot whose term has NOT ended is not touched — not one a second from its end, not one that has not started, not one that is simply live — and a lot already empty writes no row', async () => {
    const accountId = await newAccount(db());
    await h().ledger.ensureAccount(accountId);
    const live = await fundedLot(db(), accountId, { credits: 10 });
    const almost = await fundedLot(db(), accountId, {
      credits: 20,
      expires: "now() + interval '30 seconds'",
    });
    const notStarted = await fundedLot(db(), accountId, {
      credits: 30,
      starts: "now() + interval '1 day'",
      expires: "now() + interval '31 days'",
    });
    const emptyAndOver = await fundedLot(db(), accountId, {
      credits: 40,
      starts: "now() - interval '20 days'",
      expires: "now() - interval '1 day'",
    });
    await h().ledger.append({
      accountId,
      kind: 'adjustment',
      lotId: emptyAndOver,
      lotDeltaMicro: -40 * MICRO,
      idempotencyKey: 'all-spent',
    });

    expect((await h().grants.refreshCredits(accountId)).expired).toEqual([]);
    expect(await remainingOf(db(), live)).toBe(10 * MICRO);
    expect(await remainingOf(db(), almost)).toBe(20 * MICRO);
    expect(await remainingOf(db(), notStarted)).toBe(30 * MICRO);
    expect((await ledgerOf(db(), accountId)).filter((e) => e.kind === 'expiry')).toEqual([]);
  });

  it('CRITICAL "expired" and "spendable" meet exactly. For a lot whose term ends at THIS transaction’s now(): it is not spendable, and it is expired — in the same transaction, on the same clock. There is no instant at which credit is neither', async () => {
    const accountId = await newAccount(db());
    await h().ledger.ensureAccount(accountId);

    const seen = await h().ledger.transaction(async (tx) => {
      await h().ledger.lockAccount(tx, accountId);
      // now() is the transaction's start for every statement in it, so this lot
      // ends at precisely the instant every predicate below compares against.
      await tx.execute(sql`
        INSERT INTO credit_lots (account_id, kind, spend_rank, grant_key, granted_micro, starts_at, expires_at)
        VALUES (${accountId}::uuid, 'adjustment', 1, 'ends-exactly-now', 5000000, now() - interval '1 day', now())`);
      await tx.execute(sql`
        INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
        SELECT account_id, 'grant', id, granted_micro, 'grant-ends-exactly-now'
          FROM credit_lots WHERE grant_key = 'ends-exactly-now'`);
      const spendable = await h().ledger.spendableMicro(accountId, tx);
      const expired = await h().ledger.expireDueLots(tx, accountId);
      return { spendable, expired: expired.map((e) => e.expiredMicro) };
    });
    expect(seen).toEqual({ spendable: 0, expired: [5_000_000] });
  });

  it('two lots of one account that ended together each get their own row, in one refresh', async () => {
    const accountId = await newAccount(db());
    await h().ledger.ensureAccount(accountId);
    const a = await fundedLot(db(), accountId, {
      credits: 5,
      starts: "now() - interval '9 days'",
      expires: "now() - interval '2 days'",
    });
    const b = await fundedLot(db(), accountId, {
      kind: 'top_up',
      credits: 7,
      starts: "now() - interval '9 days'",
      expires: "now() - interval '1 day'",
    });
    const { expired } = await h().grants.refreshCredits(accountId);
    expect(expired).toEqual([
      { lotId: a, expiredMicro: 5 * MICRO },
      { lotId: b, expiredMicro: 7 * MICRO },
    ]);
  });

  it('CRITICAL the expiry sweep finds every account holding expired credit and handles them ONE AT A TIME, each in its own transaction: three accounts, three rows, and a walk that pages by account id and then starts over', async () => {
    // Fresh accounts only: the arms above left nothing unexpired-and-due behind.
    expect(await h().windows.accountsWithDueLots({ afterAccountId: null, limit: 100 })).toEqual([]);

    const accounts: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const accountId = await newAccount(db());
      await h().ledger.ensureAccount(accountId);
      await fundedLot(db(), accountId, {
        credits: 10 + i,
        starts: "now() - interval '9 days'",
        expires: "now() - interval '1 hour'",
      });
      accounts.push(accountId);
    }
    const inOrder = [...accounts].sort();
    expect(await h().windows.accountsWithDueLots({ afterAccountId: null, limit: 100 })).toEqual(
      inOrder,
    );

    // A full batch of two: come back for the rest, from where this one stopped.
    const first = await h().grants.sweepExpiry({ afterAccountId: null, limit: 2 });
    expect(first).toEqual({
      visited: 2,
      granted: 0,
      expired: 2,
      failed: 0,
      nextAfterAccountId: inOrder[1],
    });
    const second = await h().grants.sweepExpiry({
      afterAccountId: first.nextAfterAccountId,
      limit: 2,
    });
    expect(second).toEqual({
      visited: 1,
      granted: 0,
      expired: 1,
      failed: 0,
      nextAfterAccountId: null,
    });
    expect(await h().windows.accountsWithDueLots({ afterAccountId: null, limit: 100 })).toEqual([]);
    for (const accountId of accounts) {
      expect(
        (await ledgerOf(db(), accountId)).filter((e) => e.kind === 'expiry'),
        accountId,
      ).toHaveLength(1);
    }
  });
});

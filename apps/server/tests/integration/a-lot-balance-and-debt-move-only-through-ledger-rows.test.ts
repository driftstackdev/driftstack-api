// A lot's balance and an account's debt move only through ledger rows.
//
// `credit_lots.remaining_micro`, `credit_lots.held_micro` and
// `credit_accounts.debt_micro` are written by triggers and by nothing else, so
// every credit that exists is the sum of its ledger rows. This file proves that
// against the DATABASE with raw SQL — the repository's own checks would stop a
// bad write before Postgres saw it, and Postgres is the last line:
//
//   · a lot is born empty and an account born owing nothing, whatever the
//     INSERT said;
//   · a ledger row applies itself (the positive control for every refusal);
//   · a direct UPDATE of any of the three columns is refused — including by a
//     session that raises the apply trigger's flag itself, which is why the
//     guard also requires the write to come from inside a trigger;
//   · a lot's terms never change, and a revoked lot stays revoked;
//   · a ledger row cannot move another account's lot, and every ledger row
//     needs the account's credit row;
//   · and the apply trigger moves the REAL lot even beside a session's
//     temporary table of the same name (its search_path is pinned).
//
// Each refusal is asserted by SQLSTATE and message, beside an accepted
// neighbour, so "refused" means refused by THIS rule.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleCreditLedgerRepo } from '../../src/db/credit-ledger-repo.js';
import { creditAccounts, creditLots } from '../../src/db/schema.js';
import { inRolledBackTransaction, refusal } from './_helpers/database-refusal.js';
import {
  MICRO,
  debtOf,
  fundedLot,
  grantAll,
  insertLot,
  ledgerCount,
  newAccount,
  newCreditAccount,
  openLedgerDatabase,
  remainingOf,
  repoRefusal,
} from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_ledger_only_moves';
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

const GUARD = '55000';

describe.skipIf(!RUN_DB_TESTS)('a lot balance and debt move only through ledger rows', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    expect(database).not.toBeNull();
  });

  it('CRITICAL a lot is born empty and an account born owing nothing, whatever the INSERT said', async () => {
    const accountId = await newAccount(db());
    const [account] = await db()<Array<{ debt: string }>>`
      INSERT INTO credit_accounts (account_id, debt_micro) VALUES (${accountId}::uuid, 999000000)
      RETURNING debt_micro::text AS debt`;
    expect(Number(account?.debt), 'debt written on insert').toBe(0);

    const [lot] = await db()<Array<{ remaining: string; held: string; granted: string }>>`
      INSERT INTO credit_lots (account_id, kind, spend_rank, grant_key, granted_micro,
                               remaining_micro, held_micro, starts_at, expires_at)
      VALUES (${accountId}::uuid, 'adjustment', 1, ${`born-empty:${accountId}`}, ${50 * MICRO},
              ${50 * MICRO}, ${20 * MICRO}, now() - interval '1 hour', now() + interval '1 day')
      RETURNING remaining_micro::text AS remaining, held_micro::text AS held,
                granted_micro::text AS granted`;
    expect(
      { remaining: Number(lot?.remaining), held: Number(lot?.held) },
      'remaining and held written on insert — a lot holds credit only once a grant row funds it',
    ).toEqual({ remaining: 0, held: 0 });
    expect(Number(lot?.granted), 'the grant amount is a term, and is kept').toBe(50 * MICRO);
  });

  it('CRITICAL a ledger row applies itself: a grant funds its lot and debt incurred raises the debt — the positive control for every refusal below', async () => {
    const accountId = await newCreditAccount(db());
    const lotId = await insertLot(db(), accountId, { credits: 40 });
    expect(await remainingOf(db(), lotId)).toBe(0);
    await grantAll(db(), accountId, lotId);
    expect(await remainingOf(db(), lotId), 'after the grant row').toBe(40 * MICRO);

    const debtor = await newCreditAccount(db());
    await db()`
      INSERT INTO credit_ledger (account_id, kind, debt_delta_micro, idempotency_key, reason)
      VALUES (${debtor}::uuid, 'debt_incurred', ${7 * MICRO}, 'debt:1', 'payment_reversed')`;
    expect(await debtOf(db(), debtor), 'after the debt row').toBe(7 * MICRO);
  });

  it('CRITICAL a direct UPDATE of remaining_micro is refused, and the balance does not move', async () => {
    const accountId = await newCreditAccount(db());
    const lotId = await fundedLot(db(), accountId, { credits: 10 });

    const refused = await refusal(
      () => db()`UPDATE credit_lots SET remaining_micro = 1 WHERE id = ${lotId}::uuid`,
      'a direct write to remaining_micro',
    );
    expect(refused.code).toBe(GUARD);
    expect(refused.message).toBe('credit_lots.remaining_micro moves only through credit_ledger');
    expect(await remainingOf(db(), lotId)).toBe(10 * MICRO);

    // An UPDATE that leaves the balance as it is is not a balance move, and is
    // accepted: the guard is about the value, not about touching the row.
    await db()`UPDATE credit_lots SET remaining_micro = remaining_micro WHERE id = ${lotId}::uuid`;
    expect(await remainingOf(db(), lotId)).toBe(10 * MICRO);
  });

  it("CRITICAL a session that raises the ledger's apply flag itself is still refused — the write must come from inside the apply trigger, not only carry its flag", async () => {
    const accountId = await newCreditAccount(db());
    const lotId = await fundedLot(db(), accountId, { credits: 10 });

    for (const [what, flag, statement] of [
      [
        'remaining_micro',
        'driftstack.credit_ledger_apply',
        `UPDATE credit_lots SET remaining_micro = 1 WHERE id = '${lotId}'`,
      ],
      [
        'held_micro',
        'driftstack.credit_hold_apply',
        `UPDATE credit_lots SET held_micro = 1 WHERE id = '${lotId}'`,
      ],
      [
        'debt_micro',
        'driftstack.credit_ledger_apply',
        `UPDATE credit_accounts SET debt_micro = 1 WHERE account_id = '${accountId}'`,
      ],
    ] as const) {
      const refused = await inRolledBackTransaction(db(), async (tx) => {
        await tx.unsafe(`SET LOCAL ${flag} = 'on'`);
        const [seen] = await tx.unsafe<Array<{ v: string }>>(
          `SELECT current_setting('${flag}') AS v`,
        );
        expect(seen?.v, `${flag} is raised in this transaction`).toBe('on');
        return refusal(() => tx.savepoint((sp) => sp.unsafe(statement)), `a forged ${what} write`);
      });
      expect(refused.code, what).toBe(GUARD);
      expect(refused.message, what).toMatch(
        new RegExp(`^credit_\\w+\\.${what} moves only through`),
      );
    }
    expect(await remainingOf(db(), lotId)).toBe(10 * MICRO);
    expect(await debtOf(db(), accountId)).toBe(0);
  });

  it('CRITICAL held_micro and debt_micro refuse a direct UPDATE too, and a credit row keeps its account (moving it would move its debt with no ledger row)', async () => {
    const accountId = await newCreditAccount(db());
    const lotId = await fundedLot(db(), accountId, { credits: 10 });

    const held = await refusal(
      () => db()`UPDATE credit_lots SET held_micro = 1 WHERE id = ${lotId}::uuid`,
    );
    expect(held).toMatchObject({
      code: GUARD,
      message: 'credit_lots.held_micro moves only through credit_reservation_holds',
    });

    const debt = await refusal(
      () => db()`UPDATE credit_accounts SET debt_micro = 1 WHERE account_id = ${accountId}::uuid`,
    );
    expect(debt).toMatchObject({
      code: GUARD,
      message: 'credit_accounts.debt_micro moves only through credit_ledger',
    });

    const other = await newAccount(db());
    const moved = await refusal(
      () =>
        db()`UPDATE credit_accounts SET account_id = ${other}::uuid WHERE account_id = ${accountId}::uuid`,
    );
    expect(moved).toMatchObject({ code: GUARD, message: 'a credit account keeps its account' });

    // Positive control: the columns the cutover and the settings routes will
    // write are free to change.
    await db()`
      UPDATE credit_accounts
         SET billing_mode = 'credits', ai_source = 'credits', ai_source_set_by = 'customer',
             ai_source_set_at = now(), auto_top_up_enabled = true
       WHERE account_id = ${accountId}::uuid`;
    expect(await debtOf(db(), accountId)).toBe(0);
  });

  it("CRITICAL a lot's terms are immutable — every one of them, for a lot with no month window as for any other", async () => {
    const accountId = await newCreditAccount(db());
    const lotId = await fundedLot(db(), accountId, { credits: 10 });
    const other = await newAccount(db());

    const changes: Array<[string, string]> = [
      ['id', `id = '${randomUUID()}'`],
      ['account_id', `account_id = '${other}'`],
      ['kind', `kind = 'top_up', spend_rank = 2`],
      ['spend_rank', `spend_rank = 2`],
      ['window_id', `window_id = '${randomUUID()}'`],
      ['grant_key', `grant_key = 'another-key'`],
      ['granted_micro', `granted_micro = ${String(20 * MICRO)}`],
      ['starts_at', `starts_at = starts_at - interval '1 day'`],
      ['expires_at', `expires_at = expires_at + interval '1 day'`],
      ['created_at', `created_at = created_at - interval '1 day'`],
    ];
    for (const [term, set] of changes) {
      const refused = await refusal(
        () => db().unsafe(`UPDATE credit_lots SET ${set} WHERE id = '${lotId}'`),
        `a change to ${term}`,
      );
      expect(refused, term).toMatchObject({
        code: GUARD,
        message: 'credit_lots terms are immutable',
      });
    }
    const [after] = await db()<Array<{ granted: string; key: string }>>`
      SELECT granted_micro::text AS granted, grant_key AS key FROM credit_lots WHERE id = ${lotId}::uuid`;
    expect(after).toEqual({ granted: String(10 * MICRO), key: expect.stringMatching(/^test:/) });
  });

  it('CRITICAL a revoked lot stays revoked: revoking is accepted once, and neither un-revoking nor re-dating it is', async () => {
    const accountId = await newCreditAccount(db());
    const lotId = await fundedLot(db(), accountId, { credits: 10 });

    await db()`UPDATE credit_lots SET revoked_at = now() WHERE id = ${lotId}::uuid`;
    for (const set of ['revoked_at = NULL', "revoked_at = revoked_at + interval '1 second'"]) {
      const refused = await refusal(
        () => db().unsafe(`UPDATE credit_lots SET ${set} WHERE id = '${lotId}'`),
        set,
      );
      expect(refused, set).toMatchObject({ code: GUARD, message: 'a revoked lot stays revoked' });
    }
    const [row] = await db()<Array<{ revoked: boolean }>>`
      SELECT revoked_at IS NOT NULL AS revoked FROM credit_lots WHERE id = ${lotId}::uuid`;
    expect(row?.revoked).toBe(true);
  });

  it("CRITICAL a ledger row naming another account's lot is refused, and neither account moves", async () => {
    const owner = await newCreditAccount(db());
    const lotId = await fundedLot(db(), owner, { credits: 10 });
    const intruder = await newCreditAccount(db());

    const refused = await refusal(
      () => db()`
        INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
        VALUES (${intruder}::uuid, 'expiry', ${lotId}::uuid, ${-3 * MICRO}, 'steal:1')`,
      "a row moving another account's lot",
    );
    expect(refused.code, 'foreign_key_violation, raised by the apply trigger').toBe('23503');
    expect(refused.message).toMatch(/^ledger row \d+ names a lot of another account$/);
    expect(await remainingOf(db(), lotId)).toBe(10 * MICRO);
    expect(await ledgerCount(db(), intruder)).toBe(0);

    // The same row on the lot's own account is accepted.
    await db()`
      INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
      VALUES (${owner}::uuid, 'expiry', ${lotId}::uuid, ${-3 * MICRO}, 'own:1')`;
    expect(await remainingOf(db(), lotId)).toBe(7 * MICRO);
  });

  it('CRITICAL a ledger row of any kind for an account with no credit row is refused — debt would have nowhere to be recorded, and every movement takes that row as its per-account lock (see debt-cannot-commit-beside-spendable-credit)', async () => {
    const accountId = await newAccount(db());
    const lotId = await insertLot(db(), accountId, { credits: 10 });
    for (const [what, statement] of [
      [
        'debt incurred',
        `INSERT INTO credit_ledger (account_id, kind, debt_delta_micro, idempotency_key, reason)
         VALUES ('${accountId}', 'debt_incurred', ${String(MICRO)}, 'orphan-debt', 'plan_change')`,
      ],
      [
        'a grant',
        `INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
         VALUES ('${accountId}', 'grant', '${lotId}', ${String(10 * MICRO)}, 'orphan-grant')`,
      ],
      [
        'a lot adjustment',
        `INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
         VALUES ('${accountId}', 'adjustment', '${lotId}', ${String(MICRO)}, 'orphan-adjustment')`,
      ],
    ] as const) {
      const refused = await refusal(() => db().unsafe(statement), what);
      expect(refused.code, what).toBe('23503');
      expect(refused.message, what).toMatch(/^ledger row \d+ has no credit account$/);
    }
    expect(await ledgerCount(db(), accountId)).toBe(0);
    expect(await remainingOf(db(), lotId)).toBe(0);

    // Positive control: with the credit row, the same grant applies.
    await db()`INSERT INTO credit_accounts (account_id) VALUES (${accountId}::uuid)`;
    await grantAll(db(), accountId, lotId);
    expect(await remainingOf(db(), lotId)).toBe(10 * MICRO);
  });

  it('CRITICAL a ledger row moves the REAL lot even when the session holds a temporary table named credit_lots — an unqualified name in the apply trigger would otherwise resolve to the stand-in, since pg_temp is searched first', async () => {
    const accountId = await newCreditAccount(db());
    const lotId = await fundedLot(db(), accountId, { credits: 10 });
    const seen = await inRolledBackTransaction(db(), async (tx) => {
      await tx.unsafe(
        `CREATE TEMP TABLE credit_lots ON COMMIT DROP AS SELECT * FROM public.credit_lots WHERE id = '${lotId}'`,
      );
      const [shadow] = await tx<Array<{ n: number }>>`SELECT count(*)::int AS n FROM credit_lots`;
      expect(shadow?.n, 'the stand-in is what an unqualified name now reads').toBe(1);
      await tx`
        INSERT INTO public.credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
        VALUES (${accountId}::uuid, 'expiry', ${lotId}::uuid, ${-3 * MICRO}, 'shadow:expiry')`;
      const [real] = await tx<Array<{ n: string }>>`
        SELECT remaining_micro::text AS n FROM public.credit_lots WHERE id = ${lotId}::uuid`;
      return Number(real?.n);
    });
    expect(seen, 'the expiry row moved the real lot, 10 − 3').toBe(7 * MICRO);
  });

  it('through the repository too: a lot it inserts is empty until its grant row, and an ORM update of the balance is refused by the database', async () => {
    const accountId = await newAccount(db());
    const r = repo();
    await r.ensureAccount(accountId);
    const { inserted, lot } = await r.insertLot({
      accountId,
      kind: 'adjustment',
      grantKey: `repo-lot:${accountId}`,
      grantedMicro: 25 * MICRO,
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(inserted).toBe(true);
    expect(lot.remainingMicro, 'born empty').toBe(0);
    expect(lot.spendRank).toBe(1);

    const { applied } = await r.append({
      accountId,
      kind: 'grant',
      lotId: lot.id,
      amountMicro: 25 * MICRO,
      idempotencyKey: `grant:${lot.id}`,
    });
    expect(applied).toBe(true);
    expect(await remainingOf(db(), lot.id)).toBe(25 * MICRO);

    const orm = database;
    if (orm === null) throw new Error('isolated database unreachable');
    const refused = await repoRefusal(() =>
      orm.db.update(creditLots).set({ remainingMicro: 1 }).where(eq(creditLots.id, lot.id)),
    );
    expect(refused).toMatchObject({
      code: GUARD,
      message: 'credit_lots.remaining_micro moves only through credit_ledger',
    });
    const debt = await repoRefusal(() =>
      orm.db
        .update(creditAccounts)
        .set({ debtMicro: 5 })
        .where(eq(creditAccounts.accountId, accountId)),
    );
    expect(debt.message).toBe('credit_accounts.debt_micro moves only through credit_ledger');
    expect(await remainingOf(db(), lot.id)).toBe(25 * MICRO);
  });
});

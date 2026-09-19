// A ledger row applied twice changes the balance once — including when two
// connections race to apply it.
//
// Grants, expiries and repayments are retried: a webhook is redelivered, a job
// runs again after a crash, two processes see the same boundary. Each carries
// an idempotency key, and the database holds one row per (account, key). The
// row applies itself in an AFTER trigger, so an INSERT … ON CONFLICT DO NOTHING
// that inserts nothing applies nothing.
//
// The race is the case worth proving, and it is proven as a race rather than
// argued: the first writer's transaction is held open with its row inserted and
// applied but not committed; the second writer's INSERT is then OBSERVED blocked
// on a lock (pg_stat_activity), not assumed to be; only then does the first
// commit. The second must then insert nothing and apply nothing. The same
// interleaving is run through the repository on two separate connection pools,
// with a first writer that ROLLS BACK (the key must not be burned by an aborted
// attempt), and as eight writers at once.
//
// The movement raced is an expiry of 30 from a lot of 100: applied once it
// leaves 70, applied twice 40, and no other rule would stop the second. (A grant
// would be a poor probe here — a lot cannot hold more than it was granted, so a
// double grant is refused by a CHECK even with no idempotency at all.)

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import {
  CreditLedgerKeyReusedError,
  CreditLotGrantKeyReusedError,
  DrizzleCreditLedgerRepo,
  type NewCreditLedgerEntry,
} from '../../src/db/credit-ledger-repo.js';
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
  waitUntilBlocked,
} from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_ledger_idempotency';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const WRITERS = 8;

let client: postgres.Sql | null = null;
let url: string | null = null;
/** Separate pools, so each writer really is its own connection. */
const pools: Database[] = [];
const others: postgres.Sql[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  url = opened.url;
  for (let i = 0; i < WRITERS; i += 1) pools.push(createDb(opened.url, { max: 1 }));
  for (let i = 0; i < 2; i += 1)
    others.push(postgres(opened.url, { max: 1, onnotice: () => undefined }));
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await Promise.all(pools.map((p) => p.close().catch(() => {})));
  await Promise.all(others.map((o) => o.end({ timeout: 5 }).catch(() => {})));
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function repoOn(i: number): DrizzleCreditLedgerRepo {
  const pool = pools[i];
  if (pool === undefined) throw new Error('isolated database unreachable');
  return new DrizzleCreditLedgerRepo(pool);
}

/** Two raw connections of their own, for the SQL-level race. */
function raw(i: 0 | 1): postgres.Sql {
  const c = others[i];
  if (c === undefined) throw new Error('isolated database unreachable');
  return c;
}

async function pidOf(sql: postgres.Sql | postgres.TransactionSql): Promise<number> {
  const [row] = await sql<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  if (row === undefined) throw new Error('no backend pid');
  return row.pid;
}

async function pidOfPool(pool: Database): Promise<number> {
  const [row] = await pool.client<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  if (row === undefined) throw new Error('no backend pid');
  return row.pid;
}

function expiry(accountId: string, lotId: string, key: string): NewCreditLedgerEntry {
  return { accountId, kind: 'expiry', lotId, amountMicro: 30 * MICRO, idempotencyKey: key };
}

async function expiryRows(accountId: string, key: string): Promise<number> {
  const [row] = await db()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM credit_ledger
     WHERE account_id = ${accountId}::uuid AND idempotency_key = ${key}`;
  return row?.n ?? -1;
}

describe.skipIf(!RUN_DB_TESTS)(
  'a ledger row applied twice changes the balance once, even when two connections race',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable, with a connection per writer — otherwise every arm below would fail on setup, not on what it proves', async () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      expect(url).not.toBeNull();
      const pids = new Set(await Promise.all(pools.map(pidOfPool)));
      expect(pids.size, 'every writer pool is a distinct backend').toBe(WRITERS);
    });

    it('CRITICAL applied twice in sequence, the second application reports it applied nothing and returns the first row', async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await fundedLot(db(), accountId, { credits: 100 });
      const first = await repoOn(0).append(expiry(accountId, lotId, 'seq:1'));
      const second = await repoOn(1).append(expiry(accountId, lotId, 'seq:1'));
      expect(first.applied).toBe(true);
      expect(second.applied).toBe(false);
      expect(second.entry.id, 'the row that holds the key').toBe(first.entry.id);
      expect(await remainingOf(db(), lotId)).toBe(70 * MICRO);
      expect(await expiryRows(accountId, 'seq:1')).toBe(1);
    });

    it('CRITICAL the database alone holds one row per key: a plain second INSERT is refused by the unique index, and one with ON CONFLICT DO NOTHING inserts and applies nothing', async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await fundedLot(db(), accountId, { credits: 100 });
      const insert = (sql: postgres.Sql, onConflict: string) =>
        sql.unsafe(
          `INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
           VALUES ($1, 'expiry', $2, $3, 'raw:1') ${onConflict} RETURNING id`,
          [accountId, lotId, -30 * MICRO],
        );
      expect(await insert(db(), 'ON CONFLICT DO NOTHING')).toHaveLength(1);
      const refused = await refusal(() => insert(db(), ''), 'a second row with the same key');
      expect(refused).toMatchObject({
        code: '23505',
        constraint: 'credit_ledger_idempotency_unique',
      });
      expect(await insert(db(), 'ON CONFLICT DO NOTHING')).toHaveLength(0);
      expect(await remainingOf(db(), lotId)).toBe(70 * MICRO);
    });

    it('CRITICAL a lot grant key inserts once: the same terms return the first lot, different terms throw, and the database alone refuses a second row with the key', async () => {
      const accountId = await newCreditAccount(db());
      const r = repoOn(0);
      const lot = {
        accountId,
        kind: 'top_up' as const,
        grantKey: `topup:${accountId}`,
        grantedMicro: 25 * MICRO,
        startsAt: new Date('2026-09-01T00:00:00.000Z'),
        expiresAt: new Date('2027-09-01T00:00:00.000Z'),
      };
      const first = await r.insertLot(lot);
      const again = await repoOn(1).insertLot(lot);
      expect(first.inserted).toBe(true);
      expect(again).toEqual({ inserted: false, lot: first.lot });
      await expect(r.insertLot({ ...lot, grantedMicro: 26 * MICRO })).rejects.toBeInstanceOf(
        CreditLotGrantKeyReusedError,
      );
      const other = await newCreditAccount(db());
      await expect(r.insertLot({ ...lot, accountId: other })).rejects.toBeInstanceOf(
        CreditLotGrantKeyReusedError,
      );
      const refused = await refusal(
        () => db()`
          INSERT INTO credit_lots (account_id, kind, spend_rank, grant_key, granted_micro, starts_at, expires_at)
          VALUES (${accountId}::uuid, 'top_up', 2, ${lot.grantKey}, ${MICRO}, now(), now() + interval '1 day')`,
      );
      expect(refused).toMatchObject({ code: '23505', constraint: 'credit_lots_grant_key_unique' });
      const [row] = await db()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM credit_lots WHERE grant_key = ${lot.grantKey}`;
      expect(row?.n).toBe(1);
    });

    it('CRITICAL a key belongs to its account: the same key on another account applies there', async () => {
      const a = await newCreditAccount(db());
      const b = await newCreditAccount(db());
      const lotA = await fundedLot(db(), a, { credits: 100 });
      const lotB = await fundedLot(db(), b, { credits: 100 });
      expect((await repoOn(0).append(expiry(a, lotA, 'shared-key'))).applied).toBe(true);
      expect((await repoOn(0).append(expiry(b, lotB, 'shared-key'))).applied).toBe(true);
      expect(await remainingOf(db(), lotA)).toBe(70 * MICRO);
      expect(await remainingOf(db(), lotB)).toBe(70 * MICRO);
    });

    it('CRITICAL a key reused for a DIFFERENT movement throws rather than reporting success for a movement that never happened', async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await fundedLot(db(), accountId, { credits: 100 });
      await repoOn(0).append(expiry(accountId, lotId, 'reuse:1'));
      await expect(
        repoOn(0).append({
          accountId,
          kind: 'expiry',
          lotId,
          amountMicro: 31 * MICRO,
          idempotencyKey: 'reuse:1',
        }),
      ).rejects.toBeInstanceOf(CreditLedgerKeyReusedError);
      await expect(
        repoOn(0).append({
          accountId,
          kind: 'grant',
          lotId,
          amountMicro: 30 * MICRO,
          idempotencyKey: 'reuse:1',
        }),
      ).rejects.toBeInstanceOf(CreditLedgerKeyReusedError);
      expect(await remainingOf(db(), lotId)).toBe(70 * MICRO);
    });

    it('CRITICAL RACE (raw SQL, two connections): the second INSERT … ON CONFLICT DO NOTHING is observed WAITING on the first, and after the first commits it inserts nothing and applies nothing', async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await fundedLot(db(), accountId, { credits: 100 });
      const statement = `INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
                         VALUES ($1, 'expiry', $2, $3, 'race:sql') ON CONFLICT DO NOTHING RETURNING id`;
      const params = [accountId, lotId, -30 * MICRO];
      const secondPid = await pidOf(raw(1));

      const firstInserted = gate();
      const release = gate();
      const first = raw(0).begin(async (tx) => {
        const rows = await tx.unsafe(statement, params);
        firstInserted.open();
        await release.opened;
        return rows.length;
      });
      await firstInserted.opened;
      // Uncommitted, and already applied inside the first transaction.
      expect(await remainingOf(db(), lotId), 'the first write is not visible yet').toBe(
        100 * MICRO,
      );

      // postgres.js runs a query when it is awaited; execute() sends it now.
      const second = raw(1).unsafe(statement, params).execute();
      try {
        await waitUntilBlocked(db(), secondPid);
      } finally {
        // Released even when the wait fails, so a red run ends instead of hanging.
        release.open();
      }

      expect(await first, 'the first writer inserted its row').toBe(1);
      expect((await second).length, 'the second writer inserted nothing').toBe(0);
      expect(await remainingOf(db(), lotId), 'applied once: 100 − 30').toBe(70 * MICRO);
      expect(await expiryRows(accountId, 'race:sql')).toBe(1);
    });

    it('CRITICAL RACE (through the repository, two pools): the second append waits for the first transaction, then reports applied: false with the row the first wrote', async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await fundedLot(db(), accountId, { credits: 100 });
      const secondPool = pools[1];
      if (secondPool === undefined) throw new Error('isolated database unreachable');
      const secondPid = await pidOfPool(secondPool);

      const firstApplied = gate();
      const release = gate();
      const first = repoOn(0).transaction(async (tx) => {
        const result = await repoOn(0).append(expiry(accountId, lotId, 'race:repo'), tx);
        firstApplied.open();
        await release.opened;
        return result;
      });
      await firstApplied.opened;

      const second = repoOn(1).append(expiry(accountId, lotId, 'race:repo'));
      try {
        await waitUntilBlocked(db(), secondPid);
      } finally {
        // Released even when the wait fails, so a red run ends instead of hanging.
        release.open();
      }

      const [a, b] = await Promise.all([first, second]);
      expect(a.applied).toBe(true);
      expect(b.applied).toBe(false);
      expect(b.entry.id).toBe(a.entry.id);
      expect(await remainingOf(db(), lotId)).toBe(70 * MICRO);
      expect(await expiryRows(accountId, 'race:repo')).toBe(1);
    });

    it('CRITICAL RACE, first writer rolls back: the waiting second writer then applies — an aborted attempt does not burn the key', async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await fundedLot(db(), accountId, { credits: 100 });
      const secondPool = pools[1];
      if (secondPool === undefined) throw new Error('isolated database unreachable');
      const secondPid = await pidOfPool(secondPool);

      const firstApplied = gate();
      const release = gate();
      class Abort extends Error {}
      const first = repoOn(0)
        .transaction(async (tx) => {
          await repoOn(0).append(expiry(accountId, lotId, 'race:abort'), tx);
          firstApplied.open();
          await release.opened;
          throw new Abort('the first writer gives up');
        })
        .catch((err: unknown) => err);
      await firstApplied.opened;

      const second = repoOn(1).append(expiry(accountId, lotId, 'race:abort'));
      try {
        await waitUntilBlocked(db(), secondPid);
      } finally {
        // Released even when the wait fails, so a red run ends instead of hanging.
        release.open();
      }

      expect(await first).toBeInstanceOf(Abort);
      expect((await second).applied, 'the second writer applied after the first aborted').toBe(
        true,
      );
      expect(await remainingOf(db(), lotId)).toBe(70 * MICRO);
      expect(await expiryRows(accountId, 'race:abort')).toBe(1);
    });

    it(`CRITICAL RACE, ${String(WRITERS)} writers at once on ${String(WRITERS)} connections: exactly one applies, and the balance moves once — for a lot movement and for debt`, async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await fundedLot(db(), accountId, { credits: 100 });
      const results = await Promise.all(
        pools.map((_, i) => repoOn(i).append(expiry(accountId, lotId, 'race:many'))),
      );
      expect(results.filter((r) => r.applied)).toHaveLength(1);
      expect(new Set(results.map((r) => r.entry.id)).size, 'every writer saw the same row').toBe(1);
      expect(await remainingOf(db(), lotId)).toBe(70 * MICRO);

      // Debt has no ceiling at all, so nothing but the key stops a double charge.
      const debtor = await newCreditAccount(db());
      const debts = await Promise.all(
        pools.map((_, i) =>
          repoOn(i).append({
            accountId: debtor,
            kind: 'debt_incurred',
            amountMicro: 9 * MICRO,
            reason: 'payment_reversed',
            idempotencyKey: 'race:debt',
          }),
        ),
      );
      expect(debts.filter((r) => r.applied)).toHaveLength(1);
      expect(await debtOf(db(), debtor)).toBe(9 * MICRO);
      expect(await ledgerCount(db(), debtor)).toBe(1);
    });

    it(`CRITICAL RACE, ${String(WRITERS)} writers retrying ONE lot's grant under its key: exactly one funds it and the rest report applied: false — a lot is funded once, and that rule does not turn a retry race into a refusal`, async () => {
      const accountId = await newCreditAccount(db());
      const lotId = await insertLot(db(), accountId, { credits: 100 });
      const grants = await Promise.all(
        pools.map((_, i) =>
          repoOn(i).append({
            accountId,
            kind: 'grant',
            lotId,
            amountMicro: 100 * MICRO,
            idempotencyKey: `grant:${lotId}`,
          }),
        ),
      );
      expect(grants.filter((r) => r.applied)).toHaveLength(1);
      expect(new Set(grants.map((r) => r.entry.id)).size, 'every writer saw the same row').toBe(1);
      expect(await remainingOf(db(), lotId)).toBe(100 * MICRO);
      expect(await ledgerCount(db(), accountId)).toBe(1);
    });
  },
);

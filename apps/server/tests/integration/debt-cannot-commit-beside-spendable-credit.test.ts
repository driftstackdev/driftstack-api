// Debt cannot commit beside spendable credit.
//
// An account that owes credits and also holds credit it could spend is a
// contradiction: the owed credits should have been taken from the free ones. A
// DEFERRED constraint trigger on the ledger checks every account a new ledger
// row touched, AT COMMIT — not at the statement, because the fix (repaying the
// debt from the free credit) is written later in the same transaction.
//
// So this proves the timing as much as the rule:
//   · the debt row itself is ACCEPTED as a statement, and visible inside its
//     transaction; the COMMIT is what fails, and then nothing of it remains;
//   · repaying from the free credit in the same transaction commits, including
//     debt larger than the free credit (the remainder is owed beside nothing);
//   · credit that is not spendable does not count: a lot that has expired, has
//     not started yet, was revoked, or is empty. Each is the positive control
//     for the spendable predicate the trigger shares with every reader;
//   · a grant into an account already in debt is refused at COMMIT the same way,
//     unless the debt is repaid from it before the transaction ends;
//   · SET CONSTRAINTS … IMMEDIATE moves the same check to the statement, which
//     shows the refusal comes from this constraint trigger and nothing else;
//   · and it holds when TWO CONNECTIONS write at once. A check at COMMIT reads
//     only what is committed, so two transactions — one incurring debt, one
//     adding free credit — would each pass their own check while the other's
//     write is still invisible, and both commit (measured before the repair:
//     298 of 300 such pairs committed together). Every ledger row therefore
//     takes its account's credit row first — for update when it moves debt,
//     shared otherwise — so the second writer WAITS for the first and its own
//     check then sees what the first committed. The races are run, not argued:
//     each arm observes the second writer blocked on a lock before the first
//     commits, and an account whose credit row is still being created by the
//     debt's transaction is covered too.

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleCreditLedgerRepo } from '../../src/db/credit-ledger-repo.js';
import { inRolledBackTransaction, refusal } from './_helpers/database-refusal.js';
import {
  MICRO,
  debtOf,
  fundedLot,
  gate,
  grantAll,
  insertLot,
  ledgerCount,
  newAccount,
  newCreditAccount,
  openLedgerDatabase,
  remainingOf,
  repoRefusal,
} from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_ledger_debt_vs_free';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const CONSTRAINT = 'credit_ledger_debt_vs_free';

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

async function pidOf(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  if (row === undefined) throw new Error('no backend pid');
  return row.pid;
}

/**
 * Whichever comes first: backend `pid` blocked on a lock, or `done` settling.
 * The first means the second writer is waiting for the first; the second means
 * it ran straight past it.
 */
async function blockedOrDone(pid: number, done: Promise<unknown>): Promise<'blocked' | 'done'> {
  let settled = false;
  void done.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 400; i += 1) {
    if (settled) return 'done';
    const [row] = await db()<Array<{ wait: string | null }>>`
      SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = ${pid}`;
    if (row?.wait === 'Lock') return 'blocked';
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`backend ${String(pid)} neither blocked nor finished`);
}

/** 'committed', or 'refused <SQLSTATE> <constraint>' for a transaction the database refused. */
function outcome(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => 'committed',
    (err: unknown) => {
      const e = err as { code?: unknown; constraint_name?: unknown };
      if (typeof e.code !== 'string') throw err;
      return `refused ${e.code}${typeof e.constraint_name === 'string' ? ` ${e.constraint_name}` : ''}`;
    },
  );
}

/** Debt owed and credit spendable now, read after both writers finished. */
async function standing(accountId: string): Promise<{ debt: number; spendable: number }> {
  const [row] = await db()<Array<{ debt: string | null; spendable: string }>>`
    SELECT (SELECT debt_micro::text FROM credit_accounts WHERE account_id = ${accountId}::uuid) AS debt,
           (SELECT COALESCE(SUM(remaining_micro - held_micro), 0)::text FROM credit_lots
             WHERE account_id = ${accountId}::uuid AND starts_at <= now() AND expires_at > now()
               AND revoked_at IS NULL) AS spendable`;
  return { debt: Number(row?.debt ?? 0), spendable: Number(row?.spendable) };
}

type Tx = postgres.Sql | postgres.TransactionSql;

async function incur(sql: Tx, accountId: string, credits: number, key: string): Promise<void> {
  await sql`
    INSERT INTO credit_ledger (account_id, kind, debt_delta_micro, idempotency_key, reason)
    VALUES (${accountId}::uuid, 'debt_incurred', ${credits * MICRO}, ${key}, 'payment_reversed')`;
}

async function repay(
  sql: Tx,
  accountId: string,
  lotId: string,
  credits: number,
  key: string,
): Promise<void> {
  await sql`
    INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, debt_delta_micro, idempotency_key)
    VALUES (${accountId}::uuid, 'debt_repayment', ${lotId}::uuid, ${-credits * MICRO}, ${-credits * MICRO}, ${key})`;
}

describe.skipIf(!RUN_DB_TESTS)('debt cannot commit beside spendable credit', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    expect(database).not.toBeNull();
  });

  it('CRITICAL debt beside a spendable lot is accepted as a statement and refused at COMMIT, and then nothing of it remains', async () => {
    const accountId = await newCreditAccount(db());
    const lotId = await fundedLot(db(), accountId, { credits: 10 });

    let seenInside = -1;
    const refused = await refusal(() =>
      db().begin(async (tx) => {
        await incur(tx, accountId, 4, 'debt:commit');
        seenInside = await debtOf(tx, accountId);
      }),
    );
    expect(seenInside, 'the statement was accepted: the debt is visible inside').toBe(4 * MICRO);
    expect(refused).toMatchObject({ code: '23514', constraint: CONSTRAINT });
    expect(refused.message).toMatch(/has debt 4000000 and 10000000 spendable credit$/);
    expect(await debtOf(db(), accountId)).toBe(0);
    expect(await ledgerCount(db(), accountId), 'only the grant row').toBe(1);
    expect(await remainingOf(db(), lotId)).toBe(10 * MICRO);
  });

  it('CRITICAL SET CONSTRAINTS … IMMEDIATE moves the same check to the statement — the refusal is this constraint trigger, deferred to COMMIT by design', async () => {
    const accountId = await newCreditAccount(db());
    await fundedLot(db(), accountId, { credits: 10 });
    const statement = await inRolledBackTransaction(db(), async (tx) => {
      await tx.unsafe(`SET CONSTRAINTS ${CONSTRAINT} IMMEDIATE`);
      return refusal(
        () => tx.savepoint((sp) => incur(sp, accountId, 4, 'debt:immediate')),
        'debt beside free credit, checked at the statement',
      );
    });
    expect(statement).toMatchObject({ code: '23514', constraint: CONSTRAINT });
  });

  it('CRITICAL repaying the debt from the free credit in the same transaction commits — in full, or down to what is free with the rest still owed', async () => {
    const full = await newCreditAccount(db());
    const fullLot = await fundedLot(db(), full, { credits: 10 });
    await db().begin(async (tx) => {
      await incur(tx, full, 4, 'debt:full');
      await repay(tx, full, fullLot, 4, 'repay:full');
    });
    expect(await debtOf(db(), full)).toBe(0);
    expect(await remainingOf(db(), fullLot)).toBe(6 * MICRO);

    const partial = await newCreditAccount(db());
    const partialLot = await fundedLot(db(), partial, { credits: 10 });
    await db().begin(async (tx) => {
      await incur(tx, partial, 15, 'debt:partial');
      await repay(tx, partial, partialLot, 10, 'repay:partial');
    });
    expect(await debtOf(db(), partial), 'owed beside no free credit').toBe(5 * MICRO);
    expect(await remainingOf(db(), partialLot)).toBe(0);
  });

  it('CRITICAL credit that is not spendable does not count: an expired, a not-yet-started, a revoked and an empty lot each leave debt free to commit', async () => {
    const cases: Array<[string, (accountId: string) => Promise<void>]> = [
      [
        'expired',
        async (a) => {
          await fundedLot(db(), a, {
            starts: "now() - interval '2 days'",
            expires: "now() - interval '1 day'",
          });
        },
      ],
      [
        'not yet started',
        async (a) => {
          await fundedLot(db(), a, { starts: "now() + interval '1 day'" });
        },
      ],
      [
        'revoked',
        async (a) => {
          const lot = await fundedLot(db(), a);
          await db()`UPDATE credit_lots SET revoked_at = now() WHERE id = ${lot}::uuid`;
        },
      ],
      [
        'empty',
        async (a) => {
          await insertLot(db(), a);
        },
      ],
    ];
    for (const [what, setup] of cases) {
      const accountId = await newCreditAccount(db());
      await setup(accountId);
      await incur(db(), accountId, 4, `debt:${what}`);
      expect(await debtOf(db(), accountId), what).toBe(4 * MICRO);
    }

    // And the same account shape with a live, funded lot is refused: the four
    // above committed because of what their lot was, not because of the debt.
    const control = await newCreditAccount(db());
    await fundedLot(db(), control);
    const refused = await refusal(() => incur(db(), control, 4, 'debt:control'));
    expect(refused).toMatchObject({ code: '23514', constraint: CONSTRAINT });
  });

  it('CRITICAL a grant into an account in debt is refused at COMMIT, unless the debt is repaid from it in the same transaction', async () => {
    const accountId = await newCreditAccount(db());
    await incur(db(), accountId, 3, 'debt:before-grant');

    const refused = await refusal(() => fundedLot(db(), accountId, { credits: 10 }));
    expect(refused).toMatchObject({ code: '23514', constraint: CONSTRAINT });

    await db().begin(async (tx) => {
      const lotId = await fundedLot(tx, accountId, { credits: 10 });
      await repay(tx, accountId, lotId, 3, 'repay:from-grant');
    });
    expect(await debtOf(db(), accountId)).toBe(0);
    expect(await ledgerCount(db(), accountId), 'debt, grant, repayment').toBe(3);
  });

  it('through the repository: a transaction that incurs debt beside free credit rejects at COMMIT', async () => {
    if (database === null) throw new Error('isolated database unreachable');
    const r = new DrizzleCreditLedgerRepo(database);
    const accountId = await newCreditAccount(db());
    await fundedLot(db(), accountId, { credits: 10 });
    const refused = await repoRefusal(() =>
      r.transaction(async (tx) => {
        await r.lockAccount(tx, accountId);
        const debt = await r.append(
          {
            accountId,
            kind: 'debt_incurred',
            amountMicro: 4 * MICRO,
            reason: 'plan_change',
            idempotencyKey: 'repo:debt',
          },
          tx,
        );
        expect(debt.applied, 'accepted as a statement').toBe(true);
      }),
    );
    expect(refused).toMatchObject({ code: '23514', constraint: CONSTRAINT });
    expect(await debtOf(db(), accountId)).toBe(0);
  });

  it('the two racing writers are two distinct backends — otherwise the races below would run on one connection and prove nothing', async () => {
    expect(racers).toHaveLength(2);
    expect(await pidOf(racer(0))).not.toBe(await pidOf(racer(1)));
  });

  it('CRITICAL RACE (two connections): debt and a grant into a live lot, each checked before either commits, cannot both commit — whichever writes second is observed waiting for the first, and is refused', async () => {
    const secondPid = await pidOf(racer(1));
    for (const order of [
      ['debt', 'grant'],
      ['grant', 'debt'],
    ] as const) {
      const accountId = await newCreditAccount(db());
      const lotId = await insertLot(db(), accountId, { credits: 10 });
      const write = {
        debt: (tx: Tx) => incur(tx, accountId, 4, 'race:debt'),
        grant: (tx: Tx) => grantAll(tx, accountId, lotId),
      };

      // The first writer runs its COMMIT-time check now (SET CONSTRAINTS …
      // IMMEDIATE) and holds its transaction open: this is the interleaving
      // two concurrent COMMITs produce, made deterministic.
      const firstChecked = gate();
      const release = gate();
      const first = outcome(
        racer(0).begin(async (tx) => {
          await write[order[0]](tx);
          await tx.unsafe(`SET CONSTRAINTS ${CONSTRAINT} IMMEDIATE`);
          firstChecked.open();
          await release.opened;
        }),
      );
      await firstChecked.opened;

      const second = outcome(
        racer(1).begin(async (tx) => {
          await write[order[1]](tx);
          await tx.unsafe(`SET CONSTRAINTS ${CONSTRAINT} IMMEDIATE`);
        }),
      );
      let seen: 'blocked' | 'done';
      try {
        seen = await blockedOrDone(secondPid, second);
      } finally {
        // Released even when the wait fails, so a red run ends instead of hanging.
        release.open();
      }

      const what = `${order[0]} then ${order[1]}`;
      expect(seen, `${what}: the second writer waits for the first`).toBe('blocked');
      expect([await first, await second], what).toEqual([
        'committed',
        `refused 23514 ${CONSTRAINT}`,
      ]);
      const after = await standing(accountId);
      expect(
        after.debt === 0 || after.spendable === 0,
        `${what}: debt ${String(after.debt)} beside ${String(after.spendable)} spendable`,
      ).toBe(true);
    }
  });

  it("CRITICAL RACE: while one transaction creates an account's credit row and incurs debt, a grant from a second connection cannot commit beside it — it is refused for want of a credit row it cannot see yet", async () => {
    const secondPid = await pidOf(racer(1));
    const accountId = await newAccount(db());
    const lotId = await insertLot(db(), accountId, { credits: 10 });

    const firstChecked = gate();
    const release = gate();
    const first = outcome(
      racer(0).begin(async (tx) => {
        await tx`INSERT INTO credit_accounts (account_id) VALUES (${accountId}::uuid)`;
        await incur(tx, accountId, 4, 'race:new-row-debt');
        await tx.unsafe(`SET CONSTRAINTS ${CONSTRAINT} IMMEDIATE`);
        firstChecked.open();
        await release.opened;
      }),
    );
    await firstChecked.opened;

    const second = outcome(
      racer(1).begin(async (tx) => {
        await grantAll(tx, accountId, lotId);
        await tx.unsafe(`SET CONSTRAINTS ${CONSTRAINT} IMMEDIATE`);
      }),
    );
    try {
      await blockedOrDone(secondPid, second);
    } finally {
      release.open();
    }

    expect(await first).toBe('committed');
    expect(await second, 'the grant needs a credit row it can see and hold').toBe('refused 23503');
    expect(await standing(accountId)).toEqual({ debt: 4 * MICRO, spendable: 0 });
    expect(await remainingOf(db(), lotId)).toBe(0);
  });

  it('CRITICAL RACE, as it happens in production: 20 debt-and-grant pairs whose COMMITs are sent at the same moment never leave debt beside spendable credit', async () => {
    const secondPid = await pidOf(racer(1));
    const committedTogether: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const accountId = await newCreditAccount(db());
      const lotId = await insertLot(db(), accountId, { credits: 10 });
      const firstWrote = gate();
      const secondWrote = gate();
      const go = gate();
      const first = outcome(
        racer(0).begin(async (tx) => {
          await incur(tx, accountId, 4, `race:together:${String(i)}`);
          firstWrote.open();
          await go.opened;
        }),
      );
      await firstWrote.opened;
      const second = outcome(
        racer(1).begin(async (tx) => {
          await grantAll(tx, accountId, lotId);
          secondWrote.open();
          await go.opened;
        }),
      );
      try {
        // The second has written its row, or is waiting to: either way both
        // COMMITs are now requested at once.
        await blockedOrDone(secondPid, secondWrote.opened);
      } finally {
        go.open();
      }
      const both = [await first, await second];
      if (both.every((o) => o === 'committed')) committedTogether.push(i);
      const after = await standing(accountId);
      expect(
        after.debt === 0 || after.spendable === 0,
        `pair ${String(i)} (${both.join(', ')}): debt ${String(after.debt)} beside ${String(after.spendable)} spendable`,
      ).toBe(true);
    }
    expect(committedTogether, 'pairs where debt and the grant both committed').toEqual([]);
  });
});

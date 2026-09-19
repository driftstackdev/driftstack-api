// The credit account lock makes a second writer wait.
//
// Every transaction that moves an account's credit takes the account's credit
// row FOR UPDATE first, so two of them on one account run one after the other
// and the second reads what the first committed. `lockAccount` creates the row
// if it is missing (owing nothing, on legacy billing) and locks it.
//
// Proven as a race, not argued: the first transaction holds the lock with a
// movement applied but not committed; the second `lockAccount` is OBSERVED
// blocked on a lock (pg_stat_activity); after the first commits, the second
// proceeds and sees the committed balance. Two first-time lockers racing to
// CREATE the row both get it, once.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleCreditLedgerRepo } from '../../src/db/credit-ledger-repo.js';
import {
  MICRO,
  fundedLot,
  gate,
  newAccount,
  openLedgerDatabase,
  waitUntilBlocked,
} from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_account_lock';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
const pools: Database[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  for (let i = 0; i < 2; i += 1) pools.push(createDb(opened.url, { max: 1 }));
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await Promise.all(pools.map((p) => p.close().catch(() => {})));
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function pool(i: 0 | 1): Database {
  const p = pools[i];
  if (p === undefined) throw new Error('isolated database unreachable');
  return p;
}

async function pidOf(p: Database): Promise<number> {
  const [row] = await p.client<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  if (row === undefined) throw new Error('no backend pid');
  return row.pid;
}

describe.skipIf(!RUN_DB_TESTS)('the credit account lock makes a second writer wait', () => {
  it('the isolated database was rebuilt from the migrations and is reachable, with two separate connections — otherwise every arm below would fail on setup, not on what it proves', async () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    expect(await pidOf(pool(0))).not.toBe(await pidOf(pool(1)));
  });

  it('ensureAccount creates the credit row once, owing nothing, on legacy billing, with no AI source chosen', async () => {
    const accountId = await newAccount(db());
    const r = new DrizzleCreditLedgerRepo(pool(0));
    const first = await r.ensureAccount(accountId);
    const second = await r.ensureAccount(accountId);
    expect(first).toEqual({
      accountId,
      billingMode: 'legacy',
      aiSource: null,
      aiSourceSetBy: null,
      aiSourceSetAt: null,
      debtMicro: 0,
      autoTopUpEnabled: false,
    });
    expect(second).toEqual(first);
    const [row] = await db()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
    expect(row?.n).toBe(1);
  });

  it('CRITICAL RACE: a second lockAccount on the same account is observed waiting until the first transaction commits, then reads what it committed', async () => {
    const accountId = await newAccount(db());
    const first = new DrizzleCreditLedgerRepo(pool(0));
    const second = new DrizzleCreditLedgerRepo(pool(1));
    await first.ensureAccount(accountId);
    const lotId = await fundedLot(db(), accountId, { credits: 10 });
    const secondPid = await pidOf(pool(1));

    const locked = gate();
    const release = gate();
    const order: string[] = [];
    const firstTx = first.transaction(async (tx) => {
      await first.lockAccount(tx, accountId);
      await first.append(
        { accountId, kind: 'expiry', lotId, amountMicro: 4 * MICRO, idempotencyKey: 'lock:first' },
        tx,
      );
      locked.open();
      await release.opened;
      order.push('first commits');
    });
    await locked.opened;

    const secondTx = second.transaction(async (tx) => {
      await second.lockAccount(tx, accountId);
      order.push('second holds the lock');
      return second.spendableMicro(accountId, tx);
    });
    try {
      await waitUntilBlocked(db(), secondPid);
    } finally {
      release.open();
    }

    await firstTx;
    expect(await secondTx, 'the second read after the first committed').toBe(6 * MICRO);
    expect(order).toEqual(['first commits', 'second holds the lock']);
  });

  it('CRITICAL RACE: two first-time lockers of an account with no credit row both get the lock in turn, and the row is created once', async () => {
    const accountId = await newAccount(db());
    const [a, b] = await Promise.all(
      [pool(0), pool(1)].map((p) => {
        const r = new DrizzleCreditLedgerRepo(p);
        return r.transaction((tx) => r.lockAccount(tx, accountId));
      }),
    );
    expect(a?.accountId).toBe(accountId);
    expect(b?.accountId).toBe(accountId);
    const [row] = await db()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
    expect(row?.n).toBe(1);
  });
});

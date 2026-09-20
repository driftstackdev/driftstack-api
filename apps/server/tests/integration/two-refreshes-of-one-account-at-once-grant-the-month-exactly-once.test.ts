// Two refreshes of one account at once grant the month exactly once.
//
// A refresh is triggered by whatever notices first: both Stripe events for one
// paid invoice, a redelivery of either, the boundary job, the sweep, an admin.
// They run on different connections, often in the same second, and Stripe's
// dispatcher runs its handlers BEFORE it records the event as seen, so two
// deliveries of one event both reach the grant. Each of them must leave one
// window, one lot and one grant row between them — never two months of credits.
//
// Proven as a race, not argued. Many connections refresh one account together;
// then one refresh is held open mid-transaction, with its grant written and not
// committed, and a second is OBSERVED waiting on a lock (pg_stat_activity) until
// the first commits, after which it finds the month covered. The same is done
// for expiry, which is the other thing a refresh writes.
//
// What makes it hold is the account's credit lock, which runs refreshes of one
// account one after the other. Behind the lock the database would still refuse
// the duplicate (see an-accounts-credit-windows-never-overlap); the lock is what
// turns "refused" into "had nothing to do".
//
// ⚠️ THE ACCOUNTS HERE ALREADY HAVE THEIR CREDIT ROW, ON PURPOSE. Creating that
// row is itself a serialisation point: a second INSERT … ON CONFLICT DO NOTHING
// waits for the first's transaction. With brand-new accounts these races passed
// with the lock REMOVED (measured), because the row's creation was doing the
// lock's job. An account has its credit row for every refresh after its first,
// so that is the case that needs the lock, and the case raced here; one arm
// keeps the first-ever refresh as well.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fundedLot,
  gate,
  openLedgerDatabase,
  waitUntilBlocked,
} from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  grantCounts,
  grantsHarness,
  ledgerOf,
  payingCustomer,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_grants_race';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const RACERS = 8;

let client: postgres.Sql | null = null;
const racers: GrantsHarness[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  // One connection each, so every racer is a separate backend.
  for (let i = 0; i < RACERS; i += 1) racers.push(grantsHarness(opened.url, { max: 1 }));
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await Promise.all(racers.map((r) => r.database.close().catch(() => {})));
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function racer(i: number): GrantsHarness {
  const r = racers[i];
  if (r === undefined) throw new Error('isolated database unreachable');
  return r;
}

async function pidOf(r: GrantsHarness): Promise<number> {
  const [row] = await r.database.client<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  if (row === undefined) throw new Error('no backend pid');
  return row.pid;
}

describe.skipIf(!RUN_DB_TESTS)(
  'two refreshes of one account at once grant the month exactly once',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable, and every racer is a separate connection — otherwise "at once" would mean "one after another on one connection"', async () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      const pids = await Promise.all(racers.map(pidOf));
      expect(new Set(pids).size).toBe(RACERS);
    });

    it(`CRITICAL RACE: ${String(RACERS)} connections refresh one account together. Exactly one of them grants; the others find the month covered; the account holds one window, one lot, one grant row and one month of credits`, async () => {
      const { accountId } = await payingCustomer(db(), 'api_builder');
      await racer(0).ledger.ensureAccount(accountId);

      const results = await Promise.all(racers.map((r) => r.grants.refreshCredits(accountId)));

      expect(results.map((r) => r.window.outcome).sort()).toEqual([
        'created',
        ...Array.from({ length: RACERS - 1 }, () => 'none'),
      ]);
      expect(await grantCounts(db(), accountId)).toEqual({ windows: 1, lots: 1, ledger: 1 });
      expect(await racer(0).ledger.spendableMicro(accountId)).toBe(10_000 * MICRO);
      // They all agree on the window that is now current.
      expect(new Set(results.map((r) => r.currentWindowEnd)).size).toBe(1);
    });

    it('CRITICAL RACE, the first refresh an account ever has: no credit row exists yet, every connection tries to create it, and still exactly one grants', async () => {
      const { accountId } = await payingCustomer(db(), 'team_manual');

      const results = await Promise.all(racers.map((r) => r.grants.refreshCredits(accountId)));

      expect(results.map((r) => r.window.outcome).sort()).toEqual([
        'created',
        ...Array.from({ length: RACERS - 1 }, () => 'none'),
      ]);
      expect(await grantCounts(db(), accountId)).toEqual({ windows: 1, lots: 1, ledger: 1 });
      const [row] = await db()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
      expect(row?.n).toBe(1);
    });

    it('CRITICAL RACE, many accounts at once: 24 accounts are each refreshed by three connections together, and every one of them ends with exactly one month', async () => {
      const accounts: string[] = [];
      for (let i = 0; i < 24; i += 1) {
        const { accountId } = await payingCustomer(db(), 'api_starter');
        await racer(0).ledger.ensureAccount(accountId);
        accounts.push(accountId);
      }

      const outcomes = await Promise.all(
        accounts.flatMap((accountId, i) =>
          [0, 1, 2].map(async (k) => ({
            accountId,
            outcome: (await racer((i + k) % RACERS).grants.refreshCredits(accountId)).window
              .outcome,
          })),
        ),
      );

      for (const accountId of accounts) {
        const mine = outcomes.filter((o) => o.accountId === accountId).map((o) => o.outcome);
        expect(mine.sort(), accountId).toEqual(['created', 'none', 'none']);
        expect(await grantCounts(db(), accountId), accountId).toEqual({
          windows: 1,
          lots: 1,
          ledger: 1,
        });
      }
    });

    it('CRITICAL RACE, observed: one refresh has granted and not committed; a second refresh of the same account is seen WAITING on a lock; when the first commits, the second finds the month covered and writes nothing', async () => {
      const { accountId } = await payingCustomer(db(), 'agency_manual');
      await racer(0).ledger.ensureAccount(accountId);
      const first = racer(0);
      const second = racer(1);
      const secondPid = await pidOf(second);

      const granted = gate();
      const release = gate();
      const order: string[] = [];
      const firstTx = first.ledger.transaction(async (tx) => {
        const result = await first.grants.refreshCreditsIn(tx, accountId);
        expect(result.window.outcome).toBe('created');
        granted.open();
        await release.opened;
        order.push('first commits');
      });
      await granted.opened;
      // Not committed: nobody else can see the grant yet.
      expect(await grantCounts(db(), accountId)).toEqual({ windows: 0, lots: 0, ledger: 0 });

      const secondRun = second.grants.refreshCredits(accountId).then((r) => {
        order.push('second returns');
        return r;
      });
      try {
        await waitUntilBlocked(db(), secondPid);
      } finally {
        release.open();
      }
      await firstTx;
      const result = await secondRun;

      expect(order).toEqual(['first commits', 'second returns']);
      expect(result.window, 'the second refresh granted as well').toEqual({ outcome: 'none' });
      expect(await grantCounts(db(), accountId)).toEqual({ windows: 1, lots: 1, ledger: 1 });
      expect(await second.ledger.spendableMicro(accountId)).toBe(15_000 * MICRO);
    });

    it('CRITICAL RACE: a lot whose term has ended expires into exactly ONE expiry row however many connections refresh the account together', async () => {
      const { accountId } = await payingCustomer(db(), 'api_starter');
      await racer(0).ledger.ensureAccount(accountId);
      const lotId = await fundedLot(db(), accountId, {
        credits: 40,
        starts: "now() - interval '40 days'",
        expires: "now() - interval '1 minute'",
      });

      const results = await Promise.all(racers.map((r) => r.grants.refreshCredits(accountId)));

      expect(results.map((r) => r.expired.length).sort()).toEqual([
        ...Array.from({ length: RACERS - 1 }, () => 0),
        1,
      ]);
      const expiries = (await ledgerOf(db(), accountId)).filter((e) => e.kind === 'expiry');
      expect(expiries).toEqual([
        {
          kind: 'expiry',
          lot_id: lotId,
          lot_delta_micro: String(-40 * MICRO),
          debt_delta_micro: '0',
          idempotency_key: `expiry:${lotId}:1`,
        },
      ]);
    });
  },
);

// At most three enforced tasks hold credit at once, and the DATABASE is what
// says so.
//
// The service counts an account's open enforced reservations before it inserts
// one. Under concurrency that count is a read of a moment that has already
// passed — four requests arriving together each read three-or-fewer and each
// decide to go ahead. Two things make the answer right anyway, and this file
// separates them:
//
//   · the account's credit row is taken FOR UPDATE first, so the four decisions
//     are taken one after another rather than against one stale picture. Proved
//     by holding that lock open and watching a second reserve BLOCK on it;
//   · `credit_reservations_open_slot_unique` — a partial unique index over
//     (account, slot) where the row is open and enforced — refuses a fourth row
//     whatever any count said. Proved by writing the fourth row with raw SQL,
//     past the service entirely.
//
// The same shape covers the balance: parallel tasks between them never hold more
// credit than the account has, because each reserve draws `remaining − held`
// under the lock and the next one sees what the last one held.
//
// Concurrency is real here: separate connection pools, and Promise.all over
// them, not one pool's sequential reuse.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { gate, openLedgerDatabase, repoRefusal } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  ON_CREDITS_MODEL,
  SONNET_MAX_RESERVE_MICRO,
  fundedTaskLot,
  newTaskAccount,
  reservationsHarness,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_task_slots';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const BOOT = 'boot-slots';

let client: postgres.Sql | null = null;
let url: string | null = null;
const opened: Database[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const db = await openLedgerDatabase(ISOLATED_DB_NAME, 4);
  if (db === null) return;
  client = db.sql;
  url = db.url;
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await Promise.all(opened.map((d) => d.close().catch(() => {})));
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

/** A harness on a connection pool of its OWN, so two of them really are two clients. */
function harness(max = 1): ReservationsHarness {
  if (url === null) throw new Error('isolated database unreachable');
  const h = reservationsHarness(url, { max });
  opened.push(h.database);
  return h;
}

function reserveInput(accountId: string, over: Record<string, unknown> = {}) {
  return {
    accountId,
    reservationId: randomUUID(),
    agentSessionId: `as_${randomUUID()}`,
    idempotencyKey: null,
    model: ON_CREDITS_MODEL,
    mode: 'enforce' as const,
    bootId: BOOT,
    ...over,
  };
}

/** Wait until at least `n` backends of this database are blocked on a lock. */
async function waitForLockWaiters(watcher: postgres.Sql, n: number): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const rows = await watcher<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (rows.length >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no backend ever blocked on a lock (expected ${String(n)})`);
}

describe.skipIf(!RUN_DB_TESTS)('at most three enforced tasks hold credit at once', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    expect(url).not.toBeNull();
  });

  it('CRITICAL four tasks reserving AT ONCE, on four separate connections, yield exactly three reservations in three distinct slots and one tasks_in_flight refusal', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 400 });
    const clients = [harness(), harness(), harness(), harness()];

    const results = await Promise.all(
      clients.map((h) => h.service.reserve(reserveInput(accountId))),
    );
    const reserved = results.filter((r) => r.outcome === 'reserved');
    const refused = results.filter((r) => r.outcome === 'refused');
    expect(reserved, JSON.stringify(results)).toHaveLength(3);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ reason: 'tasks_in_flight', openTasks: 3 });

    expect(
      [...reserved.map((r) => (r.outcome === 'reserved' ? r.slot : 0))].sort(),
      'each took a slot of its own',
    ).toEqual([1, 2, 3]);
    expect(
      await db()`
        SELECT count(*)::int AS n FROM credit_reservations
         WHERE account_id = ${accountId}::uuid AND state = 'open' AND mode = 'enforce'`,
    ).toEqual([{ n: 3 }]);
    const [held] = await db()<Array<{ n: string }>>`
      SELECT COALESCE(SUM(held_micro), 0)::text AS n FROM credit_lots
       WHERE account_id = ${accountId}::uuid`;
    expect(
      Number(held?.n),
      'and the three tasks between them hold exactly what they reserved',
    ).toBe(3 * SONNET_MAX_RESERVE_MICRO);
  });

  it('CRITICAL the decision is taken under the account’s credit lock: a second reserve BLOCKS while a first transaction holds that row, and completes once it commits', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 400 });
    const holder = harness();
    const waiter = harness();
    const release = gate();

    const holding = holder.ledger.transaction(async (tx) => {
      await holder.ledger.lockAccount(tx, accountId);
      await release.opened;
    });
    // Give the holder a moment to take the lock before the waiter asks for it.
    await waitUntilLocked(db(), accountId);

    let done = false;
    const second = waiter.service.reserve(reserveInput(accountId)).then((r) => {
      done = true;
      return r;
    });
    await waitForLockWaiters(db(), 1);
    expect(done, 'the second reserve is blocked on the first transaction’s lock').toBe(false);

    release.open();
    await holding;
    const result = await second;
    expect(result.outcome, 'and it goes through once the lock is free').toBe('reserved');
  });

  it('CRITICAL the SLOT INDEX refuses a fourth open enforced task even when the service’s count is bypassed entirely — written with raw SQL, past every check in TypeScript', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 400 });
    const h = harness(4);
    for (let i = 0; i < 3; i += 1) {
      expect((await h.service.reserve(reserveInput(accountId))).outcome).toBe('reserved');
    }

    for (const slot of [1, 2, 3]) {
      const refused = await repoRefusal(
        () => db()`
          INSERT INTO credit_reservations (id, account_id, agent_session_id, model,
                                           rate_card_version, mode, slot, reserved_micro,
                                           lease_owner, lease_expires_at, max_until)
          VALUES (${randomUUID()}::uuid, ${accountId}::uuid, 'as_raw', ${ON_CREDITS_MODEL}, 1,
                  'enforce', ${slot}, ${String(MICRO)}::bigint, ${BOOT},
                  now() + interval '90 seconds', now() + interval '30 minutes')`,
        `a fourth open enforced task in slot ${String(slot)}`,
      );
      expect(refused).toMatchObject({
        code: '23505',
        constraint: 'credit_reservations_open_slot_unique',
      });
    }

    // The instrument discriminates. The same row with NO slot is refused by a
    // different rule (an enforced task must hold one), and the same row in
    // SHADOW mode — which takes no slot — is accepted. So the three refusals
    // above are the slot index and not "the database refuses this row".
    const noSlot = await repoRefusal(
      () => db()`
        INSERT INTO credit_reservations (id, account_id, agent_session_id, model,
                                         rate_card_version, mode, reserved_micro,
                                         lease_owner, lease_expires_at, max_until)
        VALUES (${randomUUID()}::uuid, ${accountId}::uuid, 'as_raw', ${ON_CREDITS_MODEL}, 1,
                'enforce', ${String(MICRO)}::bigint, ${BOOT},
                now() + interval '90 seconds', now() + interval '30 minutes')`,
      'an enforced task with no slot',
    );
    expect(noSlot).toMatchObject({ code: '23514', constraint: 'credit_reservations_slot' });

    await db()`
      INSERT INTO credit_reservations (id, account_id, agent_session_id, model,
                                       rate_card_version, mode, reserved_micro,
                                       lease_owner, lease_expires_at, max_until)
      VALUES (${randomUUID()}::uuid, ${accountId}::uuid, 'as_raw', ${ON_CREDITS_MODEL}, 1,
              'shadow', ${String(MICRO)}::bigint, ${BOOT},
              now() + interval '90 seconds', now() + interval '30 minutes')`;
    expect(
      await db()`
        SELECT count(*)::int AS n FROM credit_reservations
         WHERE account_id = ${accountId}::uuid AND mode = 'shadow'`,
      'a shadow task alongside three enforced ones is fine — it holds no slot',
    ).toEqual([{ n: 1 }]);
  });

  it('CRITICAL a settled task frees its slot, and the next task takes exactly that one', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 400 });
    const h = harness(4);
    const first = reserveInput(accountId);
    const second = reserveInput(accountId);
    const third = reserveInput(accountId);
    for (const input of [first, second, third]) {
      expect((await h.service.reserve(input)).outcome).toBe('reserved');
    }
    expect((await h.service.reserve(reserveInput(accountId))).outcome).toBe('refused');

    await h.service.settle(second.reservationId, 'completed');
    const next = reserveInput(accountId);
    const result = await h.service.reserve(next);
    expect(result.outcome).toBe('reserved');
    if (result.outcome !== 'reserved') return;
    expect(result.slot, 'the freed slot, not a fourth').toBe(2);

    // And the settled row keeps its slot: the index is partial on `state`, which
    // is what lets the history stay while the seat is given up.
    const [settled] = await db()<Array<{ slot: number; state: string }>>`
      SELECT slot, state FROM credit_reservations WHERE id = ${second.reservationId}::uuid`;
    expect(settled).toEqual({ slot: 2, state: 'settled' });
  });

  it('CRITICAL parallel tasks between them never hold more credit than the account has: three at once on 100 credits hold 100, and the one left over is refused for balance', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 100 });
    const clients = [harness(), harness(), harness()];

    const results = await Promise.all(
      clients.map((h) => h.service.reserve(reserveInput(accountId))),
    );
    const reserved = results.filter((r) => r.outcome === 'reserved');
    expect(reserved.length, JSON.stringify(results)).toBe(2);
    expect(
      reserved.map((r) => (r.outcome === 'reserved' ? r.reservedMicro : 0)).sort((a, b) => b - a),
      '60 for the first, and what was left for the second',
    ).toEqual([60 * MICRO, 40 * MICRO]);
    const refused = results.find((r) => r.outcome === 'refused');
    expect(refused).toMatchObject({ reason: 'balance', availableMicro: 0 });

    const [row] = await db()<Array<{ held: string; remaining: string }>>`
      SELECT held_micro::text AS held, remaining_micro::text AS remaining
        FROM credit_lots WHERE id = ${lot}::uuid`;
    expect(
      { held: Number(row?.held), remaining: Number(row?.remaining) },
      'the lot is fully held and nothing is spent yet',
    ).toEqual({ held: 100 * MICRO, remaining: 100 * MICRO });
  });
});

/** Wait until the account's credit row is actually locked by somebody. */
async function waitUntilLocked(watcher: postgres.Sql, accountId: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const rows = await watcher<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE a.datname = current_database() AND l.locktype = 'transactionid' AND l.granted`;
    if (rows[0] !== undefined && rows[0].n > 0) {
      // And the holder really is inside a transaction that touched this account.
      const held = await watcher<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM credit_accounts
         WHERE account_id = ${accountId}::uuid`;
      if (held[0]?.n === 1) return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no transaction ever took a lock');
}

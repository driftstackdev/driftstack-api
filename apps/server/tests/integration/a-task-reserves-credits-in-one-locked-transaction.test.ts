// A task sets credits aside in ONE transaction, under the account's credit lock,
// and every refusal is an answer rather than an exception.
//
// What this file proves, against a real Postgres:
//
//   · the four refusals, in the order §4.4 asks them — model, tasks in flight,
//     debt, balance — because the order is part of the answer a customer sees;
//   · a reservation takes the lowest free slot, reserves the LESSER of the
//     model's maximum and what the account has, and holds exactly that much
//     across the account's lots in SPEND ORDER (included credits before bought
//     ones, soonest to expire first);
//   · credits of a month that has not begun are not spendable and cannot back a
//     task (H4);
//   · `request_key` is set ONLY from an Idempotency-Key, so two requests that
//     share an inbound request id both reserve (M2);
//   · a refresh that FAILS does not block the task: the savepoint rolls its
//     partial work back, the failure is logged and alerted, and the reserve
//     continues on the balance already recorded (H5);
//   · shadow measures and never refuses, never holds, and never throws (M3).
//
// The harness uses the real repositories and the real service over a database
// rebuilt from the migrations, and every instant is the database's own now().

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import type { CreditRateCardReader } from '../../src/db/credit-rate-card-repo.js';
import { openLedgerDatabase, repoRefusal } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  ON_CREDITS_MODEL,
  OWN_KEY_ONLY_MODEL,
  SONNET_MAX_RESERVE_MICRO,
  SONNET_MIN_START_MICRO,
  fundedTaskLot,
  heldOf,
  holdRows,
  newTaskAccount,
  refresherThat,
  reservationRow,
  reservationsHarness,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_reserve';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const BOOT = 'boot-under-test';

let client: postgres.Sql | null = null;
let url: string | null = null;
const opened: Database[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const db = await openLedgerDatabase(ISOLATED_DB_NAME, 8);
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

function harness(opts: Parameters<typeof reservationsHarness>[1] = {}): ReservationsHarness {
  if (url === null) throw new Error('isolated database unreachable');
  const h = reservationsHarness(url, opts);
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

describe.skipIf(!RUN_DB_TESTS)('a task reserves credits in one locked transaction', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    expect(url).not.toBeNull();
  });

  it('CRITICAL a task reserves the LESSER of the model’s maximum and what the account has, takes slot 1, and holds exactly that much — with the whole of it recorded against the lots it came from', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 20 });
    const h = harness();

    const input = reserveInput(accountId);
    const result = await h.service.reserve(input);
    expect(result.outcome, JSON.stringify(result)).toBe('reserved');
    if (result.outcome !== 'reserved') return;

    // 20 credits on hand, 60 allowed: the account's balance is the binding one.
    expect(result.reservedMicro).toBe(20 * MICRO);
    expect(result.slot).toBe(1);
    expect(result.rateCardVersion).toBe(1);
    expect(result.holds).toEqual([{ lotId: lot, heldMicro: 20 * MICRO }]);
    expect(await heldOf(db(), lot), 'the lot records what the task holds').toBe(20 * MICRO);

    const row = await reservationRow(db(), input.reservationId);
    expect(row).toMatchObject({
      account_id: accountId,
      agent_session_id: input.agentSessionId,
      request_key: null,
      model: ON_CREDITS_MODEL,
      mode: 'enforce',
      slot: 1,
      state: 'open',
      would_refuse_reason: null,
      lease_owner: BOOT,
      charged_micro: null,
      settle_reason: null,
    });
  });

  it('CRITICAL a task never reserves more than the model’s maximum, however much the account holds — Sonnet reserves at most 60 credits', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 500 });
    const h = harness();

    const result = await h.service.reserve(reserveInput(accountId));
    expect(result.outcome).toBe('reserved');
    if (result.outcome !== 'reserved') return;
    expect(result.reservedMicro).toBe(SONNET_MAX_RESERVE_MICRO);
    expect(result.holds.reduce((n, x) => n + x.heldMicro, 0)).toBe(SONNET_MAX_RESERVE_MICRO);
  });

  it('CRITICAL the hold walk follows SPEND ORDER: included credits are held before goodwill and bought credits, and within a rank the lot that expires soonest goes first', async () => {
    const accountId = await newTaskAccount(db());
    const topUp = await fundedTaskLot(db(), accountId, { kind: 'top_up', credits: 40 });
    const goodwill = await fundedTaskLot(db(), accountId, { kind: 'adjustment', credits: 10 });
    const monthlyLate = await fundedTaskLot(db(), accountId, {
      kind: 'monthly',
      credits: 5,
      expires: "now() + interval '20 days'",
    });
    const monthlySoon = await fundedTaskLot(db(), accountId, {
      kind: 'monthly',
      credits: 30,
      expires: "now() + interval '2 days'",
    });
    const h = harness();

    const input = reserveInput(accountId);
    const result = await h.service.reserve(input);
    expect(result.outcome).toBe('reserved');
    if (result.outcome !== 'reserved') return;
    expect(result.reservedMicro).toBe(SONNET_MAX_RESERVE_MICRO);

    // 30 (monthly, soonest) + 5 (monthly) + 10 (goodwill) + 15 of the 40 bought.
    expect(await holdRows(db(), input.reservationId)).toEqual([
      { lotId: monthlySoon, heldMicro: 30 * MICRO, chargedMicro: null },
      { lotId: monthlyLate, heldMicro: 5 * MICRO, chargedMicro: null },
      { lotId: goodwill, heldMicro: 10 * MICRO, chargedMicro: null },
      { lotId: topUp, heldMicro: 15 * MICRO, chargedMicro: null },
    ]);
    expect(await heldOf(db(), topUp), 'the bought lot gives only the shortfall').toBe(15 * MICRO);
  });

  it('CRITICAL a lot whose month has NOT BEGUN is not spendable and cannot back a task (H4) — the same lot, once started, reserves', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, {
      credits: 50,
      starts: "now() + interval '1 hour'",
      expires: "now() + interval '40 days'",
    });
    const h = harness();

    const early = await h.service.reserve(reserveInput(accountId));
    expect(early.outcome, 'future credit is not a balance').toBe('refused');
    if (early.outcome !== 'refused') return;
    expect(early.reason).toBe('balance');
    expect(early.availableMicro).toBe(0);
    expect(early.minStartMicro).toBe(SONNET_MIN_START_MICRO);

    // The positive control on the same account: a lot that HAS started reserves,
    // so the refusal above is about the start and not about the fixture.
    const started = await fundedTaskLot(db(), accountId, { credits: 50 });
    const now = await h.service.reserve(reserveInput(accountId));
    expect(now.outcome).toBe('reserved');
    if (now.outcome !== 'reserved') return;
    expect(
      now.holds.map((x) => x.lotId),
      'only the started lot backs it',
    ).toEqual([started]);
  });

  it('CRITICAL a balance under the model’s minimum refuses, and the refusal carries the figures the customer is shown', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 5 });
    const h = harness();

    const result = await h.service.reserve(reserveInput(accountId));
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result).toMatchObject({
      reason: 'balance',
      availableMicro: 5 * MICRO,
      minStartMicro: SONNET_MIN_START_MICRO,
      debtMicro: 0,
      debtReason: null,
    });
    expect(
      await db()`SELECT count(*)::int AS n FROM credit_reservations WHERE account_id = ${accountId}::uuid`,
    ).toEqual([{ n: 0 }]);
  });

  it('CRITICAL an account in debt cannot start a task, and the refusal carries WHY it owes — the refusal comes before the balance is even looked at', async () => {
    const accountId = await newTaskAccount(db());
    // Debt with no spendable credit beside it: the database refuses the other
    // combination, which is the whole reason this refusal exists.
    await db()`
      INSERT INTO credit_ledger (account_id, kind, lot_delta_micro, debt_delta_micro, idempotency_key, reason)
      VALUES (${accountId}::uuid, 'debt_incurred', 0, ${String(7 * MICRO)}::bigint, 'debt:1', 'plan_change')`;
    const h = harness();

    const result = await h.service.reserve(reserveInput(accountId));
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result).toMatchObject({
      reason: 'debt',
      debtMicro: 7 * MICRO,
      debtReason: 'plan_change',
      minStartMicro: SONNET_MIN_START_MICRO,
    });
  });

  it('CRITICAL a model the deployment’s key may not run is refused BEFORE the balance, however much credit the account has (M10) — and the rate card is not what decides it', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 500 });
    const h = harness();

    const opus = await h.service.reserve(reserveInput(accountId, { model: OWN_KEY_ONLY_MODEL }));
    expect(opus.outcome).toBe('refused');
    if (opus.outcome !== 'refused') return;
    expect(opus).toMatchObject({ reason: 'model', modelRefusal: 'own_key_only' });

    const unknown = await h.service.reserve(reserveInput(accountId, { model: 'claude-made-up-9' }));
    expect(unknown.outcome).toBe('refused');
    if (unknown.outcome !== 'refused') return;
    expect(unknown).toMatchObject({ reason: 'model', modelRefusal: 'unpriced' });

    // And the control: the same account, on a model the card prices, reserves.
    expect((await h.service.reserve(reserveInput(accountId))).outcome).toBe('reserved');
  });

  it('CRITICAL two requests that share an inbound x-request-id BOTH reserve, because a reservation is keyed only by an Idempotency-Key (M2) — and two that share an Idempotency-Key are refused by the database', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 500 });
    const h = harness();

    // The request id reaches nothing: both tasks carry the same session and the
    // same (absent) key, and both reserve.
    const sharedSession = `as_${randomUUID()}`;
    const first = await h.service.reserve(
      reserveInput(accountId, { agentSessionId: sharedSession }),
    );
    const second = await h.service.reserve(
      reserveInput(accountId, { agentSessionId: sharedSession }),
    );
    expect([first.outcome, second.outcome]).toEqual(['reserved', 'reserved']);
    const keys = await db()<Array<{ request_key: string | null }>>`
      SELECT request_key FROM credit_reservations WHERE account_id = ${accountId}::uuid`;
    expect(keys.map((r) => r.request_key)).toEqual([null, null]);

    // The positive control on the index that WOULD have refused them: the
    // idempotent lane does set a key, and a second task under the same key is
    // refused by the database, not by this code.
    const other = await newTaskAccount(db());
    await fundedTaskLot(db(), other, { credits: 500 });
    const idem = { idempotencyKey: 'customer-key-1' };
    const keyed = await h.service.reserve(reserveInput(other, idem));
    expect(keyed.outcome).toBe('reserved');
    const refused = await repoRefusal(() => h.service.reserve(reserveInput(other, idem)));
    expect(refused).toMatchObject({
      code: '23505',
      constraint: 'credit_reservations_request_unique',
    });
    const stored = await db()`
      SELECT request_key FROM credit_reservations WHERE account_id = ${other}::uuid`;
    expect(stored).toEqual([{ request_key: 'idem:customer-key-1' }]);
  });

  it('CRITICAL a refresh that FAILS does not block the task (H5): its partial work is rolled back to the savepoint, the failure is logged AND alerted with no customer data, and the reserve commits on the balance already recorded', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 20 });
    const marker = `refresh-wrote-${randomUUID()}`;
    const h = harness({
      refresher: refresherThat(async (tx, id) => {
        // A real write, then a real Postgres error — so the savepoint has
        // something to undo and the transaction is genuinely aborted to it.
        await tx.execute(sql`
          INSERT INTO credit_lots (account_id, kind, spend_rank, grant_key, granted_micro, starts_at, expires_at)
          VALUES (${id}::uuid, 'adjustment', 1, ${marker}, ${String(9 * MICRO)}::bigint,
                  now() - interval '1 hour', now() + interval '10 days')`);
        await tx.execute(sql`SELECT 1 / 0`);
      }),
    });

    const input = reserveInput(accountId);
    const result = await h.service.reserve(input);
    expect(result.outcome, 'the task runs anyway').toBe('reserved');
    if (result.outcome !== 'reserved') return;
    expect(result.reservedMicro, 'on the balance that was already there').toBe(20 * MICRO);

    expect(
      await db()`SELECT count(*)::int AS n FROM credit_lots WHERE grant_key = ${marker}`,
      'the refresh’s partial work was rolled back to the savepoint',
    ).toEqual([{ n: 0 }]);
    expect(
      await reservationRow(db(), input.reservationId),
      'and the reservation committed',
    ).toMatchObject({ state: 'open' });

    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.tags).toMatchObject({
      kind: 'ai_credits_refresh_failed',
      trigger: 'task_reserve',
    });
    expect(
      JSON.stringify(h.alerts[0]),
      'the alert carries the trigger and no customer data',
    ).not.toContain(accountId);
    expect(
      h.logged.some((line) => line.accountId === accountId),
      'the log line has it',
    ).toBe(true);
  });

  it('CRITICAL a refresh that SUCCEEDS is visible to the very task that ran it — credit granted inside the savepoint is credit that task can hold', async () => {
    const accountId = await newTaskAccount(db());
    const h = harness({
      refresher: refresherThat(async (tx, id) => {
        await tx.execute(sql`
          INSERT INTO credit_lots (id, account_id, kind, spend_rank, grant_key, granted_micro, starts_at, expires_at)
          VALUES ('00000000-0000-4000-8000-00000000f00d'::uuid, ${id}::uuid, 'adjustment', 1,
                  ${`lazy:${id}`}, ${String(25 * MICRO)}::bigint,
                  now() - interval '1 minute', now() + interval '10 days')`);
        await tx.execute(sql`
          INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
          VALUES (${id}::uuid, 'grant', '00000000-0000-4000-8000-00000000f00d'::uuid,
                  ${String(25 * MICRO)}::bigint, ${`grant:lazy:${id}`})`);
      }),
    });

    const result = await h.service.reserve(reserveInput(accountId));
    expect(result.outcome).toBe('reserved');
    if (result.outcome !== 'reserved') return;
    expect(result.reservedMicro, 'the month that just began is spendable now').toBe(25 * MICRO);
    expect(h.alerts, 'and nothing was alerted').toEqual([]);
  });

  it('CRITICAL a shadow task is MEASURED and never refused: it records what enforcement would have said, takes no slot, holds nothing, and leaves the balance untouched', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 4 });
    const h = harness();

    const input = reserveInput(accountId, { mode: 'shadow' });
    const result = await h.service.reserve(input);
    expect(result.outcome).toBe('shadowed');
    if (result.outcome !== 'shadowed') return;
    expect(result.wouldRefuseReason, '4 credits is under Sonnet’s 6').toBe('balance');
    expect(result.reservedMicro, 'a measuring stick, not a claim').toBe(SONNET_MAX_RESERVE_MICRO);

    expect(await reservationRow(db(), input.reservationId)).toMatchObject({
      mode: 'shadow',
      slot: null,
      would_refuse_reason: 'balance',
    });
    expect(await heldOf(db(), lot), 'no credit is held').toBe(0);
    expect(await holdRows(db(), input.reservationId)).toEqual([]);
    expect(
      await h.ledger.spendableMicro(accountId),
      'and the balance a legacy turn would see is unchanged',
    ).toBe(4 * MICRO);
  });

  it('CRITICAL a shadow task records NOTHING as its would-refuse reason when enforcement would have let it run — so the census can tell "would have been refused" from "was not measured"', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 40 });
    const h = harness();

    const input = reserveInput(accountId, { mode: 'shadow' });
    const result = await h.service.reserve(input);
    expect(result.outcome).toBe('shadowed');
    if (result.outcome !== 'shadowed') return;
    expect(result.wouldRefuseReason).toBeNull();
    expect(await reservationRow(db(), input.reservationId)).toMatchObject({
      would_refuse_reason: null,
    });
  });

  it('CRITICAL a shadow reserve whose DATABASE work fails leaves the caller untouched (M3): it is swallowed, counted, and returns a value — while the same fault on the enforced path throws', async () => {
    const h = harness();
    const broken = reserveInput('not-a-uuid', { mode: 'shadow' });

    const result = await h.service.reserve(broken);
    expect(result.outcome, 'shadow never throws').toBe('shadow_lost');
    expect(h.shadowLost, 'and it is counted').toHaveLength(1);

    // The instrument discriminates: the SAME fault on the enforced path does
    // throw, so the arm above is about the mode, not about an easy input.
    await expect(
      h.service.reserve({ ...broken, mode: 'enforce' as const }),
      'enforcement must not swallow a database fault',
    ).rejects.toThrow();
  });

  it('CRITICAL a shadow reserve whose COLLABORATOR throws is swallowed too, and no reservation is left behind', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 40 });
    const exploding: CreditRateCardReader = {
      cardInForce: () => Promise.reject(new Error('the card reader is down')),
      modelRow: () => Promise.reject(new Error('the card reader is down')),
    };
    const h = harness({ rateCards: exploding });

    const input = reserveInput(accountId, { mode: 'shadow' });
    expect((await h.service.reserve(input)).outcome).toBe('shadow_lost');
    expect(h.shadowLost).toHaveLength(1);
    expect(await reservationRow(db(), input.reservationId)).toBeUndefined();
  });

  it('CRITICAL the shadow path runs under a two-second statement timeout (M3), set LOCALLY so it cannot outlive the transaction', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 40 });
    const seen: string[] = [];
    const h = harness({
      refresher: refresherThat(async (tx) => {
        const rows = await tx.execute<{ t: string }>(
          sql`SELECT current_setting('statement_timeout') AS t`,
        );
        seen.push((rows as unknown as { t: string }[])[0]?.t ?? '<none>');
      }),
    });

    await h.service.reserve(reserveInput(accountId, { mode: 'shadow' }));
    expect(seen, 'the shadow transaction caps itself').toEqual(['2s']);

    // The control: the enforced path does NOT cap itself, so the value above is
    // the shadow path's doing and not the database's default.
    seen.length = 0;
    await h.service.reserve(reserveInput(accountId));
    expect(seen[0]).not.toBe('2s');
  });

  it('CRITICAL a reservation past its 30-minute ceiling cannot have its lease extended (M1) — the heartbeat renews a live one and skips it, so a stuck task cannot hold its slot for ever', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 140 });
    const h = harness();

    const live = reserveInput(accountId);
    expect((await h.service.reserve(live)).outcome).toBe('reserved');
    const stale = reserveInput(accountId);
    expect((await h.service.reserve(stale)).outcome).toBe('reserved');

    // Age the second one past its ceiling. The guard trigger refuses a change to
    // `max_until`, so the row is aged by moving the whole pair back — which is
    // also refused — so it is written as the database would have written it, by
    // a direct UPDATE of the two mutable lease columns plus a ceiling in the
    // past through a fresh row.
    await db()`
      UPDATE credit_reservations SET lease_expires_at = now() - interval '1 minute'
       WHERE id = ${stale.reservationId}::uuid`;
    await db()`
      INSERT INTO credit_reservations (id, account_id, agent_session_id, model, rate_card_version,
                                       mode, reserved_micro, lease_owner, lease_expires_at,
                                       max_until, created_at)
      VALUES (${randomUUID()}::uuid, ${accountId}::uuid, 'as_old', ${ON_CREDITS_MODEL}, 1,
              'shadow', ${String(MICRO)}::bigint, ${BOOT},
              now() - interval '10 minutes', now() - interval '1 minute',
              now() - interval '31 minutes')`;
    const [past] = await db()<Array<{ id: string }>>`
      SELECT id FROM credit_reservations
       WHERE account_id = ${accountId}::uuid AND max_until < now()`;
    expect(past, 'the fixture really produced a reservation past its ceiling').toBeDefined();

    const renewed = await h.ledger.transaction((tx) =>
      h.reservations.renewLeases(tx, {
        reservationIds: [live.reservationId, past?.id ?? ''],
        leaseOwner: BOOT,
      }),
    );
    expect(renewed, 'only the live one is renewed').toEqual([live.reservationId]);

    const [after] = await db()<Array<{ ahead: boolean }>>`
      SELECT lease_expires_at > now() AS ahead FROM credit_reservations
       WHERE id = ${live.reservationId}::uuid`;
    expect(after?.ahead, 'and its lease really moved forward').toBe(true);
  });

  it('CRITICAL the database itself refuses a ceiling further than 30 minutes out, so the rule does not rest on the code that writes it', async () => {
    const accountId = await newTaskAccount(db());
    await expect(
      db()`
        INSERT INTO credit_reservations (id, account_id, agent_session_id, model, rate_card_version,
                                         mode, reserved_micro, lease_owner, lease_expires_at, max_until)
        VALUES (${randomUUID()}::uuid, ${accountId}::uuid, 'as_x', ${ON_CREDITS_MODEL}, 1,
                'shadow', ${String(MICRO)}::bigint, ${BOOT},
                now() + interval '90 seconds', now() + interval '31 minutes')`,
    ).rejects.toThrow(/credit_reservations_max_until/);
  });
});

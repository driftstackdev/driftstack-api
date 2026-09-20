// Fixtures for the task reservation tests (migration 0131 and the reservations
// service).
//
// Each file gets its own database, rebuilt from the migrations on every run
// (`openLedgerDatabase`): reservations, holds, lots and ledger rows cannot be
// deleted, so a kept database would carry every earlier run's tasks into "this
// account has three open tasks".
//
// ⛔ EVERY TIME IS SQL TEXT OVER THE DATABASE'S OWN now(). The code under test
// decides "started", "expired", "leased" and "past its ceiling" on that clock
// alone, so a fixture that passed a JavaScript Date would be comparing this
// process's milliseconds against the database's microseconds.
//
// ⛔ ROWS ARE WRITTEN WITH RAW SQL WHERE THE POINT IS WHAT THE DATABASE REFUSES.
// The tests prove the database's own guarantees, so the fixtures must not route
// through the repository whose checks would stop a bad row before Postgres saw
// it.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { createDb, type Database } from '../../../src/db/client.js';
import {
  DrizzleCreditLedgerRepo,
  type CreditLedgerTx,
} from '../../../src/db/credit-ledger-repo.js';
import { DrizzleCreditRateCardRepo } from '../../../src/db/credit-rate-card-repo.js';
import type { CreditRateCardReader } from '../../../src/db/credit-rate-card-repo.js';
import { DrizzleCreditReservationsRepo } from '../../../src/db/credit-reservations-repo.js';
import { DrizzleCreditWindowsRepo } from '../../../src/db/credit-windows-repo.js';
import { CreditGrantsService } from '../../../src/services/credit-grants.js';
import {
  CreditReservationsService,
  type CreditBoundExceeded,
  type CreditsInTransactionRefresher,
} from '../../../src/services/credit-reservations.js';
import type { Logger } from '../../../src/lib/logger.js';
import { MICRO } from './credit-ledger-fixtures.js';

type Sql = postgres.Sql | postgres.TransactionSql;

export { MICRO };

/** The launch card's Sonnet 5 row (0127's seed), in microcredits. */
export const SONNET_MIN_START_MICRO = 6 * MICRO;
export const SONNET_MAX_RESERVE_MICRO = 60 * MICRO;
export const HAIKU_MIN_START_MICRO = 3 * MICRO;
export const HAIKU_MAX_RESERVE_MICRO = 30 * MICRO;

/** A model the deployment's key may run on credits, and one it may not. */
export const ON_CREDITS_MODEL = 'claude-sonnet-5';
export const OWN_KEY_ONLY_MODEL = 'claude-opus-5';

export interface ReservationsHarness {
  readonly database: Database;
  readonly ledger: DrizzleCreditLedgerRepo;
  readonly windows: DrizzleCreditWindowsRepo;
  readonly reservations: DrizzleCreditReservationsRepo;
  readonly rateCards: CreditRateCardReader;
  readonly service: CreditReservationsService;
  /** Every error the shadow path swallowed, in order. */
  readonly shadowLost: unknown[];
  /** Every `ai_credits_bound_exceeded` a call settlement raised, in order. */
  readonly boundExceeded: CreditBoundExceeded[];
  /** Every Sentry alert the refresh failure raised. */
  readonly alerts: { message: string; tags?: Record<string, string> }[];
  /** Every error-level log line, so an alert can be told from a log. */
  readonly logged: Record<string, unknown>[];
}

export interface HarnessOptions {
  readonly max?: number;
  /**
   * The refresh a reserve runs under its savepoint. `'real'` wires the live
   * grants service; a function stands in for it; null is "AI credits are off",
   * which is what every arm that is not about the refresh wants.
   */
  readonly refresher?: 'real' | CreditsInTransactionRefresher | null;
  readonly rateCards?: CreditRateCardReader;
}

/** The real repos and service over one connection pool on `url`. */
export function reservationsHarness(url: string, opts: HarnessOptions = {}): ReservationsHarness {
  const database = createDb(url, { max: opts.max ?? 4 });
  const ledger = new DrizzleCreditLedgerRepo(database);
  const windows = new DrizzleCreditWindowsRepo(database);
  const reservations = new DrizzleCreditReservationsRepo();
  const rateCards = opts.rateCards ?? new DrizzleCreditRateCardRepo(database);
  const shadowLost: unknown[] = [];
  const boundExceeded: CreditBoundExceeded[] = [];
  const alerts: { message: string; tags?: Record<string, string> }[] = [];
  const logged: Record<string, unknown>[] = [];
  const refresher =
    opts.refresher === 'real'
      ? new CreditGrantsService({ ledger, windows })
      : (opts.refresher ?? null);
  const service = new CreditReservationsService({
    ledger,
    reservations,
    rateCards,
    refresher,
    logger: {
      error: (obj: unknown) => logged.push(obj as Record<string, unknown>),
      warn: (obj: unknown) => logged.push(obj as Record<string, unknown>),
      info: () => undefined,
      debug: () => undefined,
    } as unknown as Logger,
    sentry: {
      captureMessage: (input: { message: string; tags?: Record<string, string> }) => {
        alerts.push({ message: input.message, ...(input.tags ? { tags: input.tags } : {}) });
      },
    },
    onShadowLost: (err) => shadowLost.push(err),
    onBoundExceeded: (detail) => boundExceeded.push(detail),
  });
  return {
    database,
    ledger,
    windows,
    reservations,
    rateCards,
    service,
    shadowLost,
    boundExceeded,
    alerts,
    logged,
  };
}

/** A refresher that runs `body` inside the reserve's savepoint. */
export function refresherThat(
  body: (tx: CreditLedgerTx, accountId: string) => Promise<unknown>,
): CreditsInTransactionRefresher {
  return { refreshCreditsIn: (tx, accountId) => body(tx, accountId) };
}

/** A new account with its credit row, on `tier`. */
export async function newTaskAccount(sql: Sql, tier = 'team_manual'): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO accounts (id, email, tier)
    VALUES (${id}::uuid, ${`task-${id}@example.test`}, ${tier}::account_tier)`;
  await sql`INSERT INTO credit_accounts (account_id) VALUES (${id}::uuid)`;
  return id;
}

export interface LotSpec {
  readonly kind?: 'monthly' | 'proration' | 'adjustment' | 'top_up';
  readonly credits?: number;
  /** SQL for starts_at; default one hour ago. */
  readonly starts?: string;
  /** SQL for expires_at; default thirty days on. */
  readonly expires?: string;
}

/**
 * A funded lot. An included lot (monthly or proration, spend rank 0) gets a
 * month window of its own, because `credit_lots_window_iff_included` requires
 * one and `credit_lots_window_fk` requires it to belong to this account.
 */
export async function fundedTaskLot(
  sql: Sql,
  accountId: string,
  lot: LotSpec = {},
): Promise<string> {
  const kind = lot.kind ?? 'adjustment';
  const rank = kind === 'monthly' || kind === 'proration' ? 0 : kind === 'adjustment' ? 1 : 2;
  const granted = (lot.credits ?? 100) * MICRO;
  const windowId = rank === 0 ? await monthWindow(sql, accountId) : null;
  const [row] = await sql.unsafe<Array<{ id: string }>>(
    `INSERT INTO credit_lots (account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, ${lot.starts ?? "now() - interval '1 hour'"}, ${lot.expires ?? "now() + interval '30 days'"})
     RETURNING id`,
    [accountId, kind, rank, windowId, `task:${randomUUID()}`, granted],
  );
  if (row === undefined) throw new Error('lot insert returned nothing');
  await sql`
    INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
    SELECT ${accountId}::uuid, 'grant', id, granted_micro, ${`grant:${row.id}`}
      FROM credit_lots WHERE id = ${row.id}::uuid`;
  return row.id;
}

/**
 * A month window for this account, so that an INCLUDED lot has one to name.
 *
 * ⛔ ANCHORED ON A FIXED INSTANT, NOT ON now(). Each window is the nth calendar
 * month from a date in the past, so any number of them are disjoint by
 * construction — which is what `credit_windows_no_overlap` demands. Windows cut
 * from `now() - n months` are NOT: `now()` is the transaction timestamp and
 * advances between statements, so the second window's end lands a few
 * microseconds past the first window's start and the exclusion constraint
 * refuses it. (Measured, the first time this helper was written that way.)
 * A window's own term says nothing about its lots' terms, which is what the
 * arms about started, live and expired credit vary.
 */
export async function monthWindow(sql: Sql, accountId: string): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO credit_windows (account_id, source, source_ref, natural_start, natural_end,
                                window_start, window_end, tier, level_micro)
    SELECT ${accountId}::uuid, 'plan_override', ${`ref-${randomUUID()}`},
           ${WINDOW_EPOCH}::timestamptz + make_interval(months => n),
           ${WINDOW_EPOCH}::timestamptz + make_interval(months => 1 + n),
           ${WINDOW_EPOCH}::timestamptz + make_interval(months => n),
           ${WINDOW_EPOCH}::timestamptz + make_interval(months => 1 + n),
           'team_manual'::account_tier, 0
      FROM (SELECT count(*)::int AS n FROM credit_windows WHERE account_id = ${accountId}::uuid) c
    RETURNING id`;
  if (row === undefined) throw new Error('window insert returned nothing');
  return row.id;
}

/** Where the fixed month ladder above starts. Long past, so every window has begun. */
const WINDOW_EPOCH = '2020-01-01T00:00:00Z';

/**
 * A month window whose END is in the future, so a lot hanging off it can be
 * live. Only one per account: a second would overlap the first.
 */
export async function liveMonthWindow(sql: Sql, accountId: string): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO credit_windows (account_id, source, source_ref, natural_start, natural_end,
                                window_start, window_end, tier, level_micro)
    VALUES (${accountId}::uuid, 'plan_override', ${`live-${randomUUID()}`},
            now() - interval '10 days', now() + interval '20 days',
            now() - interval '10 days', now() + interval '20 days',
            'team_manual'::account_tier, 0)
    RETURNING id`;
  if (row === undefined) throw new Error('window insert returned nothing');
  return row.id;
}

/** What the account's lots are holding for running tasks right now. */
export async function heldOf(sql: Sql, lotId: string): Promise<number> {
  const [row] = await sql<Array<{ n: string }>>`
    SELECT held_micro::text AS n FROM credit_lots WHERE id = ${lotId}::uuid`;
  if (row === undefined) throw new Error(`lot ${lotId} not found`);
  return Number(row.n);
}

export async function reservationRow(
  sql: Sql,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const [row] = await sql<Array<Record<string, unknown>>>`
    SELECT * FROM credit_reservations WHERE id = ${id}::uuid`;
  return row;
}

export async function holdRows(
  sql: Sql,
  reservationId: string,
): Promise<{ lotId: string; heldMicro: number; chargedMicro: number | null }[]> {
  const rows = await sql<Array<{ lot_id: string; held: string; charged: string | null }>>`
    SELECT h.lot_id, h.held_micro::text AS held, h.charged_micro::text AS charged
      FROM credit_reservation_holds h
      JOIN credit_lots l ON l.id = h.lot_id
     WHERE h.reservation_id = ${reservationId}::uuid
     ORDER BY l.spend_rank, l.expires_at, l.created_at, l.id`;
  return rows.map((r) => ({
    lotId: r.lot_id,
    heldMicro: Number(r.held),
    chargedMicro: r.charged === null ? null : Number(r.charged),
  }));
}

/**
 * One SETTLED model call on a reservation, written with raw SQL in ONE
 * transaction with the reservation's `committed_micro`.
 *
 * ⛔ THE TWO GO TOGETHER OR NEITHER DOES. A COMMIT-time check refuses a
 * reservation whose `committed_micro` is not what its calls commit (a started
 * call commits its bound, a settled one its charge), so a call written on its
 * own aborts the transaction that wrote it. S8 writes both in one statement
 * pair for the same reason.
 */
export async function settledCall(
  sql: postgres.Sql,
  input: {
    readonly reservationId: string;
    readonly accountId: string;
    readonly seq?: number;
    readonly chargedMicro: number;
    /** Defaults to twice the charge, so the charge is inside the bound. */
    readonly boundMicro?: number;
  },
): Promise<string> {
  const id = randomUUID();
  const bound = input.boundMicro ?? Math.max(input.chargedMicro * 2, 2);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO credit_model_calls (id, reservation_id, account_id, seq, purpose, model,
                                      input_bound_tokens, input_bound_basis, input_bound_micro,
                                      max_output_tokens, bound_micro, sent, state, settle_basis,
                                      charged_micro, settled_at)
      VALUES (${id}::uuid, ${input.reservationId}::uuid, ${input.accountId}::uuid,
              ${input.seq ?? 1}, 'plan', ${ON_CREDITS_MODEL}, 1000, 'region_bytes',
              ${String(Math.max(1, Math.floor(bound / 2)))}::bigint, 4096, ${String(bound)}::bigint,
              true, 'settled', 'provider_usage', ${String(input.chargedMicro)}::bigint, now())`;
    await tx`
      UPDATE credit_reservations
         SET committed_micro = (SELECT COALESCE(SUM(CASE WHEN state = 'started' THEN bound_micro
                                                         ELSE charged_micro END), 0)
                                  FROM credit_model_calls
                                 WHERE reservation_id = ${input.reservationId}::uuid)
       WHERE id = ${input.reservationId}::uuid`;
  });
  return id;
}

/**
 * One STARTED model call on a reservation — admitted, sent, and no outcome ever
 * recorded for it — written with raw SQL in ONE transaction with the
 * reservation's `committed_micro`, for the same reason `settledCall` is.
 *
 * ⛔ THIS IS THE CRASH SHAPE, AND §5.3 CALLS THE CRASH PATH THE MAIN PATH. A
 * process that dies after a request goes out leaves exactly this row: `state`
 * still 'started', `charged_micro` still NULL, and nothing that will ever fill
 * them in. The lease keeper then settles the task around it, and what the
 * settlement does with the call is the owner's rule — the full bound.
 */
export async function startedCall(
  sql: postgres.Sql,
  input: {
    readonly reservationId: string;
    readonly accountId: string;
    readonly seq?: number;
    readonly boundMicro: number;
    /** False is "a Stop landed during admission": the request never went out. */
    readonly sent?: boolean;
  },
): Promise<string> {
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO credit_model_calls (id, reservation_id, account_id, seq, purpose, model,
                                      input_bound_tokens, input_bound_basis, input_bound_micro,
                                      max_output_tokens, bound_micro, sent)
      VALUES (${id}::uuid, ${input.reservationId}::uuid, ${input.accountId}::uuid,
              ${input.seq ?? 1}, 'plan', ${ON_CREDITS_MODEL}, 1000, 'region_bytes',
              ${String(Math.max(1, Math.floor(input.boundMicro / 2)))}::bigint, 4096,
              ${String(input.boundMicro)}::bigint, ${input.sent ?? true})`;
    await tx`
      UPDATE credit_reservations
         SET committed_micro = (SELECT COALESCE(SUM(CASE WHEN state = 'started' THEN bound_micro
                                                         ELSE charged_micro END), 0)
                                  FROM credit_model_calls
                                 WHERE reservation_id = ${input.reservationId}::uuid)
       WHERE id = ${input.reservationId}::uuid`;
  });
  return id;
}

/**
 * An ENFORCED task whose hard ceiling (`max_until`, M1) has ALREADY PASSED,
 * backed by a real hold on `lotId`.
 *
 * ⛔ WRITTEN AS A FRESH ROW, NOT AGED BY AN UPDATE. `created_at` and `max_until`
 * are both on the reservation guard's immutable list, so a row cannot be moved
 * back in time after it exists — and `credit_reservations_max_until` requires
 * the ceiling to sit within thirty minutes of creation, so the pair has to be
 * written together. This is the row the keeper finds when a turn never finished.
 */
export async function agedReservation(
  sql: postgres.Sql,
  input: {
    readonly accountId: string;
    readonly lotId: string;
    readonly reservedMicro: number;
    readonly model?: string;
    readonly leaseOwner?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO credit_reservations (id, account_id, agent_session_id, model, rate_card_version,
                                       mode, slot, reserved_micro, lease_owner,
                                       lease_expires_at, max_until, created_at)
      SELECT ${id}::uuid, ${input.accountId}::uuid, ${`as_${id}`},
             ${input.model ?? ON_CREDITS_MODEL}, 1, 'enforce',
             (SELECT s FROM generate_series(1, 3) s
               WHERE NOT EXISTS (SELECT 1 FROM credit_reservations o
                                  WHERE o.account_id = ${input.accountId}::uuid
                                    AND o.state = 'open' AND o.mode = 'enforce' AND o.slot = s)
               ORDER BY s LIMIT 1),
             ${String(input.reservedMicro)}::bigint, ${input.leaseOwner ?? 'fixture-boot'},
             now() - interval '1 minute', now() - interval '1 minute',
             now() - interval '31 minutes'`;
    await tx`
      INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
      VALUES (${id}::uuid, ${input.lotId}::uuid, ${input.accountId}::uuid,
              ${String(input.reservedMicro)}::bigint)`;
  });
  return id;
}

/** Every model call of one task, in the order the task made them. */
export async function modelCallRows(
  sql: Sql,
  reservationId: string,
): Promise<
  {
    id: string;
    seq: number;
    purpose: string;
    model: string;
    state: string;
    sent: boolean;
    settleBasis: string | null;
    boundMicro: number;
    inputBoundMicro: number;
    maxOutputTokens: number;
    chargedMicro: number | null;
    actualMicro: number | null;
    shadowOverReservation: boolean;
    outputTokens: number | null;
  }[]
> {
  const rows = await sql<Array<Record<string, string | number | boolean | null>>>`
    SELECT id, seq, purpose, model, state, sent, settle_basis, bound_micro::text AS bound,
           input_bound_micro::text AS input_bound, max_output_tokens,
           charged_micro::text AS charged, actual_micro::text AS actual,
           shadow_over_reservation, output_tokens
      FROM credit_model_calls WHERE reservation_id = ${reservationId}::uuid
     ORDER BY seq`;
  return rows.map((r) => ({
    id: String(r.id),
    seq: Number(r.seq),
    purpose: String(r.purpose),
    model: String(r.model),
    state: String(r.state),
    sent: r.sent === true,
    settleBasis: r.settle_basis === null ? null : String(r.settle_basis),
    boundMicro: Number(r.bound),
    inputBoundMicro: Number(r.input_bound),
    maxOutputTokens: Number(r.max_output_tokens),
    chargedMicro: r.charged === null ? null : Number(r.charged),
    actualMicro: r.actual === null ? null : Number(r.actual),
    shadowOverReservation: r.shadow_over_reservation === true,
    outputTokens: r.output_tokens === null ? null : Number(r.output_tokens),
  }));
}

/** What one task has committed and been charged, and how its lease stands. */
export async function reservationCounters(
  sql: Sql,
  id: string,
): Promise<{
  state: string;
  reservedMicro: number;
  committedMicro: number;
  chargedMicro: number | null;
  wouldRefuseReason: string | null;
  leaseSecondsLeft: number;
}> {
  const [row] = await sql<Array<Record<string, string | number | null>>>`
    SELECT state, reserved_micro::text AS reserved, committed_micro::text AS committed,
           charged_micro::text AS charged, would_refuse_reason,
           EXTRACT(EPOCH FROM (lease_expires_at - now()))::float8 AS lease_left
      FROM credit_reservations WHERE id = ${id}::uuid`;
  if (row === undefined) throw new Error(`reservation ${id} not found`);
  return {
    state: String(row.state),
    reservedMicro: Number(row.reserved),
    committedMicro: Number(row.committed),
    chargedMicro: row.charged === null ? null : Number(row.charged),
    wouldRefuseReason: row.would_refuse_reason === null ? null : String(row.would_refuse_reason),
    leaseSecondsLeft: Number(row.lease_left),
  };
}

/** One model call's settlement, as the database recorded it. */
export async function modelCallRow(
  sql: Sql,
  id: string,
): Promise<{
  state: string;
  settleBasis: string | null;
  chargedMicro: number | null;
  boundMicro: number;
}> {
  const [row] = await sql<
    Array<{ state: string; basis: string | null; charged: string | null; bound: string }>
  >`
    SELECT state, settle_basis AS basis, charged_micro::text AS charged,
           bound_micro::text AS bound
      FROM credit_model_calls WHERE id = ${id}::uuid`;
  if (row === undefined) throw new Error(`model call ${id} not found`);
  return {
    state: row.state,
    settleBasis: row.basis,
    chargedMicro: row.charged === null ? null : Number(row.charged),
    boundMicro: Number(row.bound),
  };
}

/** Every ledger row of one account, newest last, as (kind, lot, delta) triples. */
export async function ledgerOf(
  sql: Sql,
  accountId: string,
): Promise<{ kind: string; lotId: string | null; lotDelta: number; debtDelta: number }[]> {
  const rows = await sql<Array<{ kind: string; lot_id: string | null; lot: string; debt: string }>>`
    SELECT kind, lot_id, lot_delta_micro::text AS lot, debt_delta_micro::text AS debt
      FROM credit_ledger WHERE account_id = ${accountId}::uuid ORDER BY id`;
  return rows.map((r) => ({
    kind: r.kind,
    lotId: r.lot_id,
    lotDelta: Number(r.lot),
    debtDelta: Number(r.debt),
  }));
}

/** A lot's remaining and held amounts. */
export async function lotState(
  sql: Sql,
  lotId: string,
): Promise<{ remaining: number; held: number }> {
  const [row] = await sql<Array<{ remaining: string; held: string }>>`
    SELECT remaining_micro::text AS remaining, held_micro::text AS held
      FROM credit_lots WHERE id = ${lotId}::uuid`;
  if (row === undefined) throw new Error(`lot ${lotId} not found`);
  return { remaining: Number(row.remaining), held: Number(row.held) };
}

/** The account's recorded debt. */
export async function debtMicroOf(sql: Sql, accountId: string): Promise<number> {
  const [row] = await sql<Array<{ n: string }>>`
    SELECT debt_micro::text AS n FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
  return Number(row?.n ?? '-1');
}

/** Wait until the database says this lot's term has ended. No timing margin: it polls. */
export async function waitUntilExpired(sql: postgres.Sql, lotId: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    const [row] = await sql<Array<{ done: boolean }>>`
      SELECT expires_at <= now() AS done FROM credit_lots WHERE id = ${lotId}::uuid`;
    if (row?.done === true) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`lot ${lotId} never expired`);
}

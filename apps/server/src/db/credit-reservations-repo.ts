// Reads and writes the task reservations AI credits are spent through
// (migration 0131): the reservation row, the holds that back it, and the reads
// a settlement walks.
//
// ⛔ THE DATABASE IS THE AUTHORITY, NOT THIS FILE. At most three enforced tasks
// per account (a partial unique index), a hold only on a started, live,
// unrevoked lot of the same account, a hold never beyond what its lot has left,
// `held_micro` moving only through the holds, immutable terms, and a settled
// task that balances across its calls, its holds and the ledger — all of that is
// enforced in Postgres (see the notes beside `creditReservations` in schema.ts).
// The statements here are written so that an ordinary outcome is an empty
// result rather than an exception, and so that the choice of WHICH lots back a
// task is made by the database in one statement rather than by a walk in this
// process.
//
// ⛔ SPENDABLE IS ONE PREDICATE, EVERYWHERE, ON THE DATABASE'S CLOCK:
// `starts_at <= now() AND now() < expires_at AND revoked_at IS NULL AND
// remaining_micro > held_micro`. It is what `spendableMicro` sums, what the hold
// walk below draws from, what the holds' own trigger re-checks, and what the
// COMMIT-time debt check reads. The `starts_at` half is H4: a month that has not
// begun must not be spendable, or a payment refunded before that month starts
// takes back credits that are already gone.
//
// Amounts are microcredits (1 credit = 1,000,000 µcr = US$0.01), read as
// JavaScript numbers and refused rather than rounded past 2^53.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { CreditLedgerExecutor, CreditLedgerTx } from './credit-ledger-repo.js';
import { rowsOf } from './credit-ledger-repo.js';
import { creditReservations } from './schema.js';

/** How a task is metered (`credit_reservations_mode`). */
export const CREDIT_RESERVATION_MODES = ['enforce', 'shadow'] as const;
export type CreditReservationMode = (typeof CREDIT_RESERVATION_MODES)[number];

/** Where a task stands (`credit_reservations_state`). */
export const CREDIT_RESERVATION_STATES = ['open', 'settled'] as const;
export type CreditReservationState = (typeof CREDIT_RESERVATION_STATES)[number];

/**
 * What enforcement would have refused a shadow task on
 * (`credit_reservations_would_refuse_reason`). The first four are decided by
 * `reserve`; `call_did_not_fit` is decided per call by S8's admission.
 */
export const CREDIT_WOULD_REFUSE_REASONS = [
  'model',
  'tasks_in_flight',
  'debt',
  'balance',
  'call_did_not_fit',
] as const;
export type CreditWouldRefuseReason = (typeof CREDIT_WOULD_REFUSE_REASONS)[number];

/** Why a task was settled (`credit_reservations_settle_reason`). */
export const CREDIT_SETTLE_REASONS = ['completed', 'lease_expired', 'max_age', 'admin'] as const;
export type CreditSettleReason = (typeof CREDIT_SETTLE_REASONS)[number];

/** What one model call was for (`credit_model_calls_purpose`). */
export const CREDIT_MODEL_CALL_PURPOSES = ['plan', 'answer'] as const;
export type CreditModelCallPurpose = (typeof CREDIT_MODEL_CALL_PURPOSES)[number];

/** How a call's input bound was measured (`credit_model_calls_basis`). */
export const CREDIT_CALL_BOUND_BASES = ['region_bytes', 'token_count'] as const;
export type CreditCallBoundBasis = (typeof CREDIT_CALL_BOUND_BASES)[number];

/** Where one model call stands (`credit_model_calls_state`). */
export const CREDIT_MODEL_CALL_STATES = ['started', 'settled'] as const;
export type CreditModelCallState = (typeof CREDIT_MODEL_CALL_STATES)[number];

/** What a settled call's charge was computed from (`credit_model_calls_settle_basis`). */
export const CREDIT_CALL_SETTLE_BASES = [
  'provider_usage',
  'provider_rejected',
  'never_sent',
  'partial_usage',
  'no_record',
] as const;
export type CreditCallSettleBasis = (typeof CREDIT_CALL_SETTLE_BASES)[number];

/** A task holds at most this many of an account's three enforced slots. */
export const CREDIT_RESERVATION_SLOTS = [1, 2, 3] as const;
export type CreditReservationSlot = (typeof CREDIT_RESERVATION_SLOTS)[number];

/** How long a lease runs before the keeper may settle the task, in seconds. */
export const CREDIT_LEASE_SECONDS = 90;

/** The hard ceiling on a task's life, in minutes (M1). */
export const CREDIT_MAX_UNTIL_MINUTES = 30;

export interface NewCreditReservation {
  readonly id: string;
  readonly accountId: string;
  readonly agentSessionId: string;
  /** `'idem:<Idempotency-Key>'`, or null on every other lane (M2). */
  readonly requestKey: string | null;
  readonly model: string;
  readonly rateCardVersion: number;
  /** The most this task may reserve, from the model's rate-card row. */
  readonly maxReserveMicro: number;
  /** What the account has spendable right now; the reservation is the lesser. */
  readonly availableMicro: number;
  readonly leaseOwner: string;
}

export interface InsertedCreditReservation {
  readonly slot: CreditReservationSlot;
  readonly reservedMicro: number;
}

export interface CreditHold {
  readonly lotId: string;
  readonly heldMicro: number;
}

/** One hold as a settlement walks it: spend order, unreleased first. */
export interface OpenCreditHold extends CreditHold {
  /** True when the lot's term has ended or it was revoked: what is released expires. */
  readonly lotDone: boolean;
  readonly lotRevoked: boolean;
}

export interface OpenCreditReservation {
  readonly id: string;
  readonly accountId: string;
  readonly agentSessionId: string;
  readonly mode: CreditReservationMode;
  readonly model: string;
  readonly rateCardVersion: number;
  readonly slot: CreditReservationSlot | null;
  readonly state: CreditReservationState;
  readonly reservedMicro: number;
  readonly committedMicro: number;
  readonly chargedMicro: number | null;
}

/**
 * The ceiling one call is admitted under, as the fit ladder decided it (§4.5).
 * Every field is written onto the `credit_model_calls` row, so what the task was
 * allowed to spend is recoverable long after the process that spent it is gone.
 */
export interface CreditCallBound {
  readonly inputBoundTokens: number;
  readonly inputBoundMicro: number;
  readonly maxOutputTokens: number;
  readonly boundMicro: number;
  readonly basis: CreditCallBoundBasis;
}

/** What one admission committed, read back from the statement that committed it. */
export interface CommittedCallBound {
  readonly accountId: string;
  readonly mode: CreditReservationMode;
  readonly rateCardVersion: number;
  /** `reserved − committed` AFTER this bound was committed. */
  readonly leftMicro: number;
  /** Shadow only: this call carried the measurement past what the task reserved. */
  readonly overReservation: boolean;
}

/**
 * Why an admission found no row to update. Each is a different answer to the
 * customer, and "zero rows" on its own is none of them.
 */
export type CreditAdmissionRefusal = 'gone' | 'settled' | 'max_age' | 'model' | 'did_not_fit';

/** One call as a settlement finds it, with the terms its reservation pinned. */
export interface CreditCallForSettlement {
  readonly callId: string;
  readonly reservationId: string;
  readonly accountId: string;
  readonly state: CreditModelCallState;
  readonly sent: boolean;
  readonly model: string;
  readonly mode: CreditReservationMode;
  readonly rateCardVersion: number;
  readonly boundMicro: number;
  readonly maxOutputTokens: number;
  /** What it was charged, once it is settled. */
  readonly chargedMicro: number | null;
}

/** What a task pinned, as a call about to be planned needs to read it. */
export interface CreditReservationTerms {
  readonly mode: CreditReservationMode;
  readonly model: string;
  readonly rateCardVersion: number;
  readonly state: CreditReservationState;
  readonly reservedMicro: number;
  readonly committedMicro: number;
  /** True once the task has passed its hard ceiling: no call may be admitted. */
  readonly pastCeiling: boolean;
}

/**
 * Why a task the lease keeper found is the keeper's to settle. A subset of the
 * settle reasons on purpose: `completed` belongs to the process that ran the
 * turn, and `admin` to a person.
 */
export type LapsedSettleReason = Extract<CreditSettleReason, 'lease_expired' | 'max_age'>;

/** One abandoned task, as the lease keeper's candidate read found it. */
export interface LapsedCreditReservation {
  readonly reservationId: string;
  readonly accountId: string;
  readonly reason: LapsedSettleReason;
}

/** A clawback still owed credit that running tasks hold (`pending_micro > 0`). */
export interface PendingCreditClaim {
  readonly clawbackId: string;
  readonly source: string;
  readonly pendingMicro: number;
  /** What it claws from: a credit unit (`window:<window>:<payment>`) for a reversal. */
  readonly targetKey: string;
  /** 0140 — the account's newest ledger row when the claim was made; null before 0140. */
  readonly ledgerMark: number | null;
  /**
   * 0140 — how much more of the unit's credit may be spent after the claim was
   * made before a part of it left unpaid is no longer owed; null: always owed.
   */
  readonly claimForgiveAfterMicro: number | null;
}

function exact(what: string, value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} is not a safe integer`);
  return value;
}

function slotOf(value: unknown): CreditReservationSlot {
  const n = Number(value);
  if (n !== 1 && n !== 2 && n !== 3) throw new RangeError('a reservation slot is 1, 2 or 3');
  return n;
}

function member<T extends string>(what: string, values: readonly T[], value: string): T {
  if (!(values as readonly string[]).includes(value)) {
    throw new RangeError(`${what} holds an unknown value`);
  }
  return value as T;
}

export class DrizzleCreditReservationsRepo {
  /**
   * How many enforced tasks this account has in flight. The caller holds the
   * account's credit lock, so the count it reads cannot change under it — and
   * behind that, `credit_reservations_open_slot_unique` refuses a fourth open
   * enforced row whatever any count said.
   */
  async openEnforceCount(tx: CreditLedgerTx, accountId: string): Promise<number> {
    const result = await tx.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM credit_reservations
       WHERE account_id = ${accountId}::uuid AND state = 'open' AND mode = 'enforce'`);
    return exact('open reservations', Number(rowsOf<{ n: string }>(result)[0]?.n ?? '0'));
  }

  /**
   * S14 — the same count as {@link openEnforceCount}, read with NO LOCK, for
   * `GET /v1/account/me/ai`'s `balance.tasks_in_flight` (§4.4: the tier/source
   * read may run without one — this is the same kind of read, and the number
   * it returns is free to move before the response is sent). The authority
   * for whether a NEW task may start remains `openEnforceCount` under the
   * account lock inside `reserve()`; this exists only so a GET does not open a
   * write transaction merely to count.
   */
  async openEnforceCountNoLock(accountId: string, on: CreditLedgerExecutor): Promise<number> {
    const result = await on.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM credit_reservations
       WHERE account_id = ${accountId}::uuid AND state = 'open' AND mode = 'enforce'`);
    return exact('open reservations', Number(rowsOf<{ n: string }>(result)[0]?.n ?? '0'));
  }

  /**
   * Insert an ENFORCED reservation, taking the lowest free slot and reserving
   * `LEAST(max_reserve, available)`. One statement: the slot is chosen by the
   * database from the rows that exist at that instant, so two connections racing
   * for the same slot meet the unique index rather than each other's read.
   *
   * ⛔ CALL UNDER `lockAccount`, and only after the four refusals. The reserved
   * amount must be positive (`credit_reservations_amounts`), which is what the
   * `balance` refusal guarantees, and the slot must exist, which is what the
   * `tasks_in_flight` refusal guarantees.
   */
  async insertEnforceReservation(
    tx: CreditLedgerTx,
    r: NewCreditReservation,
  ): Promise<InsertedCreditReservation> {
    const result = await tx.execute<{ slot: number; reserved: string }>(sql`
      INSERT INTO credit_reservations (id, account_id, agent_session_id, request_key, model,
                                       rate_card_version, mode, slot, reserved_micro,
                                       lease_owner, lease_expires_at, max_until)
      SELECT ${r.id}::uuid, ${r.accountId}::uuid, ${r.agentSessionId}, ${r.requestKey},
             ${r.model}, ${r.rateCardVersion}, 'enforce',
             (SELECT s FROM generate_series(1, 3) s
               WHERE NOT EXISTS (SELECT 1 FROM credit_reservations o
                                  WHERE o.account_id = ${r.accountId}::uuid
                                    AND o.state = 'open' AND o.mode = 'enforce' AND o.slot = s)
               ORDER BY s LIMIT 1),
             LEAST(${r.maxReserveMicro}::bigint, ${r.availableMicro}::bigint), ${r.leaseOwner},
             now() + make_interval(secs => ${CREDIT_LEASE_SECONDS}),
             now() + make_interval(mins => ${CREDIT_MAX_UNTIL_MINUTES})
      RETURNING slot, reserved_micro::text AS reserved`);
    const row = rowsOf<{ slot: number; reserved: string }>(result)[0];
    if (row === undefined) throw new Error('a reservation insert returned nothing');
    return { slot: slotOf(row.slot), reservedMicro: exact('a reservation', Number(row.reserved)) };
  }

  /**
   * Insert a SHADOW reservation: no slot, no holds, and `would_refuse_reason`
   * recording the first check enforcement would have refused on.
   *
   * It reserves the model's FULL `max_reserve` rather than what the account
   * could afford. A shadow reservation is a measuring stick, not a claim on
   * credit — it holds nothing — so capping it at a balance the task never
   * touches would cap the measurement too, and the balance answer is exactly
   * what `would_refuse_reason` already carries.
   *
   * ⛔ `reservedMicro`, NOT `maxReserveMicro`, because the two part company in
   * exactly one case: a model the card in force cannot price has NO
   * `max_reserve`, and its measurement reserves ZERO (0132). Naming the
   * parameter after the rate-card row would have made that call site a lie about
   * where its number came from.
   */
  async insertShadowReservation(
    tx: CreditLedgerTx,
    r: Omit<NewCreditReservation, 'availableMicro' | 'maxReserveMicro'> & {
      /** The model's `max_reserve`, or 0 for a model the card cannot price. */
      readonly reservedMicro: number;
      readonly wouldRefuseReason: CreditWouldRefuseReason | null;
    },
  ): Promise<{ readonly reservedMicro: number }> {
    const result = await tx.execute<{ reserved: string }>(sql`
      INSERT INTO credit_reservations (id, account_id, agent_session_id, request_key, model,
                                       rate_card_version, mode, reserved_micro,
                                       would_refuse_reason, lease_owner, lease_expires_at, max_until)
      VALUES (${r.id}::uuid, ${r.accountId}::uuid, ${r.agentSessionId}, ${r.requestKey},
              ${r.model}, ${r.rateCardVersion}, 'shadow', ${r.reservedMicro}::bigint,
              ${r.wouldRefuseReason}, ${r.leaseOwner},
              now() + make_interval(secs => ${CREDIT_LEASE_SECONDS}),
              now() + make_interval(mins => ${CREDIT_MAX_UNTIL_MINUTES}))
      RETURNING reserved_micro::text AS reserved`);
    const row = rowsOf<{ reserved: string }>(result)[0];
    if (row === undefined) throw new Error('a shadow reservation insert returned nothing');
    return { reservedMicro: exact('a reservation', Number(row.reserved)) };
  }

  /**
   * Back a reservation with holds: walk the account's spendable lots in spend
   * order — included credits, then goodwill, then bought; soonest to expire
   * first — and take from each until `neededMicro` is covered.
   *
   * ONE STATEMENT, and that is the point. A running total over the same ordering
   * says how much each lot must give, so the lots are chosen and the holds
   * written from a single snapshot. A walk that read the lots and then inserted
   * holds one at a time would be choosing from a picture that another
   * transaction could have changed — and it is the SQL ordering, not the
   * TypeScript comparator, that is the authority on spend order.
   *
   * ⛔ CALL UNDER `lockAccount`, with `neededMicro` equal to the reservation's
   * `reserved_micro` and no greater than the same predicate's sum. The COMMIT-
   * time check refuses a reservation whose holds do not sum to exactly what it
   * reserved, so a short walk fails the whole transaction.
   */
  async placeHolds(
    tx: CreditLedgerTx,
    input: {
      readonly reservationId: string;
      readonly accountId: string;
      readonly neededMicro: number;
    },
  ): Promise<CreditHold[]> {
    const result = await tx.execute<{ lot_id: string; held: string }>(sql`
      WITH spendable AS (
        SELECT id,
               (remaining_micro - held_micro) AS free,
               COALESCE(SUM(remaining_micro - held_micro) OVER (
                 ORDER BY spend_rank, expires_at, created_at, id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
          FROM credit_lots
         WHERE account_id = ${input.accountId}::uuid
           AND starts_at <= now() AND expires_at > now() AND revoked_at IS NULL
           AND remaining_micro > held_micro
      )
      INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
      SELECT ${input.reservationId}::uuid, id, ${input.accountId}::uuid,
             LEAST(free, ${input.neededMicro}::bigint - before)
        FROM spendable
       WHERE before < ${input.neededMicro}::bigint
      RETURNING lot_id, held_micro::text AS held`);
    return rowsOf<{ lot_id: string; held: string }>(result).map((row) => ({
      lotId: row.lot_id,
      heldMicro: exact('a hold', Number(row.held)),
    }));
  }

  /**
   * The reservation, locked until the transaction ends. Null when there is no
   * such row. ⛔ Take `lockAccount` on its account FIRST: that is the lock order
   * every credit writer uses, and taking this one first would invert it.
   */
  async lockReservation(tx: CreditLedgerTx, id: string): Promise<OpenCreditReservation | null> {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT id, account_id, agent_session_id, mode, model, rate_card_version, slot, state,
             reserved_micro::text AS reserved, committed_micro::text AS committed,
             charged_micro::text AS charged
        FROM credit_reservations WHERE id = ${id}::uuid FOR UPDATE`);
    const row = rowsOf<Record<string, unknown>>(result)[0];
    if (row === undefined) return null;
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      agentSessionId: String(row.agent_session_id),
      mode: member('credit_reservations.mode', CREDIT_RESERVATION_MODES, String(row.mode)),
      model: String(row.model),
      rateCardVersion: exact('a rate card version', Number(row.rate_card_version)),
      slot: row.slot === null ? null : slotOf(row.slot),
      state: member('credit_reservations.state', CREDIT_RESERVATION_STATES, String(row.state)),
      reservedMicro: exact('a reservation', Number(row.reserved)),
      committedMicro: exact('a committed amount', Number(row.committed)),
      chargedMicro: row.charged === null ? null : exact('a charge', Number(row.charged)),
    };
  }

  /** Which account a reservation belongs to, so its credit row can be locked first. */
  async accountOf(tx: CreditLedgerTx, id: string): Promise<string | null> {
    const result = await tx.execute<{ account_id: string }>(sql`
      SELECT account_id FROM credit_reservations WHERE id = ${id}::uuid`);
    return rowsOf<{ account_id: string }>(result)[0]?.account_id ?? null;
  }

  /**
   * Commit one call's bound against its task, in ONE statement (§4.5).
   *
   * ⛔ THE PREDICATE IS THE ADMISSION. Everything a call must be true of is in
   * the WHERE clause of a single UPDATE, so the decision and the commitment
   * happen at the same instant under the same row lock: the task is still open,
   * it has not passed its ceiling, the call is on the model the task reserved
   * (M10 — a task that priced Sonnet must not pay for Opus), and what it has
   * already committed plus this bound still fits what it reserved. Zero rows is
   * a refusal, and `admissionRefusal` says which of those it was.
   *
   * ⛔ SHADOW IS ADMITTED WHATEVER IT COSTS, and the two facts that would have
   * refused it are recorded instead: `shadow_over_reservation` on the call, and
   * `would_refuse_reason = 'call_did_not_fit'` on the task when nothing earlier
   * had already refused it. That is the whole point of a measurement — a shadow
   * task that stopped at the reservation would measure the limit, not the load.
   *
   * ⛔ ADMISSION RENEWS THE LEASE, and never shortens it: `GREATEST` keeps a
   * lease the heartbeat has already pushed further out. A task making calls is
   * a task that is alive, and the keeper must not settle it out from under a
   * request that is about to go out.
   */
  async commitCallBound(
    tx: CreditLedgerTx,
    input: {
      readonly reservationId: string;
      /** The model the call is actually about to be made on. */
      readonly model: string;
      readonly boundMicro: number;
    },
  ): Promise<CommittedCallBound | null> {
    const bound = String(input.boundMicro);
    const result = await tx.execute<Record<string, unknown>>(sql`
      UPDATE credit_reservations
         SET committed_micro = committed_micro + ${bound}::bigint,
             lease_expires_at = GREATEST(lease_expires_at,
                                         now() + make_interval(secs => ${CREDIT_LEASE_SECONDS})),
             would_refuse_reason = CASE
               WHEN mode = 'shadow' AND would_refuse_reason IS NULL
                    AND committed_micro + ${bound}::bigint > reserved_micro
                 THEN 'call_did_not_fit'
               ELSE would_refuse_reason END
       WHERE id = ${input.reservationId}::uuid AND state = 'open' AND now() < max_until
         AND model = ${input.model}
         AND (mode = 'shadow' OR committed_micro + ${bound}::bigint <= reserved_micro)
      RETURNING account_id, mode, rate_card_version,
                (reserved_micro - committed_micro)::text AS left_micro,
                (mode = 'shadow' AND committed_micro > reserved_micro) AS over`);
    const row = rowsOf<Record<string, unknown>>(result)[0];
    if (row === undefined) return null;
    return {
      accountId: String(row.account_id),
      mode: member('credit_reservations.mode', CREDIT_RESERVATION_MODES, String(row.mode)),
      rateCardVersion: exact('a rate card version', Number(row.rate_card_version)),
      leftMicro: exact('a reservation remainder', Number(row.left_micro)),
      overReservation: row.over === true,
    };
  }

  /**
   * Which of the admission predicates a refused call failed. Read AFTER the
   * UPDATE returned nothing, in the same transaction, so it describes the row
   * that refused rather than a later one.
   *
   * The order mirrors the WHERE clause: a task that is gone, settled or past its
   * ceiling is answered as that whatever else is also true, because "this task
   * is over" is the more useful thing to tell the caller than "it did not fit".
   */
  async admissionRefusal(
    tx: CreditLedgerTx,
    input: {
      readonly reservationId: string;
      readonly model: string;
    },
  ): Promise<{ readonly reason: CreditAdmissionRefusal; readonly leftMicro: number }> {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT state, model, (now() >= max_until) AS past_ceiling,
             (reserved_micro - committed_micro)::text AS left_micro
        FROM credit_reservations WHERE id = ${input.reservationId}::uuid`);
    const row = rowsOf<Record<string, unknown>>(result)[0];
    if (row === undefined) return { reason: 'gone', leftMicro: 0 };
    const leftMicro = exact('a reservation remainder', Number(row.left_micro));
    if (String(row.state) === 'settled') return { reason: 'settled', leftMicro };
    if (row.past_ceiling === true) return { reason: 'max_age', leftMicro };
    if (String(row.model) !== input.model) return { reason: 'model', leftMicro };
    return { reason: 'did_not_fit', leftMicro };
  }

  /**
   * Write the call the bound above was committed for. `seq` is one past the
   * highest this task has used, and `credit_model_calls_seq_unique` is what
   * makes that a fact rather than a hope: two admissions racing on one task are
   * already serialized by the row lock the UPDATE took, and if they somehow were
   * not, the second would be refused rather than reuse a number.
   *
   * ⛔ THE SAME TRANSACTION AS `commitCallBound`. The COMMIT-time check requires
   * a reservation's `committed_micro` to equal what its calls commit, so the
   * bound and the row that carries it are written together or neither is.
   */
  async insertModelCall(
    tx: CreditLedgerTx,
    input: {
      readonly callId: string;
      readonly reservationId: string;
      readonly accountId: string;
      readonly purpose: CreditModelCallPurpose;
      readonly model: string;
      readonly bound: CreditCallBound;
      readonly shadowOverReservation: boolean;
    },
  ): Promise<{ readonly callId: string; readonly seq: number }> {
    const { bound } = input;
    const result = await tx.execute<{ id: string; seq: number }>(sql`
      INSERT INTO credit_model_calls (id, reservation_id, account_id, seq, purpose, model,
                                      input_bound_tokens, input_bound_basis, input_bound_micro,
                                      max_output_tokens, bound_micro, shadow_over_reservation)
      SELECT ${input.callId}::uuid, ${input.reservationId}::uuid, ${input.accountId}::uuid,
             COALESCE(MAX(seq), 0) + 1, ${input.purpose}, ${input.model},
             ${bound.inputBoundTokens}, ${bound.basis}, ${String(bound.inputBoundMicro)}::bigint,
             ${bound.maxOutputTokens}, ${String(bound.boundMicro)}::bigint,
             ${input.shadowOverReservation}
        FROM credit_model_calls WHERE reservation_id = ${input.reservationId}::uuid
      RETURNING id, seq`);
    const row = rowsOf<{ id: string; seq: number }>(result)[0];
    if (row === undefined) throw new Error('a model call insert returned nothing');
    return { callId: row.id, seq: exact('a call sequence number', Number(row.seq)) };
  }

  /**
   * Record that this call's request is going out (§4.5). One tiny statement of
   * its own, run immediately before the fetch and COMMITTED BEFORE IT.
   *
   * ⛔ THAT ORDER IS THE WHOLE POINT. `sent` is the only fact a settlement
   * running after this process died can use to tell a request that was served
   * and billed from one that never left the building, and the two are charged
   * the full bound and nothing at all. Written after the fetch, it would be
   * missing exactly when it matters; written inside the admission transaction,
   * every refused-before-the-fetch call would be charged as if it had gone out.
   *
   * False when the call is already settled — a keeper beat this process to it —
   * and the caller should not send the request.
   */
  async markCallSent(on: CreditLedgerExecutor, callId: string): Promise<boolean> {
    const result = await on.execute<{ id: string }>(sql`
      UPDATE credit_model_calls SET sent = true
       WHERE id = ${callId}::uuid AND state = 'started'
      RETURNING id`);
    return rowsOf<{ id: string }>(result).length === 1;
  }

  /**
   * One call and the terms its task pinned, with the TASK locked and then the
   * CALL (§4.6: the lock order is reservation then call). Null when there is no
   * such call.
   *
   * It takes no account lock, and must not: settling a call moves no balance, so
   * an account lock here would queue every call of every task behind whichever
   * one was refreshing credits.
   *
   * ⛔ TWO STATEMENTS, AND THAT IS THE WHOLE POINT. Read as ONE join with
   * `FOR UPDATE OF r`, the call's own columns come back from the snapshot the
   * statement STARTED with — Postgres re-checks only the relation it locks, so a
   * settlement that queued behind the lease keeper would read `state = 'started'`
   * and `charged_micro = NULL` about a call the keeper had already settled and
   * charged. Measured, not reasoned: with the keeper holding the task's row and
   * settling the call under it, the joined read returns the pre-wait call beside
   * the post-wait reservation. The second statement runs after the lock is held,
   * takes a fresh snapshot, and locks the call itself so nothing but this
   * transaction can move it afterwards.
   */
  async lockCallForSettlement(
    tx: CreditLedgerTx,
    callId: string,
  ): Promise<CreditCallForSettlement | null> {
    const locked = await tx.execute<Record<string, unknown>>(sql`
      SELECT r.id AS reservation_id, r.mode, r.rate_card_version
        FROM credit_model_calls c
        JOIN credit_reservations r ON r.id = c.reservation_id
       WHERE c.id = ${callId}::uuid
         FOR UPDATE OF r`);
    const task = rowsOf<Record<string, unknown>>(locked)[0];
    if (task === undefined) return null;
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT account_id, state, sent, model, bound_micro::text AS bound, max_output_tokens,
             charged_micro::text AS charged
        FROM credit_model_calls WHERE id = ${callId}::uuid
         FOR UPDATE`);
    const row = rowsOf<Record<string, unknown>>(result)[0];
    if (row === undefined) return null;
    return {
      callId,
      reservationId: String(task.reservation_id),
      accountId: String(row.account_id),
      state: member('credit_model_calls.state', CREDIT_MODEL_CALL_STATES, String(row.state)),
      sent: row.sent === true,
      model: String(row.model),
      mode: member('credit_reservations.mode', CREDIT_RESERVATION_MODES, String(task.mode)),
      rateCardVersion: exact('a rate card version', Number(task.rate_card_version)),
      boundMicro: exact('a call bound', Number(row.bound)),
      maxOutputTokens: exact('an output ceiling', Number(row.max_output_tokens)),
      chargedMicro: row.charged === null ? null : exact('a call charge', Number(row.charged)),
    };
  }

  /**
   * What a task pinned, read WITHOUT a lock, so that planning the next call
   * never queues behind a settlement of the same task.
   *
   * ⛔ THE NUMBERS IT RETURNS ARE ADVISORY AND THE ADMISSION RE-CHECKS THEM ALL.
   * Between this read and `commitCallBound` another call of the same task may
   * commit, or the keeper may settle it; the admission statement decides on its
   * own row lock, so the worst this staleness can do is turn a call that would
   * have fitted into a refusal. It can never let one through that does not fit.
   */
  async reservationTerms(
    on: CreditLedgerExecutor,
    reservationId: string,
  ): Promise<CreditReservationTerms | null> {
    const result = await on.execute<Record<string, unknown>>(sql`
      SELECT mode, model, rate_card_version, state, reserved_micro::text AS reserved,
             committed_micro::text AS committed, (now() >= max_until) AS past_ceiling
        FROM credit_reservations WHERE id = ${reservationId}::uuid`);
    const row = rowsOf<Record<string, unknown>>(result)[0];
    if (row === undefined) return null;
    return {
      mode: member('credit_reservations.mode', CREDIT_RESERVATION_MODES, String(row.mode)),
      model: String(row.model),
      rateCardVersion: exact('a rate card version', Number(row.rate_card_version)),
      state: member('credit_reservations.state', CREDIT_RESERVATION_STATES, String(row.state)),
      reservedMicro: exact('a reservation', Number(row.reserved)),
      committedMicro: exact('a committed amount', Number(row.committed)),
      pastCeiling: row.past_ceiling === true,
    };
  }

  /**
   * Settle one call for what it cost. Null when it was already settled — a
   * keeper got there first — which is a no-op and not an error: §5.3 makes that
   * race the ordinary case, and the charge the keeper wrote is the one that
   * stands.
   */
  async settleOneCall(
    tx: CreditLedgerTx,
    input: {
      readonly callId: string;
      readonly basis: CreditCallSettleBasis;
      readonly chargedMicro: number;
      readonly actualMicro: number | null;
      readonly tokens: {
        readonly uncachedInput: number;
        readonly output: number;
        readonly cacheRead: number;
        readonly cacheWrite5m: number;
        readonly cacheWrite1h: number;
      } | null;
      readonly usageRecordId: string | null;
    },
  ): Promise<{ readonly boundMicro: number; readonly chargedMicro: number } | null> {
    const t = input.tokens;
    const result = await tx.execute<{ bound: string; charged: string }>(sql`
      UPDATE credit_model_calls
         SET state = 'settled', settle_basis = ${input.basis},
             uncached_input_tokens = ${t === null ? null : t.uncachedInput},
             output_tokens = ${t === null ? null : t.output},
             cache_read_tokens = ${t === null ? null : t.cacheRead},
             cache_write_5m_tokens = ${t === null ? null : t.cacheWrite5m},
             cache_write_1h_tokens = ${t === null ? null : t.cacheWrite1h},
             actual_micro = ${input.actualMicro === null ? null : String(input.actualMicro)}::bigint,
             charged_micro = ${String(input.chargedMicro)}::bigint,
             usage_record_id = ${input.usageRecordId}::uuid,
             settled_at = now()
       WHERE id = ${input.callId}::uuid AND state = 'started'
      RETURNING bound_micro::text AS bound, charged_micro::text AS charged`);
    const row = rowsOf<{ bound: string; charged: string }>(result)[0];
    if (row === undefined) return null;
    return {
      boundMicro: exact('a call bound', Number(row.bound)),
      chargedMicro: exact('a call charge', Number(row.charged)),
    };
  }

  /**
   * Give the task back the difference between what a call was allowed to cost
   * and what it did cost. An already-settled task is left alone: its charge is
   * final and the COMMIT-time check would refuse a counter that moved after it.
   */
  async releaseCommittedBound(
    tx: CreditLedgerTx,
    input: {
      readonly reservationId: string;
      readonly boundMicro: number;
      readonly chargedMicro: number;
    },
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE credit_reservations
         SET committed_micro = committed_micro - ${String(input.boundMicro)}::bigint
                                              + ${String(input.chargedMicro)}::bigint
       WHERE id = ${input.reservationId}::uuid AND state = 'open'`);
  }

  /**
   * Settle every call of this reservation that is still started, because the
   * process that would have settled each one is gone. §5.3 calls this the MAIN
   * path: a crash, a lapsed lease or a task past its ceiling all arrive here.
   *
   * ⛔ ONE RECORDED FACT DECIDES WHAT EACH ONE COSTS — whether its request went
   * out (§4.6, §5.3):
   *
   *   · `sent` → `no_record`, charged its FULL BOUND. The owner's rule: a call
   *     that went out and left no record is paid for in full, because the
   *     provider may well have served it.
   *   · not `sent` → `never_sent`, charged NOTHING. The request never left this
   *     process, so there is nothing to pay for — and the database says the same
   *     thing twice: `credit_model_calls_never_sent_really` accepts that basis
   *     only while `sent` is false, and `credit_model_calls_unbilled` then
   *     REQUIRES the charge to be zero.
   *
   * ⛔ THAT DISTINCTION IS THE ONLY REASON `sent` IS A COLUMN. It is written in
   * its own tiny statement immediately before the request goes out (§4.5)
   * precisely so a settlement running after that process died can still tell the
   * two apart. Charging the bound for both would bill the customer the ceiling
   * of a request that never left the building, on the path the plan says is the
   * common one — and it errs toward the provider's bill, not the customer's.
   *
   * `committed_micro` is recomputed in the same breath, because a started call
   * commits its BOUND and a settled one commits its CHARGE. Without that, a
   * `never_sent` call leaves the two disagreeing and the COMMIT-time check
   * refuses the whole settlement ("commits X but its calls commit Y") — so the
   * task could never be settled at all.
   */
  async settleStartedCallsAfterACrash(tx: CreditLedgerTx, reservationId: string): Promise<number> {
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE credit_model_calls
         SET state = 'settled',
             settle_basis = CASE WHEN sent THEN 'no_record' ELSE 'never_sent' END,
             charged_micro = CASE WHEN sent THEN bound_micro ELSE 0 END,
             settled_at = now()
       WHERE reservation_id = ${reservationId}::uuid AND state = 'started'
      RETURNING id`);
    const settled = rowsOf<{ id: string }>(result).length;
    if (settled === 0) return 0;
    await tx.execute(sql`
      UPDATE credit_reservations r
         SET committed_micro = (SELECT COALESCE(SUM(CASE WHEN c.state = 'started'
                                                         THEN c.bound_micro ELSE c.charged_micro END), 0)
                                  FROM credit_model_calls c WHERE c.reservation_id = r.id)
       WHERE r.id = ${reservationId}::uuid AND r.state = 'open'`);
    return settled;
  }

  /** What this reservation's settled calls charged, in total. */
  async chargedByCalls(tx: CreditLedgerTx, reservationId: string): Promise<number> {
    const result = await tx.execute<{ micro: string }>(sql`
      SELECT COALESCE(SUM(charged_micro), 0)::text AS micro FROM credit_model_calls
       WHERE reservation_id = ${reservationId}::uuid`);
    return exact('a task charge', Number(rowsOf<{ micro: string }>(result)[0]?.micro ?? '0'));
  }

  /**
   * The reservation's unreleased holds, in the order the lots are spent in, with
   * whether each lot's term has ended or it was revoked — which decides what
   * happens to the part the task did not use.
   */
  async openHoldsInSpendOrder(
    tx: CreditLedgerTx,
    reservationId: string,
  ): Promise<OpenCreditHold[]> {
    const result = await tx.execute<{
      lot_id: string;
      held: string;
      done: boolean;
      revoked: boolean;
    }>(sql`
      SELECT h.lot_id, h.held_micro::text AS held,
             (l.expires_at <= now() OR l.revoked_at IS NOT NULL) AS done,
             (l.revoked_at IS NOT NULL) AS revoked
        FROM credit_reservation_holds h
        JOIN credit_lots l ON l.id = h.lot_id
       WHERE h.reservation_id = ${reservationId}::uuid AND h.released_at IS NULL
       ORDER BY l.spend_rank, l.expires_at, l.created_at, l.id
         FOR UPDATE OF l`);
    return rowsOf<{ lot_id: string; held: string; done: boolean; revoked: boolean }>(result).map(
      (row) => ({
        lotId: row.lot_id,
        heldMicro: exact('a hold', Number(row.held)),
        lotDone: row.done,
        lotRevoked: row.revoked,
      }),
    );
  }

  /**
   * Release one hold for what the task took out of that lot. The database's own
   * trigger takes the whole hold back off the lot's `held_micro`; a hold changes
   * exactly once, and any other update to it is refused.
   */
  async releaseHold(
    tx: CreditLedgerTx,
    input: {
      readonly reservationId: string;
      readonly lotId: string;
      readonly chargedMicro: number;
    },
  ): Promise<void> {
    const result = await tx.execute<{ lot_id: string }>(sql`
      UPDATE credit_reservation_holds
         SET charged_micro = ${input.chargedMicro}::bigint, released_at = now()
       WHERE reservation_id = ${input.reservationId}::uuid AND lot_id = ${input.lotId}::uuid
         AND released_at IS NULL
      RETURNING lot_id`);
    if (rowsOf<{ lot_id: string }>(result).length !== 1) {
      throw new Error('a credit hold could not be released: it is already released or gone');
    }
  }

  /** Mark the task settled. The guard trigger refuses a second settlement. */
  async markSettled(
    tx: CreditLedgerTx,
    input: {
      readonly reservationId: string;
      readonly chargedMicro: number;
      readonly settleReason: CreditSettleReason;
    },
  ): Promise<void> {
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE credit_reservations
         SET state = 'settled', charged_micro = ${input.chargedMicro}::bigint,
             settled_at = now(), settle_reason = ${input.settleReason}
       WHERE id = ${input.reservationId}::uuid AND state = 'open'
      RETURNING id`);
    if (rowsOf<{ id: string }>(result).length !== 1) {
      throw new Error('a reservation could not be settled: it is already settled or gone');
    }
  }

  /**
   * Renew the lease of every live reservation this process still holds (§4.7).
   * A reservation past its `max_until` is NOT renewed, which is what makes the
   * ceiling a fact rather than a promise: the lease then lapses and the keeper
   * settles the task at `max_age`.
   *
   * Runs outside a transaction of its own: it is one statement, and the rows it
   * misses are picked up by the next tick. It therefore takes an EXECUTOR and
   * not a transaction handle — the lease keeper calls it on the pool directly,
   * fifteen seconds apart, and wrapping one statement in a transaction would
   * hold a connection for no reason it could name.
   */
  async renewLeases(
    tx: CreditLedgerExecutor,
    input: { readonly reservationIds: readonly string[]; readonly leaseOwner: string },
  ): Promise<string[]> {
    if (input.reservationIds.length === 0) return [];
    const rows = await tx
      .update(creditReservations)
      .set({ leaseExpiresAt: sql`now() + make_interval(secs => ${CREDIT_LEASE_SECONDS})` })
      .where(
        and(
          inArray(creditReservations.id, [...input.reservationIds]),
          eq(creditReservations.state, 'open'),
          eq(creditReservations.leaseOwner, input.leaseOwner),
          sql`now() < ${creditReservations.maxUntil}`,
        ),
      )
      .returning({ id: creditReservations.id });
    return rows.map((row) => row.id);
  }

  /**
   * Tasks nobody is coming back for: the lease has lapsed, or the hard ceiling
   * has passed (§5.3). The lease keeper settles these, oldest lease first.
   *
   * ⛔ THIS IS A CANDIDATE LIST, NOT A CLAIM. It takes no lock, so between this
   * read and the settlement another process may renew the lease — a turn that
   * was merely slow, not gone. `claimLapsedReservation` re-asks the same
   * question under the row lock, and that is what decides (H6).
   *
   * `max_age` wins when both are true: a task past its ceiling is settled for
   * being over its ceiling whatever its lease said, which is the reason the
   * ceiling exists (M1).
   */
  async lapsedReservations(
    on: CreditLedgerExecutor,
    limit: number,
  ): Promise<LapsedCreditReservation[]> {
    const result = await on.execute<{ id: string; account_id: string; reason: string }>(sql`
      SELECT id, account_id,
             CASE WHEN max_until < now() THEN 'max_age' ELSE 'lease_expired' END AS reason
        FROM credit_reservations
       WHERE state = 'open' AND (lease_expires_at < now() OR max_until < now())
       ORDER BY lease_expires_at, id
       LIMIT ${limit}`);
    return rowsOf<{ id: string; account_id: string; reason: string }>(result).map((row) => ({
      reservationId: row.id,
      accountId: row.account_id,
      reason: row.reason === 'max_age' ? 'max_age' : 'lease_expired',
    }));
  }

  /**
   * Claim one lapsed task for settlement, under its row lock: null when it is
   * not the keeper's to settle after all.
   *
   * ⛔ THE RE-CHECK IS THE WHOLE POINT (H6). A boot pass, a canary, a manual
   * `node dist/index.js` during an incident and the ordinary 15-second tick all
   * run this, and NONE of them may settle a task whose lease is live: its
   * process is still making calls, and settling it would charge every started
   * call its full bound and end the customer's turn. The candidate read above
   * cannot decide that — the lease can be renewed a microsecond after it — so
   * the predicate is asked again here, inside the transaction that will do the
   * settling, on a row nobody else can change until it commits.
   *
   * ⛔ CALL UNDER `lockAccount` ON ITS ACCOUNT FIRST. Same lock order as every
   * other credit writer; `settleIn` takes the same two locks and re-entering
   * them costs nothing.
   */
  async claimLapsedReservation(
    tx: CreditLedgerTx,
    reservationId: string,
  ): Promise<LapsedSettleReason | null> {
    const result = await tx.execute<{ reason: string }>(sql`
      SELECT CASE WHEN max_until < now() THEN 'max_age' ELSE 'lease_expired' END AS reason
        FROM credit_reservations
       WHERE id = ${reservationId}::uuid AND state = 'open'
         AND (lease_expires_at < now() OR max_until < now())
         FOR UPDATE`);
    const row = rowsOf<{ reason: string }>(result)[0];
    if (row === undefined) return null;
    return row.reason === 'max_age' ? 'max_age' : 'lease_expired';
  }

  /**
   * Hand back every lease this process still holds, by expiring it now (H6).
   *
   * Run once on the way out. A deploy stops the old process while a turn is
   * still open, and without this the credit and the slot stay locked up for the
   * rest of the lease — 90 seconds in which the customer's next task is told
   * three tasks are already running. Expiring the lease makes every one of them
   * due at once, so the NEW process's boot pass frees them immediately.
   *
   * ⛔ IT SETTLES NOTHING. Only the lease moves; what each task is charged is
   * decided by the settlement that follows, from the calls the task recorded.
   */
  async expireLeasesOfOwner(on: CreditLedgerExecutor, leaseOwner: string): Promise<string[]> {
    const result = await on.execute<{ id: string }>(sql`
      UPDATE credit_reservations SET lease_expires_at = now()
       WHERE lease_owner = ${leaseOwner} AND state = 'open'
      RETURNING id`);
    return rowsOf<{ id: string }>(result).map((row) => row.id);
  }

  /**
   * Clawbacks still owed credit that running tasks hold, OLDEST FIRST — the
   * order `credit_clawbacks_pending_idx` is built for. A settlement pays them
   * from the credit it releases, one claim at a time, so that two claims are
   * never both paid from the same credit.
   *
   * ⛔ ONLY A CLAWBACK THAT STILL STANDS (S17 audit #3). A won dispute reverses
   * its clawback, and a reversed clawback is owed nothing: paying its claim
   * would take credit from a customer whose payment is whole again, and a
   * claim left unpaid would become debt that nothing forgives.
   */
  async pendingClaims(tx: CreditLedgerTx, accountId: string): Promise<PendingCreditClaim[]> {
    const result = await tx.execute<{
      id: string;
      source: string;
      pending: string;
      target_key: string;
      mark: string | null;
      forgive_after: string | null;
    }>(sql`
      SELECT id, source, pending_micro::text AS pending, target_key,
             ledger_mark::text AS mark, claim_forgive_after_micro::text AS forgive_after
        FROM credit_clawbacks
       WHERE account_id = ${accountId}::uuid AND pending_micro > 0 AND state = 'applied'
       ORDER BY created_at, id
         FOR UPDATE`);
    return rowsOf<{
      id: string;
      source: string;
      pending: string;
      target_key: string;
      mark: string | null;
      forgive_after: string | null;
    }>(result).map((row) => ({
      clawbackId: row.id,
      source: row.source,
      pendingMicro: exact('a pending claim', Number(row.pending)),
      targetKey: row.target_key,
      ledgerMark: row.mark === null ? null : exact('a ledger mark', Number(row.mark)),
      claimForgiveAfterMicro:
        row.forgive_after === null ? null : exact('a claim threshold', Number(row.forgive_after)),
    }));
  }

  /**
   * S17 R8 (audit 4 #3) — how much of one clawback's claim is no longer asked
   * for WITHOUT having been paid or taken as debt: what a reconciliation
   * released of it (a give-back), and what a settlement let go because the
   * spending it stood for was no longer the customer's to owe. The clawback's
   * amounts less what it clawed, still claims, owes as debt, and collected
   * (its `claim:<clawback>:…` rows, read by `credit_ledger_claim_clawback_idx`).
   */
  async claimLetGoMicro(tx: CreditLedgerTx, clawbackId: string): Promise<number> {
    const result = await tx.execute<{ micro: string }>(sql`
      SELECT (COALESCE(c.amount_micro, 0) - COALESCE(c.clawed_micro, 0) - c.pending_micro
                - COALESCE(c.debt_micro, 0)
                - COALESCE((SELECT sum(-x.lot_delta_micro) FROM credit_ledger x
                             WHERE x.account_id = c.account_id
                               AND starts_with(x.idempotency_key, 'claim:')
                               AND x.idempotency_key ~>=~ ('claim:' || c.id::text || ':')
                               AND x.idempotency_key ~<~ ('claim:' || c.id::text || ';')), 0))::text AS micro
        FROM credit_clawbacks c
       WHERE c.id = ${clawbackId}::uuid
       ORDER BY 1`);
    return Math.max(0, Number(rowsOf<{ micro: string }>(result)[0]?.micro ?? '0'));
  }

  /**
   * S17 R8 — let part of a clawback's claim go: its pending claim falls and
   * nothing becomes debt (the guard lets a claim fall). Refused if the row no
   * longer claims that much.
   */
  async letClaimGo(
    tx: CreditLedgerTx,
    input: { readonly clawbackId: string; readonly micro: number },
  ): Promise<void> {
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE credit_clawbacks SET pending_micro = pending_micro - ${input.micro}::bigint
       WHERE id = ${input.clawbackId}::uuid AND pending_micro >= ${input.micro}::bigint
      RETURNING id`);
    if (rowsOf<{ id: string }>(result).length !== 1) {
      throw new Error('a pending credit claim could not be let go: it no longer claims that much');
    }
  }

  /**
   * Pay `micro` off one clawback's pending claim. The database refuses a claim
   * that rises, so this only ever falls, and it is refused outright if the row
   * no longer owes that much.
   */
  async payPendingClaim(
    tx: CreditLedgerTx,
    input: { readonly clawbackId: string; readonly micro: number },
  ): Promise<void> {
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE credit_clawbacks SET pending_micro = pending_micro - ${input.micro}::bigint
       WHERE id = ${input.clawbackId}::uuid AND pending_micro >= ${input.micro}::bigint
      RETURNING id`);
    if (rowsOf<{ id: string }>(result).length !== 1) {
      throw new Error('a pending credit claim could not be paid down: it no longer owes that much');
    }
  }

  /**
   * Take what one clawback's pending claim still owes as DEBT: `pending_micro`
   * falls to zero for that amount and `debt_micro` rises by the same amount, in
   * ONE statement.
   *
   * ⛔ ONE STATEMENT BECAUSE THE DATABASE WILL ACCEPT NO OTHER SHAPE. 0132's
   * `credit_clawbacks_guard` permits exactly this movement — a rise in
   * `debt_micro` matched by an equal fall in `pending_micro`, judged on OLD and
   * NEW of the same row — and refuses `debt_micro` moving on its own. Paying the
   * claim down first and raising the debt afterwards would be refused twice
   * over, which is the point: the clawback's own record of what it cost cannot
   * drift from the ledger's.
   *
   * Refused outright if the row no longer owes that much, or carries no debt
   * figure at all (an `unmatched` clawback took nothing and owes nothing).
   */
  async pendingClaimBecomesDebt(
    tx: CreditLedgerTx,
    input: { readonly clawbackId: string; readonly micro: number },
  ): Promise<void> {
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE credit_clawbacks
         SET pending_micro = pending_micro - ${input.micro}::bigint,
             debt_micro = debt_micro + ${input.micro}::bigint
       WHERE id = ${input.clawbackId}::uuid AND pending_micro >= ${input.micro}::bigint
         AND debt_micro IS NOT NULL
      RETURNING id`);
    if (rowsOf<{ id: string }>(result).length !== 1) {
      throw new Error(
        'a pending credit claim could not be taken as debt: it no longer owes that much',
      );
    }
  }

  /** Whether the account still has an open enforced task other than this one. */
  async hasOtherOpenEnforce(
    tx: CreditLedgerTx,
    input: { readonly accountId: string; readonly exceptReservationId: string },
  ): Promise<boolean> {
    const result = await tx.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM credit_reservations
       WHERE account_id = ${input.accountId}::uuid AND state = 'open' AND mode = 'enforce'
         AND id <> ${input.exceptReservationId}::uuid`);
    return Number(rowsOf<{ n: string }>(result)[0]?.n ?? '0') > 0;
  }
}

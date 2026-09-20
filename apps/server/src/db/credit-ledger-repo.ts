// Reads and writes the AI credits ledger core (migration 0128).
//
// The primitives later work builds on, and nothing more: make sure an account
// has its credit row (and lock it), add a lot, write a ledger row, read the
// spendable balance, read the ledger a page at a time, expire what is left of
// lots whose term has ended, and repay debt from free credit. There are no
// grants from billing here and no reservations; those compose these primitives
// in their own transactions.
//
// ⛔ THE DATABASE IS THE AUTHORITY, NOT THIS FILE. A lot is born empty and an
// account owes nothing until a ledger row says otherwise; a balance column is
// written only by the ledger's own trigger; the ledger refuses UPDATE and
// DELETE; every rule the types here express is enforced again in Postgres (see
// the trigger notes beside `creditLedger` in schema.ts). The checks in this file
// exist to fail early with a readable error, never as the only line.
//
// Amounts are microcredits (1 credit = 1,000,000 µcr = US$0.01), read as
// JavaScript numbers and refused rather than rounded past 2^53. Ten million
// credits a month for a hundred years is still under 2^53 by a factor of eight.
//
// IDEMPOTENCY. `append` inserts with ON CONFLICT (account_id, idempotency_key)
// DO NOTHING. Under READ COMMITTED a second writer racing on the same key waits
// for the first transaction to finish; if it committed, the second inserts
// nothing and applies nothing, and `append` reports `applied: false` with the
// row that did apply. A key already used for a DIFFERENT movement is a caller
// bug, and it throws rather than reporting success for a movement that never
// happened.

import { and, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import {
  AiBillingSchema,
  AiDebtReasonSchema,
  AiSourceSchema,
  AiSourceSetBySchema,
  CREDIT_LOT_KINDS,
  CREDIT_LOT_SPEND_RANK,
  type AiBilling,
  type AiDebtReason,
  type AiSource,
  type AiSourceSetBy,
  type CreditLotKind,
} from '@driftstack/api-types';
import type { Database } from './client.js';
import {
  creditAccounts,
  creditLedger,
  creditLots,
  type CreditAccountRow,
  type CreditLedgerRow,
  type CreditLotRow,
} from './schema.js';

/** Every kind of ledger row the database accepts (`credit_ledger_kind`). */
export const CREDIT_LEDGER_KINDS = [
  'grant',
  'proration_grant',
  'proration_clawback',
  'task_charge',
  'expiry',
  'refund_clawback',
  'debt_incurred',
  'debt_repayment',
  'adjustment',
  'top_up',
] as const;
export type CreditLedgerKind = (typeof CREDIT_LEDGER_KINDS)[number];

/** Who a ledger row is attributed to (`credit_ledger_actor`). */
export const CREDIT_LEDGER_ACTORS = ['system', 'customer', 'admin', 'stripe', 'crypto'] as const;
export type CreditLedgerActor = (typeof CREDIT_LEDGER_ACTORS)[number];

/**
 * Why an account's monthly credits are set by hand (`credit_plan_overrides_reason`).
 * The table is created with the ledger; its writer is an admin path not built yet.
 */
export const CREDIT_PLAN_OVERRIDE_REASONS = ['contract', 'admin_tier'] as const;
export type CreditPlanOverrideReason = (typeof CREDIT_PLAN_OVERRIDE_REASONS)[number];

/** `credit_ledger_idempotency_key_length`: 1 to 200 characters. */
export const CREDIT_LEDGER_IDEMPOTENCY_KEY_MAX_CHARS = 200;

/** A ledger page holds at most this many entries. */
export const CREDIT_LEDGER_PAGE_MAX = 100;

type Db = Database['db'];
/** The handle `db.transaction(async (tx) => …)` passes to its body. */
export type CreditLedgerTx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Where a primitive runs: the pool, or a transaction a caller holds open. */
export type CreditLedgerExecutor = Db | CreditLedgerTx;

export interface CreditAccountRecord {
  readonly accountId: string;
  readonly billingMode: AiBilling;
  /** Null means automatic: the customer's own key when usable, else credits. */
  readonly aiSource: AiSource | null;
  readonly aiSourceSetBy: AiSourceSetBy | null;
  readonly aiSourceSetAt: Date | null;
  readonly debtMicro: number;
  readonly autoTopUpEnabled: boolean;
}

export interface CreditLotRecord {
  readonly id: string;
  readonly accountId: string;
  readonly kind: CreditLotKind;
  readonly spendRank: 0 | 1 | 2;
  readonly windowId: string | null;
  readonly grantKey: string;
  readonly grantedMicro: number;
  readonly remainingMicro: number;
  readonly heldMicro: number;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface CreditLedgerRecord {
  /** The identity, as a decimal string: it is a Postgres bigint. */
  readonly id: string;
  readonly accountId: string;
  readonly kind: CreditLedgerKind;
  readonly lotId: string | null;
  readonly lotDeltaMicro: number;
  readonly debtDeltaMicro: number;
  readonly idempotencyKey: string;
  readonly reservationId: string | null;
  readonly agentSessionId: string | null;
  readonly model: string | null;
  readonly rateCardVersion: number | null;
  readonly reason: string | null;
  readonly actor: CreditLedgerActor;
  readonly createdAt: Date;
}

export interface NewCreditLot {
  readonly accountId: string;
  readonly kind: CreditLotKind;
  /** The month window of a 'monthly' or 'proration' lot; absent for every other kind. */
  readonly windowId?: string | null;
  /** Globally unique; the same key inserts the lot once. */
  readonly grantKey: string;
  /** Whole credits, in microcredits. */
  readonly grantedMicro: number;
  readonly startsAt: Date;
  readonly expiresAt: Date;
}

interface LedgerEntryCommon {
  readonly accountId: string;
  /** Unique per account; the same key applies once. At most 200 characters. */
  readonly idempotencyKey: string;
  readonly actor?: CreditLedgerActor;
  readonly agentSessionId?: string | null;
}

/**
 * A ledger row this module writes, one variant per movement. Task charges,
 * refund movements and top-ups are written by the work that owns them, not
 * here; the two proration movements are below because a mid-month plan change
 * is written through `append` like every other movement (`credit-grants.ts`).
 */
export type NewCreditLedgerEntry = LedgerEntryCommon &
  (
    | {
        /** Credits arrive in a lot. */
        readonly kind: 'grant';
        readonly lotId: string;
        readonly amountMicro: number;
        readonly reason?: string | null;
      }
    | {
        /** Credits leave a lot unspent. */
        readonly kind: 'expiry';
        readonly lotId: string;
        readonly amountMicro: number;
        readonly reason?: string | null;
      }
    | {
        /**
         * A mid-month UPGRADE's share of the rest of the window arrives in its
         * own `proration` lot. Funds that lot exactly as `grant` funds a
         * monthly one.
         */
        readonly kind: 'proration_grant';
        readonly lotId: string;
        readonly amountMicro: number;
        readonly reason?: string | null;
      }
    | {
        /**
         * A mid-month DOWNGRADE takes back what one lot still holds. Never more
         * than the lot's free credit: what a running task holds is not taken
         * (the clawback records that part as a pending claim instead).
         */
        readonly kind: 'proration_clawback';
        readonly lotId: string;
        readonly amountMicro: number;
        readonly reason?: string | null;
      }
    | {
        /** A correction to a lot, in either direction. */
        readonly kind: 'adjustment';
        readonly lotId: string;
        readonly lotDeltaMicro: number;
        readonly reason?: string | null;
      }
    | {
        /** Debt forgiven, with no lot involved. */
        readonly kind: 'adjustment';
        readonly forgiveDebtMicro: number;
        readonly reason?: string | null;
      }
    | {
        /** The account now owes credits it no longer holds. */
        readonly kind: 'debt_incurred';
        readonly amountMicro: number;
        readonly reason: AiDebtReason;
      }
    | {
        /** Debt paid from a lot's free credit. */
        readonly kind: 'debt_repayment';
        readonly lotId: string;
        readonly amountMicro: number;
        readonly reason?: string | null;
      }
  );

/** The columns one entry writes. */
export interface CreditLedgerRowValues {
  readonly accountId: string;
  readonly kind: CreditLedgerKind;
  readonly lotId: string | null;
  readonly lotDeltaMicro: number;
  readonly debtDeltaMicro: number;
  readonly idempotencyKey: string;
  readonly agentSessionId: string | null;
  readonly reason: string | null;
  readonly actor: CreditLedgerActor;
}

export interface CreditLedgerAppendResult {
  /** False when a row with this key already existed; nothing was applied. */
  readonly applied: boolean;
  /** The row that holds this key: the one just written, or the earlier one. */
  readonly entry: CreditLedgerRecord;
}

export interface CreditLotInsertResult {
  /** False when a lot with this grant key already existed. */
  readonly inserted: boolean;
  readonly lot: CreditLotRecord;
}

export interface CreditLedgerPage {
  /** Newest first. */
  readonly entries: readonly CreditLedgerRecord[];
  /** Pass back as `cursor` for the next (older) page; null on the last page. */
  readonly nextCursor: string | null;
}

/** One lot's unspent, unheld credit leaving it because its term ended. */
export interface ExpiredCreditLot {
  readonly lotId: string;
  readonly expiredMicro: number;
}

/** Debt paid down from one lot's free credit. */
export interface CreditDebtRepayment {
  readonly lotId: string;
  readonly repaidMicro: number;
}

/** An idempotency key already used by a different movement on the same account. */
export class CreditLedgerKeyReusedError extends Error {
  constructor(
    readonly accountId: string,
    readonly idempotencyKey: string,
  ) {
    super(`credit ledger key "${idempotencyKey}" was already used for a different movement`);
    this.name = 'CreditLedgerKeyReusedError';
  }
}

/** A grant key already used by a lot with different terms. */
export class CreditLotGrantKeyReusedError extends Error {
  constructor(readonly grantKey: string) {
    super(`credit lot grant key "${grantKey}" was already used for a different lot`);
    this.name = 'CreditLotGrantKeyReusedError';
  }
}

/** A positive whole number of microcredits, below 2^53. */
function positiveMicro(what: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${what} must be a positive safe integer of microcredits`);
  }
  return value;
}

function checkedKey(key: string): string {
  // Postgres length() counts characters (code points), not UTF-16 units.
  const chars = [...key].length;
  if (chars < 1 || chars > CREDIT_LEDGER_IDEMPOTENCY_KEY_MAX_CHARS) {
    throw new RangeError(
      `a credit ledger idempotency key must be 1 to ${String(CREDIT_LEDGER_IDEMPOTENCY_KEY_MAX_CHARS)} characters`,
    );
  }
  return key;
}

/**
 * The one row `entry` writes: which kind, which lot, and the signed deltas.
 * Pure, so the mapping from a movement to its row shape is tested on its own.
 */
export function creditLedgerRowFor(entry: NewCreditLedgerEntry): CreditLedgerRowValues {
  const common = {
    accountId: entry.accountId,
    idempotencyKey: checkedKey(entry.idempotencyKey),
    agentSessionId: entry.agentSessionId ?? null,
    actor: entry.actor ?? 'system',
    reason: entry.reason ?? null,
  };
  switch (entry.kind) {
    case 'grant':
      return {
        ...common,
        kind: 'grant',
        lotId: entry.lotId,
        lotDeltaMicro: positiveMicro('a grant', entry.amountMicro),
        debtDeltaMicro: 0,
      };
    case 'expiry':
      return {
        ...common,
        kind: 'expiry',
        lotId: entry.lotId,
        lotDeltaMicro: -positiveMicro('an expiry', entry.amountMicro),
        debtDeltaMicro: 0,
      };
    case 'proration_grant':
      return {
        ...common,
        kind: 'proration_grant',
        lotId: entry.lotId,
        lotDeltaMicro: positiveMicro('a proration grant', entry.amountMicro),
        debtDeltaMicro: 0,
      };
    case 'proration_clawback':
      return {
        ...common,
        kind: 'proration_clawback',
        lotId: entry.lotId,
        lotDeltaMicro: -positiveMicro('a proration clawback', entry.amountMicro),
        debtDeltaMicro: 0,
      };
    case 'adjustment': {
      if ('lotId' in entry) {
        const delta = entry.lotDeltaMicro;
        if (!Number.isSafeInteger(delta) || delta === 0) {
          throw new RangeError('a lot adjustment must be a non-zero safe integer of microcredits');
        }
        return {
          ...common,
          kind: 'adjustment',
          lotId: entry.lotId,
          lotDeltaMicro: delta,
          debtDeltaMicro: 0,
        };
      }
      return {
        ...common,
        kind: 'adjustment',
        lotId: null,
        lotDeltaMicro: 0,
        debtDeltaMicro: -positiveMicro('forgiven debt', entry.forgiveDebtMicro),
      };
    }
    case 'debt_incurred':
      return {
        ...common,
        kind: 'debt_incurred',
        lotId: null,
        lotDeltaMicro: 0,
        debtDeltaMicro: positiveMicro('debt', entry.amountMicro),
        reason: member('a debt reason', AiDebtReasonSchema.options, entry.reason),
      };
    case 'debt_repayment': {
      const amount = positiveMicro('a debt repayment', entry.amountMicro);
      return {
        ...common,
        kind: 'debt_repayment',
        lotId: entry.lotId,
        lotDeltaMicro: -amount,
        debtDeltaMicro: -amount,
      };
    }
  }
}

export class DrizzleCreditLedgerRepo {
  constructor(private readonly database: Database) {}

  /** Run `body` in one transaction; the primitives below accept its handle. */
  transaction<T>(body: (tx: CreditLedgerTx) => Promise<T>): Promise<T> {
    return this.database.db.transaction(body);
  }

  /**
   * The account's credit row, created (owing nothing, on legacy billing) if it
   * did not exist. Takes no lock; see `lockAccount`.
   */
  async ensureAccount(
    accountId: string,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<CreditAccountRecord> {
    await on
      .insert(creditAccounts)
      .values({ accountId })
      .onConflictDoNothing({ target: creditAccounts.accountId });
    const [row] = await on
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.accountId, accountId))
      .limit(1);
    if (row === undefined) throw new Error('credit account row vanished after it was ensured');
    return toAccountRecord(row);
  }

  /**
   * Ensure the account's credit row and lock it FOR UPDATE until `tx` ends.
   * This row is the per-account lock every balance-changing transaction takes
   * first, so two of them on one account run one after the other.
   */
  async lockAccount(tx: CreditLedgerTx, accountId: string): Promise<CreditAccountRecord> {
    await tx
      .insert(creditAccounts)
      .values({ accountId })
      .onConflictDoNothing({ target: creditAccounts.accountId });
    const [row] = await tx
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.accountId, accountId))
      .for('update');
    if (row === undefined) throw new Error('credit account row vanished after it was ensured');
    return toAccountRecord(row);
  }

  /**
   * Add a lot. It is born EMPTY — the database forces `remaining_micro` to 0 —
   * and holds credit only once a `grant` ledger row funds it. The same grant key
   * inserts once; a second call with the same terms returns the first lot.
   */
  async insertLot(
    lot: NewCreditLot,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<CreditLotInsertResult> {
    const values = {
      accountId: lot.accountId,
      kind: lot.kind,
      spendRank: CREDIT_LOT_SPEND_RANK[lot.kind],
      windowId: lot.windowId ?? null,
      grantKey: lot.grantKey,
      grantedMicro: positiveMicro('a lot', lot.grantedMicro),
      startsAt: lot.startsAt,
      expiresAt: lot.expiresAt,
    };
    const [inserted] = await on
      .insert(creditLots)
      .values(values)
      .onConflictDoNothing({ target: creditLots.grantKey })
      .returning();
    if (inserted !== undefined) return { inserted: true, lot: toLotRecord(inserted) };

    const [existing] = await on
      .select()
      .from(creditLots)
      .where(eq(creditLots.grantKey, lot.grantKey))
      .limit(1);
    if (existing === undefined) {
      throw new Error('a credit lot conflicted on its grant key and then could not be read');
    }
    const record = toLotRecord(existing);
    const same =
      record.accountId === values.accountId &&
      record.kind === values.kind &&
      record.windowId === values.windowId &&
      record.grantedMicro === values.grantedMicro &&
      record.startsAt.getTime() === values.startsAt.getTime() &&
      record.expiresAt.getTime() === values.expiresAt.getTime();
    if (!same) throw new CreditLotGrantKeyReusedError(lot.grantKey);
    return { inserted: false, lot: record };
  }

  /**
   * Write one ledger row, which applies itself to its lot and the account's
   * debt in the same statement. Applies once per (account, key), including when
   * two connections race on the key.
   *
   * Every movement needs the account's credit row (`ensureAccount`, or
   * `lockAccount` first in a transaction); the database refuses it otherwise
   * (23503). The row's trigger locks that credit row until the transaction
   * ends — shared, or for update when the movement changes debt — so a writer
   * that did not take `lockAccount` first still waits behind one that is moving
   * the same account's debt. A second funding row (grant) for a lot that has
   * already been funded is refused (23505), whatever its key.
   */
  async append(
    entry: NewCreditLedgerEntry,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<CreditLedgerAppendResult> {
    const row = creditLedgerRowFor(entry);
    const [inserted] = await on
      .insert(creditLedger)
      .values(row)
      .onConflictDoNothing({ target: [creditLedger.accountId, creditLedger.idempotencyKey] })
      .returning();
    if (inserted !== undefined) return { applied: true, entry: toLedgerRecord(inserted) };

    const [existing] = await on
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.accountId, row.accountId),
          eq(creditLedger.idempotencyKey, row.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing === undefined) {
      throw new Error('a credit ledger row conflicted on its key and then could not be read');
    }
    const record = toLedgerRecord(existing);
    const same =
      record.kind === row.kind &&
      record.lotId === row.lotId &&
      record.lotDeltaMicro === row.lotDeltaMicro &&
      record.debtDeltaMicro === row.debtDeltaMicro &&
      record.reason === row.reason;
    if (!same) throw new CreditLedgerKeyReusedError(row.accountId, row.idempotencyKey);
    return { applied: false, entry: record };
  }

  /**
   * Credit a new task could use right now: the sum of `remaining − held` over
   * lots that have started, have not expired and are not revoked. "Now" is the
   * DATABASE's clock (inside a transaction, its start), never this process's.
   */
  async spendableMicro(
    accountId: string,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<number> {
    const [row] = await on
      .select({
        micro: sql<string>`coalesce(sum(${creditLots.remainingMicro} - ${creditLots.heldMicro}), 0)::text`,
      })
      .from(creditLots)
      .where(
        and(
          eq(creditLots.accountId, accountId),
          lte(creditLots.startsAt, sql`now()`),
          gt(creditLots.expiresAt, sql`now()`),
          isNull(creditLots.revokedAt),
          gt(creditLots.remainingMicro, creditLots.heldMicro),
        ),
      );
    return exact('spendable credit', Number(row?.micro ?? '0'));
  }

  /**
   * Credit that running tasks are holding right now: the sum of `held` over
   * every one of the account's lots. Unlike `spendableMicro` this counts lots
   * whose term has already ended, because a task that started before a lot
   * expired still holds — and may still be charged from — the part it took.
   *
   * It is what decides how much of a clawback's shortfall is a PENDING CLAIM
   * rather than debt: credit a task is holding is credit the account still has,
   * and the claim is paid out of it when the task settles.
   */
  async heldMicro(accountId: string, on: CreditLedgerExecutor = this.database.db): Promise<number> {
    const [row] = await on
      .select({ micro: sql<string>`coalesce(sum(${creditLots.heldMicro}), 0)::text` })
      .from(creditLots)
      .where(eq(creditLots.accountId, accountId));
    return exact('held credit', Number(row?.micro ?? '0'));
  }

  /**
   * Expire what is left of every lot of this account whose term has ended: one
   * `expiry` row per lot, for `remaining − held` — never the part a running task
   * still holds, which that task may yet be charged from. "Ended" is judged on
   * the DATABASE's clock. One statement, so each lot's amount and its row are
   * read and written together.
   *
   * ⛔ CALL UNDER `lockAccount`. The key is `expiry:<lot>:<n>`, n counting the
   * lot's expiry rows: a lot whose held part is released after it expired gives
   * that part up in a second row, which needs a key of its own. Two callers that
   * both held the lock in turn cannot compute the same n for different amounts;
   * two that did not could, and the second would silently expire nothing.
   */
  async expireDueLots(tx: CreditLedgerTx, accountId: string): Promise<ExpiredCreditLot[]> {
    const result = await tx.execute<{ lot_id: string; expired: string }>(sql`
      INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key, actor)
      SELECT l.account_id, 'expiry', l.id, -(l.remaining_micro - l.held_micro),
             'expiry:' || l.id || ':' || (
               1 + (SELECT count(*) FROM credit_ledger x WHERE x.lot_id = l.id AND x.kind = 'expiry')),
             'system'
        FROM credit_lots l
       WHERE l.account_id = ${accountId}::uuid
         AND l.expires_at <= now()
         AND l.remaining_micro > l.held_micro
       ORDER BY l.expires_at, l.id
      ON CONFLICT (account_id, idempotency_key) DO NOTHING
      RETURNING lot_id, (-lot_delta_micro)::text AS expired`);
    return rowsOf<{ lot_id: string; expired: string }>(result).map((r) => ({
      lotId: r.lot_id,
      expiredMicro: exact('an expired amount', Number(r.expired)),
    }));
  }

  /**
   * Repay the account's debt from its spendable credit, in spend order
   * (included credits, then goodwill, then bought credits; soonest to expire
   * first), until the debt is gone or no free credit is left. One
   * `debt_repayment` row per lot used.
   *
   * The database refuses to COMMIT an account that holds debt beside spendable
   * credit, so every transaction that adds free credit to an account, or debt to
   * one, ends with this. ⛔ CALL UNDER `lockAccount`: the debt read here is the
   * locked row's, and the key `debt_repayment:<lot>:<n>` counts the lot's
   * repayment rows the same way `expireDueLots` counts expiries.
   */
  async settleDebtFromFree(tx: CreditLedgerTx, accountId: string): Promise<CreditDebtRepayment[]> {
    const [account] = await tx
      .select({ debtMicro: creditAccounts.debtMicro })
      .from(creditAccounts)
      .where(eq(creditAccounts.accountId, accountId))
      .limit(1)
      .for('update');
    let owed = exact('credit_accounts.debt_micro', account?.debtMicro ?? 0);
    if (owed <= 0) return [];

    const lots = await tx.execute<{ id: string; free: string; repayments: string }>(sql`
      SELECT l.id, (l.remaining_micro - l.held_micro)::text AS free,
             (SELECT count(*) FROM credit_ledger x
               WHERE x.lot_id = l.id AND x.kind = 'debt_repayment')::text AS repayments
        FROM credit_lots l
       WHERE l.account_id = ${accountId}::uuid
         AND l.starts_at <= now() AND l.expires_at > now() AND l.revoked_at IS NULL
         AND l.remaining_micro > l.held_micro
       ORDER BY l.spend_rank, l.expires_at, l.created_at, l.id
         FOR UPDATE OF l`);
    const repaid: CreditDebtRepayment[] = [];
    for (const lot of rowsOf<{ id: string; free: string; repayments: string }>(lots)) {
      if (owed <= 0) break;
      const free = exact('free credit', Number(lot.free));
      const amount = Math.min(free, owed);
      const n = exact('a repayment count', Number(lot.repayments)) + 1;
      await this.append(
        {
          accountId,
          kind: 'debt_repayment',
          lotId: lot.id,
          amountMicro: amount,
          idempotencyKey: `debt_repayment:${lot.id}:${String(n)}`,
        },
        tx,
      );
      repaid.push({ lotId: lot.id, repaidMicro: amount });
      owed = owed - amount;
    }
    return repaid;
  }

  /**
   * One page of the account's ledger, newest first. `cursor` is the id of the
   * last entry already seen; the page holds entries older than it.
   */
  async ledgerPage(
    accountId: string,
    opts: { readonly limit: number; readonly cursor?: string },
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<CreditLedgerPage> {
    const { limit, cursor } = opts;
    if (!Number.isInteger(limit) || limit < 1 || limit > CREDIT_LEDGER_PAGE_MAX) {
      throw new RangeError(`a ledger page holds 1 to ${String(CREDIT_LEDGER_PAGE_MAX)} entries`);
    }
    // At most 18 digits, so any cursor fits a Postgres bigint.
    if (cursor !== undefined && !/^[1-9][0-9]{0,17}$/.test(cursor)) {
      throw new RangeError('a ledger cursor is the id of a ledger entry');
    }
    const rows = await on
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.accountId, accountId),
          cursor === undefined ? undefined : sql`${creditLedger.id} < ${cursor}::bigint`,
        ),
      )
      .orderBy(desc(creditLedger.id))
      .limit(limit + 1);
    const entries = rows.slice(0, limit).map(toLedgerRecord);
    const last = entries[entries.length - 1];
    return {
      entries,
      nextCursor: rows.length > limit && last !== undefined ? last.id : null,
    };
  }
}

/** The rows of a raw `execute`: postgres-js returns them as the array itself. */
export function rowsOf<T>(result: unknown): T[] {
  const rows = (result as { rows?: unknown }).rows;
  return (Array.isArray(rows) ? rows : (result as unknown[])) as T[];
}

/**
 * A bigint column read as a JavaScript number, refused rather than rounded past
 * 2^53. A value that is not exact is a corrupt row, and a silently rounded
 * balance would be a wrong charge.
 */
function exact(what: string, value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} is not a safe integer`);
  return value;
}

/** A stored vocabulary value, refused if the database somehow holds another. */
function member<T extends string>(what: string, values: readonly T[], value: string): T {
  if (!(values as readonly string[]).includes(value)) {
    throw new RangeError(`${what} holds an unknown value`);
  }
  return value as T;
}

function toAccountRecord(r: CreditAccountRow): CreditAccountRecord {
  return {
    accountId: r.accountId,
    billingMode: member('credit_accounts.billing_mode', AiBillingSchema.options, r.billingMode),
    aiSource:
      r.aiSource === null
        ? null
        : member('credit_accounts.ai_source', AiSourceSchema.options, r.aiSource),
    aiSourceSetBy:
      r.aiSourceSetBy === null
        ? null
        : member('credit_accounts.ai_source_set_by', AiSourceSetBySchema.options, r.aiSourceSetBy),
    aiSourceSetAt: r.aiSourceSetAt,
    debtMicro: exact('credit_accounts.debt_micro', r.debtMicro),
    autoTopUpEnabled: r.autoTopUpEnabled,
  };
}

function toLotRecord(r: CreditLotRow): CreditLotRecord {
  const kind = member('credit_lots.kind', CREDIT_LOT_KINDS, r.kind);
  const spendRank = CREDIT_LOT_SPEND_RANK[kind];
  if (r.spendRank !== spendRank)
    throw new RangeError('credit_lots.spend_rank does not match its kind');
  return {
    id: r.id,
    accountId: r.accountId,
    kind,
    spendRank,
    windowId: r.windowId,
    grantKey: r.grantKey,
    grantedMicro: exact('credit_lots.granted_micro', r.grantedMicro),
    remainingMicro: exact('credit_lots.remaining_micro', r.remainingMicro),
    heldMicro: exact('credit_lots.held_micro', r.heldMicro),
    startsAt: r.startsAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
  };
}

function toLedgerRecord(r: CreditLedgerRow): CreditLedgerRecord {
  return {
    id: r.id.toString(),
    accountId: r.accountId,
    kind: member('credit_ledger.kind', CREDIT_LEDGER_KINDS, r.kind),
    lotId: r.lotId,
    lotDeltaMicro: exact('credit_ledger.lot_delta_micro', r.lotDeltaMicro),
    debtDeltaMicro: exact('credit_ledger.debt_delta_micro', r.debtDeltaMicro),
    idempotencyKey: r.idempotencyKey,
    reservationId: r.reservationId,
    agentSessionId: r.agentSessionId,
    model: r.model,
    rateCardVersion: r.rateCardVersion,
    reason: r.reason,
    actor: member('credit_ledger.actor', CREDIT_LEDGER_ACTORS, r.actor),
    createdAt: r.createdAt,
  };
}

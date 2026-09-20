// Reads the AI credits rate card (migration 0127).
//
// Two questions and nothing else: which card is in force at an instant, and
// what one model costs on one card. There is deliberately NO writer here. A card
// is published by an owner-only admin path that does not exist yet, and the
// database refuses every later change on its own (see the trigger notes beside
// `creditRateCards` in schema.ts), so the read side has nothing to guard.
//
// The card in force is the newest card that has taken effect and was not
// withdrawn. A withdrawn card is never in force at any instant, because the
// database only lets a card be withdrawn before it takes effect, and judges
// "before" when the withdrawal COMMITS, so no reader ever saw it in force.

import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { CreditRateCardModelRow } from '@driftstack/api-types';
import type { Database } from './client.js';
import type { CreditLedgerExecutor } from './credit-ledger-repo.js';
import {
  creditRateCardModels,
  creditRateCards,
  type CreditRateCardModelDbRow,
  type CreditRateCardRow,
} from './schema.js';

export interface CreditRateCardRecord {
  readonly version: number;
  /** Markup over list price in basis points (20,000 = 2.0 ×). */
  readonly markupBp: number;
  readonly announcedAt: Date;
  readonly effectiveAt: Date;
  /** Always null for a card that is or was in force. */
  readonly withdrawnAt: Date | null;
  readonly createdByKeyId: string | null;
  readonly note: string;
}

/** One model's prices on one card, in the api-types row shape. */
export interface CreditRateCardModelRecord extends CreditRateCardModelRow {
  readonly version: number;
  readonly model: string;
}

export interface CreditRateCardReader {
  /**
   * The card in force at `at`, or at the database's now() when `at` is
   * omitted. Null when no card had taken effect by then.
   *
   * `at` has millisecond precision and the column has microseconds, so an
   * instant read back from `effectiveAt` may sit just under it.
   *
   * `on` runs the read inside a transaction the caller holds, so a reservation
   * picks its card on the same snapshot and the same clock as the balance it is
   * drawing on. A card is immutable once it has taken effect, so the two forms
   * can differ only across a publication.
   */
  cardInForce(at?: Date, on?: CreditLedgerExecutor): Promise<CreditRateCardRecord | null>;
  /**
   * One model's row on a card, or null when that card does not price the model
   * (an Opus-class model, an unknown id, or a version that does not exist).
   */
  modelRow(
    version: number,
    model: string,
    on?: CreditLedgerExecutor,
  ): Promise<CreditRateCardModelRecord | null>;
}

export class DrizzleCreditRateCardRepo implements CreditRateCardReader {
  constructor(private readonly database: Database) {}

  async cardInForce(
    at?: Date,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<CreditRateCardRecord | null> {
    const [row] = await on
      .select()
      .from(creditRateCards)
      .where(
        and(
          at === undefined
            ? lte(creditRateCards.effectiveAt, sql`now()`)
            : lte(creditRateCards.effectiveAt, at),
          isNull(creditRateCards.withdrawnAt),
        ),
      )
      .orderBy(desc(creditRateCards.effectiveAt))
      .limit(1);
    return row === undefined ? null : toCardRecord(row);
  }

  async modelRow(
    version: number,
    model: string,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<CreditRateCardModelRecord | null> {
    const [row] = await on
      .select()
      .from(creditRateCardModels)
      .where(and(eq(creditRateCardModels.version, version), eq(creditRateCardModels.model, model)))
      .limit(1);
    return row === undefined ? null : toModelRecord(row);
  }
}

function toCardRecord(r: CreditRateCardRow): CreditRateCardRecord {
  return {
    version: r.version,
    markupBp: r.markupBp,
    announcedAt: r.announcedAt,
    effectiveAt: r.effectiveAt,
    withdrawnAt: r.withdrawnAt,
    createdByKeyId: r.createdByKeyId,
    note: r.note,
  };
}

/**
 * A bigint column read as a JavaScript number, refused rather than rounded when
 * it is past 2^53. Every price on a card is far below that; a value that is not
 * is a corrupt row, and a silently rounded price would be a wrong charge.
 */
function exact(column: string, value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`credit_rate_card_models.${column} is not a safe integer`);
  }
  return value;
}

function toModelRecord(r: CreditRateCardModelDbRow): CreditRateCardModelRecord {
  return {
    version: r.version,
    model: r.model,
    inputMicroPerToken: exact('input_micro_per_token', r.inputMicroPerToken),
    outputMicroPerToken: exact('output_micro_per_token', r.outputMicroPerToken),
    cacheReadMicroPerToken: exact('cache_read_micro_per_token', r.cacheReadMicroPerToken),
    cacheWrite5mMicroPerToken: exact('cache_write_5m_micro_per_token', r.cacheWrite5mMicroPerToken),
    cacheWrite1hMicroPerToken: exact('cache_write_1h_micro_per_token', r.cacheWrite1hMicroPerToken),
    minStartMicro: exact('min_start_micro', r.minStartMicro),
    maxReserveMicro: exact('max_reserve_micro', r.maxReserveMicro),
    listInputMicrocentsPerToken: exact(
      'list_input_microcents_per_token',
      r.listInputMicrocentsPerToken,
    ),
    listOutputMicrocentsPerToken: exact(
      'list_output_microcents_per_token',
      r.listOutputMicrocentsPerToken,
    ),
  };
}

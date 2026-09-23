// Reads and (S15) writes the AI credits rate card (migration 0127).
//
// Two questions the read side answers, and nothing else: which card is in
// force at an instant, and what one model costs on one card.
//
// S15 adds the writer: `publish` and `withdraw`, for the owner-only admin
// path (`services/admin-credits.ts`). The database still refuses everything
// this file does not do on its own — no UPDATE of a published card's terms,
// no DELETE ever, no model row after the card's own transaction, the 30-day
// notice, "withdraw only before it takes effect" — see the trigger notes
// beside `creditRateCards`/`creditRateCardModels` in schema.ts. This file's
// checks exist to fail early and readably; the database is the last line.
//
// The card in force is the newest card that has taken effect and was not
// withdrawn. A withdrawn card is never in force at any instant, because the
// database only lets a card be withdrawn before it takes effect, and judges
// "before" when the withdrawal COMMITS, so no reader ever saw it in force.

import { and, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type { CreditRateCardModelRow } from '@driftstack/api-types';
import type { Database } from './client.js';
import { rowsOf, type CreditLedgerExecutor, type CreditLedgerTx } from './credit-ledger-repo.js';
import { actingKeyIdFromColumns, optionalActingKeyColumns } from '../lib/acting-key-columns.js';
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
  /** Who published it, as the auth context had it: a key's uuid or `wsk_<uuid>`. */
  readonly createdByKeyId: string | null;
  readonly note: string;
}

/** One model's prices on one card, in the api-types row shape. */
export interface CreditRateCardModelRecord extends CreditRateCardModelRow {
  readonly version: number;
  readonly model: string;
}

/** S15 — a derived row (`deriveRateCardRows`'s output), ready to write. */
export interface RateCardModelToWrite extends CreditRateCardModelRow {
  readonly model: string;
}

/** S15 — what `publish` writes: the card row plus every model it prices. */
export interface RateCardPublishInput {
  /** Markup over list price in basis points; the database re-checks the range. */
  readonly markupBp: number;
  /** When the card takes effect. The database re-checks the 30-day notice. */
  readonly effectiveAt: Date;
  readonly rows: readonly RateCardModelToWrite[];
  readonly createdByKeyId: string | null;
  readonly note?: string;
}

/**
 * S15 audit fix #2 — what `publish`/`withdraw` run INSIDE their own
 * transaction, after the write and before the commit: the audit row. The card
 * and its audit row then commit together or not at all; a hook that throws
 * rolls the write back.
 */
export type RateCardWriteHook = (tx: CreditLedgerTx, card: CreditRateCardRecord) => Promise<void>;

/** S15 — what `withdraw` found. `card` is null only for `not_found`. */
export type RateCardWithdrawResult =
  | { readonly outcome: 'withdrawn'; readonly card: CreditRateCardRecord }
  | { readonly outcome: 'already_withdrawn'; readonly card: CreditRateCardRecord }
  | { readonly outcome: 'not_found'; readonly card: null };

/**
 * S15 — thrown by `publish`/`withdraw` when the DATABASE itself refused the
 * write (a CHECK or a trigger raised at INSERT/UPDATE or at COMMIT), so the
 * caller can tell "this specific rule" apart from an ordinary connection
 * failure. `sqlState` is the Postgres error code (e.g. `23514`, `55000`);
 * `constraintName` is set when Postgres named one.
 */
export class RateCardRefusedError extends Error {
  constructor(
    message: string,
    readonly sqlState: string | null,
    readonly constraintName: string | null,
  ) {
    super(message);
    this.name = 'RateCardRefusedError';
  }
}

/** The Postgres error shape `postgres`/drizzle surface on a driver error. */
function pgError(err: unknown): { code?: string; constraint_name?: string } | null {
  const cause = (err as { cause?: unknown }).cause;
  const candidate = cause ?? err;
  if (candidate !== null && typeof candidate === 'object' && 'code' in candidate) {
    return candidate as { code?: string; constraint_name?: string };
  }
  return null;
}

/**
 * Re-throw a driver error from a rate-card write as {@link RateCardRefusedError}
 * when it is one of the rules migration 0127 documents; anything else (a
 * dropped connection, say) passes through unchanged.
 *
 *   · 23514 — a CHECK (the markup range, the 30-day notice, "withdraw before
 *     it takes effect"), or a trigger raising `check_violation`;
 *   · 55000 — the immutability and commit-time triggers;
 *   · 23505 — `credit_rate_cards_live_effective_unique`: a live card already
 *     takes effect at that instant (S15 audit #8 — this one came back as a
 *     500). The version itself cannot collide: publishes are serialised by
 *     their advisory lock. The caller answers it 409, a clash, not a 400.
 */
function asRateCardRefusal(err: unknown): never {
  const pg = pgError(err);
  if (pg !== null && (pg.code === '23514' || pg.code === '55000' || pg.code === '23505')) {
    throw new RateCardRefusedError(
      err instanceof Error ? err.message : 'the rate card write was refused',
      pg.code ?? null,
      pg.constraint_name ?? null,
    );
  }
  throw err;
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
  /**
   * S14 — the next ANNOUNCED card: the soonest `effective_at` strictly after
   * `at` (the database's now() when omitted) among cards not withdrawn. Null
   * when none is announced. `GET /v1/account/me/ai`'s `rate_card.next` and
   * `GET /v1/ai/models`' per-model `next` both read this — the published
   * notice period (§9, `RATE_CARD_CHANGE_NOTICE_DAYS`) means a customer may
   * see the NEXT card's prices before they take effect.
   */
  nextAnnouncedCard(at?: Date, on?: CreditLedgerExecutor): Promise<CreditRateCardRecord | null>;
}

/** S15 — the owner-only publish path. */
export interface CreditRateCardWriter {
  /**
   * Insert a new card and its model rows in ONE transaction: the next version
   * number (`max(version) + 1`, serialized against a concurrent publish by an
   * advisory lock so two owners cannot compute the same one), the card row,
   * then every model row. `input.rows` is already `deriveRateCardRows`'
   * OUTPUT — this writes what it derived, unchanged; it does not re-derive.
   *
   * Throws {@link RateCardRefusedError} for a CHECK/trigger refusal (the
   * 30-day notice, the markup range, an Opus-class model — every rule
   * migration 0127 documents); the caller decides the HTTP shape.
   */
  publish(
    input: RateCardPublishInput,
    inTransaction?: RateCardWriteHook,
  ): Promise<CreditRateCardRecord>;
  /**
   * Withdraw a card that has not taken effect yet, in a transaction of its
   * own; `inTransaction` runs inside it only when the card was withdrawn.
   *
   * Throws {@link RateCardRefusedError} when the database refuses the write
   * itself (its `effective_at` has passed — including the COMMIT-time race
   * the deferred trigger catches). Does NOT throw for "no such version" or
   * "already withdrawn": both are ordinary outcomes the caller distinguishes
   * from `withdrawn` on the result, because neither reaches the database
   * trigger (the UPDATE's own WHERE excludes an already-withdrawn row, so it
   * matches zero rows rather than being refused).
   */
  withdraw(version: number, inTransaction?: RateCardWriteHook): Promise<RateCardWithdrawResult>;
  /** Every card, newest version first — `GET /v1/admin/credit-rate-cards`. */
  listAll(on?: CreditLedgerExecutor): Promise<readonly CreditRateCardRecord[]>;
  /** How many models each card prices, by version — that list's `model_count`. */
  modelCounts(on?: CreditLedgerExecutor): Promise<ReadonlyMap<number, number>>;
}

export class DrizzleCreditRateCardRepo implements CreditRateCardReader, CreditRateCardWriter {
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

  async nextAnnouncedCard(
    at?: Date,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<CreditRateCardRecord | null> {
    const [row] = await on
      .select()
      .from(creditRateCards)
      .where(
        and(
          // Same shape as `cardInForce` above: the raw `sql` fragment carries
          // only the literal `now()`, with the column comparison left to the
          // builder — never a column or a `Date` interpolated into a raw
          // template (docs/internal/drizzle-date-param-workaround.md).
          at === undefined
            ? gt(creditRateCards.effectiveAt, sql`now()`)
            : gt(creditRateCards.effectiveAt, at),
          isNull(creditRateCards.withdrawnAt),
        ),
      )
      .orderBy(creditRateCards.effectiveAt)
      .limit(1);
    return row === undefined ? null : toCardRecord(row);
  }

  async publish(
    input: RateCardPublishInput,
    inTransaction?: RateCardWriteHook,
  ): Promise<CreditRateCardRecord> {
    try {
      return await this.database.db.transaction(async (tx: CreditLedgerTx) => {
        // Serialize concurrent publishes: without this, two owners racing to
        // publish could both read the same MAX(version) and try to insert the
        // same next one — the second would fail on the primary key, which is
        // a correct refusal but a confusing one ("version already exists" for
        // a version the caller never chose). The lock makes the second wait
        // and then see the first's version in its own MAX() read.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended('credit_rate_cards_publish', 0))`,
        );
        const result = await tx.execute<{ next: number }>(
          sql`SELECT (COALESCE(MAX(version), 0) + 1)::int AS next FROM credit_rate_cards`,
        );
        const next = rowsOf<{ next: number }>(result)[0]?.next;
        if (next === undefined) throw new Error('could not compute the next rate card version');

        // 0138 — the owner's key, or their web session when they published signed
        // in (`wsk_<uuid>` cannot go in the uuid key column).
        const publisher = optionalActingKeyColumns(input.createdByKeyId);
        const [card] = await tx
          .insert(creditRateCards)
          .values({
            version: next,
            markupBp: input.markupBp,
            // announced_at is forced to now() by the BEFORE INSERT trigger
            // regardless of what is sent; effective_at is the one figure this
            // write actually controls.
            effectiveAt: input.effectiveAt,
            createdByKeyId: publisher.keyId,
            createdByWebSessionId: publisher.webSessionId,
            note: input.note ?? '',
          })
          .returning();
        if (card === undefined) throw new Error('a rate card was inserted and not returned');

        if (input.rows.length > 0) {
          await tx.insert(creditRateCardModels).values(
            input.rows.map((r) => ({
              version: next,
              model: r.model,
              inputMicroPerToken: r.inputMicroPerToken,
              outputMicroPerToken: r.outputMicroPerToken,
              cacheReadMicroPerToken: r.cacheReadMicroPerToken,
              cacheWrite5mMicroPerToken: r.cacheWrite5mMicroPerToken,
              cacheWrite1hMicroPerToken: r.cacheWrite1hMicroPerToken,
              minStartMicro: r.minStartMicro,
              maxReserveMicro: r.maxReserveMicro,
              listInputMicrocentsPerToken: r.listInputMicrocentsPerToken,
              listOutputMicrocentsPerToken: r.listOutputMicrocentsPerToken,
            })),
          );
        }
        const record = toCardRecord(card);
        if (inTransaction !== undefined) await inTransaction(tx, record);
        return record;
      });
    } catch (err) {
      asRateCardRefusal(err);
    }
  }

  async withdraw(
    version: number,
    inTransaction?: RateCardWriteHook,
  ): Promise<RateCardWithdrawResult> {
    try {
      // One transaction, so the hook commits with the withdrawal; the
      // deferred "before it takes effect" trigger fires at ITS commit, still
      // inside this try.
      return await this.database.db.transaction(
        async (tx: CreditLedgerTx): Promise<RateCardWithdrawResult> => {
          const [row] = await tx
            .update(creditRateCards)
            .set({ withdrawnAt: sql`now()` })
            .where(and(eq(creditRateCards.version, version), isNull(creditRateCards.withdrawnAt)))
            .returning();
          if (row !== undefined) {
            const card = toCardRecord(row);
            if (inTransaction !== undefined) await inTransaction(tx, card);
            return { outcome: 'withdrawn', card };
          }
          // The UPDATE matched zero rows: either no such version, or one that
          // exists but is already withdrawn (the WHERE above excludes it).
          // Read back to tell the two apart.
          const [existing] = await tx
            .select()
            .from(creditRateCards)
            .where(eq(creditRateCards.version, version))
            .limit(1);
          return existing === undefined
            ? { outcome: 'not_found', card: null }
            : { outcome: 'already_withdrawn', card: toCardRecord(existing) };
        },
      );
    } catch (err) {
      asRateCardRefusal(err);
    }
  }

  async listAll(
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<readonly CreditRateCardRecord[]> {
    const rows = await on.select().from(creditRateCards).orderBy(desc(creditRateCards.version));
    return rows.map(toCardRecord);
  }

  /** S15 — how many models each card prices, for `GET /v1/admin/credit-rate-cards`'
   *  `model_count`. A card with no rows at all (refused before any model row was
   *  written) reads 0, not absent. */
  async modelCounts(
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<ReadonlyMap<number, number>> {
    const rows = await on
      .select({ version: creditRateCardModels.version, count: sql<string>`count(*)::text` })
      .from(creditRateCardModels)
      .groupBy(creditRateCardModels.version);
    return new Map(rows.map((r) => [r.version, Number(r.count)]));
  }
}

function toCardRecord(r: CreditRateCardRow): CreditRateCardRecord {
  return {
    version: r.version,
    markupBp: r.markupBp,
    announcedAt: r.announcedAt,
    effectiveAt: r.effectiveAt,
    withdrawnAt: r.withdrawnAt,
    createdByKeyId: actingKeyIdFromColumns(r.createdByKeyId, r.createdByWebSessionId),
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

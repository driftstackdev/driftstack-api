// V-666 — Drizzle implementation of CryptoOrdersRepo (migration 0060).
//
// The service layer (apps/server/src/services/crypto-orders.ts) is
// already exhaustively tested against InMemoryCryptoOrdersRepo; this
// file is a thin adapter that maps the CryptoOrder envelope ↔ the
// crypto_orders row shape. All state-transition logic, idempotency
// tracking, and IPN handling stay in the service.
//
// JSONB encoding: events[] is an append-only state-transition log
// stored as a JSONB column so support can reconstruct an order's
// history without grepping logs.
//
// Account_id is uuid + nullable on the DB side (V-666 anonymous-then-
// claim flow). The CryptoOrder envelope uses string|null; we pass
// through unchanged.

import { and, asc, count, desc, eq, gte, inArray, lte, sql, sum } from 'drizzle-orm';
import type { Database } from './client.js';
import { cryptoOrders } from './schema.js';
import {
  UNPAID_CRYPTO_ORDER_STATUSES,
  type CryptoOrder,
  type CryptoOrderEvent,
  type CryptoOrderLimits,
  type CryptoOrderRefusal,
  type CryptoOrdersRepo,
  type CryptoOrderWebhookEvent,
  type PaymentMintClaim,
  type PaymentMintClaimTerms,
} from '../services/crypto-orders.js';
import { enqueueWebhookEventInTransaction } from './webhooks-repo.js';

type Row = typeof cryptoOrders.$inferSelect;

/** The columns an order row is written with (`upsert` and the capped inserts below). */
function orderRowValues(order: CryptoOrder): {
  orderId: string;
  accountId: string | null;
  product: string;
  priceCents: number;
  priceCurrency: string;
  paymentId: string | null;
  payAmount: number | null;
  payCurrency: string | null;
  status: CryptoOrder['status'];
  customerNote: string | null;
  internalNote: string | null;
  events: CryptoOrderEvent[];
  createdAt: Date;
  updatedAt: Date;
} {
  return {
    orderId: order.order_id,
    accountId: order.account_id,
    product: order.product,
    priceCents: order.price_cents,
    priceCurrency: order.price_currency,
    paymentId: order.payment_id,
    payAmount: order.pay_amount,
    payCurrency: order.pay_currency,
    status: order.status,
    customerNote: order.customer_note,
    internalNote: order.internal_note,
    events: order.events,
    createdAt: new Date(order.created_at),
    updatedAt: new Date(order.updated_at),
  };
}

/** What `upsert` rewrites when the order row already exists. */
function orderUpsertSet(
  values: ReturnType<typeof orderRowValues>,
): Partial<ReturnType<typeof orderRowValues>> {
  return {
    accountId: values.accountId,
    paymentId: values.paymentId,
    payAmount: values.payAmount,
    payCurrency: values.payCurrency,
    status: values.status,
    customerNote: values.customerNote,
    internalNote: values.internalNote,
    events: values.events,
    updatedAt: values.updatedAt,
  };
}

/**
 * Security sweep #18 — the per-account transaction lock the open-order limit and the
 * daily budget are counted and written under. Different accounts hash to different
 * keys, so one account's checkouts never wait on another's.
 */
function openOrderLockKey(accountId: string): string {
  return `crypto-order-open:${accountId}`;
}

type Tx = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

/**
 * Security sweep #18 (residual) — the payments minted for the account's unpaid orders
 * whose latest mint claim is at or after `since`, read under the account's lock. An
 * order claimed again later is counted whole while its latest claim is in the window,
 * which can only over-count.
 */
async function mintsSinceUnder(tx: Tx, accountId: string, since: number): Promise<number> {
  const [minted] = await tx
    .select({ n: sum(cryptoOrders.paymentMints) })
    .from(cryptoOrders)
    .where(
      and(
        eq(cryptoOrders.accountId, accountId),
        inArray(cryptoOrders.status, [...UNPAID_CRYPTO_ORDER_STATUSES]),
        gte(cryptoOrders.paymentMintClaimedAt, new Date(since)),
      ),
    );
  return Number(minted?.n ?? 0);
}

/**
 * Security sweep #18 — which of the account's limits a NEW order would break, read
 * under the account's lock: the daily budget first (unpaid orders created since
 * `startedSince` — when it is spent, cancelling an open order does not help, since a
 * cancelled order keeps counting; paying one does, since a paid order never counts),
 * and the daily mint budget with it (a new order could not be minted once that is
 * spent), then the open-order limit. Null when the order may be written.
 */
async function refusalUnder(
  tx: Tx,
  accountId: string,
  limits: CryptoOrderLimits,
): Promise<CryptoOrderRefusal | null> {
  const [started] = await tx
    .select({ n: count() })
    .from(cryptoOrders)
    .where(
      and(
        eq(cryptoOrders.accountId, accountId),
        inArray(cryptoOrders.status, [...UNPAID_CRYPTO_ORDER_STATUSES]),
        gte(cryptoOrders.createdAt, new Date(limits.startedSince)),
      ),
    );
  if ((started?.n ?? 0) >= limits.startedPerDay) return 'daily_budget';
  if ((await mintsSinceUnder(tx, accountId, limits.startedSince)) >= limits.mintsPerDay) {
    return 'mint_budget';
  }
  const [pending] = await tx
    .select({ n: count() })
    .from(cryptoOrders)
    .where(and(eq(cryptoOrders.accountId, accountId), eq(cryptoOrders.status, 'pending')));
  if ((pending?.n ?? 0) >= limits.open) return 'open_limit';
  return null;
}

function rowToEnvelope(row: Row): CryptoOrder {
  return {
    order_id: row.orderId,
    account_id: row.accountId,
    product: row.product,
    price_cents: row.priceCents,
    price_currency: row.priceCurrency,
    payment_id: row.paymentId,
    // Billing-integrity (#1) — crypto-denominated quote (mode:'number' on the
    // numeric column reads back as number|null).
    pay_amount: row.payAmount,
    pay_currency: row.payCurrency,
    status: row.status,
    customer_note: row.customerNote,
    internal_note: row.internalNote,
    // JSONB column reads back as `unknown` from drizzle's $inferSelect —
    // cast to the typed array shape. The service is the only writer so
    // shape integrity is guaranteed by construction.
    events: (row.events as CryptoOrderEvent[]) ?? [],
    created_at: row.createdAt.getTime(),
    updated_at: row.updatedAt.getTime(),
  };
}

export class DrizzleCryptoOrdersRepo implements CryptoOrdersRepo {
  /** Webhooks audit #5 — `withOrderLock` writes lock-time events in its transaction. */
  readonly writesWebhookEventsInLock = true;

  constructor(private readonly database: Database) {}

  async upsert(order: CryptoOrder): Promise<void> {
    const values = orderRowValues(order);
    await this.database.db
      .insert(cryptoOrders)
      .values(values)
      .onConflictDoUpdate({ target: cryptoOrders.orderId, set: orderUpsertSet(values) });
  }

  async getById(orderId: string): Promise<CryptoOrder | null> {
    const rows = await this.database.db
      .select()
      .from(cryptoOrders)
      .where(eq(cryptoOrders.orderId, orderId))
      .limit(1);
    return rows[0] ? rowToEnvelope(rows[0]) : null;
  }

  // Billing-integrity (#7 cross-instance idempotency) — INSERT ... ON CONFLICT
  // (idempotency_key) DO NOTHING. When the key already exists the insert
  // returns zero rows; we then SELECT the prior order by that key and return it
  // as a replay. The DB UNIQUE index is the source of truth, so two concurrent
  // / cross-instance / post-restart same-key requests can never mint two rows.
  async insertWithIdempotencyKey(
    order: CryptoOrder,
    scopedIdempotencyKey: string,
    bodyFingerprint: string,
  ): Promise<{ order: CryptoOrder; replayed: boolean; storedFingerprint: string | null }> {
    const inserted = await this.database.db
      .insert(cryptoOrders)
      .values({
        orderId: order.order_id,
        accountId: order.account_id,
        product: order.product,
        priceCents: order.price_cents,
        priceCurrency: order.price_currency,
        paymentId: order.payment_id,
        payAmount: order.pay_amount,
        payCurrency: order.pay_currency,
        idempotencyKey: scopedIdempotencyKey,
        idempotencyBodyFingerprint: bodyFingerprint,
        status: order.status,
        customerNote: order.customer_note,
        internalNote: order.internal_note,
        events: order.events,
        createdAt: new Date(order.created_at),
        updatedAt: new Date(order.updated_at),
      })
      // The unique index on idempotency_key is PARTIAL (WHERE idempotency_key
      // IS NOT NULL — see schema.ts crypto_orders_idempotency_key_unique), so
      // Postgres only matches this ON CONFLICT when the arbiter carries the
      // SAME predicate. Without the `where`, real Postgres raises 42P10 ("no
      // unique or exclusion constraint matching the ON CONFLICT specification")
      // and every idempotent crypto checkout 500s. (Audit-2 2026-07-08,
      // C6 — invisible to the pglite/in-memory tests, only real PG enforces it.)
      .onConflictDoNothing({
        target: cryptoOrders.idempotencyKey,
        where: sql`${cryptoOrders.idempotencyKey} IS NOT NULL`,
      })
      .returning();
    if (inserted[0] !== undefined) {
      return { order: rowToEnvelope(inserted[0]), replayed: false, storedFingerprint: null };
    }
    // Key already existed → fetch + replay the prior order.
    const existing = await this.database.db
      .select()
      .from(cryptoOrders)
      .where(eq(cryptoOrders.idempotencyKey, scopedIdempotencyKey))
      .limit(1);
    if (existing[0] !== undefined) {
      // V-725 — hand back the RECORDED fingerprint (NULL for rows written
      // before the column existed, or without a key) so the caller can tell a
      // genuine body mismatch from "we have nothing to compare against". The
      // service must never read NULL as a match.
      return {
        order: rowToEnvelope(existing[0]),
        replayed: true,
        storedFingerprint: existing[0].idempotencyBodyFingerprint,
      };
    }
    // Extremely unlikely (conflict on insert but the row vanished between the
    // insert + select). Fall back to a plain upsert so the checkout still
    // completes rather than 500ing.
    await this.upsert(order);
    return { order, replayed: false, storedFingerprint: null };
  }

  // Row-level locked read-modify-write (mirrors stripe-webhooks-repo.setAccountTier).
  // Closes the IPN dup-fire (#3) + note/cancel lost-update (#7) races: the decision is
  // computed against the SELECT … FOR UPDATE snapshot, so concurrent IPNs/edits serialize
  // and only the winner writes/fires side-effects. Skips the write when fn returns
  // `updated: null` (the no-op branches). The SET clause matches upsert's update set.
  /**
   * V-779 — paid orders that never got an entitlement.
   *
   * The IPN handler commits `status='paid'` in one transaction (`withOrderLock`) and calls the
   * tier activator in a LATER one. A process death between the two strands a paying customer:
   * the retry re-reads the order, sees `status='paid'`, computes `firePaid = false` and skips
   * activation forever. The handler's own comment says exactly that — "a NowPayments retry would
   * find the order already paid and cannot re-drive activation — ops must remediate from the
   * alarm" — but the alarm is raised by a catch around the activator call, so an abrupt death
   * raises nothing at all.
   *
   * The predicate is lifted from the one-time backfill in
   * `migrations/0100_crypto_entitlements.sql`, which repaired exactly this population once.
   * Nothing made it recurring; this is that.
   *
   * `payment_id` and the first paid event's timestamp are read back so the reconciler can
   * rebuild the same activation intent the IPN path would have passed.
   */
  async listPaidOrdersMissingEntitlement(limit: number): Promise<
    Array<{
      orderId: string;
      accountId: string;
      product: string;
      paymentId: string | null;
      paidAt: Date;
    }>
  > {
    const result = await this.database.db.execute<{
      order_id: string;
      account_id: string;
      product: string;
      payment_id: string | null;
      paid_at: Date;
    }>(sql`
      SELECT o.order_id, o.account_id, o.product, o.payment_id,
             COALESCE(
               to_timestamp(
                 (SELECT min((e->>'at')::bigint)
                    FROM jsonb_array_elements(o.events) AS e
                   WHERE e->>'status' = 'paid') / 1000.0
               ),
               o.updated_at
             ) AS paid_at
        FROM crypto_orders o
       WHERE o.status = 'paid'
         AND o.account_id IS NOT NULL
         AND o.product IN ('solo_manual', 'team_manual', 'agency_manual',
                           'api_starter', 'api_builder', 'api_scale')
         AND NOT EXISTS (
           SELECT 1 FROM crypto_entitlements ce WHERE ce.order_id = o.order_id
         )
       ORDER BY o.updated_at ASC
       LIMIT ${limit};
    `);
    const rows = ((result as { rows?: unknown[] }).rows ?? (result as unknown[])) as Array<{
      order_id: string;
      account_id: string;
      product: string;
      payment_id: string | null;
      paid_at: string | Date;
    }>;
    return rows.map((r) => ({
      orderId: r.order_id,
      accountId: r.account_id,
      product: r.product,
      paymentId: r.payment_id,
      // `paid_at` arrives as a STRING, not a Date. Raw `db.execute` does no column-type
      // mapping, and drizzle-orm/postgres-js additionally replaces this client's timestamp
      // PARSERS with a transparent pass-through (the same override that forces ISO strings on
      // the write side — see the note in db-retention-scrub-drizzle.test.ts). Normalising here
      // rather than at the call site: a caller doing `paidAt.toISOString()` on a string throws,
      // and per-item error isolation in the sweeper would have swallowed that as a failed
      // order rather than surfacing a type bug.
      paidAt: r.paid_at instanceof Date ? r.paid_at : new Date(r.paid_at),
    }));
  }

  async withOrderLock<T>(
    orderId: string,
    fn: (locked: CryptoOrder) => {
      updated: CryptoOrder | null;
      result: T;
      webhookEvents?: readonly CryptoOrderWebhookEvent[];
    },
  ): Promise<T | null> {
    return this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(cryptoOrders)
        .where(eq(cryptoOrders.orderId, orderId))
        .for('update')
        .limit(1);
      if (rows[0] === undefined) return null;
      const locked = rowToEnvelope(rows[0]);
      const { updated, result, webhookEvents = [] } = fn(locked);
      if (updated !== null) {
        await tx
          .update(cryptoOrders)
          .set({
            // V-1649 — `accountId` is deliberately NOT in this SET.
            //
            // An order's owner is fixed at creation: nothing in the service
            // rebinds it, and there is no claim/attach path. But this UPDATE used
            // to write `accountId: updated.account_id` from the CALLBACK'S object,
            // so a callback that built `updated` from anything other than the
            // locked row — an IPN payload, say — would silently transfer the order
            // to another account. Every callback spreads `...order` today; that is
            // a convention, and the row lock does not police it, because a lock
            // protects against concurrency, not against authorship.
            //
            // Omitting the column makes the invariant structural instead of
            // conventional. Behaviour is unchanged today: every caller already
            // passes the locked value back, so writing it wrote what was already
            // there.
            paymentId: updated.payment_id,
            payAmount: updated.pay_amount,
            payCurrency: updated.pay_currency,
            status: updated.status,
            customerNote: updated.customer_note,
            internalNote: updated.internal_note,
            events: updated.events,
            updatedAt: new Date(updated.updated_at),
          })
          .where(eq(cryptoOrders.orderId, orderId));
      }
      // Webhooks audit #5 — the events this transition raises are queued in the
      // SAME transaction as the write above: the order and its event commit
      // together, or neither does. A throw here rolls the order back, so the
      // IPN fails and the provider's retry finds it still unpaid and fires the
      // event once — instead of the order committing as paid with its
      // `crypto.order.paid` lost to a failure in a later, separate step.
      for (const event of webhookEvents) {
        await enqueueWebhookEventInTransaction(tx, event);
      }
      return result;
    });
  }

  async listAll(opts: { accountId?: string; limit?: number } = {}): Promise<CryptoOrder[]> {
    const limit = opts.limit ?? 50;
    const where =
      opts.accountId !== undefined
        ? and(eq(cryptoOrders.accountId, sql`${opts.accountId}::uuid`))
        : undefined;
    const rows = await this.database.db
      .select()
      .from(cryptoOrders)
      .where(where ?? sql`true`)
      .orderBy(desc(cryptoOrders.createdAt))
      .limit(limit);
    return rows.map(rowToEnvelope);
  }

  async listPendingOlderThan(opts: { olderThan: number; limit: number }): Promise<CryptoOrder[]> {
    const rows = await this.database.db
      .select()
      .from(cryptoOrders)
      .where(
        and(
          eq(cryptoOrders.status, 'pending'),
          lte(cryptoOrders.createdAt, new Date(opts.olderThan)),
        ),
      )
      .orderBy(asc(cryptoOrders.createdAt))
      .limit(opts.limit);
    return rows.map(rowToEnvelope);
  }

  /**
   * Security sweep #18 — `upsert` a new pending order only while its account is under
   * both limits (see `refusalUnder`). The counts and the write run in one transaction
   * under a per-account advisory lock (the pattern of
   * AccountProxiesRepo.createIfUnderLimit): a count read on its own, then a write,
   * let thirty checkouts sent at once all pass a count of zero. Under READ
   * COMMITTED each statement sees what the previous lock holder committed.
   */
  async insertPendingUnderOrderLimits(
    order: CryptoOrder,
    limits: CryptoOrderLimits,
  ): Promise<'written' | CryptoOrderRefusal> {
    const accountId = order.account_id;
    if (accountId === null) {
      await this.upsert(order);
      return 'written';
    }
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${openOrderLockKey(accountId)}))`);
      const refusal = await refusalUnder(tx, accountId, limits);
      if (refusal !== null) return refusal;
      const values = orderRowValues(order);
      await tx
        .insert(cryptoOrders)
        .values(values)
        .onConflictDoUpdate({ target: cryptoOrders.orderId, set: orderUpsertSet(values) });
      return 'written' as const;
    });
  }

  /**
   * Security sweep #18 — `insertWithIdempotencyKey` under the same per-account lock
   * and limits. Under the lock, a key already stored is replayed with its recorded
   * fingerprint and never refused; otherwise the counts decide, and a new key over a
   * limit returns `{ refused }` having written nothing — no row, so no stored key.
   * Every key of an account is written under that account's lock, so the ON CONFLICT
   * arm below is only a backstop.
   */
  async insertWithIdempotencyKeyUnderOrderLimits(
    order: CryptoOrder,
    scopedIdempotencyKey: string,
    bodyFingerprint: string,
    limits: CryptoOrderLimits,
  ): Promise<
    | { order: CryptoOrder; replayed: boolean; storedFingerprint: string | null }
    | { refused: CryptoOrderRefusal }
  > {
    const accountId = order.account_id;
    if (accountId === null) {
      return this.insertWithIdempotencyKey(order, scopedIdempotencyKey, bodyFingerprint);
    }
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${openOrderLockKey(accountId)}))`);
      const storedForKey = async (): Promise<Row | undefined> =>
        (
          await tx
            .select()
            .from(cryptoOrders)
            .where(eq(cryptoOrders.idempotencyKey, scopedIdempotencyKey))
            .limit(1)
        )[0];
      const replay = (
        row: Row,
      ): { order: CryptoOrder; replayed: true; storedFingerprint: string | null } => ({
        order: rowToEnvelope(row),
        replayed: true,
        storedFingerprint: row.idempotencyBodyFingerprint,
      });
      const stored = await storedForKey();
      if (stored !== undefined) return replay(stored);
      const refusal = await refusalUnder(tx, accountId, limits);
      if (refusal !== null) return { refused: refusal };
      const [inserted] = await tx
        .insert(cryptoOrders)
        .values({
          ...orderRowValues(order),
          idempotencyKey: scopedIdempotencyKey,
          idempotencyBodyFingerprint: bodyFingerprint,
        })
        // The partial unique index needs the same predicate on the arbiter (C6,
        // see insertWithIdempotencyKey).
        .onConflictDoNothing({
          target: cryptoOrders.idempotencyKey,
          where: sql`${cryptoOrders.idempotencyKey} IS NOT NULL`,
        })
        .returning();
      if (inserted !== undefined) {
        return { order: rowToEnvelope(inserted), replayed: false, storedFingerprint: null };
      }
      const winner = await storedForKey();
      if (winner !== undefined) return replay(winner);
      throw new Error('crypto order insert conflicted on its idempotency key, and no row holds it');
    });
  }

  /**
   * Security sweep #18 (residual) — claim the right to mint the order's payment (see
   * `CryptoOrdersRepo.claimPaymentMint`). One transaction: the account's advisory lock
   * first (the lock new orders are admitted under, so the mint budget is counted and
   * spent one claim at a time across servers), then the order's row lock, the lock
   * `withOrderLock` takes, so the claim is decided against the same committed row a
   * concurrent bind, cancel or IPN writes. Nothing takes these two locks in the other
   * order. An order's account never changes (V-1649), so reading it before the locks
   * is safe.
   */
  async claimPaymentMint(
    orderId: string,
    terms: PaymentMintClaimTerms,
  ): Promise<PaymentMintClaim | null> {
    return this.database.db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ accountId: cryptoOrders.accountId })
        .from(cryptoOrders)
        .where(eq(cryptoOrders.orderId, orderId))
        .limit(1);
      if (owner === undefined) return null;
      const accountId = owner.accountId;
      if (accountId !== null) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${openOrderLockKey(accountId)}))`,
        );
      }
      const [row] = await tx
        .select()
        .from(cryptoOrders)
        .where(eq(cryptoOrders.orderId, orderId))
        .for('update')
        .limit(1);
      if (row === undefined) return null;
      const order = rowToEnvelope(row);
      if (order.payment_id !== null) return { kind: 'bound', order };
      if (order.status !== 'pending') return { kind: 'not_pending', order };
      if (
        row.paymentMintClaimedAt !== null &&
        row.paymentMintClaimedAt.getTime() >= terms.staleBefore
      ) {
        return { kind: 'in_progress', order };
      }
      if (
        accountId !== null &&
        (await mintsSinceUnder(tx, accountId, terms.mintsSince)) >= terms.mintsPerDay
      ) {
        return { kind: 'mint_budget', order };
      }
      await tx
        .update(cryptoOrders)
        .set({
          paymentMintClaimedAt: new Date(terms.now),
          paymentMints: sql`${cryptoOrders.paymentMints} + 1`,
        })
        .where(eq(cryptoOrders.orderId, orderId));
      return { kind: 'claimed', order };
    });
  }
}

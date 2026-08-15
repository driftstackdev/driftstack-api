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

import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { cryptoOrders } from './schema.js';
import type { CryptoOrder, CryptoOrderEvent, CryptoOrdersRepo } from '../services/crypto-orders.js';

type Row = typeof cryptoOrders.$inferSelect;

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
  constructor(private readonly database: Database) {}

  async upsert(order: CryptoOrder): Promise<void> {
    const values = {
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
    await this.database.db
      .insert(cryptoOrders)
      .values(values)
      .onConflictDoUpdate({
        target: cryptoOrders.orderId,
        set: {
          accountId: values.accountId,
          paymentId: values.paymentId,
          payAmount: values.payAmount,
          payCurrency: values.payCurrency,
          status: values.status,
          customerNote: values.customerNote,
          internalNote: values.internalNote,
          events: values.events,
          updatedAt: values.updatedAt,
        },
      });
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
      // and every idempotent crypto checkout 500s. (Fable audit-2 2026-07-08,
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
    fn: (locked: CryptoOrder) => { updated: CryptoOrder | null; result: T },
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
      const { updated, result } = fn(locked);
      if (updated !== null) {
        await tx
          .update(cryptoOrders)
          .set({
            accountId: updated.account_id,
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
}

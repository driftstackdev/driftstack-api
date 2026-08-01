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

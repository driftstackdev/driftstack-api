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

import { and, desc, eq, sql } from 'drizzle-orm';
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
}

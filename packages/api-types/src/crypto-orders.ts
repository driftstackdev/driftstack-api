// Crypto-orders flow schemas (V-666).
//
// Customer-facing endpoints under /v1/billing/crypto-*:
//   - POST   /v1/billing/crypto-checkout          (mint a new order)
//   - GET    /v1/billing/crypto-orders            (list caller's orders)
//   - GET    /v1/billing/crypto-orders/:id        (one order envelope)
//   - PATCH  /v1/billing/crypto-orders/:id        (update customer_note)
//   - POST   /v1/billing/crypto-orders/:id/cancel (abandon a pending order)
//
// Crypto payments are non-refundable. Cancellation halts a pending
// order's pay window but does NOT refund a settled payment.

import { z } from 'zod';
import { PURCHASABLE_TIERS } from './common.js';

// ───────────────────────────────────────────────────────────────────────────
// Status + events
// ───────────────────────────────────────────────────────────────────────────

export const CryptoOrderStatusSchema = z.enum([
  'pending',
  'confirming',
  'paid',
  'failed',
  'partial',
  'cancelled',
]);
export type CryptoOrderStatus = z.infer<typeof CryptoOrderStatusSchema>;

// V-666.AU — customer-facing event source. 'swept' is mapped to
// 'expired' server-side before serialization so the customer-facing
// surface only sees four sources.
export const CryptoOrderEventSourceSchema = z.enum(['create', 'ipn', 'cancel', 'expired']);
export type CryptoOrderEventSource = z.infer<typeof CryptoOrderEventSourceSchema>;

export const CryptoOrderEventSchema = z.object({
  status: CryptoOrderStatusSchema,
  at: z.string().describe('ISO-8601 UTC timestamp of the transition.'),
  source: CryptoOrderEventSourceSchema,
});
export type CryptoOrderEvent = z.infer<typeof CryptoOrderEventSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Checkout
// ───────────────────────────────────────────────────────────────────────────

export const CreateCryptoCheckoutRequestSchema = z.object({
  /**
   * Target tier. Must be a self-serve paid tier (not 'free' or 'enterprise') —
   * the same set as `CreateCheckoutSessionRequestSchema.tier` in ./billing.ts,
   * which is the Stripe sibling of this endpoint.
   *
   * V-924: this was `z.string()` with the constraint stated only in prose, so
   * the published OpenAPI schema advertised no valid-value list at all while the
   * route enforced `z.enum(SUPPORTED_PRODUCTS)`. The prose also named only the
   * free tier as excluded, though enterprise is rejected too — a customer
   * reading the spec could reasonably send it and get an unpredicted 400.
   *
   * Spelled as an enum rather than a refine for the reason recorded on
   * PURCHASABLE_TIERS: a refine does not survive into JSON Schema, so it would
   * have published all eight tiers including the two that 400.
   */
  product: z
    .enum(PURCHASABLE_TIERS, {
      message: 'product must be a self-serve paid tier (free and enterprise excluded)',
    })
    .describe(
      'SKU; one of the self-serve paid tier ids (free and enterprise are not purchasable).',
    ),
  price_cents: z.number().int().positive().max(1_000_000),
  price_currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'price_currency must be a 3-letter uppercase ISO code'),
});
export type CreateCryptoCheckoutRequest = z.infer<typeof CreateCryptoCheckoutRequestSchema>;

export const CreateCryptoCheckoutResponseSchema = z.object({
  order_id: z.string(),
  product: z.string(),
  price_cents: z.number().int(),
  price_currency: z.string(),
  status: CryptoOrderStatusSchema,
  /** Payment rail used for this checkout; `stub` is the support-assisted fallback. */
  provider: z.enum(['stub', 'nowpayments']),
  payment_address: z.string().nullable(),
  pay_currency: z.string().nullable(),
  /**
   * The crypto amount to send, denominated in `pay_currency`. Null
   * for the support-assisted `stub` fallback or when upstream omits it.
   * Returned by POST /v1/billing/crypto-checkout (billing-crypto.ts)
   * and documented in /docs/api/billing-crypto.
   */
  pay_amount: z.number().nullable(),
  created_at: z.string(),
});
export type CreateCryptoCheckoutResponse = z.infer<typeof CreateCryptoCheckoutResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Order envelope (list + single GET)
// ───────────────────────────────────────────────────────────────────────────

export const CryptoOrderEnvelopeSchema = z.object({
  order_id: z.string(),
  product: z.string(),
  price_cents: z.number().int(),
  price_currency: z.string(),
  payment_id: z.string().nullable(),
  status: CryptoOrderStatusSchema,
  customer_note: z.string().nullable(),
  /** V-666.AU — append-only state-transition timeline. */
  events: z.array(CryptoOrderEventSchema),
  /** V-666.AV — informational pay-window deadline. Null on non-pending. */
  expires_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CryptoOrderEnvelope = z.infer<typeof CryptoOrderEnvelopeSchema>;

export const ListCryptoOrdersResponseSchema = z.object({
  orders: z.array(CryptoOrderEnvelopeSchema),
  /**
   * V-666.BU — forward cursor; null when there is no further page.
   * Pass back as `?cursor=` on the next request. Treat as opaque.
   */
  next_cursor: z.string().nullable().optional(),
});
export type ListCryptoOrdersResponse = z.infer<typeof ListCryptoOrdersResponseSchema>;

// V-666.BR — typed query schema for GET /v1/billing/crypto-orders.
// Customer dashboards + SDK consumers can reuse this instead of
// re-declaring the status union inline.
export const ListCryptoOrdersQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  status: CryptoOrderStatusSchema.optional(),
  /**
   * V-666.BU — forward cursor from a prior page's next_cursor.
   *
   * V-1473 — `.max(512)` added for the slice-149 convention. This schema is
   * offered for dashboards and SDKs to reuse and currently has no consumer at
   * all, so nothing was unbounded in practice; a published schema that omits the
   * cap is how the next consumer inherits one.
   */
  cursor: z.string().min(1).max(512).optional(),
  /** V-666.BX — half-open window on created_at; ISO 8601 strings. */
  created_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
});
export type ListCryptoOrdersQuery = z.infer<typeof ListCryptoOrdersQuerySchema>;

// ───────────────────────────────────────────────────────────────────────────
// Customer-note update
// ───────────────────────────────────────────────────────────────────────────

export const UpdateCryptoOrderNoteRequestSchema = z.object({
  customer_note: z.string().max(500).nullable(),
});
export type UpdateCryptoOrderNoteRequest = z.infer<typeof UpdateCryptoOrderNoteRequestSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Cancellation
// ───────────────────────────────────────────────────────────────────────────

export const CancelCryptoOrderResponseSchema = CryptoOrderEnvelopeSchema;
export type CancelCryptoOrderResponse = z.infer<typeof CancelCryptoOrderResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Quote
// ───────────────────────────────────────────────────────────────────────────

export const CryptoQuoteRequestSchema = z.object({
  product: z.string(),
  price_currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/)
    .optional(),
});
export type CryptoQuoteRequest = z.infer<typeof CryptoQuoteRequestSchema>;

export const CryptoQuoteResponseSchema = z.object({
  product: z.string(),
  price_cents: z.number().int().positive(),
  price_currency: z.string(),
});
export type CryptoQuoteResponse = z.infer<typeof CryptoQuoteResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Receipts (V-666.AZ — JSON, text, PDF variants)
// ───────────────────────────────────────────────────────────────────────────

export const CryptoOrderReceiptSchema = z.object({
  order_id: z.string(),
  issued_at: z.string(),
  status: CryptoOrderStatusSchema,
  product: z.string(),
  price_cents: z.number().int(),
  price_currency: z.string(),
  payment_id: z.string().nullable(),
  paid_at: z.string().nullable(),
  created_at: z.string(),
});
export type CryptoOrderReceipt = z.infer<typeof CryptoOrderReceiptSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Admin surface (V-666.AY — exposed in OpenAPI for ops integrators)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Admin envelope adds `account_id` + `internal_note` on top of the
 * customer envelope. Same wire shape as the customer one minus
 * those two fields.
 */
export const AdminCryptoOrderEnvelopeSchema = CryptoOrderEnvelopeSchema.extend({
  /** Owning account; null for pre-signup checkouts. */
  account_id: z.string().nullable(),
  /** Admin-only operations note. Never returned on the customer surface. */
  internal_note: z.string().nullable(),
});
export type AdminCryptoOrderEnvelope = z.infer<typeof AdminCryptoOrderEnvelopeSchema>;

export const AdminListCryptoOrdersResponseSchema = z.object({
  orders: z.array(AdminCryptoOrderEnvelopeSchema),
  next_cursor: z.string().nullable(),
});
export type AdminListCryptoOrdersResponse = z.infer<typeof AdminListCryptoOrdersResponseSchema>;

export const AdminCryptoOrderEventsResponseSchema = z.object({
  events: z.array(
    z.object({
      status: CryptoOrderStatusSchema,
      at: z.string(),
      /** Admin source includes the internal 'swept' variant. */
      source: z.enum(['create', 'ipn', 'cancel', 'expired', 'swept']),
    }),
  ),
});
export type AdminCryptoOrderEventsResponse = z.infer<typeof AdminCryptoOrderEventsResponseSchema>;

export const AdminUpdateInternalNoteRequestSchema = z.object({
  internal_note: z.string().max(2000).nullable(),
});
export type AdminUpdateInternalNoteRequest = z.infer<typeof AdminUpdateInternalNoteRequestSchema>;

export const AdminSweepExpiredRequestSchema = z.object({
  older_than_hours: z.number().int().min(1).max(8760).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type AdminSweepExpiredRequest = z.infer<typeof AdminSweepExpiredRequestSchema>;

export const AdminSweepExpiredResponseSchema = z.object({
  expired: z.number().int().nonnegative(),
  capped: z.boolean(),
});
export type AdminSweepExpiredResponse = z.infer<typeof AdminSweepExpiredResponseSchema>;

export const AdminCryptoDailyBreakdownResponseSchema = z.object({
  rows: z.array(
    z.object({
      date: z.string().describe('UTC YYYY-MM-DD.'),
      status: CryptoOrderStatusSchema,
      count: z.number().int().nonnegative(),
    }),
  ),
  truncated: z.boolean(),
});
export type AdminCryptoDailyBreakdownResponse = z.infer<
  typeof AdminCryptoDailyBreakdownResponseSchema
>;

/**
 * GET /v1/admin/crypto-orders/pending-age.
 *
 * This described `{ buckets, total_pending }` with both REQUIRED, and the route
 * has never returned `total_pending` at all — the field is called `total`. The
 * other three the route does send were undocumented, so the contract was wrong
 * in both directions at once: a required field that never arrives, and four
 * that arrive unannounced. Corrected against the handler
 * (`admin-crypto-orders.ts`) and the service's own return type.
 */
export const AdminCryptoPendingAgeResponseSchema = z.object({
  buckets: z.record(z.string(), z.number().int().nonnegative()),
  /** Sum of price_cents across pending orders, keyed by currency. */
  pending_value_cents: z.record(z.string(), z.number().int().nonnegative()),
  /** Sum of the four bucket counts. Named `total`, not `total_pending`. */
  total: z.number().int().nonnegative(),
  /** True when the scan hit its limit before exhausting pending orders. */
  truncated: z.boolean(),
  scanned: z.number().int().nonnegative(),
});
export type AdminCryptoPendingAgeResponse = z.infer<typeof AdminCryptoPendingAgeResponseSchema>;

export const AdminApplyIpnRequestSchema = z.object({
  provider_status: z.string(),
  payment_id: z.string(),
});
export type AdminApplyIpnRequest = z.infer<typeof AdminApplyIpnRequestSchema>;

export const AdminIdempotencyMetricsResponseSchema = z.object({
  replays: z.number().int().nonnegative(),
  first_writes: z.number().int().nonnegative(),
  body_mismatches: z.number().int().nonnegative(),
});
export type AdminIdempotencyMetricsResponse = z.infer<typeof AdminIdempotencyMetricsResponseSchema>;

export const AdminCryptoStatsResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  by_status: z.record(z.string(), z.number().int().nonnegative()),
  paid_revenue_cents: z.record(z.string(), z.number().int().nonnegative()),
  avg_time_to_paid_ms: z.number().int().nullable(),
  paid_sample: z.number().int().nonnegative(),
  paid_revenue_by_product: z.record(
    z.string(),
    z.record(z.string(), z.number().int().nonnegative()),
  ),
  paid_count_by_product: z.record(z.string(), z.number().int().nonnegative()),
  truncated: z.boolean(),
  scanned: z.number().int().nonnegative(),
});
export type AdminCryptoStatsResponse = z.infer<typeof AdminCryptoStatsResponseSchema>;

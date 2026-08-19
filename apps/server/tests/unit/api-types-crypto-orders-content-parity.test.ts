// W436.C — drift guard for packages/api-types/src/crypto-orders.ts.
// V-666 customer-facing crypto-checkout + V-666.AU customer events
// (swept→expired mapping; admin sees swept variant) + V-666.AV pay-
// window expires_at + V-666.AZ receipts + V-666.AY admin surface +
// V-666.BR/BU/BX list query (status + cursor + date window).
// Drift here either widens the customer-facing CryptoOrderEventSource
// enum past 4 values (leaks the internal 'swept' source into customer
// dashboards) or weakens price_currency validation (3-letter uppercase
// ISO required — drift accepts free-form strings that NowPayments
// rejects on settlement).
//
//   • V-666 framing pinned: 5 customer endpoints (checkout + list +
//     get + patch note + cancel); non-refundable; cancel halts pending
//     pay window only.
//   • CryptoOrderStatus enum: 6 values (pending/confirming/paid/failed/
//     partial/cancelled).
//   • V-666.AU CryptoOrderEventSource enum: 4 customer-facing values
//     (swept mapped to expired server-side before serialization).
//   • CreateCryptoCheckoutRequest: product + price_cents int positive
//     max 1M + price_currency 3-letter uppercase ISO regex.
//   • Provider enum: stub|nowpayments + support-assisted fallback
//     framing.
//   • V-666.AV expires_at informational pay-window deadline (null on
//     non-pending).
//   • V-666.BR ListCryptoOrdersQuery + V-666.BU cursor + V-666.BX
//     created_after/before datetime.
//   • V-666.AZ CryptoOrderReceipt (JSON/text/PDF variants).
//   • V-666.AY admin envelope: account_id nullable (pre-signup
//     checkouts) + internal_note (admin-only, never customer); admin
//     event source includes 'swept' internal variant.
//   • Admin sweep expired / daily breakdown / pending age / apply IPN
//     / idempotency metrics / stats endpoints pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W436.C packages/api-types/src/crypto-orders.ts content parity', () => {
  const body = read(LIB);

  it('V-666 framing pinned + 5 customer endpoints listed (POST checkout / GET list / GET one / PATCH note / POST cancel) + non-refundable rationale + cancel halts pending pay window but does NOT refund settled payment', () => {
    expect(body).toMatch(/\/\/ Crypto-orders flow schemas \(V-666\)\./);
    expect(body).toMatch(
      /\/\/ Customer-facing endpoints under \/v1\/billing\/crypto-\*:\s*\n?\s*\/\/\s*- POST\s+\/v1\/billing\/crypto-checkout\s+\(mint a new order\)\s*\n?\s*\/\/\s*- GET\s+\/v1\/billing\/crypto-orders\s+\(list caller's orders\)\s*\n?\s*\/\/\s*- GET\s+\/v1\/billing\/crypto-orders\/:id\s+\(one order envelope\)\s*\n?\s*\/\/\s*- PATCH\s+\/v1\/billing\/crypto-orders\/:id\s+\(update customer_note\)\s*\n?\s*\/\/\s*- POST\s+\/v1\/billing\/crypto-orders\/:id\/cancel \(abandon a pending order\)/,
    );
    expect(body).toMatch(
      /\/\/ Crypto payments are non-refundable\. Cancellation halts a pending\s*\n?\s*\/\/ order's pay window but does NOT refund a settled payment\./,
    );
  });

  it("imports z from 'zod' plus the shared PURCHASABLE_TIERS tuple from ./common.js (V-924 — the product enum is the same set the Stripe checkout accepts, so it is declared once)", () => {
    expect(body).toMatch(/^import \{ z \} from 'zod';/m);
    expect(body).toMatch(/^import \{ PURCHASABLE_TIERS \} from '\.\/common\.js';/m);
  });

  it('CryptoOrderStatus enum: 6 values (pending|confirming|paid|failed|partial|cancelled) in exact order', () => {
    expect(body).toMatch(
      /export const CryptoOrderStatusSchema = z\.enum\(\[\s*\n?\s*'pending',\s*\n?\s*'confirming',\s*\n?\s*'paid',\s*\n?\s*'failed',\s*\n?\s*'partial',\s*\n?\s*'cancelled',\s*\n?\s*\]\);/,
    );
  });

  it('V-666.AU CryptoOrderEventSource framing pinned: swept mapped to expired server-side before serialization; customer-facing surface only sees 4 sources (create|ipn|cancel|expired)', () => {
    expect(body).toMatch(
      /\/\/ V-666\.AU — customer-facing event source\. 'swept' is mapped to\s*\n?\s*\/\/ 'expired' server-side before serialization so the customer-facing\s*\n?\s*\/\/ surface only sees four sources\./,
    );
    expect(body).toMatch(
      /export const CryptoOrderEventSourceSchema = z\.enum\(\['create', 'ipn', 'cancel', 'expired'\]\);/,
    );
    expect(body).toMatch(
      /export const CryptoOrderEventSchema = z\.object\(\{\s*\n?\s*status: CryptoOrderStatusSchema,\s*\n?\s*at: z\.string\(\)\.describe\('ISO-8601 UTC timestamp of the transition\.'\),\s*\n?\s*source: CryptoOrderEventSourceSchema,\s*\n?\s*\}\);/,
    );
  });

  it('CreateCryptoCheckoutRequest: product is the shared PURCHASABLE_TIERS enum (V-924 — free and enterprise excluded, the same set as the Stripe sibling in billing.ts) + price_cents int positive max 1M + price_currency 3-letter uppercase ISO regex /^[A-Z]{3}$/', () => {
    expect(body).toMatch(/export const CreateCryptoCheckoutRequestSchema = z\.object\(\{/);
    expect(body, 'product is constrained to the purchasable-tier enum, not a bare string').toMatch(
      /product: z\s*\n?\s*\.enum\(PURCHASABLE_TIERS, \{\s*\n?\s*message: 'product must be a self-serve paid tier \(free and enterprise excluded\)',\s*\n?\s*\}\)\s*\n?\s*\.describe\(/,
    );
    // A refine would not reach the published spec: JSON Schema cannot express a
    // predicate, so the generated document would list all eight tiers.
    expect(body, 'the predicate form must not be used here either').not.toMatch(
      /product: AccountTierSchema\.refine\(/,
    );
    // Per-occurrence negative. V-924: the published schema typed this field as an
    // unconstrained string while the server enforced an enum, so the OpenAPI
    // document advertised no valid-value list. The describe also named only the
    // free tier as excluded when enterprise is refused too.
    expect(body, 'the unconstrained form must not return').not.toMatch(
      /product: z\.string\(\)\.describe\(/,
    );
    expect(body, 'and it must still name both exclusions').toMatch(
      /free and enterprise are not purchasable/,
    );
    expect(body).toMatch(/price_cents: z\.number\(\)\.int\(\)\.positive\(\)\.max\(1_000_000\),/);
    expect(body).toMatch(
      /price_currency: z\s*\n?\s*\.string\(\)\s*\n?\s*\.length\(3\)\s*\n?\s*\.regex\(\/\^\[A-Z\]\{3\}\$\/, 'price_currency must be a 3-letter uppercase ISO code'\),\s*\n?\s*\}\);/,
    );
  });

  it('CreateCryptoCheckoutResponse: order_id + product + price_cents + price_currency + status + provider stub|nowpayments + payment_address nullable + pay_currency nullable + pay_amount nullable (the crypto amount to send; returned by the route + documented in api/billing-crypto) + created_at; stub is the support-assisted fallback', () => {
    expect(body).toMatch(
      /export const CreateCryptoCheckoutResponseSchema = z\.object\(\{\s*\n?\s*order_id: z\.string\(\),\s*\n?\s*product: z\.string\(\),\s*\n?\s*price_cents: z\.number\(\)\.int\(\),\s*\n?\s*price_currency: z\.string\(\),\s*\n?\s*status: CryptoOrderStatusSchema,\s*\n?\s*\/\*\* Payment rail used for this checkout; `stub` is the support-assisted fallback\. \*\/\s*\n?\s*provider: z\.enum\(\['stub', 'nowpayments'\]\),\s*\n?\s*payment_address: z\.string\(\)\.nullable\(\),\s*\n?\s*pay_currency: z\.string\(\)\.nullable\(\),[\s\S]*?pay_amount: z\.number\(\)\.nullable\(\),\s*\n?\s*created_at: z\.string\(\),\s*\n?\s*\}\);/,
    );
  });

  it('CryptoOrderEnvelope: order_id + product + price_cents + price_currency + payment_id nullable + status + customer_note nullable + V-666.AU events array + V-666.AV informational expires_at (null on non-pending) + created/updated_at', () => {
    expect(body).toMatch(
      /export const CryptoOrderEnvelopeSchema = z\.object\(\{\s*\n?\s*order_id: z\.string\(\),\s*\n?\s*product: z\.string\(\),\s*\n?\s*price_cents: z\.number\(\)\.int\(\),\s*\n?\s*price_currency: z\.string\(\),\s*\n?\s*payment_id: z\.string\(\)\.nullable\(\),\s*\n?\s*status: CryptoOrderStatusSchema,\s*\n?\s*customer_note: z\.string\(\)\.nullable\(\),\s*\n?\s*\/\*\* V-666\.AU — append-only state-transition timeline\. \*\/\s*\n?\s*events: z\.array\(CryptoOrderEventSchema\),\s*\n?\s*\/\*\* V-666\.AV — informational pay-window deadline\. Null on non-pending\. \*\/\s*\n?\s*expires_at: z\.string\(\)\.nullable\(\),\s*\n?\s*created_at: z\.string\(\),\s*\n?\s*updated_at: z\.string\(\),\s*\n?\s*\}\);/,
    );
  });

  it('V-666.BR ListCryptoOrdersQuery + V-666.BU forward cursor (treat as opaque) + V-666.BX created_after/before half-open window ISO 8601; ListCryptoOrdersResponse: orders + next_cursor nullable optional', () => {
    expect(body).toMatch(
      /\/\/ V-666\.BR — typed query schema for GET \/v1\/billing\/crypto-orders\.\s*\n?\s*\/\/ Customer dashboards \+ SDK consumers can reuse this instead of\s*\n?\s*\/\/ re-declaring the status union inline\./,
    );
    expect(body).toMatch(
      /export const ListCryptoOrdersQuerySchema = z\.object\(\{\s*\n?\s*limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.optional\(\),\s*\n?\s*status: CryptoOrderStatusSchema\.optional\(\),\s*\n?\s*\/\*\* V-666\.BU — forward cursor from a prior page's next_cursor\. \*\/\s*\n?\s*cursor: z\.string\(\)\.min\(1\)\.optional\(\),\s*\n?\s*\/\*\* V-666\.BX — half-open window on created_at; ISO 8601 strings\. \*\/\s*\n?\s*created_after: z\.string\(\)\.datetime\(\)\.optional\(\),\s*\n?\s*created_before: z\.string\(\)\.datetime\(\)\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /\*\s*V-666\.BU — forward cursor; null when there is no further page\.\s*\n?\s*\*\s*Pass back as `\?cursor=` on the next request\. Treat as opaque\./,
    );
    expect(body).toMatch(
      /export const ListCryptoOrdersResponseSchema = z\.object\(\{\s*\n?\s*orders: z\.array\(CryptoOrderEnvelopeSchema\),/,
    );
    expect(body).toMatch(/next_cursor: z\.string\(\)\.nullable\(\)\.optional\(\),/);
  });

  it('UpdateCryptoOrderNote: customer_note max 500 nullable; CancelCryptoOrderResponse = CryptoOrderEnvelopeSchema alias', () => {
    expect(body).toMatch(
      /export const UpdateCryptoOrderNoteRequestSchema = z\.object\(\{\s*\n?\s*customer_note: z\.string\(\)\.max\(500\)\.nullable\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const CancelCryptoOrderResponseSchema = CryptoOrderEnvelopeSchema;/,
    );
  });

  it('CryptoQuoteRequest (product + optional 3-letter uppercase price_currency) + exact pricing-only response', () => {
    expect(body).toMatch(
      /export const CryptoQuoteRequestSchema = z\.object\(\{\s*\n?\s*product: z\.string\(\),\s*\n?\s*price_currency: z\s*\n?\s*\.string\(\)\s*\n?\s*\.length\(3\)\s*\n?\s*\.regex\(\/\^\[A-Z\]\{3\}\$\/\)\s*\n?\s*\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const CryptoQuoteResponseSchema = z\.object\(\{\s*\n?\s*product: z\.string\(\),\s*\n?\s*price_cents: z\.number\(\)\.int\(\)\.positive\(\),\s*\n?\s*price_currency: z\.string\(\),\s*\n?\s*\}\);/,
    );
    expect(body).not.toMatch(/CryptoQuoteResponseSchema[\s\S]{0,300}pay_min_amount/);
  });

  it('V-666.AZ CryptoOrderReceipt framing + shape (order_id + issued_at + status + product + price + payment_id nullable + paid_at nullable + created_at) — JSON/text/PDF variants', () => {
    expect(body).toMatch(/\/\/ Receipts \(V-666\.AZ — JSON, text, PDF variants\)/);
    expect(body).toMatch(
      /export const CryptoOrderReceiptSchema = z\.object\(\{\s*\n?\s*order_id: z\.string\(\),\s*\n?\s*issued_at: z\.string\(\),\s*\n?\s*status: CryptoOrderStatusSchema,\s*\n?\s*product: z\.string\(\),\s*\n?\s*price_cents: z\.number\(\)\.int\(\),\s*\n?\s*price_currency: z\.string\(\),\s*\n?\s*payment_id: z\.string\(\)\.nullable\(\),\s*\n?\s*paid_at: z\.string\(\)\.nullable\(\),\s*\n?\s*created_at: z\.string\(\),\s*\n?\s*\}\);/,
    );
  });

  it('V-666.AY AdminCryptoOrderEnvelope framing pinned: extends customer envelope with account_id nullable (pre-signup checkouts) + internal_note (admin-only, never returned on customer surface)', () => {
    expect(body).toMatch(
      /\/\/ Admin surface \(V-666\.AY — exposed in OpenAPI for ops integrators\)/,
    );
    expect(body).toMatch(
      /\*\s*Admin envelope adds `account_id` \+ `internal_note` on top of the\s*\n?\s*\*\s*customer envelope\. Same wire shape as the customer one minus\s*\n?\s*\*\s*those two fields\./,
    );
    expect(body).toMatch(
      /export const AdminCryptoOrderEnvelopeSchema = CryptoOrderEnvelopeSchema\.extend\(\{\s*\n?\s*\/\*\* Owning account; null for pre-signup checkouts\. \*\/\s*\n?\s*account_id: z\.string\(\)\.nullable\(\),\s*\n?\s*\/\*\* Admin-only operations note\. Never returned on the customer surface\. \*\/\s*\n?\s*internal_note: z\.string\(\)\.nullable\(\),\s*\n?\s*\}\);/,
    );
  });

  it('AdminListCryptoOrdersResponse: orders[] + next_cursor nullable; AdminCryptoOrderEventsResponse: events with 5-value internal source including "swept" variant', () => {
    expect(body).toMatch(
      /export const AdminListCryptoOrdersResponseSchema = z\.object\(\{\s*\n?\s*orders: z\.array\(AdminCryptoOrderEnvelopeSchema\),\s*\n?\s*next_cursor: z\.string\(\)\.nullable\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const AdminCryptoOrderEventsResponseSchema = z\.object\(\{\s*\n?\s*events: z\.array\(\s*\n?\s*z\.object\(\{\s*\n?\s*status: CryptoOrderStatusSchema,\s*\n?\s*at: z\.string\(\),\s*\n?\s*\/\*\* Admin source includes the internal 'swept' variant\. \*\/\s*\n?\s*source: z\.enum\(\['create', 'ipn', 'cancel', 'expired', 'swept'\]\),\s*\n?\s*\}\),\s*\n?\s*\),\s*\n?\s*\}\);/,
    );
  });

  it('AdminUpdateInternalNote (max 2000 nullable) + AdminSweepExpired (older_than_hours int 1..8760 optional + limit int 1..500 optional) → response (expired count + capped bool)', () => {
    expect(body).toMatch(
      /export const AdminUpdateInternalNoteRequestSchema = z\.object\(\{\s*\n?\s*internal_note: z\.string\(\)\.max\(2000\)\.nullable\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const AdminSweepExpiredRequestSchema = z\.object\(\{\s*\n?\s*older_than_hours: z\.number\(\)\.int\(\)\.min\(1\)\.max\(8760\)\.optional\(\),\s*\n?\s*limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const AdminSweepExpiredResponseSchema = z\.object\(\{\s*\n?\s*expired: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*capped: z\.boolean\(\),\s*\n?\s*\}\);/,
    );
  });

  it('Admin daily breakdown (rows: UTC YYYY-MM-DD date + status + count; truncated) + pending age (buckets + pending_value_cents + total + truncated + scanned; NOT total_pending, which the route never returned) + apply IPN (provider_status + payment_id) + idempotency metrics (replays + first_writes + body_mismatches) + stats (total + by_status + revenue + avg/sample + by_product + truncated + scanned)', () => {
    expect(body).toMatch(
      /export const AdminCryptoDailyBreakdownResponseSchema = z\.object\(\{\s*\n?\s*rows: z\.array\(\s*\n?\s*z\.object\(\{\s*\n?\s*date: z\.string\(\)\.describe\('UTC YYYY-MM-DD\.'\),\s*\n?\s*status: CryptoOrderStatusSchema,\s*\n?\s*count: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*\}\),\s*\n?\s*\),\s*\n?\s*truncated: z\.boolean\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const AdminCryptoPendingAgeResponseSchema = z\.object\(\{\s*\n?\s*buckets: z\.record\(z\.string\(\), z\.number\(\)\.int\(\)\.nonnegative\(\)\),[\s\S]*?pending_value_cents: z\.record\([\s\S]*?total: z\.number\(\)\.int\(\)\.nonnegative\(\),[\s\S]*?truncated: z\.boolean\(\),[\s\S]*?scanned: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const AdminApplyIpnRequestSchema = z\.object\(\{\s*\n?\s*provider_status: z\.string\(\),\s*\n?\s*payment_id: z\.string\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const AdminIdempotencyMetricsResponseSchema = z\.object\(\{\s*\n?\s*replays: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*first_writes: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*body_mismatches: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const AdminCryptoStatsResponseSchema = z\.object\(\{\s*\n?\s*total: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*by_status: z\.record\(z\.string\(\), z\.number\(\)\.int\(\)\.nonnegative\(\)\),\s*\n?\s*paid_revenue_cents: z\.record\(z\.string\(\), z\.number\(\)\.int\(\)\.nonnegative\(\)\),\s*\n?\s*avg_time_to_paid_ms: z\.number\(\)\.int\(\)\.nullable\(\),\s*\n?\s*paid_sample: z\.number\(\)\.int\(\)\.nonnegative\(\),/,
    );
    expect(body).toMatch(
      /truncated: z\.boolean\(\),\s*\n?\s*scanned: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

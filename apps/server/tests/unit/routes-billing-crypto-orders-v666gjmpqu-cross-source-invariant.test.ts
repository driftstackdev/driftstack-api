// W1041 — routes/billing-crypto-orders V-666.G/J/M/P/Q/U cross-source
// invariant. Pins the apps/server/src/routes/billing-crypto-orders.ts
// customer-facing crypto-orders routes:
//
//   V-666.G anchor — 'V-666.G — customer-facing crypto-orders routes'.
//
//   Endpoint roster comments — 7 endpoints listed in the header (list /
//   get / patch / cancel / receipt / receipt.txt / receipt.pdf).
//
//   Cross-account 404 framing — 'All routes are scoped to the calling
//   account. Cross-account id lookups return 404 (not 403) — we don't
//   leak the existence of orders that belong to other accounts'.
//
//   V-666.AV PAY_WINDOW_MS = 60 * 60 * 1000 (1 hour) + expires_at
//   computation only for pending orders.
//
//   V-666.AU customer events filter — 'swept' source remapped to
//   'expired' (admin-only internal lifecycle event).
//
//   V-666.AW no-store + private cache header on list + single GET.
//
//   V-666.BR status filter enum — pending / confirming / paid / failed
//   / partial / cancelled (6 entries).
//
//   V-666.BU cursor pagination + next_cursor envelope.
//
//   V-666.BX created_after (inclusive) + created_before (exclusive)
//   half-open date-range filter.
//
//   V-666.BZ before<=after rejection with explicit 400 message.
//
//   V-666.J cancel — pending only; confirming/partial/paid/failed →
//   409 with "Crypto payments are non-refundable" hint.
//
//   V-666.Q update customer_note — z.string().max(500).nullable().
//
//   V-666.M JSON receipt + V-666.P plain-text receipt + V-666.U PDF
//   receipt with content-disposition attachment + receipt-${id}.pdf
//   filename.
//
// stays in lockstep across apps/server/src/routes/billing-crypto-orders.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
}

describe('W1041 routes/billing-crypto-orders V-666.G/J/M/P/Q/U cross-source invariant', () => {
  // ─── V-666.G header anchor + 7-endpoint roster ───────────────

  it("CRITICAL V-666.G anchor — 'V-666.G — customer-facing crypto-orders routes'. The single-anchor design ties the route file back to its NowPayments-rail parent V-666.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.G — customer-facing crypto-orders routes\./);
  });

  it('CRITICAL endpoint roster — 7 endpoints in the header (list / get / patch / cancel / receipt / receipt.txt / receipt.pdf). The exhaustive header comment is the canonical contract for the customer-facing crypto-orders surface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/GET\s+\/v1\/billing\/crypto-orders\s+— list caller's own orders/);
    expect(p).toMatch(/GET\s+\/v1\/billing\/crypto-orders\/:id\s+— single order lookup/);
    expect(p).toMatch(
      /PATCH \/v1\/billing\/crypto-orders\/:id\s+— update customer_note \(V-666\.Q\)/,
    );
    expect(p).toMatch(
      /POST\s+\/v1\/billing\/crypto-orders\/:id\/cancel\s+— abandon a pending order \(V-666\.J\)/,
    );
    expect(p).toMatch(
      /GET\s+\/v1\/billing\/crypto-orders\/:id\/receipt\s+— normalized receipt JSON \(V-666\.M\)/,
    );
    expect(p).toMatch(/receipt\.txt\s+— same receipt as text\/plain \(V-666\.P\)/);
    expect(p).toMatch(/receipt\.pdf\s+— same receipt as application\/pdf \(V-666\.U\)/);
  });

  it("CRITICAL cross-account 404 framing — 'All routes are scoped to the calling account. Cross-account id lookups return 404 (not 403) — we don't leak the existence of orders that belong to other accounts'. The 404-not-403 anti-enumeration posture matches the rest of the customer-facing surface.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/All routes are scoped to the calling account\. Cross-account/);
    expect(p).toMatch(/id lookups return 404 \(not 403\) — we don't leak the existence of/);
    expect(p).toMatch(/orders that belong to other accounts\./);
  });

  // ─── V-666.AV pay-window + expires_at ────────────────────────

  it('CRITICAL V-666.AV PAY_WINDOW_MS = 60 * 60 * 1000 (1 hour). The 1-hour pay window is the customer-facing countdown anchor; drift would change the UI hint.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.AV — customer-facing pay-window hint\. Pending orders carry/);
    expect(p).toMatch(/const PAY_WINDOW_MS = 60 \* 60 \* 1000;/);
  });

  it("CRITICAL expires_at — pending → created_at + PAY_WINDOW_MS ISO; non-pending → null. The pending-only design matches the customer-facing countdown semantics ('only show the timer while the order can still be paid').", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(
      /order\.status === 'pending' \? new Date\(order\.created_at \+ PAY_WINDOW_MS\)\.toISOString\(\) : null/,
    );
  });

  // ─── V-666.AU swept → expired remap ──────────────────────────

  it("CRITICAL V-666.AU 'swept' → 'expired' remap on customer event timeline. The remap hides the admin-internal lifecycle event from the customer view.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.AU — customer-facing event timeline\./);
    expect(p).toMatch(/source: e\.source === 'swept' \? 'expired' : e\.source,/);
  });

  // ─── V-666.AW no-store private cache ─────────────────────────

  it("CRITICAL V-666.AW cache-control: no-store + private on list + single GET. The 'state flips mid-checkout' rationale rules out any shared-cache layer that could serve stale state.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.AW — order state changes constantly between mints \+ IPNs;/);
    expect(p).toMatch(/reply\.header\('cache-control', 'no-store, private'\);/);
  });

  // ─── V-666.BR status-filter enum ─────────────────────────────

  it('CRITICAL V-666.BR status filter — 6-value enum (pending / confirming / paid / failed / partial / cancelled). The exhaustive enum mirrors the admin endpoint so customer + admin filtering share semantics.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(
      /status: z\.enum\(\['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled'\]\)\.optional\(\),/,
    );
  });

  // ─── V-666.BU cursor pagination ──────────────────────────────

  it("CRITICAL V-666.BU cursor pagination + next_cursor envelope. The 'consumers loop until they get null' contract is the canonical paging API across the customer + admin order list.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.BU — cursor for forward pagination\./);
    expect(p).toMatch(/Opaque base64url/);
    expect(p).toMatch(/cursor: z\.string\(\)\.min\(1\)\.optional\(\),/);
    expect(p).toMatch(/next_cursor: page\.nextCursor,/);
  });

  // ─── V-666.BX/BZ date-range filter ───────────────────────────

  it('CRITICAL V-666.BX created_after (inclusive) + created_before (exclusive) half-open range. The half-open convention matches the rest of the audit-log family.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.BX — half-open date-range filter on created_at\. Both/);
    expect(p).toMatch(/bounds accept ISO 8601 timestamps\. created_after is inclusive,/);
    expect(p).toMatch(/created_before is exclusive\./);
    expect(p).toMatch(/created_after: z\.string\(\)\.datetime\(\)\.optional\(\),/);
    expect(p).toMatch(/created_before: z\.string\(\)\.datetime\(\)\.optional\(\),/);
  });

  it("CRITICAL V-666.BZ before<=after rejection — explicit 400 with 'created_before must be strictly greater than created_after.'. The early reject prevents the silent-empty-result bug from masking common typos.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.BZ — reject obviously-wrong windows \(before <= after\)\./);
    expect(p).toMatch(
      /BadRequestError\('created_before must be strictly greater than created_after\.'\)/,
    );
  });

  // ─── V-666.Q update customer_note ────────────────────────────

  it('CRITICAL V-666.Q update customer_note — z.string().max(500).nullable(). The 500-char cap is the customer-facing PO-number / internal-label slot; drift would change the data-model surface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.Q — update the customer's free-text note on an order/);
    expect(p).toMatch(/customer_note: z\.string\(\)\.max\(500\)\.nullable\(\),/);
  });

  // ─── V-666.J cancel ──────────────────────────────────────────

  it("CRITICAL V-666.J cancel — pending only; confirming/partial/paid/failed → 409 with explicit 'Crypto payments are non-refundable; contact support' hint. The 409-with-hint design routes uncancellable states to support rather than silently erroring.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.J — cancel a pending order\. Customer-facing self-service/);
    expect(p).toMatch(/abandonment\. Once any payment activity exists/);
    expect(p).toMatch(/can no longer be cancelled\. Crypto payments are non-refundable;/);
    expect(p).toMatch(/contact support if you need to discuss reconciliation\./);
    expect(p).toMatch(/throw new ConflictError\(/);
  });

  // ─── V-666.M / V-666.P / V-666.U receipt variants ────────────

  it('CRITICAL V-666.M JSON receipt — returns service.getReceipt(...) as JSON, 404 on cross-account or missing. The 3-variant receipt family (JSON / txt / pdf) shares the same access predicate.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.M — return a normalized receipt payload for an order the/);
    expect(p).toMatch(/'\/v1\/billing\/crypto-orders\/:order_id\/receipt',/);
  });

  it("CRITICAL V-666.P plain-text receipt — 'Driftstack receipt' header line + 6 mandatory lines + paid_at/payment_id conditional + 'Created' line + final newline + text/plain; charset=utf-8 content-type. The exact line order is the canonical wget-pipe contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.P — plain-text rendering of the same receipt\. Useful for/);
    expect(p).toMatch(/'Driftstack receipt',/);
    expect(p).toMatch(/`Order: \$\{receipt\.order_id\}`/);
    expect(p).toMatch(/`Issued: \$\{receipt\.issued_at\}`/);
    expect(p).toMatch(/`Status: \$\{receipt\.status\}`/);
    expect(p).toMatch(/`Product: \$\{receipt\.product\}`/);
    expect(p).toMatch(
      /`Amount: \$\{\(receipt\.price_cents \/ 100\)\.toFixed\(2\)\} \$\{receipt\.price_currency\}`/,
    );
    expect(p).toMatch(/`Paid at: \$\{receipt\.paid_at\}`/);
    expect(p).toMatch(/`Payment id: \$\{receipt\.payment_id\}`/);
    expect(p).toMatch(/reply\.type\('text\/plain; charset=utf-8'\)/);
  });

  it('CRITICAL V-666.U PDF receipt — buildReceiptPdfBytes(receipt) + application/pdf content-type + Content-Disposition: attachment; filename="receipt-${order_id}.pdf". The download-with-meaningful-filename contract is what the customer-dashboard \'Download PDF\' button relies on.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.U — PDF rendering of the receipt for archiving \/ emailing\./);
    expect(p).toMatch(/const bytes = buildReceiptPdfBytes\(receipt\);/);
    expect(p).toMatch(/\.type\('application\/pdf'\)/);
    expect(p).toMatch(
      /'content-disposition', `attachment; filename="receipt-\$\{receipt\.order_id\}\.pdf"`/,
    );
  });

  // ─── parseOrThrow helper ─────────────────────────────────────

  it('CRITICAL parseOrThrow throws BadRequestError with result.error.message. The single helper is the boundary translator from zod-error to RFC7807 400.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts'));
    expect(p).toMatch(/function parseOrThrow<T>\(schema: z\.ZodSchema<T>, input: unknown\): T \{/);
    expect(p).toMatch(/throw new BadRequestError\(result\.error\.message\)/);
  });
});

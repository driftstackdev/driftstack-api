// W593.B (W633-deepened) — drift guard for packages/sdk-go/crypto_orders.go.
// V-666 customer-facing crypto-checkout resource (243 lines, 8 verbs).
//
// W633 splits the original 3 it() blocks (file-exists + types-bundle +
// verbs-bundle) into 11 focused per-verb / per-concept blocks + pins
// previously-implicit invariants:
//
//   • V-666 customer-facing-only / non-refundable framing — explicit
//     contract that crypto payments are terminal once minted.
//   • Untyped-pending-OpenAPI map[string]any aliases — placeholder
//     shape until V-666 codegen lands.
//   • Idempotency-Key 24h window invariant — duplicate key returns
//     the ORIGINAL envelope, never a fresh order.
//   • ListCryptoOrdersOptions query() builder semantics — nil short-
//     circuit + per-field conditional setting + empty-bag-returns-nil
//     (so the runtime URL has no spurious "?" prefix).
//   • Half-open created_after/created_before window (inclusive after,
//     exclusive before) + inverted-window 400 rejection.
//   • Iterate cursor-handoff invariant — opts.Cursor MUST NOT be set
//     by callers; the iterator manages cursors internally via a
//     defensive copy.
//   • Cancel 409-once-past-pending + 404-on-foreign-account/missing.
//   • Receipt JSON-only — PDF/.txt variants live on a different REST
//     surface, not exposed via this SDK.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/crypto_orders.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W593.B packages/sdk-go/crypto_orders.go content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + CryptoOrdersResource binds /v1/billing/crypto-* + customer-facing-only + non-refundable framing pinned (crypto payments are terminal once minted; admin endpoints stay on the REST surface, not surfaced here)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/\/\/ CryptoOrdersResource handles \/v1\/billing\/crypto-\* endpoints\./);
    expect(body).toMatch(
      /\/\/ Customer-facing only; admin endpoints aren't exposed here \(use the/,
    );
    expect(body).toMatch(/\/\/ REST surface directly\)\. Crypto payments are non-refundable\./);
    expect(body).toMatch(/^type CryptoOrdersResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('7 forward-compatible map[string]any type aliases pinned (CryptoQuoteRequest + CryptoQuoteResponse + CreateCryptoCheckoutRequest + CryptoOrderEnvelope + CryptoOrderReceipt + CancelCryptoOrderResponse + UpdateCryptoOrderNoteRequest). Drift to a concrete struct would lock in a shape that the server can still evolve.', () => {
    expect(body).toMatch(/^type CryptoQuoteRequest = map\[string\]any$/m);
    expect(body).toMatch(/^type CryptoQuoteResponse = map\[string\]any$/m);
    expect(body).toMatch(/^type CreateCryptoCheckoutRequest = map\[string\]any$/m);
    expect(body).toMatch(/^type CryptoOrderEnvelope = map\[string\]any$/m);
    expect(body).toMatch(/^type CryptoOrderReceipt = map\[string\]any$/m);
    expect(body).toMatch(/^type CancelCryptoOrderResponse = map\[string\]any$/m);
    expect(body).toMatch(/^type UpdateCryptoOrderNoteRequest = map\[string\]any$/m);
    expect(body).toMatch(/The map preserves forward compatibility as quote fields evolve\./);
    expect(body).toMatch(/Read documented fields by key and tolerate additional response fields\./);
    expect(body).not.toMatch(/Untyped pending|codegen|\bV-\d+\b|\bW\d+\b/);
  });

  it("ListCryptoOrdersResponse — envelope shape {orders, next_cursor?} with NextCursor *string nullable + omitempty json tag. Pinned struct shape so a regen can't silently drop next_cursor (would break customers paginating with the cursor-walking Iterate variant).", () => {
    expect(body).toMatch(/\/\/ ListCryptoOrdersResponse is the envelope returned by/);
    // gofmt 1.19+ doc-comment formatting converts ``code`` → typographic
    // “code“ quotes; pin the canonical form rather than the pre-1.19
    // double-backtick variant so re-gofmt passes don't trip the parity.
    expect(body).toMatch(/\/\/ \[CryptoOrdersResource\.List\]: “\{ orders, next_cursor\? \}“\./);
    expect(body).toMatch(
      /^type ListCryptoOrdersResponse struct \{\s*\n\s*Orders\s+\[\]CryptoOrderEnvelope `json:"orders"`\s*\n\s*NextCursor \*string\s+`json:"next_cursor,omitempty"`\s*\n\}/m,
    );
  });

  it('ListCryptoOrdersOptions 5-field narrow + per-field server-side semantics: Limit *int clamps to 1..=100 default 50 + Status *string single-status filter (unknown values 400) + Cursor *string (nil for first page) + CreatedAfter/Before half-open RFC3339 window (inclusive after, exclusive before, inverted 400). All fields are *T pointers so nil means "omit" — drift to plain T would force callers to send zero-value sentinels.', () => {
    expect(body).toMatch(
      /\/\/ ListCryptoOrdersOptions narrows the \[CryptoOrdersResource\.List\] call\./,
    );
    expect(body).toMatch(/\/\/ Nil-valued fields are omitted; the server returns newest-first\./);
    expect(body).toMatch(/\/\/ Limit clamps server-side to 1\.\.=100; default is 50\./);
    expect(body).toMatch(/Limit \*int/);
    expect(body).toMatch(/\/\/ Status filters to a single envelope status\. Unknown values 400\./);
    expect(body).toMatch(/Status \*string/);
    expect(body).toMatch(
      /\/\/ Cursor is the previous page's NextCursor\. Pass nil for the first page\./,
    );
    expect(body).toMatch(/Cursor \*string/);
    expect(body).toMatch(/\/\/ CreatedAfter \/ CreatedBefore are RFC3339 timestamps\. Half-open/);
    expect(body).toMatch(/\/\/ window: inclusive after, exclusive before\. Inverted windows 400\./);
    expect(body).toMatch(/CreatedAfter\s+\*string/);
    expect(body).toMatch(/CreatedBefore \*string/);
  });

  it('query() builder — nil-options short-circuit returns nil + per-field conditional setting + empty-bag-also-returns-nil. Returning nil (not an empty url.Values{}) ensures the underlying request builder emits no spurious "?" prefix when no filters are set.', () => {
    expect(body).toMatch(
      /func \(o \*ListCryptoOrdersOptions\) query\(\) url\.Values \{\s*\n\s*if o == nil \{\s*\n\s*return nil\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /if o\.Limit != nil \{\s*\n\s*q\.Set\("limit", strconv\.Itoa\(\*o\.Limit\)\)/,
    );
    expect(body).toMatch(/if o\.Status != nil \{\s*\n\s*q\.Set\("status", \*o\.Status\)/);
    expect(body).toMatch(/if o\.Cursor != nil \{\s*\n\s*q\.Set\("cursor", \*o\.Cursor\)/);
    expect(body).toMatch(/q\.Set\("created_after", \*o\.CreatedAfter\)/);
    expect(body).toMatch(/q\.Set\("created_before", \*o\.CreatedBefore\)/);
    // Empty bag also short-circuits to nil (no spurious "?" prefix).
    expect(body).toMatch(/if len\(q\) == 0 \{\s*\n\s*return nil\s*\n\s*\}/);
  });

  it('Quote — V-666.H POST /v1/billing/crypto-checkout/quote previews the authoritative fiat price without minting an order.', () => {
    expect(body).toMatch(/\/\/ Quote previews the authoritative fiat price without minting an/);
    expect(body).toMatch(/\/\/ order\. Requires read:billing/);
    expect(body).toMatch(
      /func \(r \*CryptoOrdersResource\) Quote\(ctx context\.Context, body CryptoQuoteRequest\) \(CryptoQuoteResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/billing\/crypto-checkout\/quote",/);
  });

  it('CreateCheckoutOptions + CreateCheckout — V-666.C POST /v1/billing/crypto-checkout mints a new crypto order. V-666.AO Idempotency-Key invariant: "On a duplicate key within the 24h window the server returns the original order envelope, never a second one." The SDK forwards the key via req.headers map ONLY when opts.IdempotencyKey is non-nil — drift to always-setting would force every retry to carry a header, breaking the "pair with an IdempotencyKey so retries don\'t mint duplicates" customer ergonomic.', () => {
    expect(body).toMatch(
      /\/\/ CreateCheckoutOptions tunes \[CryptoOrdersResource\.CreateCheckout\]\./,
    );
    expect(body).toMatch(/\/\/ IdempotencyKey is forwarded as the Idempotency-Key header\./);
    expect(body).toMatch(/\/\/ On a duplicate key within the 24h window the server/);
    expect(body).toMatch(/\/\/ returns the original order envelope, never a second one\./);
    expect(body).toMatch(
      /^type CreateCheckoutOptions struct \{\s*\n[\s\S]*?IdempotencyKey \*string\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ CreateCheckout mints a new crypto order\. Pair with an/);
    expect(body).toMatch(/\/\/ IdempotencyKey so retries don't mint duplicates\./);
    expect(body).toMatch(
      /func \(r \*CryptoOrdersResource\) CreateCheckout\(\s*\n\s*ctx context\.Context,\s*\n\s*body CreateCryptoCheckoutRequest,\s*\n\s*opts \*CreateCheckoutOptions,\s*\n\) \(CryptoOrderEnvelope, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/billing\/crypto-checkout",/);
    // Conditional header-set — only when opts is non-nil AND IdempotencyKey is non-nil.
    expect(body).toMatch(
      /if opts != nil && opts\.IdempotencyKey != nil \{\s*\n\s*req\.headers = map\[string\]string\{"Idempotency-Key": \*opts\.IdempotencyKey\}\s*\n\s*\}/,
    );
  });

  it('List — V-666.G/.BR/.BU/.BX GET /v1/billing/crypto-orders newest-first + accepts nil opts for defaults + passes opts.query() to the request builder (which handles the nil-short-circuit + empty-bag-nil ergonomics)', () => {
    expect(body).toMatch(/\/\/ List lists the caller account's crypto orders newest-first/);
    expect(body).toMatch(/and accepts nil opts for defaults\./);
    expect(body).toMatch(
      /func \(r \*CryptoOrdersResource\) List\(ctx context\.Context, opts \*ListCryptoOrdersOptions\) \(\*ListCryptoOrdersResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "GET",\s*\n\s*path:\s+"\/v1\/billing\/crypto-orders",\s*\n\s*query:\s+opts\.query\(\),/,
    );
  });

  it('Iterate — V-666.BU cursor-walking variant. CRITICAL invariant: "do NOT set opts.Cursor when calling Iterate; cursor handoff is managed internally." The implementation makes a DEFENSIVE COPY of opts and clears Cursor (page.Cursor = nil) so a caller-passed cursor doesn\'t pollute the first-page request. visit-returns-false stops early without fetching further pages. nil-NextCursor terminates the outer loop.', () => {
    expect(body).toMatch(
      /\/\/ Iterate is the cursor-walking variant of \[CryptoOrdersResource\.List\]/,
    );
    expect(body).toMatch(/The visit callback is invoked once per order; return/);
    expect(body).toMatch(/\/\/ false from visit to stop iteration early \(no further pages are/);
    expect(body).toMatch(/\/\/ fetched\)\. Cursor handoff is managed internally; do NOT set/);
    expect(body).toMatch(/\/\/ opts\.Cursor when calling Iterate\./);
    expect(body).toMatch(
      /func \(r \*CryptoOrdersResource\) Iterate\(\s*\n\s*ctx context\.Context,\s*\n\s*opts \*ListCryptoOrdersOptions,\s*\n\s*visit func\(CryptoOrderEnvelope\) bool,\s*\n\) error/,
    );
    // Defensive copy + Cursor cleared so caller-set cursor doesn't leak.
    expect(body).toMatch(
      /\/\/ Defensive copy so we can mutate Cursor between pages without\s*\n\s*\/\/ surprising the caller's options struct\.\s*\n\s*var page ListCryptoOrdersOptions\s*\n\s*if opts != nil \{\s*\n\s*page = \*opts\s*\n\s*page\.Cursor = nil\s*\n\s*\}/,
    );
    // visit-returns-false stops early; termination + non-advance guard go
    // through the shared advanceCursor helper (matches the audit-log / profiles
    // / profile-snapshots iterators: empty NextCursor → done, repeated → error).
    expect(body).toMatch(
      /for _, o := range resp\.Orders \{\s*\n\s*if !visit\(o\) \{\s*\n\s*return nil\s*\n\s*\}\s*\n\s*\}/,
    );
    expect(body).toMatch(/next, done, err := advanceCursor\(current, resp\.NextCursor\)/);
  });

  it('Get — V-666.G GET /v1/billing/crypto-orders/{id} reads a single order envelope. URL-escapes the orderID so a malformed id cannot inject path traversal.', () => {
    expect(body).toMatch(/\/\/ Get reads a single order envelope\./);
    expect(body).toMatch(
      /func \(r \*CryptoOrdersResource\) Get\(ctx context\.Context, orderID string\) \(CryptoOrderEnvelope, error\)/,
    );
    expect(body).toMatch(
      /method: "GET",\s*\n\s*path:\s+"\/v1\/billing\/crypto-orders\/" \+ url\.PathEscape\(orderID\),/,
    );
  });

  it('UpdateNote — V-666.Q PATCH /v1/billing/crypto-orders/{id} updates the customer-facing free-text note. PATCH semantics (partial update; the note is the only mutable field on a minted order — drift to PUT would invite full-envelope rewrites).', () => {
    expect(body).toMatch(/\/\/ UpdateNote updates the customer-facing free-text note on an order/);
    expect(body).toMatch(
      /\/\/ UpdateNote updates the customer-facing free-text note on an order\./,
    );
    expect(body).toMatch(
      /func \(r \*CryptoOrdersResource\) UpdateNote\(\s*\n\s*ctx context\.Context,\s*\n\s*orderID string,\s*\n\s*body UpdateCryptoOrderNoteRequest,\s*\n\) \(CryptoOrderEnvelope, error\)/,
    );
    expect(body).toMatch(
      /method: "PATCH",\s*\n\s*path:\s+"\/v1\/billing\/crypto-orders\/" \+ url\.PathEscape\(orderID\),/,
    );
  });

  it('Cancel — V-666.J POST /v1/billing/crypto-orders/{id}/cancel + status-code error contract pinned: 409 once past pending + 404 on foreign-account/missing. The 409 prevents customers from cancelling an order the chain has already accepted; the 404 collapses "not yours" with "not real" into the same response so we don\'t leak the existence of other accounts\' order ids.', () => {
    expect(body).toMatch(
      /\/\/ Cancel abandons a pending order\. The server returns 409 once the order has/,
    );
    expect(body).toMatch(/\/\/ moved past pending; 404 if it doesn't exist or belongs to another/);
    expect(body).toMatch(/\/\/ account\./);
    expect(body).toMatch(
      /func \(r \*CryptoOrdersResource\) Cancel\(ctx context\.Context, orderID string\) \(CancelCryptoOrderResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/billing\/crypto-orders\/" \+ url\.PathEscape\(orderID\) \+ "\/cancel",/,
    );
  });

  it('Receipt — V-666.M GET /v1/billing/crypto-orders/{id}/receipt returns the JSON receipt only. "For PDF / .txt variants, hit the corresponding REST endpoint directly" — pinned so customers know this SDK verb is JSON-only and PDF/.txt aren\'t silently dropped from the surface.', () => {
    expect(body).toMatch(/\/\/ Receipt fetches the JSON receipt for an order\. For PDF \//);
    expect(body).toMatch(/\/\/ \.txt variants, hit the corresponding REST endpoint directly\./);
    expect(body).toMatch(
      /func \(r \*CryptoOrdersResource\) Receipt\(ctx context\.Context, orderID string\) \(CryptoOrderReceipt, error\)/,
    );
    expect(body).toMatch(
      /method: "GET",\s*\n\s*path:\s+"\/v1\/billing\/crypto-orders\/" \+ url\.PathEscape\(orderID\) \+ "\/receipt",/,
    );
  });
});

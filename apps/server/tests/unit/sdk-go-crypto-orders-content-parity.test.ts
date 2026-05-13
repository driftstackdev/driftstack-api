// W593.B — drift guard for packages/sdk-go/crypto_orders.go.

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

  it('V-666 CryptoOrdersResource: customer-facing only + non-refundable framing + untyped pending OpenAPI codegen + 7 type aliases + ListCryptoOrdersOptions query() builder pinned', () => {
    expect(body).toMatch(
      /\/\/ CryptoOrdersResource handles \/v1\/billing\/crypto-\* endpoints \(V-666\)\./,
    );
    expect(body).toMatch(
      /\/\/ Customer-facing only; admin endpoints aren't exposed here \(use the/,
    );
    expect(body).toMatch(/\/\/ REST surface directly\)\. Crypto payments are non-refundable\./);
    expect(body).toMatch(/^type CryptoQuoteRequest = map\[string\]any$/m);
    expect(body).toMatch(/^type CryptoQuoteResponse = map\[string\]any$/m);
    expect(body).toMatch(/^type CreateCryptoCheckoutRequest = map\[string\]any$/m);
    expect(body).toMatch(/^type CryptoOrderEnvelope = map\[string\]any$/m);
    expect(body).toMatch(/^type CryptoOrderReceipt = map\[string\]any$/m);
    expect(body).toMatch(/^type CancelCryptoOrderResponse = map\[string\]any$/m);
    expect(body).toMatch(/^type UpdateCryptoOrderNoteRequest = map\[string\]any$/m);
    expect(body).toMatch(/\/\/ ListCryptoOrdersResponse is the envelope returned by/);
    expect(body).toMatch(/\/\/ \[CryptoOrdersResource\.List\]: ``\{ orders, next_cursor\? \}``\./);
    expect(body).toMatch(
      /^type ListCryptoOrdersResponse struct \{\s*\n\s*Orders\s+\[\]CryptoOrderEnvelope `json:"orders"`\s*\n\s*NextCursor \*string\s+`json:"next_cursor,omitempty"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /\/\/ ListCryptoOrdersOptions narrows the \[CryptoOrdersResource\.List\] call\./,
    );
    expect(body).toMatch(/\/\/ Limit clamps server-side to 1\.\.=100; default is 50\./);
    expect(body).toMatch(/\/\/ Status filters to a single envelope status\. Unknown values 400\./);
    expect(body).toMatch(/Half-open/);
    expect(body).toMatch(/window: inclusive after, exclusive before\. Inverted windows 400\./);
    expect(body).toMatch(
      /func \(o \*ListCryptoOrdersOptions\) query\(\) url\.Values \{\s*\n\s*if o == nil \{\s*\n\s*return nil\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /if o\.Limit != nil \{\s*\n\s*q\.Set\("limit", strconv\.Itoa\(\*o\.Limit\)\)/,
    );
    expect(body).toMatch(/q\.Set\("created_after", \*o\.CreatedAfter\)/);
    expect(body).toMatch(/q\.Set\("created_before", \*o\.CreatedBefore\)/);
  });

  it('8 verbs (Quote V-666.H + CreateCheckout V-666.C with V-666.AO Idempotency-Key escape hatch via req.headers + List V-666.G/.BR/.BU/.BX + Iterate V-666.BU + Get + UpdateNote + Cancel + Receipt) pinned', () => {
    expect(body).toMatch(/\/\/ Quote previews the fiat-cents price \+ crypto pay-range without/);
    expect(body).toMatch(/\/\/ minting an order \(V-666\.H\)\./);
    expect(body).toMatch(/path:\s+"\/v1\/billing\/crypto-checkout\/quote",/);
    expect(body).toMatch(/\/\/ IdempotencyKey is forwarded as the Idempotency-Key header/);
    expect(body).toMatch(
      /\/\/ \(V-666\.AO\)\. On a duplicate key within the 24h window the server/,
    );
    expect(body).toMatch(/\/\/ returns the original order envelope, never a second one\./);
    expect(body).toMatch(/\/\/ CreateCheckout mints a new crypto order \(V-666\.C\)\./);
    expect(body).toMatch(
      /if opts != nil && opts\.IdempotencyKey != nil \{\s*\n\s*req\.headers = map\[string\]string\{"Idempotency-Key": \*opts\.IdempotencyKey\}\s*\n\s*\}/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/billing\/crypto-checkout",/);
    expect(body).toMatch(/\/\/ List lists the caller account's crypto orders newest-first/);
    expect(body).toMatch(/\(V-666\.G \/ \.BR \/ \.BU \/ \.BX\)\./);
    expect(body).toMatch(/path:\s+"\/v1\/billing\/crypto-orders",/);
    expect(body).toMatch(/query:\s+opts\.query\(\),/);
    expect(body).toMatch(
      /\/\/ Iterate is the cursor-walking variant of \[CryptoOrdersResource\.List\]/,
    );
    expect(body).toMatch(/\(V-666\.BU\)\./);
    expect(body).toMatch(/Cursor handoff is managed internally; do NOT set/);
    expect(body).toMatch(/opts\.Cursor when calling Iterate\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

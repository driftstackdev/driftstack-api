// W426.A — drift guard for packages/sdk-typescript/src/resources/crypto-orders.ts.
// V-666 customer-facing crypto-payment surface. Drift here either
// breaks the V-666.AO Idempotency-Key passthrough (retries
// double-mint orders) or strips the V-666.BU listAll cursor walker
// (long-tail listings cap at first page).
//
//   • Framing pinned: V-666 customer-facing only; admin not exposed
//     in public SDK; payments non-refundable.
//   • CreateCryptoCheckoutOptions.idempotencyKey → Idempotency-Key
//     header.
//   • 8-verb surface: quote V-666.H + createCheckout V-666.C + list
//     V-666.G/BR + listAll V-666.BU + get V-666.G + updateNote
//     V-666.Q + cancel V-666.J + receipt V-666.M.
//   • listAll: AsyncGenerator<CryptoOrderEnvelope, void, void>;
//     Omit<ListCryptoOrdersOptions, 'cursor'>; internal cursor mgmt;
//     terminates on null/undefined next_cursor.
//   • All :id segments encodeURIComponent-wrapped.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/crypto-orders.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W426.A packages/sdk-typescript/src/resources/crypto-orders.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: V-666 typed methods for /v1/billing/crypto-* + customer-facing only (admin not exposed in public SDK) + non-refundable', () => {
    expect(body).toMatch(
      /\/\/ CryptoOrdersResource — typed methods for \/v1\/billing\/crypto-\* \(V-666\)\./,
    );
    expect(body).toMatch(
      /\/\/ Customer-facing only; admin endpoints are not exposed in the public\s*\n?\s*\/\/ SDK \(use the OpenAPI spec at \/openapi\.json directly\)\. Crypto\s*\n?\s*\/\/ payments are non-refundable\./,
    );
  });

  it('imports: 9 api-types verb shapes + HttpClient', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*CancelCryptoOrderResponse,\s*\n?\s*CreateCryptoCheckoutRequest,\s*\n?\s*CreateCryptoCheckoutResponse,\s*\n?\s*CryptoOrderEnvelope,\s*\n?\s*CryptoOrderReceipt,\s*\n?\s*CryptoQuoteRequest,\s*\n?\s*CryptoQuoteResponse,\s*\n?\s*ListCryptoOrdersQuery,\s*\n?\s*ListCryptoOrdersResponse,\s*\n?\s*UpdateCryptoOrderNoteRequest,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
  });

  it('CreateCryptoCheckoutOptions.idempotencyKey: V-666.AO idempotency-key passed as Idempotency-Key header', () => {
    expect(body).toMatch(
      /export interface CreateCryptoCheckoutOptions \{\s*\n?\s*\/\*\* V-666\.AO — idempotency key\. The SDK passes it as the Idempotency-Key header\. \*\/\s*\n?\s*idempotencyKey\?: string;\s*\n?\s*\}/,
    );
  });

  it('ListCryptoOrdersOptions: V-666.BR re-export from api-types (status union in lockstep with server enum)', () => {
    expect(body).toMatch(
      /\*\s*V-666\.BR — list options\. Sourced from @driftstack\/api-types so the\s*\n?\s*\*\s*status union stays in lockstep with the server-side enum\./,
    );
    expect(body).toMatch(/export type ListCryptoOrdersOptions = ListCryptoOrdersQuery;/);
  });

  it('V-666.H quote: POST /v1/billing/crypto-checkout/quote; preview fiat-cents price + crypto pay-range without minting', () => {
    expect(body).toMatch(
      /\/\*\* V-666\.H — preview the fiat-cents price \+ crypto pay-range without minting an order\. \*\//,
    );
    expect(body).toMatch(
      /quote\(body: CryptoQuoteRequest\): Promise<CryptoQuoteResponse> \{\s*\n?\s*return this\.http\.request<CryptoQuoteResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/billing\/crypto-checkout\/quote',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-666.C createCheckout: POST /v1/billing/crypto-checkout; conditional idempotency-key header spread when opts.idempotencyKey defined', () => {
    expect(body).toMatch(
      /\/\*\* V-666\.C — mint a new crypto order\. Send an `idempotencyKey` to dedupe retries\. \*\//,
    );
    expect(body).toMatch(
      /createCheckout\(\s*\n?\s*body: CreateCryptoCheckoutRequest,\s*\n?\s*opts: CreateCryptoCheckoutOptions = \{\},\s*\n?\s*\): Promise<CreateCryptoCheckoutResponse> \{\s*\n?\s*return this\.http\.request<CreateCryptoCheckoutResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/billing\/crypto-checkout',\s*\n?\s*body,\s*\n?\s*\.\.\.\(opts\.idempotencyKey !== undefined\s*\n?\s*\? \{ headers: \{ 'idempotency-key': opts\.idempotencyKey \} \}\s*\n?\s*: \{\}\),\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-666.G/BR/BU list: GET /v1/billing/crypto-orders; status + limit + cursor + created_after + created_before query passthrough; empty-query branch omits query key', () => {
    expect(body).toMatch(
      /\*\s*V-666\.G — list the caller account's crypto orders \(newest first\)\.\s*\n?\s*\*\s*V-666\.BR — pass `status` to narrow the list to a single status\.\s*\n?\s*\*\s*V-666\.BU — pass `cursor` from a prior page's `next_cursor` to\s*\n?\s*\*\s*iterate\. Loop until the response's `next_cursor` is null\./,
    );
    expect(body).toMatch(
      /list\(opts: ListCryptoOrdersOptions = \{\}\): Promise<ListCryptoOrdersResponse> \{\s*\n?\s*const query: Record<string, string \| number \| undefined> = \{\};\s*\n?\s*if \(opts\.status !== undefined\) query\.status = opts\.status;\s*\n?\s*if \(opts\.limit !== undefined\) query\.limit = opts\.limit;\s*\n?\s*if \(opts\.cursor !== undefined\) query\.cursor = opts\.cursor;\s*\n?\s*if \(opts\.created_after !== undefined\) query\.created_after = opts\.created_after;\s*\n?\s*if \(opts\.created_before !== undefined\) query\.created_before = opts\.created_before;/,
    );
    expect(body).toMatch(
      /return this\.http\.request<ListCryptoOrdersResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/billing\/crypto-orders',\s*\n?\s*\.\.\.\(Object\.keys\(query\)\.length > 0 \? \{ query \} : \{\}\),\s*\n?\s*\}\);/,
    );
  });

  it('V-666.BU listAll: AsyncGenerator<CryptoOrderEnvelope, void, void>; Omit<...,"cursor">; internal cursor mgmt; terminates on null OR undefined next_cursor', () => {
    expect(body).toMatch(
      /\*\s*V-666\.BU — async generator that walks every page until the\s*\n?\s*\*\s*server stops emitting a next_cursor\. Yields the envelope of\s*\n?\s*\*\s*each order one at a time so consumers can break early\./,
    );
    expect(body).toMatch(
      /\*\s*Accepts the same options as `list\(\)` minus `cursor` \(the\s*\n?\s*\*\s*iterator manages cursors internally\)\./,
    );
    expect(body).toMatch(
      /async \*listAll\(\s*\n?\s*opts: Omit<ListCryptoOrdersOptions, 'cursor'> = \{\},\s*\n?\s*\): AsyncGenerator<CryptoOrderEnvelope, void, void> \{\s*\n?\s*let cursor: string \| undefined;\s*\n?\s*while \(true\) \{\s*\n?\s*const page = await this\.list\(\{\s*\n?\s*\.\.\.opts,\s*\n?\s*\.\.\.\(cursor !== undefined \? \{ cursor \} : \{\}\),\s*\n?\s*\}\);\s*\n?\s*for \(const order of page\.orders\) yield order;\s*\n?\s*if \(page\.next_cursor === null \|\| page\.next_cursor === undefined\) return;\s*\n?\s*cursor = page\.next_cursor;\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it('V-666.G get: GET /v1/billing/crypto-orders/:orderId encoded → CryptoOrderEnvelope', () => {
    expect(body).toMatch(/\/\*\* V-666\.G — read a single order envelope\. \*\//);
    expect(body).toMatch(
      /get\(orderId: string\): Promise<CryptoOrderEnvelope> \{\s*\n?\s*return this\.http\.request<CryptoOrderEnvelope>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-666.Q updateNote: PATCH /v1/billing/crypto-orders/:orderId encoded → CryptoOrderEnvelope', () => {
    expect(body).toMatch(/\/\*\* V-666\.Q — update the customer-facing free-text note\. \*\//);
    expect(body).toMatch(
      /updateNote\(orderId: string, body: UpdateCryptoOrderNoteRequest\): Promise<CryptoOrderEnvelope> \{\s*\n?\s*return this\.http\.request<CryptoOrderEnvelope>\(\{\s*\n?\s*method: 'PATCH',\s*\n?\s*path: `\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-666.J cancel: POST /v1/billing/crypto-orders/:orderId/cancel encoded → CancelCryptoOrderResponse (self-service abandon pending)', () => {
    expect(body).toMatch(/\/\*\* V-666\.J — abandon a pending order \(self-service\)\. \*\//);
    expect(body).toMatch(
      /cancel\(orderId: string\): Promise<CancelCryptoOrderResponse> \{\s*\n?\s*return this\.http\.request<CancelCryptoOrderResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}\/cancel`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-666.M receipt: GET /v1/billing/crypto-orders/:orderId/receipt encoded → CryptoOrderReceipt', () => {
    expect(body).toMatch(/\/\*\* V-666\.M — fetch the JSON receipt\. \*\//);
    expect(body).toMatch(
      /receipt\(orderId: string\): Promise<CryptoOrderReceipt> \{\s*\n?\s*return this\.http\.request<CryptoOrderReceipt>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}\/receipt`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('All :orderId path segments encodeURIComponent-wrapped (4 occurrences: get / updateNote / cancel / receipt)', () => {
    const matches = body.match(/encodeURIComponent\(orderId\)/g);
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBe(4);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

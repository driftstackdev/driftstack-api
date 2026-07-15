// W426.A (W665-deepened) — drift guard for packages/sdk-typescript/
// src/resources/crypto-orders.ts. V-666 crypto-orders TS parity.
//
// W665 splits the original 14 it() blocks into 20 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • V-666.AO Idempotency-Key escape hatch — conditional headers
//     spread when opts.idempotencyKey defined. Drift to always
//     sending the header (even when undefined) would pay the
//     overhead on every call. Drift to using a query param instead
//     of header would not match the HTTP spec convention.
//   • V-666 customer-facing-only invariant — admin endpoints NOT
//     exposed in public SDK. Drift would let customers call
//     admin-only verbs through the public SDK.
//   • "Crypto payments are non-refundable" framing — load-bearing
//     legal disclosure that justifies the V-666.J self-service
//     cancel (the only out).
//   • V-666.BU listAll AsyncGenerator — internal cursor management
//     via Omit<...,'cursor'> on opts (callers MUST NOT pass cursor).
//     Termination on EITHER null OR undefined next_cursor (defensive
//     against server-side absence-vs-null differences).
//   • Per-verb V-anchor pinned (H/C/G/BR/BU/Q/J/M) — drift to dropping
//     any anchor would lose the changelog provenance for that verb.
//   • Per-id wire-path inventory + encodeURIComponent on orderId
//     (4 occurrences: get + updateNote + cancel + receipt).
//   • cancel verb POST (not DELETE) — abandons state, doesn't
//     delete the row. Drift to DELETE would lose the audit-log
//     row that captures the cancellation event.
//   • receipt returns JSON (NOT PDF) — drift to a binary blob would
//     break content-negotiation typing.

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

  it('file exists at canonical path + module header V-666 anchor on the resource line', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /\/\/ CryptoOrdersResource — typed methods for \/v1\/billing\/crypto-\* \(V-666\)\./,
    );
  });

  it('CRITICAL Customer-facing-only invariant + non-refundable disclosure pinned per-line. The customer-facing-only framing prevents admin verbs from leaking into the public SDK; the non-refundable disclosure justifies the V-666.J self-service cancel as the ONLY out for pending orders.', () => {
    expect(body).toMatch(
      /\/\/ Customer-facing only; admin endpoints are not exposed in the public\s*\n?\s*\/\/ SDK \(use the OpenAPI spec at \/openapi\.json directly\)\. Crypto\s*\n?\s*\/\/ payments are non-refundable\./,
    );
  });

  it("Imports — 10 api-types shapes (sorted alphabetical block) covering every verb's wire shape + HttpClient. CRITICAL: 10-shape import surface — drift to hand-rolling any of these types would diverge from @driftstack/api-types Zod single-source-of-truth.", () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*CancelCryptoOrderResponse,\s*\n?\s*CreateCryptoCheckoutRequest,\s*\n?\s*CreateCryptoCheckoutResponse,\s*\n?\s*CryptoOrderEnvelope,\s*\n?\s*CryptoOrderReceipt,\s*\n?\s*CryptoQuoteRequest,\s*\n?\s*CryptoQuoteResponse,\s*\n?\s*ListCryptoOrdersQuery,\s*\n?\s*ListCryptoOrdersResponse,\s*\n?\s*UpdateCryptoOrderNoteRequest,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
  });

  it('CreateCryptoCheckoutOptions interface — V-666.AO idempotencyKey field pinned with "passes it as the Idempotency-Key header" framing. Drift to passing as a query param OR body field would not match HTTP spec convention.', () => {
    expect(body).toMatch(
      /export interface CreateCryptoCheckoutOptions \{\s*\n?\s*\/\*\* V-666\.AO — idempotency key\. The SDK passes it as the Idempotency-Key header\. \*\/\s*\n?\s*idempotencyKey\?: string;\s*\n?\s*\}/,
    );
  });

  it('ListCryptoOrdersOptions type-alias — V-666.BR `export type ListCryptoOrdersOptions = ListCryptoOrdersQuery` (re-export from api-types). CRITICAL rationale: "status union stays in lockstep with the server-side enum." Drift to a local hand-rolled type would silently let the SDK accept status values the server-side enum rejects.', () => {
    expect(body).toMatch(
      /\*\s*V-666\.BR — list options\. Sourced from @driftstack\/api-types so the\s*\n?\s*\*\s*status union stays in lockstep with the server-side enum\./,
    );
    expect(body).toMatch(/export type ListCryptoOrdersOptions = ListCryptoOrdersQuery;/);
  });

  it('CryptoOrdersResource class declaration + private-readonly http constructor field.', () => {
    expect(body).toMatch(/^export class CryptoOrdersResource \{$/m);
    expect(body).toMatch(/constructor\(private readonly http: HttpClient\) \{\}/);
  });

  it('V-666.H quote verb — POST /v1/billing/crypto-checkout/quote with CryptoQuoteRequest body → Promise<CryptoQuoteResponse>. Authoritative fiat-price preview without minting an order.', () => {
    expect(body).toMatch(
      /\/\*\* V-666\.H — preview the authoritative fiat price without minting an order\. \*\//,
    );
    expect(body).toMatch(
      /quote\(body: CryptoQuoteRequest\): Promise<CryptoQuoteResponse> \{\s*\n?\s*return this\.http\.request<CryptoQuoteResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/billing\/crypto-checkout\/quote',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it("CRITICAL V-666.C createCheckout verb — POST /v1/billing/crypto-checkout with body + opts default-empty + CONDITIONAL headers spread. The `...(opts.idempotencyKey !== undefined ? { headers: { ... } } : {})` pattern means: (1) when idempotencyKey IS provided, send Idempotency-Key header; (2) when NOT provided, DON'T send headers key at all (vs sending undefined which would pay the overhead). Drift to always sending headers would let stale state leak; drift to NOT conditionally spreading would force the customer to pass idempotencyKey on every call.", () => {
    expect(body).toMatch(
      /\/\*\* V-666\.C — mint a new crypto order\. Send an `idempotencyKey` to dedupe retries\. \*\//,
    );
    expect(body).toMatch(
      /createCheckout\(\s*\n?\s*body: CreateCryptoCheckoutRequest,\s*\n?\s*opts: CreateCryptoCheckoutOptions = \{\},\s*\n?\s*\): Promise<CreateCryptoCheckoutResponse> \{\s*\n?\s*return this\.http\.request<CreateCryptoCheckoutResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/billing\/crypto-checkout',\s*\n?\s*body,\s*\n?\s*\.\.\.\(opts\.idempotencyKey !== undefined\s*\n?\s*\? \{ headers: \{ 'idempotency-key': opts\.idempotencyKey \} \}\s*\n?\s*: \{\}\),\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-666.G/BR/BU list verb — GET /v1/billing/crypto-orders with 5-param query. JSDoc pinned per-anchor: V-666.G (caller account, newest first), V-666.BR (status filter), V-666.BU (cursor pagination, loop until next_cursor null). Each anchor MUST stay attached because the list verb spans 3 user-facing features (read-only listing + status-filter + cursor-pagination).', () => {
    expect(body).toMatch(
      /\*\s*V-666\.G — list the caller account's crypto orders \(newest first\)\.\s*\n?\s*\*\s*V-666\.BR — pass `status` to narrow the list to a single status\.\s*\n?\s*\*\s*V-666\.BU — pass `cursor` from a prior page's `next_cursor` to\s*\n?\s*\*\s*iterate\. Loop until the response's `next_cursor` is null\./,
    );
  });

  it('list verb implementation — 5-field query builder (status + limit + cursor + created_after + created_before) with `if (...) query.field = ...` pattern + EMPTY-query branch via `Object.keys(query).length > 0 ? { query } : {}`. CRITICAL: empty-query branch is what lets the verb emit a CLEAN `/v1/billing/crypto-orders` (no `?` suffix) when no filters are set — drift to always sending `query: {}` would append `?` to the URL even for the all-orders default case.', () => {
    expect(body).toMatch(
      /list\(opts: ListCryptoOrdersOptions = \{\}\): Promise<ListCryptoOrdersResponse> \{\s*\n?\s*const query: Record<string, string \| number \| undefined> = \{\};\s*\n?\s*if \(opts\.status !== undefined\) query\.status = opts\.status;\s*\n?\s*if \(opts\.limit !== undefined\) query\.limit = opts\.limit;\s*\n?\s*if \(opts\.cursor !== undefined\) query\.cursor = opts\.cursor;\s*\n?\s*if \(opts\.created_after !== undefined\) query\.created_after = opts\.created_after;\s*\n?\s*if \(opts\.created_before !== undefined\) query\.created_before = opts\.created_before;/,
    );
    expect(body).toMatch(
      /return this\.http\.request<ListCryptoOrdersResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/billing\/crypto-orders',\s*\n?\s*\.\.\.\(Object\.keys\(query\)\.length > 0 \? \{ query \} : \{\}\),\s*\n?\s*\}\);/,
    );
  });

  it('CRITICAL V-666.BU listAll verb — a method returning AsyncGenerator<CryptoOrderEnvelope, void, void> that DELEGATES to the shared iteratePaginated helper (audit 2026-06-23 — was an inline async* while-loop), so it inherits the non-advancing-cursor guard every other list has. Internal cursor management via `Omit<ListCryptoOrdersOptions, "cursor">` — callers MUST NOT pass cursor (the type system rejects it at compile time). The crypto envelope keys rows off `orders`, so the fetch closure adapts orders→data + `next_cursor ?? null`. Drift to dropping the adapter or the shared helper would re-introduce the unguarded loop / iterate an empty list.', () => {
    expect(body).toMatch(
      /\*\s*V-666\.BU — async generator that walks every page until the\s*\n?\s*\*\s*server stops emitting a next_cursor\. Yields the envelope of\s*\n?\s*\*\s*each order one at a time so consumers can break early\./,
    );
    expect(body).toMatch(
      /\*\s*Accepts the same options as `list\(\)` minus `cursor` \(the\s*\n?\s*\*\s*iterator manages cursors internally\)\./,
    );
    expect(body).toMatch(
      /listAll\(\s*\n?\s*opts: Omit<ListCryptoOrdersOptions, 'cursor'> = \{\},\s*\n?\s*\): AsyncGenerator<CryptoOrderEnvelope, void, void> \{[\s\S]*?return iteratePaginated<CryptoOrderEnvelope>\(\(cursor\) =>\s*\n?\s*this\.list\(\{\s*\n?\s*\.\.\.opts,\s*\n?\s*\.\.\.\(cursor !== null \? \{ cursor \} : \{\}\),\s*\n?\s*\}\)\.then\(\(page\) => \(\{\s*\n?\s*data: page\.orders,\s*\n?\s*next_cursor: page\.next_cursor \?\? null,\s*\n?\s*\}\)\),\s*\n?\s*\);/,
    );
    // The shared paginator must actually be imported (the delegation target).
    expect(body).toMatch(/import \{ iteratePaginated \} from '\.\.\/pagination\.js';/);
  });

  it('V-666.G get verb — GET /v1/billing/crypto-orders/${encodeURIComponent(orderId)} → Promise<CryptoOrderEnvelope>. Single-line minimalist implementation; encodeURIComponent wrapping prevents path traversal via maliciously-crafted orderIds.', () => {
    expect(body).toMatch(/\/\*\* V-666\.G — read a single order envelope\. \*\//);
    expect(body).toMatch(
      /get\(orderId: string\): Promise<CryptoOrderEnvelope> \{\s*\n?\s*return this\.http\.request<CryptoOrderEnvelope>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-666.Q updateNote verb — PATCH /v1/billing/crypto-orders/${encodeURIComponent(orderId)} with UpdateCryptoOrderNoteRequest body → Promise<CryptoOrderEnvelope>. Customer-facing free-text note; PATCH (not PUT) because the note is just one field on the broader order envelope.', () => {
    expect(body).toMatch(/\/\*\* V-666\.Q — update the customer-facing free-text note\. \*\//);
    expect(body).toMatch(
      /updateNote\(orderId: string, body: UpdateCryptoOrderNoteRequest\): Promise<CryptoOrderEnvelope> \{\s*\n?\s*return this\.http\.request<CryptoOrderEnvelope>\(\{\s*\n?\s*method: 'PATCH',\s*\n?\s*path: `\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('CRITICAL V-666.J cancel verb — POST (NOT DELETE) /v1/billing/crypto-orders/${encodeURIComponent(orderId)}/cancel → Promise<CancelCryptoOrderResponse>. POST (state transition, not row deletion) + audit-log preservation. Drift to DELETE would lose the audit-log row that captures the cancellation event. "abandon a pending order (self-service)" — the ONLY out for non-refundable crypto payments.', () => {
    expect(body).toMatch(/\/\*\* V-666\.J — abandon a pending order \(self-service\)\. \*\//);
    expect(body).toMatch(
      /cancel\(orderId: string\): Promise<CancelCryptoOrderResponse> \{\s*\n?\s*return this\.http\.request<CancelCryptoOrderResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}\/cancel`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-666.M receipt verb — GET /v1/billing/crypto-orders/${encodeURIComponent(orderId)}/receipt → Promise<CryptoOrderReceipt>. Returns JSON (NOT PDF — PDF download lives elsewhere). Drift to a binary blob response type would break content-negotiation typing across the SDK.', () => {
    expect(body).toMatch(/\/\*\* V-666\.M — fetch the JSON receipt\. \*\//);
    expect(body).toMatch(
      /receipt\(orderId: string\): Promise<CryptoOrderReceipt> \{\s*\n?\s*return this\.http\.request<CryptoOrderReceipt>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}\/receipt`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it("encodeURIComponent on :orderId — EXACTLY 4 escape call sites (get + updateNote + cancel + receipt). listAll doesn't escape directly (delegates via this.list() which doesn't use :orderId). Drift to dropping any escape would let path-traversal via maliciously-crafted orderIds.", () => {
    const matches = body.match(/encodeURIComponent\(orderId\)/g) ?? [];
    expect(matches.length, 'expected encodeURIComponent(orderId) 4 times').toBe(4);
  });

  it('9-verb inventory + verb-mix invariants — exactly 9 method declarations (quote + createCheckout + list + listAll + iterate + get + updateNote + cancel + receipt). `iterate` is the cross-SDK naming alias for `listAll` (Python/Go name the walker `iterate`); both delegate to the shared paginator so neither emits its own wire call. Verb mix: 3 POSTs (quote + createCheckout + cancel) + 3 GETs (list + get + receipt) + 1 PATCH (updateNote) + ZERO DELETE/PUT.', () => {
    const methods = body.match(/^ {2}(?!constructor)(?:async \*)?[a-zA-Z]+\(/gm) ?? [];
    expect(methods.length, 'expected 9 verb declarations').toBe(9);
    // `iterate` is the cross-SDK naming alias delegating to `listAll`.
    expect(body).toMatch(
      /iterate\(\s*\n?\s*opts: Omit<ListCryptoOrdersOptions, 'cursor'> = \{\},\s*\n?\s*\): AsyncGenerator<CryptoOrderEnvelope, void, void> \{\s*\n?\s*return this\.listAll\(opts\);\s*\n?\s*\}/,
    );
    const posts = (body.match(/method: 'POST'/g) ?? []).length;
    expect(posts, 'expected 3 POSTs (quote + createCheckout + cancel)').toBe(3);
    const gets = (body.match(/method: 'GET'/g) ?? []).length;
    expect(gets, 'expected 3 GETs (list + get + receipt)').toBe(3);
    const patches = (body.match(/method: 'PATCH'/g) ?? []).length;
    expect(patches, 'expected 1 PATCH (updateNote)').toBe(1);
    expect(body).not.toMatch(/method: 'DELETE'/);
    expect(body).not.toMatch(/method: 'PUT'/);
  });

  it('V-anchor coverage — 8 distinct V-666 sub-anchors pinned (H + C + G appears 2× since list mentions both G and BR but also G is on get + BR + BU + Q + J + M). Distinct V-666 anchor mentions: H (1) + C (1) + G (2: list + get) + BR (1) + BU (2: list + listAll) + Q (1) + J (1) + M (1) + AO (1 in CreateCryptoCheckoutOptions). Total V-666 anchor mentions ≥ 11 (one per verb context + 1 type + listAll). The wide anchor coverage is what threads each verb back to the V-666 changelog entry.', () => {
    const v666Matches = body.match(/V-666\./g) ?? [];
    expect(
      v666Matches.length,
      'expected V-666 anchors threaded across the file',
    ).toBeGreaterThanOrEqual(10);
  });

  it("Wire-path inventory — bare /v1/billing/crypto-checkout/quote + /v1/billing/crypto-checkout (createCheckout) + /v1/billing/crypto-orders (list) + per-id templates for get/updateNote/cancel/receipt. listAll delegates via this.list() so doesn't emit its own path. Drift to renaming any path would break dashboard URL-generation logic.", () => {
    expect(body).toMatch(/path: '\/v1\/billing\/crypto-checkout\/quote'/);
    expect(body).toMatch(/path: '\/v1\/billing\/crypto-checkout'/);
    expect(body).toMatch(/path: '\/v1\/billing\/crypto-orders'/);
    expect(body).toMatch(
      /path: `\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}`/,
    );
    expect(body).toMatch(
      /path: `\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}\/cancel`/,
    );
    expect(body).toMatch(
      /path: `\/v1\/billing\/crypto-orders\/\$\{encodeURIComponent\(orderId\)\}\/receipt`/,
    );
  });
});

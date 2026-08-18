// V-843 — the customer crypto API page, checked against the routes rather than
// against itself.
//
// `apps/docs/src/pages/api/billing-crypto.md` was one of only TWO customer doc
// pages out of 57 that no pin referenced at all. Unpinned meant unchecked, and
// it was missing four live endpoints:
//
//   POST /v1/billing/crypto-checkout/quote            price a product first
//   GET  /v1/billing/crypto-orders/:id/receipt        receipt JSON
//   GET  /v1/billing/crypto-orders/:id/receipt.txt    text/plain
//   GET  /v1/billing/crypto-orders/:id/receipt.pdf    application/pdf
//
// All four require `read:billing` and are scoped to the caller. The omission is
// not cosmetic on a payment surface: a customer who cannot find the quote
// endpoint has to create a real order to learn the price, and one who cannot
// find the receipt endpoints has no invoice for their accounting.
//
// This is V-813's shape — a customer-facing page one row short of what the
// server serves — with the difference that no guard existed to be
// one-directional. So the guard is written in the direction that was missing
// first: every REGISTERED customer crypto route must appear on the page.
//
// The reverse direction is also asserted, because V-824 found the docs naming
// endpoints the spec omitted and it cost real time to work out which side was
// wrong. Here both sides are derived from source, so neither can drift alone.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/billing-crypto.md');
/**
 * The OTHER page no pin referenced. V-844 read it end to end and found it
 * accurate, so it gets the fabricated-path arm but not the completeness one:
 * a troubleshooting guide is not an API reference and has no duty to list
 * every endpoint. It does have a duty not to invent one.
 */
const GUIDE = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/crypto-troubleshooting.md');

/**
 * Customer crypto routes registered by the server, normalised to the `:id`
 * spelling the page uses. Admin routes (`/v1/admin/crypto-orders/*`) are a
 * different surface with its own audience and are excluded.
 */
function registeredRoutes(): string[] {
  const found = new Set<string>();
  for (const name of readdirSync(ROUTES)) {
    if (!name.startsWith('billing-crypto') || !name.endsWith('.ts')) continue;
    // Comments stripped: this file's own route inventory sits in a header
    // comment, and counting it would let the roster agree with a comment
    // rather than with the registrations.
    const src = readFileSync(join(ROUTES, name), 'utf8').replace(/\/\/[^\n]*/g, '');
    for (const m of src.matchAll(/'(\/v1\/billing\/crypto[^']*)'/g)) {
      found.add((m[1] as string).replace(':order_id', ':id'));
    }
  }
  return [...found].sort();
}

function documentedRoutes(source = DOC): string[] {
  const doc = readFileSync(source, 'utf8');
  const found = new Set<string>();
  for (const m of doc.matchAll(/(\/v1\/billing\/crypto[A-Za-z0-9_\-/:.]*)/g)) {
    found.add(
      (m[1] as string)
        .replace(':order_id', ':id')
        // Prose and curl examples use a concrete id where the route
        // declares a param. Without this the guide's own examples read as
        // three fabricated endpoints — which is what the first run of this
        // arm reported, confidently and wrongly.
        .replace(/\/ord_[A-Za-z0-9]+/, '/:id')
        .replace(/[.,)]+$/, ''),
    );
  }
  return [...found].sort();
}

describe('V-843 the crypto API doc lists every customer crypto route', () => {
  it('CRITICAL both sides parse real data. The comparisons below report differences, so an empty route scan or an empty doc scan would agree with each other and report a complete page over nothing — the failure mode this sweep kept finding.', () => {
    expect(registeredRoutes().length, 'customer crypto routes registered').toBeGreaterThan(6);
    expect(documentedRoutes().length, 'crypto paths named on the page').toBeGreaterThan(6);
  });

  it('CRITICAL every registered customer crypto route appears on the page. This is the direction that was missing: the page omitted the quote endpoint and all three receipt formats, so a customer had to create a real order to discover a price and had no invoice to download. On a payment surface an undocumented endpoint is one the customer cannot use.', () => {
    const undocumented = registeredRoutes().filter((r) => !documentedRoutes().includes(r));
    expect(
      undocumented,
      'registered customer crypto route missing from apps/docs/src/pages/api/billing-crypto.md:',
    ).toEqual([]);
  });

  it('CRITICAL the page names no crypto route the server does not register. The opposite failure and the more embarrassing one — a customer following the docs gets a 404 on an endpoint that never existed. V-824 spent real time working out which side was wrong when the docs and the OpenAPI spec disagreed; deriving both sides from source removes the question.', () => {
    const fabricated = documentedRoutes().filter((d) => !registeredRoutes().includes(d));
    expect(fabricated, 'path named on the page that no route registers:').toEqual([]);
  });

  it("V-844 CRITICAL the troubleshooting guide names no crypto route the server does not register. It was the second of the two customer pages no pin referenced. Read end to end it is accurate — including the NowPayments statuses `expired` and `refunded`, which are the PROVIDER's vocabulary mapped to Driftstack `failed`, not invented order statuses. This arm keeps it that way without pretending a guide must enumerate the API.", () => {
    const fabricated = documentedRoutes(GUIDE).filter((d) => !registeredRoutes().includes(d));
    expect(fabricated, 'path named in the troubleshooting guide that no route registers:').toEqual(
      [],
    );
  });
});

// Every header we send to a customer's webhook endpoint is documented.
//
// The headers ARE the integration contract. A customer writes their handler
// against what the docs name; a header we emit and never document is one they
// cannot use, and one we can change without anyone noticing it was load-bearing
// for somebody. The signature header is covered by its own suites, but nothing
// checked the SET.
//
// Measured when written: three headers are emitted across the two delivery
// paths — `x-driftstack-signature`, `x-driftstack-event-id`,
// `x-driftstack-event-type` — and all three are documented. So this closes no
// live gap; it makes adding a fourth a decision rather than an omission.
//
// Case-insensitive on purpose. The docs write `X-Driftstack-Event-Id` in HTTP
// title case and the source emits lowercase, which is correct on both sides —
// HTTP header names are case-insensitive. A case-sensitive comparison reports a
// discrepancy that does not exist, which is exactly what happened when this was
// first measured by hand.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The two paths that actually put headers on the wire to a customer. */
const DELIVERY_SOURCES = [
  'apps/server/src/services/webhook-worker.ts',
  'apps/server/src/services/durable-webhook-delivery.ts',
];

const DOCS_DIR = 'apps/docs/src/pages/webhooks';

/**
 * Headers emitted internally that are deliberately NOT part of the customer
 * contract. Empty today; an entry here is a claim that a customer never needs
 * to know about the header, and the shrink assertion removes it once the docs
 * describe it anyway.
 */
const NOT_CUSTOMER_FACING: Record<string, string> = {};

function emittedHeaders(): string[] {
  const found = new Set<string>();
  for (const rel of DELIVERY_SOURCES) {
    const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    for (const m of src.matchAll(/'(x-driftstack-[a-z-]+)'/g)) found.add(m[1]!.toLowerCase());
  }
  return [...found].sort();
}

function docsCorpus(): string {
  const dir = resolve(REPO_ROOT, DOCS_DIR);
  let corpus = '';
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isFile()) corpus += readFileSync(full, 'utf8');
  }
  return corpus.toLowerCase();
}

describe('every webhook header we emit is documented for customers', () => {
  const emitted = emittedHeaders();
  const corpus = docsCorpus();

  it('CRITICAL the scan found emitted headers and a docs corpus. Either coming back empty would make the check below vacuously true.', () => {
    expect(emitted.length, 'headers emitted across the delivery paths').toBeGreaterThan(2);
    expect(emitted, 'the signature header must survive the scan').toContain(
      'x-driftstack-signature',
    );
    expect(corpus.length, 'webhook docs corpus').toBeGreaterThan(2000);
  });

  it('CRITICAL no header reaches a customer endpoint undocumented. The headers are the integration contract — one we send and never document is one nobody can write a handler against, and one we can change without knowing who depended on it.', () => {
    const undocumented = emitted
      .filter((h) => NOT_CUSTOMER_FACING[h] === undefined)
      .filter((h) => !corpus.includes(h));
    expect(
      undocumented.sort(),
      'webhook header(s) emitted but not named in apps/docs/src/pages/webhooks — document them, or add them to NOT_CUSTOMER_FACING with a reason:',
    ).toEqual([]);
  });

  it('CRITICAL the exemption list may only SHRINK — a header the docs now describe must leave it, and an entry naming a header we no longer emit must go too.', () => {
    const nowDocumented = Object.keys(NOT_CUSTOMER_FACING)
      .filter((h) => corpus.includes(h))
      .sort();
    expect(
      nowDocumented,
      'these are documented now — remove them from NOT_CUSTOMER_FACING so they stay checked:',
    ).toEqual([]);

    const stale = Object.keys(NOT_CUSTOMER_FACING)
      .filter((h) => !emitted.includes(h))
      .sort();
    expect(stale, 'exemption(s) for headers that are no longer emitted:').toEqual([]);
  });
});

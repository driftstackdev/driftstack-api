// A webhook delivery can never be double-claimed while it is still in flight.
//
// The claim is leased by staleness: a row sitting `in_flight` with an
// `updated_at` older than RECLAIM_STALE_IN_FLIGHT_MS is treated as abandoned
// and reclaimed by another worker. That is correct only while the lease
// comfortably outlasts a single delivery attempt. If a slow-but-alive POST can
// outlive the lease, a second worker reclaims a delivery the first is still
// making and the CUSTOMER receives the same webhook twice — which for a
// customer whose handler is not idempotent means the event is processed twice.
//
// `webhooks-repo.ts` states the relationship in a comment: "5 min ≫ the 10s
// per-attempt delivery timeout, so a slow (not stuck) delivery is never
// double-claimed." Nothing computed it. The three numbers live in three files,
// each pinned as literal text by its own content-parity test, and no pin looks
// at another — so lowering the lease to 5 seconds updates one pin and leaves
// every other test green while the safety property silently inverts.
//
// The constant is also DUPLICATED: `db/webhooks-repo.ts` (the live claim path)
// and `services/durable-webhook-delivery.ts` (its not-yet-wired successor)
// each declare their own copy. Two workers disagreeing about how long a lease
// lasts is the same double-claim bug arriving by a different route, and each
// copy's own text pin stays green while they diverge. So they are compared to
// each other rather than to a literal.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const REPO = resolve(REPO_ROOT, 'apps/server/src/db/webhooks-repo.ts');
const SUCCESSOR = resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts');
const WORKER = resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts');

/** Evaluate a `5 * 60 * 1000`-style constant declaration to a number. */
function msConstant(file: string, name: string): number {
  const src = readFileSync(file, 'utf8');
  const m = new RegExp(`${name} = ([0-9_ *+]+);`).exec(src);
  if (m === null) throw new Error(`${name} not found in ${file}`);
  const expr = m[1]!.replace(/_/g, '').trim();
  if (!/^[\d *+]+$/.test(expr)) throw new Error(`${name} is not a plain arithmetic literal`);
  return expr
    .split('+')
    .map((term) => term.split('*').reduce((a, b) => a * Number(b.trim()), 1))
    .reduce((a, b) => a + b, 0);
}

const leaseInRepo = (): number => msConstant(REPO, 'RECLAIM_STALE_IN_FLIGHT_MS');
const leaseInSuccessor = (): number => msConstant(SUCCESSOR, 'RECLAIM_STALE_IN_FLIGHT_MS');
const attemptTimeout = (): number => msConstant(WORKER, 'DEFAULT_TIMEOUT_MS');

/**
 * How much longer the lease must be than one attempt. The source comment says
 * "≫", which shipped as 30×. Requiring an order of magnitude keeps the margin
 * meaningful without pinning today's exact ratio: it permits retuning either
 * number and refuses a change that makes double-claiming reachable.
 */
const MIN_LEASE_RATIO = 10;

describe('the in-flight claim lease outlasts a delivery attempt', () => {
  it('CRITICAL all three constants parsed to real numbers. A regex that silently failed would leave the comparisons below running on a fallback, and the failure being guarded is a ratio — so a broken parse could report a healthy margin for a lease that does not have one.', () => {
    expect(leaseInRepo(), 'RECLAIM_STALE_IN_FLIGHT_MS in webhooks-repo').toBeGreaterThan(0);
    expect(
      leaseInSuccessor(),
      'RECLAIM_STALE_IN_FLIGHT_MS in durable-webhook-delivery',
    ).toBeGreaterThan(0);
    expect(attemptTimeout(), 'DEFAULT_TIMEOUT_MS in webhook-worker').toBeGreaterThan(0);
  });

  it('CRITICAL the lease is at least an order of magnitude longer than one delivery attempt. If a slow-but-alive POST can outlive the lease, a second worker reclaims a delivery still in flight and the customer receives the same webhook twice.', () => {
    const lease = leaseInRepo();
    const attempt = attemptTimeout();
    expect(
      lease / attempt,
      `reclaim lease ${String(lease)}ms vs ${String(attempt)}ms per-attempt timeout — a slow delivery could be double-claimed`,
    ).toBeGreaterThanOrEqual(MIN_LEASE_RATIO);
  });

  it('CRITICAL the live claim path and its successor agree on the lease. Two workers using different reclaim windows is the same double-claim bug by another route, and each copy is pinned only by its own content-parity test — so they can diverge with every test still green.', () => {
    expect(
      leaseInSuccessor(),
      'durable-webhook-delivery and webhooks-repo must use the same reclaim window',
    ).toBe(leaseInRepo());
  });

  it('CRITICAL production does not override the per-attempt timeout. The worker accepts a deliveryTimeoutMs config seam with no upper bound; a value above the lease would make double-claiming reachable, so bootstrap must not set one without this check being revisited.', () => {
    const bootstrap = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'), 'utf8');
    const construction = /new WebhookDeliveryWorker\(\{([\s\S]*?)\}\);/.exec(bootstrap);
    expect(construction, 'the live worker construction must be findable').not.toBeNull();
    expect(
      construction![1],
      'bootstrap sets deliveryTimeoutMs — re-check it against RECLAIM_STALE_IN_FLIGHT_MS',
    ).not.toMatch(/deliveryTimeoutMs/);
  });
});

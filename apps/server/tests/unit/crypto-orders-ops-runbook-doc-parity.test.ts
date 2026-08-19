// W242.C — drift-guard for /docs/crypto-orders-ops-runbook. Pins the
// admin endpoint paths, query/body field names, and structured log
// event names that support relies on. Catches drift if any of these
// move and the runbook is left behind.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'crypto-orders-ops-runbook.astro',
);
const ROUTES_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'admin-crypto-orders.ts');
const BILLING_ROUTES_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'billing-crypto.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W242.C crypto-orders-ops-runbook doc parity', () => {
  const doc = read(DOC_PATH);
  const routes = read(ROUTES_PATH);
  const billing = read(BILLING_ROUTES_PATH);

  it('references every admin endpoint by its actual path', () => {
    expect(routes).toContain(`'/v1/admin/crypto-orders/:order_id/events'`);
    expect(routes).toContain(`'/v1/admin/crypto-orders/:order_id/apply-ipn'`);
    expect(routes).toContain(`'/v1/admin/crypto-orders/sweep-expired'`);
    expect(routes).toContain(`'/v1/admin/crypto-orders/idempotency-metrics'`);
    expect(doc).toMatch(/\/v1\/admin\/crypto-orders\/:id\/events/);
    expect(doc).toMatch(/\/v1\/admin\/crypto-orders\/:id\/apply-ipn/);
    expect(doc).toMatch(/\/v1\/admin\/crypto-orders\/sweep-expired/);
    expect(doc).toMatch(/\/v1\/admin\/crypto-orders\/idempotency-metrics/);
  });

  it('apply-ipn body requires both provider_status and payment_id', () => {
    // Server schema requires both.
    expect(routes).toMatch(/provider_status:\s*z\.string\(\)\.min\(1\)/);
    expect(routes).toMatch(/payment_id:\s*z\.string\(\)\.min\(1\)/);
    // Doc mentions both.
    expect(doc).toMatch(/provider_status/);
    expect(doc).toMatch(/payment_id/);
  });

  it('idempotency-metrics field is body_mismatches not body_mismatch_count', () => {
    expect(routes).toMatch(/body_mismatches:/);
    expect(doc).toMatch(/body_mismatches/);
    expect(doc).not.toMatch(/body_mismatch_count/);
  });

  it('structured log event name matches the live emitter', () => {
    expect(billing).toContain(`'crypto_checkout_idempotency_body_mismatch'`);
    expect(doc).toContain('crypto_checkout_idempotency_body_mismatch');
  });

  it('payment_id filter is exposed on the admin list query', () => {
    expect(routes).toMatch(/payment_id:\s*z\.string\(\)\.min\(1\)\.max\(128\)\.optional\(\)/);
    expect(doc).toMatch(/payment_id=np_/);
  });

  const live = new Set(
    (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).map((v) => v),
  );
  const failedIsLive = live.has('crypto.order.failed');

  it('CRITICAL the subscribability gate was computed and has RETIRED. The arm title says "while the enum stays gated" and the enum stopped being gated in V-666, so it has asserted nothing since — while still reporting as a pass. Support reads this runbook; a stale not-yet-subscribable note would have been unguarded either way.', () => {
    expect(live.size, 'the enum was really read').toBeGreaterThan(3);
    expect(failedIsLive, 'crypto.order.failed is subscribable, so the gate has retired').toBe(true);
  });

  it.skipIf(failedIsLive)(
    'flags crypto.order.failed as not-yet-subscribable while the enum stays gated',
    () => {
      expect(doc).toMatch(/not yet customer-\s*subscribable/i);
    },
  );
});

// W358.A — drift guard for /docs/crypto-orders-ops-runbook. V-721.
// The customer-auditable ops playbook for the crypto-orders surface.
// Every admin endpoint cited is the actual support escalation path;
// a silent rename would leave on-call running broken commands.
//
// Pinned:
//   • Every admin endpoint cited (payment_id reverse lookup,
//     sweep-expired, apply-ipn, /events, idempotency-metrics, CSV
//     export with status + date window filters) is registered
//     server-side.
//   • payment_id exact-match filter is distinct from the fuzzy
//     search param (V-666.AY) — both stay pinned.
//   • crypto.order.failed reason set (ipn / expired / swept)
//     pinned; the page's claim that this event IS customer-
//     subscribable matches SubscribableWebhookEventTypeSchema
//     (LIVE as of 2026-05-22 migration 0064).
//   • Non-refundable policy + customer-credit-not-refund framing
//     pinned (consequential decision the page is published to
//     audit).
//   • crypto-orders /events source-tag set (create / ipn / cancel /
//     expired / swept) pinned.
//   • body_mismatches metric + structured warn log event name
//     ('crypto_checkout_idempotency_body_mismatch') pinned.
//   • Cross-links to admin-api / admin-api-pagination /
//     admin-csv-export / idempotency-keys / billing-crypto-
//     integration-guide / legal/refunds all resolve.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/crypto-orders-ops-runbook.astro',
);
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function allRoutes(): string {
  const out: string[] = [];
  for (const e of readdirSync(ROUTES_DIR)) {
    if (e.endsWith('.ts')) out.push(readFileSync(join(ROUTES_DIR, e), 'utf8'));
  }
  return out.join('\n');
}

describe('W358.A /docs/crypto-orders-ops-runbook parity', () => {
  const body = read(PAGE);
  const routes = allRoutes();
  const subscribable = new Set<string>(
    (SubscribableWebhookEventTypeSchema._def as { values: readonly string[] }).values,
  );

  it('every admin endpoint cited is registered server-side', () => {
    // Page-side citations.
    for (const cite of [
      '/v1/admin/crypto-orders?payment_id=',
      '/v1/admin/crypto-orders/:id',
      '/v1/admin/crypto-orders/sweep-expired',
      '/v1/admin/crypto-orders/:id/apply-ipn',
      '/v1/admin/crypto-orders/:id/events',
      '/v1/admin/crypto-orders/idempotency-metrics',
      '/v1/admin/crypto-orders.csv',
    ]) {
      expect(body).toContain(cite);
    }
    // Server-side registrations.
    for (const r of [
      "'/v1/admin/crypto-orders/sweep-expired'",
      "'/v1/admin/crypto-orders/:order_id/apply-ipn'",
      "'/v1/admin/crypto-orders/:order_id/events'",
      "'/v1/admin/crypto-orders/idempotency-metrics'",
    ]) {
      expect(routes, `route missing: ${r}`).toContain(r);
    }
  });

  it('payment_id exact-match filter (V-666.AY) is distinct from fuzzy search param', () => {
    expect(body).toMatch(/admin list endpoint\s+accepts an exact-match\s+<code>payment_id<\/code>/);
    expect(body).toMatch(
      /Distinct from the fuzzy <code>search<\/code> param.*walks order_id \/ product \/ customer_note/s,
    );
  });

  it('crypto.order.failed reason set (ipn / expired / swept) pinned', () => {
    expect(body).toMatch(
      /<code>crypto\.order\.failed<\/code>\s+event\s+emitted by these transitions carries a <code>reason<\/code>\s+field with one of <code>ipn<\/code>\s*\/\s*<code>expired<\/code>\s*\/\s*<code>swept<\/code>/,
    );
  });

  it('crypto.order.failed IS customer-subscribable (matches schema)', () => {
    expect(subscribable.has('crypto.order.failed')).toBe(true);
    expect(body).toMatch(
      /customer-subscribable.*<code>SubscribableWebhookEventTypeSchema<\/code>/s,
    );
  });

  it('/events source-tag set (create / ipn / cancel / expired / swept) pinned', () => {
    expect(body).toMatch(
      /<code>source<\/code> tag — <code>create<\/code>,\s+<code>ipn<\/code>, <code>cancel<\/code>, <code>expired<\/code>,\s+or <code>swept<\/code>/,
    );
  });

  it('non-refundable + customer-credit-not-refund framing pinned (auditable decision)', () => {
    expect(body).toMatch(/<a href="\/legal\/refunds\/">non-refundable policy<\/a>/);
    expect(body).toMatch(/Crypto is non-\s*refundable/);
    expect(body).toMatch(/resolution is to credit the customer's\s+next billing cycle, not refund/);
  });

  it('60-minute pay-window claim pinned (matches PAY_WINDOW_MS in routes)', () => {
    expect(body).toMatch(/Pay windows are ~60 minutes/);
    expect(routes).toMatch(/PAY_WINDOW_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('apply-ipn workflow pins provider_status: finished body field (V-666.F replay)', () => {
    expect(body).toMatch(/<code>provider_status: 'finished'<\/code>/);
  });

  it('idempotency-metrics body_mismatches counter + warn log event name pinned', () => {
    expect(body).toMatch(/<code>body_mismatches<\/code>\s+counter/);
    expect(body).toContain('crypto_checkout_idempotency_body_mismatch');
  });

  it('CSV reconcile snippet pins status + created_after + created_before triple (V-666.BY)', () => {
    expect(body).toMatch(/\?created_after<\/code>\s*\+\s*<code>\?created_before/);
    expect(body).toMatch(/status=paid&created_after=/);
  });

  it('all related cross-links resolve', () => {
    for (const [href, path] of [
      ['/docs/admin-api', 'apps/marketing-site/src/pages/docs/admin-api.astro'],
      [
        '/docs/admin-api-pagination',
        'apps/marketing-site/src/pages/docs/admin-api-pagination.astro',
      ],
      ['/docs/admin-csv-export', 'apps/marketing-site/src/pages/docs/admin-csv-export.astro'],
      ['/docs/idempotency-keys', 'apps/marketing-site/src/pages/docs/idempotency-keys.astro'],
      [
        // S47 2026-07-07: integration-guide mirror deleted; docs
        // successor is the paying-with-crypto guide.
        'https://docs.driftstack.dev/guides/paying-with-crypto/',
        'apps/docs/src/pages/guides/paying-with-crypto.md',
      ],
      [
        // S47 2026-07-07 (founder-approved: mirror deprecation): the
        // webhooks-crypto-events mirror is deleted; the page
        // cross-links its docs successor.
        'https://docs.driftstack.dev/webhooks/crypto-events/',
        'apps/docs/src/pages/webhooks/crypto-events.md',
      ],
      ['/legal/refunds', 'apps/marketing-site/src/pages/legal/refunds.md'],
    ] as const) {
      expect(body).toContain(href);
      expect(existsSync(resolve(REPO_ROOT, path)), `missing: ${path}`).toBe(true);
    }
  });
});

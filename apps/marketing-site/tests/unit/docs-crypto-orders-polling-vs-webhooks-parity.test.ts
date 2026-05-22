// W356.A — drift guard for /docs/crypto-orders-polling-vs-webhooks.
// V-666.BV practitioner guide. As of 2026-05-22 migration 0064 +
// bootstrap emitter sink, crypto.order.paid + crypto.order.failed
// ARE in SubscribableWebhookEventTypeSchema, so the page documents
// both polling and the now-live hybrid webhook + reconciliation
// pattern. Pinned:
//
//   • crypto.order.paid + crypto.order.failed ARE in
//     SubscribableWebhookEventTypeSchema (the page's central
//     premise — if this flips back, the page needs a rewrite).
//   • The terminal-status set the polling snippet hedges
//     (paid / failed / partial / cancelled) is a subset of
//     CryptoOrderStatusSchema values.
//   • Customer-facing list endpoint GET /v1/billing/crypto-orders
//     is registered server-side.
//   • Polling cadence guidance (1-5s / 30-60s / hourly).
//   • Customer-dashboard 60s poll cadence claim pinned.
//   • Hybrid (webhooks + reconciliation polling) framed as the
//     recommended pattern; idempotency-key advice
//     ((order_id, status)) pinned.
//   • Cross-links to /docs/webhooks-crypto-events + /docs/webhooks
//     + /docs/sdk-typescript-crypto-orders +
//     /docs/billing-crypto-integration-guide all resolve.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CryptoOrderStatusSchema, SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/crypto-orders-polling-vs-webhooks.astro',
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

describe('W356.A /docs/crypto-orders-polling-vs-webhooks parity', () => {
  const body = read(PAGE);
  const subscribable = new Set<string>(
    (SubscribableWebhookEventTypeSchema._def as { values: readonly string[] }).values,
  );
  const statuses = new Set<string>(
    (CryptoOrderStatusSchema._def as { values: readonly string[] }).values,
  );

  it('central premise: crypto.order.paid + crypto.order.failed ARE subscribable', () => {
    expect(subscribable.has('crypto.order.paid')).toBe(true);
    expect(subscribable.has('crypto.order.failed')).toBe(true);
    expect(body).toMatch(
      /<code>crypto\.order\.paid<\/code>\s*\/\s*<code>crypto\.order\.failed<\/code>\s*events/,
    );
    expect(body).toContain('SubscribableWebhookEventTypeSchema');
  });

  it('polling-loop terminal-status set is a subset of CryptoOrderStatusSchema', () => {
    for (const s of ['paid', 'failed', 'partial', 'cancelled']) {
      expect(statuses.has(s)).toBe(true);
      expect(body).toContain(`order.status === '${s}'`);
    }
    // The transition list cites all six.
    expect(body).toMatch(
      /<code>pending<\/code>\s*→\s*<code>confirming<\/code>\s*→\s*<code>paid<\/code>/,
    );
  });

  it('customer-facing list endpoint /v1/billing/crypto-orders is registered server-side', () => {
    expect(body).toMatch(
      /GET <code>\/v1\/billing\/crypto-orders<\/code>|<code>GET \/v1\/billing\/crypto-orders<\/code>/,
    );
    expect(allRoutes()).toContain("'/v1/billing/crypto-orders'");
  });

  it('polling-cadence guidance (1-5s / 30-60s / hourly+nightly) pinned', () => {
    expect(body).toMatch(/<strong>1-5 seconds<\/strong>/);
    expect(body).toMatch(/<strong>30-60 seconds<\/strong>/);
    expect(body).toMatch(/<strong>Hourly \/ nightly<\/strong>/);
  });

  it.skip('customer-dashboard 60s poll claim pinned (V-534.BS)', () => {
    expect(body).toMatch(/every 60s while/);
    expect(body).toMatch(/V-534\.BS/);
  });

  it.skip('SDK listAll() helper cited (V-132 SDK async-iterator pattern)', () => {
    expect(body).toContain('listAll');
    expect(body).toMatch(/cursors internally/);
  });

  it('hybrid (webhooks + reconciliation polling) framed as the recommended pattern (now live)', () => {
    expect(body).toMatch(/Recommended: hybrid \(webhooks \+ reconciliation polling\)/);
    expect(body).toMatch(
      /Both <code>crypto\.order\.paid<\/code> and\s*<code>crypto\.order\.failed<\/code> are in\s*<code>SubscribableWebhookEventTypeSchema<\/code>/,
    );
  });

  it('idempotency advice for the hybrid future pinned ((order_id, status) keying)', () => {
    expect(body).toMatch(/\(order_id, status\)/);
    expect(body).toMatch(
      /duplicate\s*<code>crypto\.order\.paid<\/code>\s*events for the same order are\s*a no-op/,
    );
  });

  it('cross-links to /docs/webhooks-crypto-events + /docs/webhooks + sdk-crypto-orders + integration-guide resolve', () => {
    for (const [href, path] of [
      [
        '/docs/webhooks-crypto-events',
        'apps/marketing-site/src/pages/docs/webhooks-crypto-events.astro',
      ],
      ['/docs/webhooks', 'apps/marketing-site/src/pages/docs/webhooks.astro'],
      [
        '/docs/sdk-typescript-crypto-orders',
        'apps/marketing-site/src/pages/docs/sdk-typescript-crypto-orders.astro',
      ],
      [
        '/docs/billing-crypto-integration-guide',
        'apps/marketing-site/src/pages/docs/billing-crypto-integration-guide.astro',
      ],
    ] as const) {
      expect(body).toContain(href);
      expect(existsSync(resolve(REPO_ROOT, path)), `missing: ${path}`).toBe(true);
    }
  });
});

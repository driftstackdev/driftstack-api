// W356.B — drift guard for /docs/billing-crypto-integration-guide.
// V-720 end-to-end walkthrough. The page strings together five
// concrete endpoint claims; if any of them silently rename or
// move, an integrator following the guide hits a 404 mid-checkout.
//
// Pinned:
//   • POST /v1/billing/crypto-checkout (registered server-side)
//   • GET /v1/billing/crypto-orders/:id polling claim — and the
//     terminal-status branch (paid / failed) matches
//     CryptoOrderStatusSchema values.
//   • Three receipt formats (JSON / .txt / .pdf) under
//     /v1/billing/crypto-orders/:id/receipt*
//   • Admin replay-IPN claim → POST /v1/admin/crypto-orders/:id/apply-ipn
//     is registered (used in dev confidence testing).
//   • 60-minute pay-window claim ↔ PAY_WINDOW_MS source-of-truth.
//   • Backfill code uses status + created_after + cursor (the live
//     filter triple).
//   • Idempotency-Key advice + Idempotent-Replayed header reference
//     to /docs/idempotency-keys.
//   • Crypto-non-refundable cross-reference to /legal/refunds.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CryptoOrderStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/billing-crypto-integration-guide.astro',
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

describe('W356.B /docs/billing-crypto-integration-guide parity', () => {
  const body = read(PAGE);
  const routes = allRoutes();
  const statuses = new Set<string>(
    (CryptoOrderStatusSchema._def as { values: readonly string[] }).values,
  );

  it('POST /v1/billing/crypto-checkout is registered server-side', () => {
    expect(body).toContain('/v1/billing/crypto-checkout');
    expect(routes).toContain("'/v1/billing/crypto-checkout'");
  });

  it("polling loop's terminal-status branch (paid / failed) matches the schema", () => {
    expect(body).toMatch(/order\.status === 'paid'/);
    expect(body).toMatch(/order\.status === 'failed'/);
    expect(statuses.has('paid')).toBe(true);
    expect(statuses.has('failed')).toBe(true);
    expect(statuses.has('partial')).toBe(true);
    // partial framing in edge-cases section.
    expect(body).toMatch(/moves to\s*<code>partial<\/code>/);
  });

  it('three receipt formats reachable from /v1/billing/crypto-orders/:id/receipt', () => {
    expect(body).toContain('/v1/billing/crypto-orders/:id/receipt');
    expect(body).toContain('/v1/billing/crypto-orders/:id/receipt.txt');
    expect(body).toContain('/v1/billing/crypto-orders/:id/receipt.pdf');
  });

  it('admin apply-IPN endpoint cited as the dev confidence test + registered server-side', () => {
    expect(body).toMatch(/<code>POST \/v1\/admin\/crypto-orders\/:id\/apply-ipn<\/code>/);
    expect(routes).toContain("'/v1/admin/crypto-orders/:order_id/apply-ipn'");
  });

  it('60-minute pay-window claim matches PAY_WINDOW_MS source-of-truth', () => {
    expect(body).toMatch(/window is\s*roughly 60 minutes from order mint/);
    // PAY_WINDOW_MS = 60 * 60 * 1000 = 1 hour. The constant lives in
    // the billing-crypto-orders route file (it's a route-local
    // detail — not pulled into a shared lib).
    expect(routes).toMatch(/PAY_WINDOW_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('backfill loop uses status + created_after + cursor filters', () => {
    // SDK-driven loop.
    expect(body).toMatch(/status:\s*'paid'/);
    expect(body).toMatch(/created_after:\s*since/);
    expect(body).toMatch(/listAll/);
    // Raw-fetch loop pins cursor pagination semantics.
    expect(body).toMatch(/searchParams\.set\('cursor', cursor\)/);
    expect(body).toMatch(/if \(!next_cursor\) break/);
  });

  it('Idempotency-Key advice is concrete + cross-linked to /docs/idempotency-keys', () => {
    expect(body).toMatch(/Always send an\s*<code>Idempotency-Key<\/code>/);
    expect(body).toMatch(/<code>Idempotent-Replayed<\/code>\s*response header/);
    expect(body).toContain('/docs/idempotency-keys');
  });

  it('crypto-non-refundable cross-reference to /legal/refunds resolves', () => {
    expect(body).toMatch(/Crypto\s*payments are non-refundable/);
    expect(body).toContain('/legal/refunds');
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/refunds.md'))).toBe(
      true,
    );
  });

  it('settlement copy: "Grant entitlements only after status === paid" stays pinned', () => {
    // Safety-critical claim — a future copy revamp must not water
    // this down to "after order_id" or anything less specific.
    expect(body).toMatch(
      /Grant entitlements only after observing\s*<code>status === 'paid'<\/code>/,
    );
  });

  it('payment_address may be null on stub provider (Tier-3 wire-up deferred)', () => {
    // The integrator needs to know the stub-provider shape isn't a
    // bug — it's the current state until NowPayments wire-up lands
    // for the pair.
    expect(body).toMatch(/<code>null<\/code> with <code>provider: 'stub'<\/code>/);
  });

  it('all related cross-links resolve', () => {
    for (const [href, path] of [
      [
        '/docs/billing-crypto-overview',
        'apps/marketing-site/src/pages/docs/billing-crypto-overview.astro',
      ],
      [
        '/docs/webhooks-crypto-events',
        'apps/marketing-site/src/pages/docs/webhooks-crypto-events.astro',
      ],
      ['/docs/idempotency-keys', 'apps/marketing-site/src/pages/docs/idempotency-keys.astro'],
      [
        '/docs/billing-crypto-troubleshooting',
        'apps/marketing-site/src/pages/docs/billing-crypto-troubleshooting.astro',
      ],
      [
        '/docs/crypto-orders-polling-vs-webhooks',
        'apps/marketing-site/src/pages/docs/crypto-orders-polling-vs-webhooks.astro',
      ],
    ] as const) {
      expect(body).toContain(href);
      expect(existsSync(resolve(REPO_ROOT, path)), `missing: ${path}`).toBe(true);
    }
  });
});

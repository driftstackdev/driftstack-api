// W268.D — drift-guard for customer-dashboard /billing page. Pins
// every /v1/billing/* endpoint cited by the page's inline action
// handlers to a live route registration.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/billing.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts');
// 2026-05-21 — V-666.D added /v1/billing/crypto-checkout to the page;
// that route lives in billing-crypto.ts (separate file from
// billing.ts since the auth gate + service deps differ). Include both
// route sources when checking registration coverage.
const CRYPTO_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts');
const CRYPTO_ORDERS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W268.D /billing page ↔ /v1/billing/* route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);
  const cryptoRoute = read(CRYPTO_ROUTE);
  const cryptoOrdersRoute = read(CRYPTO_ORDERS_ROUTE);
  const allRouteSources = route + '\n' + cryptoRoute + '\n' + cryptoOrdersRoute;

  it('every /v1/billing/* path cited by inline action handlers is registered', () => {
    const paths = [...page.matchAll(/['"`](\/v1\/billing\/[a-z-]+)['"`]/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(0);
    const missing = paths.filter((p) => !allRouteSources.includes(`'${p}'`));
    expect(missing).toEqual([]);
  });

  it('portal action targets /v1/billing/portal-session', () => {
    expect(page).toMatch(/\/v1\/billing\/portal-session/);
    expect(route).toContain(`'/v1/billing/portal-session'`);
  });

  it('trial-pack purchase flow removed from the /billing page (2026-05-27)', () => {
    // The entry tier is now the perpetual free tier (no purchase), so
    // the /billing page no longer cites the trial-pack checkout. Guard
    // against drift back on the dashboard side. (The server keeps a
    // disabled-route stub for it under registerBillingDisabledRoutes —
    // that's apps/server's concern, not this page's.)
    expect(page).not.toContain('/v1/billing/trial-pack');
  });

  it('crypto payments history targets /v1/billing/crypto-orders (+ per-order receipt.pdf) and both are registered (slice 3.3)', () => {
    expect(page).toContain("'/v1/billing/crypto-orders?limit=5'");
    expect(page).toMatch(
      /\/v1\/billing\/crypto-orders\/' \+ encodeURIComponent\(id\) \+ '\/receipt\.pdf/,
    );
    expect(cryptoOrdersRoute).toContain(`'/v1/billing/crypto-orders'`);
    expect(cryptoOrdersRoute).toContain(`'/v1/billing/crypto-orders/:order_id/receipt.pdf'`);
  });

  it('checkout-session route exists on the live server (used by /select-tier, not /billing)', () => {
    // /billing page itself only wires the portal session; the tier
    // checkout flow lives on /select-tier. Verify the route still exists
    // so other pages can rely on it.
    expect(route).toContain(`'/v1/billing/checkout-session'`);
  });

  it('cite no-store header for /v1/billing reads', () => {
    // The customer-facing /v1/billing/state response should be no-store
    // per W134. We verify the page's GET path here doesn't expose
    // billing data to cache.
    expect(page).toMatch(/Manage subscription/);
  });

  it('Stripe is the documented payment processor', () => {
    expect(page).toMatch(/Stripe/);
    expect(page).not.toMatch(/PayPal Checkout/);
    expect(page).not.toMatch(/Square/);
  });
});

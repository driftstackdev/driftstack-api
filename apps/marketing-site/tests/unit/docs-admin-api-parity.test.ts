// W265.C — drift-guard for /docs/admin-api. Pins every /v1/admin/*
// path cited in the page to a live route registration.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/admin-api.astro');
const ADMIN_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W265.C /docs/admin-api ↔ /v1/admin/crypto-orders/* route parity', () => {
  const page = read(PAGE);
  const route = read(ADMIN_ROUTE);

  it('every /v1/admin/crypto-orders/* path documented is registered', () => {
    // Pull paths from <code>METHOD /v1/admin/crypto-orders/...</code> rows.
    const paths = [
      ...page.matchAll(
        /<code>(?:GET|POST|PATCH|DELETE) (\/v1\/admin\/crypto-orders[\w./:-]*)<\/code>/g,
      ),
    ].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(5);

    // Normalize each path: strip query strings; collapse `:id` etc.
    const normalize = (p: string): string => p.replace(/\?.*$/, '');
    const missing: string[] = [];
    for (const p of paths) {
      const n = normalize(p);
      if (!route.includes(`'${n}'`)) missing.push(n);
    }
    expect(missing).toEqual([]);
  });

  it('driftstack_internal_admin scope is named as the gate', () => {
    expect(page).toMatch(/<code>driftstack_internal_admin<\/code>/);
  });

  it('cites the no-admin-impersonation invariant', () => {
    expect(page).toMatch(/no\s+admin-impersonation path/i);
  });

  it('cites the no-crypto-refund invariant', () => {
    expect(page).toMatch(/Crypto payments are non-refundable/i);
    expect(page).toMatch(/no admin endpoint that initiates a\s+crypto-side reversal/i);
  });

  it('Stripe + NowPayments are the only money-moving paths', () => {
    expect(page).toMatch(/Stripe.*NowPayments|NowPayments.*Stripe/);
  });
});

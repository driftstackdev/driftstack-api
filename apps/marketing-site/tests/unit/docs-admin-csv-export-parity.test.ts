// W266.C — drift-guard for /docs/admin-csv-export. Pins:
// 1. CSV endpoint matches the live route registration.
// 2. status filter values match CryptoOrderStatusSchema.
// 3. order_id prefix `ord_` matches the live id-mint helper.
// 4. limit cap 1000 matches the live route schema.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CryptoOrderStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/admin-csv-export.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts');
const MINT = resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W266.C /docs/admin-csv-export ↔ live admin CSV route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('GET /v1/admin/crypto-orders.csv is documented + registered', () => {
    expect(page).toMatch(/GET \/v1\/admin\/crypto-orders\.csv/);
    expect(route).toContain(`'/v1/admin/crypto-orders.csv'`);
  });

  it('status filter values match CryptoOrderStatusSchema', () => {
    const live = new Set(CryptoOrderStatusSchema.options);
    for (const s of live) {
      expect(page).toMatch(new RegExp(`<code>${s}</code>`));
    }
  });

  it('order_id prefix ord_ matches the live id-mint helper', () => {
    expect(page).toMatch(/<code>ord_\*<\/code>/);
    const mint = read(MINT);
    expect(mint).toMatch(/`ord_\$\{/);
  });

  it('driftstack_internal_admin scope is required', () => {
    expect(page).toMatch(/<code>driftstack_internal_admin<\/code>/);
  });

  it('limit cap 1000 matches the live route schema', () => {
    expect(page).toMatch(/limit.*1.*1000|integer 1.1000/);
  });

  it('created_after / created_before filter is documented with strict ordering', () => {
    expect(page).toMatch(/created_after/);
    expect(page).toMatch(/created_before/);
    expect(page).toMatch(/strictly greater than/);
  });
});

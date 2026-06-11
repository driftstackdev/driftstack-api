// W269.A — drift-guard for customer-dashboard /usage page. Pins
// /v1/usage + /v1/usage/series endpoints used by the inline fetch
// to live route registrations.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/usage.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W269.A /usage page ↔ /v1/usage* route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('GET /v1/usage is registered and used by the page', () => {
    expect(page).toMatch(/\/v1\/usage(?!\/series)/);
    expect(route).toContain(`'/v1/usage'`);
  });

  it('GET /v1/usage/series is registered and used by the page', () => {
    expect(page).toMatch(/\/v1\/usage\/series\?days=30/);
    expect(route).toContain(`'/v1/usage/series'`);
  });

  it('30-day series window is documented', () => {
    expect(page).toMatch(/days=30/);
  });

  it('W576: GET /v1/account/rate-limits is registered and used by the rate-limits card', () => {
    expect(page).toMatch(/\/v1\/account\/rate-limits/);
    expect(page).toMatch(/data-section="rate-limits"/);
    expect(page).toMatch(/data-rate-limit-rows/);
    // Rows are innerHTML-rendered from server data → must escape.
    expect(page).toMatch(/escapeHtml\(b\.bucket_key\)/);
    const accountRlRoute = read(
      resolve(REPO_ROOT, 'apps/server/src/routes/account-rate-limits.ts'),
    );
    expect(accountRlRoute).toContain(`'/v1/account/rate-limits'`);
  });

  it('uses PUBLIC_API_BASE_URL for the base URL (no hard-coded host)', () => {
    expect(page).toMatch(/resolveApiBaseUrl/);
    expect(page).not.toMatch(/https:\/\/api\.driftstack\.dev\/v1\/usage/);
  });

  it('reads ds_web_session_token from localStorage for auth', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });

  it('sparkline series keys match the documented metric names', () => {
    for (const k of ['navigates', 'interacts', 'captures', 'session_minutes']) {
      expect(page).toMatch(new RegExp(`${k}:\\s*mockSeries`));
    }
  });
});

// W269.D — drift-guard for customer-dashboard /webhooks page. Pins
// every /v1/webhook* endpoint cited by the page's inline list /
// create / edit / rotate-secret / test / deliveries / replay handlers
// to a live route registration in apps/server/src/routes/webhooks.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/webhooks.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/webhooks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W269.D /webhooks page ↔ /v1/webhooks* route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('GET + POST /v1/webhooks are registered and used by the page', () => {
    expect(page).toMatch(/\/v1\/webhooks(?!['"\/-])/);
    expect(route).toContain(`'/v1/webhooks'`);
  });

  it('PATCH/DELETE /v1/webhooks/:id is registered', () => {
    expect(page).toMatch(/\/v1\/webhooks\/'\s*\+\s*encodeURIComponent\(/);
    expect(route).toContain(`'/v1/webhooks/:id'`);
  });

  it('GET /v1/webhooks/:id/deliveries is registered', () => {
    expect(page).toMatch(/\/deliveries/);
    expect(route).toContain(`'/v1/webhooks/:id/deliveries'`);
  });

  it('POST /v1/webhook-deliveries/:deliveryId/replay is registered', () => {
    expect(page).toMatch(/\/v1\/webhook-deliveries\/'\s*\+/);
    expect(route).toContain(`'/v1/webhook-deliveries/:deliveryId/replay'`);
  });

  it('POST /v1/webhooks/:id/rotate-secret is registered', () => {
    expect(page).toMatch(/\/rotate-secret/);
    expect(route).toContain(`'/v1/webhooks/:id/rotate-secret'`);
  });

  it('POST /v1/webhooks/:id/test is registered', () => {
    expect(page).toMatch(/'\/test'/);
    expect(route).toContain(`'/v1/webhooks/:id/test'`);
  });

  it('reads ds_web_session_token from localStorage for auth', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });

  it('every /v1/webhooks/* path-suffix cited by the page is a live route', () => {
    const suffixes = [...page.matchAll(/'\/(deliveries|rotate-secret|test)'/g)].map((m) => m[1]!);
    expect(suffixes.length).toBeGreaterThan(0);
    for (const s of suffixes) {
      expect(route).toMatch(new RegExp(`'/v1/webhooks/:id/${s}'`));
    }
  });
});

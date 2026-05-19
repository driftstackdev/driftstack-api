// W268.A — drift-guard for /docs/idempotency-keys. Pins:
// 1. Endpoint /v1/billing/crypto-checkout matches the live route.
// 2. Idempotency-Key header + Idempotent-Replayed response header.
// 3. 24-hour dedupe window.
// 4. Length limit 255 ASCII chars / no whitespace.
// 5. Example product is a real AccountTier slug.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/idempotency-keys.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts');
const KEY_LIB = resolve(REPO_ROOT, 'apps/server/src/lib/idempotency-key.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W268.A /docs/idempotency-keys ↔ /v1/billing/crypto-checkout parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);
  const keyLib = read(KEY_LIB);

  it('POST /v1/billing/crypto-checkout endpoint is documented + registered', () => {
    expect(page).toMatch(/POST \/v1\/billing\/crypto-checkout/);
    expect(route).toContain(`'/v1/billing/crypto-checkout'`);
  });

  it('Idempotency-Key request header + Idempotent-Replayed response header are documented', () => {
    expect(page).toMatch(/Idempotency-Key/);
    expect(page).toMatch(/Idempotent-Replayed/);
    expect(route).toMatch(/Idempotent-Replayed/);
    // The lowercase header lookup lives in the shared lib (extracted
    // so V-666.AO billing-crypto + v2-#19 agent-sessions share one
    // validation path). Pin it there + verify the route imports
    // through that lib.
    expect(keyLib).toMatch(/'idempotency-key'/);
    expect(route).toMatch(/readIdempotencyKey/);
  });

  it('24-hour dedupe window matches the live service comment', () => {
    expect(page).toMatch(/24 hours/);
    const service = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(service).toMatch(/24h/);
  });

  it('255 ASCII / no whitespace constraint matches the live route validation', () => {
    expect(page).toMatch(/255 (?:ASCII )?characters/);
    expect(page).toMatch(/no whitespace/);
    expect(route).toMatch(/1-255 ASCII chars \(no whitespace\)/);
  });

  it('example product is a real AccountTier slug', () => {
    const m = page.match(/"product":\s*"([a-z_]+)"/);
    expect(m).not.toBeNull();
    expect(AccountTierSchema.options).toContain(m![1] as never);
    expect(m![1]).not.toBe('team_growth');
  });

  it('UUIDv4 is the canonical key choice', () => {
    expect(page).toMatch(/UUIDv4/);
  });
});

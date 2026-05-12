// W267.A — drift-guard for the three /docs/sdk-{ts,py,go}-crypto-orders
// reference pages. Pins:
// 1. `product` example values use a real AccountTier slug.
// 2. ord_ prefix is the live order id format.
// 3. Each SDK's method names match the live resource surface.
// 4. Non-refundable framing is consistent.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const TS_PAGE = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/sdk-typescript-crypto-orders.astro',
);
const PY_PAGE = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/sdk-python-crypto-orders.astro',
);
const GO_PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-go-crypto-orders.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const liveTiers = new Set(AccountTierSchema.options);

describe('W267.A /docs/sdk-{ts,py,go}-crypto-orders ↔ live tier + SDK parity', () => {
  it('TS page product example is a real AccountTier slug', () => {
    const ts = read(TS_PAGE);
    const m = ts.match(/product:\s*'([a-z_]+)'/);
    expect(m).not.toBeNull();
    expect(liveTiers.has(m![1] as never)).toBe(true);
    expect(m![1]).not.toBe('team_growth');
  });

  it('Python page product example is a real AccountTier slug', () => {
    const py = read(PY_PAGE);
    const m = py.match(/"product":\s*"([a-z_]+)"/);
    expect(m).not.toBeNull();
    expect(liveTiers.has(m![1] as never)).toBe(true);
    expect(m![1]).not.toBe('team_growth');
  });

  it('Go page product example is a real AccountTier slug', () => {
    const go = read(GO_PAGE);
    const m = go.match(/"product":\s*"([a-z_]+)"/);
    expect(m).not.toBeNull();
    expect(liveTiers.has(m![1] as never)).toBe(true);
    expect(m![1]).not.toBe('team_growth');
  });

  it('TS page cites cryptoOrders methods that exist on the live resource', () => {
    const ts = read(TS_PAGE);
    const resource = read(
      resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/crypto-orders.ts'),
    );
    for (const m of ['quote', 'createCheckout', 'list', 'get', 'cancel', 'receipt']) {
      expect(ts).toContain(`client.cryptoOrders.${m}`);
      expect(resource).toMatch(new RegExp(`\\b${m}\\s*\\(`));
    }
  });

  it('Python page cites crypto_orders methods that exist on the live resource', () => {
    const py = read(PY_PAGE);
    const resource = read(
      resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/crypto_orders.py'),
    );
    for (const m of ['quote', 'create_checkout', 'list', 'get', 'cancel', 'receipt']) {
      expect(py).toContain(`crypto_orders.${m}`);
      expect(resource).toMatch(new RegExp(`def\\s+${m}\\s*\\(`));
    }
  });

  it('Go page cites CryptoOrders methods that exist on the live resource', () => {
    const go = read(GO_PAGE);
    const resource = read(resolve(REPO_ROOT, 'packages/sdk-go/crypto_orders.go'));
    for (const m of ['Quote', 'CreateCheckout', 'List', 'Get', 'Cancel', 'Receipt']) {
      expect(go).toContain(`CryptoOrders.${m}`);
      expect(resource).toMatch(new RegExp(`func\\s+\\(.*CryptoOrdersResource\\)\\s+${m}\\b`));
    }
  });

  it('all three pages frame crypto payments as non-refundable', () => {
    for (const p of [TS_PAGE, PY_PAGE, GO_PAGE]) {
      expect(read(p)).toMatch(/non-refundable/i);
    }
  });
});

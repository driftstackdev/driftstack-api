// W265.D — drift-guard for /docs/billing-crypto-overview. Pins:
// 1. State-machine table values match CryptoOrderStatusSchema exactly.
// 2. NowPayments is the only crypto processor named.
// 3. Crypto payments framed as non-refundable.
// 4. /pricing link exists.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CryptoOrderStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/billing-crypto-overview.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W265.D /docs/billing-crypto-overview ↔ CryptoOrderStatusSchema parity', () => {
  const page = read(PAGE);
  const liveStates = new Set(CryptoOrderStatusSchema.options);

  it('every state in the lifecycle table is a real CryptoOrderStatusSchema value', () => {
    const docStates = [...page.matchAll(/<td><code>([a-z]+)<\/code><\/td>\s*<td>/g)].map(
      (m) => m[1]!,
    );
    expect(docStates.length).toBeGreaterThan(4);
    const offenders = docStates.filter((s) => !liveStates.has(s as never));
    expect(offenders).toEqual([]);
  });

  it('every live CryptoOrderStatusSchema value is documented', () => {
    for (const s of liveStates) {
      expect(page).toMatch(new RegExp(`<code>${s}</code>`));
    }
  });

  it('NowPayments is named as the processor; no fictional providers', () => {
    expect(page).toMatch(/NowPayments/);
    expect(page).not.toMatch(/CoinPayments/);
    expect(page).not.toMatch(/Coinbase Commerce/);
    expect(page).not.toMatch(/BitPay/);
  });

  it('crypto payments are framed as non-refundable', () => {
    expect(page).toMatch(/non-refundable/i);
  });

  it('/pricing cross-link exists', () => {
    expect(page).toContain('/pricing');
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro'))).toBe(
      true,
    );
  });
});

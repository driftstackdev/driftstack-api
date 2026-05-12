// W340.A — drift guard for /pricing/crypto. The page makes
// concrete claims about:
//
//   • the pay-window (must match server PAY_WINDOW_MS in
//     billing-crypto-orders.ts; previously said 20 min, server is 1h)
//   • the list of crypto-payable tier IDs (every one must exist in
//     API_TIERS — otherwise the .find() at build time throws)
//   • the non-refundable posture (must match /legal/refunds)
//   • cross-link to /legal/refunds
//
// Catches: pay-window drift, tier-id typos, broken cross-link.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_TIERS } from '../../src/data/pricing';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing/crypto.astro');
const SERVER = resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts');
const REFUNDS = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/refunds.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W340.A /pricing/crypto parity', () => {
  const page = read(PAGE);
  const server = read(SERVER);

  it('server PAY_WINDOW_MS is 1 hour and page cites the matching 1-hour pay-window', () => {
    expect(server).toMatch(/PAY_WINDOW_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
    expect(page).toMatch(/1[-\s]hour/);
    // Old "20 minute" pay-window text should be gone — it was
    // server-drift. (The "~20 minutes" BTC confirmation time in
    // the table below is a separate, legitimate chain-latency
    // figure and must NOT be matched here.)
    expect(page).not.toMatch(/20[-\s]minutes? (?:from the quote|quote window)/);
    expect(page).not.toMatch(/locked in for 20[-\s]minutes?/);
  });

  it('every CRYPTO_PAYABLE_TIER_IDS entry resolves to an API_TIERS row', () => {
    const idMatch = page.match(/CRYPTO_PAYABLE_TIER_IDS\s*=\s*\[([\s\S]*?)\];/);
    expect(idMatch).not.toBeNull();
    const ids = [...idMatch![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(0);
    const tierIds = new Set(API_TIERS.map((t) => t.id));
    const offenders = ids.filter((id) => !tierIds.has(id as (typeof API_TIERS)[number]['id']));
    expect(offenders).toEqual([]);
  });

  it('Trial pack is included in crypto-payable tiers (one-time $2.99 path)', () => {
    expect(page).toMatch(/'trial_pack'/);
  });

  it('lists at least the canonical 5 currencies (BTC / ETH / USDC ERC-20 / USDT ERC-20 / USDC Polygon)', () => {
    const accepted = page.match(/ACCEPTED_CURRENCIES\s*=\s*\[([\s\S]*?)\];/);
    expect(accepted).not.toBeNull();
    expect(accepted![1]!).toContain("'BTC'");
    expect(accepted![1]!).toContain("'ETH'");
    expect(accepted![1]!).toContain("'USDC (ERC-20)'");
    expect(accepted![1]!).toContain("'USDT (ERC-20)'");
    expect(accepted![1]!).toContain("'USDC (Polygon)'");
  });

  it('declares crypto payments non-refundable (must match /legal/refunds posture)', () => {
    expect(page).toMatch(/[Cc]rypto payments are non-refundable/);
    expect(page).toContain('/legal/refunds');
    expect(existsSync(REFUNDS)).toBe(true);
    expect(read(REFUNDS)).toMatch(/Crypto payments at Driftstack are non-refundable/);
  });

  it('cites NowPayments as the on-chain settlement provider', () => {
    // Pin the provider name; cross-reference the server bootstrap
    // also wires a NowPayments IPN webhook handler.
    expect(page).toContain('NowPayments');
  });

  it('confirmation table covers BTC/ETH/ERC-20/Polygon with concrete counts', () => {
    expect(page).toMatch(/<td>BTC<\/td><td>2<\/td>/);
    expect(page).toMatch(/<td>ETH<\/td><td>12<\/td>/);
    expect(page).toMatch(/<td>USDC \/ USDT \(ERC-20\)<\/td><td>12<\/td>/);
    expect(page).toMatch(/<td>USDC \(Polygon\)<\/td><td>32<\/td>/);
  });
});

// doc-150 item 6 — unit tests for the pure storage-quota helper.
//
// Verifies computeAccountStorageState's state thresholds (ok / soft / hard),
// the enterprise soft-only carve-out, the 80% soft warn, and the defensive
// clamps (negative used → 0). Caps are read from TIER_STORAGE_BYTES_CAP so a
// future cap change re-derives here without hardcoding byte literals.

import { describe, expect, it } from 'vitest';
import { TIER_STORAGE_BYTES_CAP, STORAGE_SOFT_WARN_FRACTION } from '@driftstack/api-types';
import { computeAccountStorageState } from '../../src/services/profile-storage-quota.js';

const GiB = 2 ** 30;

describe('computeAccountStorageState', () => {
  it('state ok below the soft threshold; carries cap + fraction', () => {
    const cap = TIER_STORAGE_BYTES_CAP.solo_manual; // 5 GiB
    const s = computeAccountStorageState({ usedBytes: GiB, tier: 'solo_manual' });
    expect(s.state).toBe('ok');
    expect(s.capBytes).toBe(cap);
    expect(s.usedBytes).toBe(GiB);
    expect(s.fraction).toBeCloseTo(1 / 5, 6);
    expect(s.isEnterprise).toBe(false);
  });

  it('state soft at/just-above the 80% threshold (>= STORAGE_SOFT_WARN_FRACTION)', () => {
    const cap = TIER_STORAGE_BYTES_CAP.free; // 1 GiB
    // ceil lands at-or-above 80% (floor can drop a hair below on a non-integer
    // product, which is the 'ok' side — covered separately below).
    const used = Math.ceil(cap * STORAGE_SOFT_WARN_FRACTION);
    const s = computeAccountStorageState({ usedBytes: used, tier: 'free' });
    expect(s.fraction).toBeGreaterThanOrEqual(STORAGE_SOFT_WARN_FRACTION);
    expect(s.state).toBe('soft');
  });

  it('state ok just below 80%', () => {
    const cap = TIER_STORAGE_BYTES_CAP.free;
    const used = Math.floor(cap * STORAGE_SOFT_WARN_FRACTION) - 1;
    const s = computeAccountStorageState({ usedBytes: used, tier: 'free' });
    expect(s.fraction).toBeLessThan(STORAGE_SOFT_WARN_FRACTION);
    expect(s.state).toBe('ok');
  });

  it('state hard exactly at the cap (fraction >= 1)', () => {
    const cap = TIER_STORAGE_BYTES_CAP.free;
    const s = computeAccountStorageState({ usedBytes: cap, tier: 'free' });
    expect(s.state).toBe('hard');
    expect(s.fraction).toBe(1);
  });

  it('state hard over the cap (non-enterprise)', () => {
    const cap = TIER_STORAGE_BYTES_CAP.api_starter; // 15 GiB
    const s = computeAccountStorageState({ usedBytes: cap + GiB, tier: 'api_starter' });
    expect(s.state).toBe('hard');
    expect(s.fraction).toBeGreaterThan(1);
  });

  it('enterprise is SOFT-ONLY: never reports hard even over its cap', () => {
    const cap = TIER_STORAGE_BYTES_CAP.enterprise; // 500 GiB
    const atCap = computeAccountStorageState({ usedBytes: cap, tier: 'enterprise' });
    const overCap = computeAccountStorageState({ usedBytes: cap * 2, tier: 'enterprise' });
    expect(atCap.state).toBe('soft');
    expect(overCap.state).toBe('soft');
    expect(atCap.isEnterprise).toBe(true);
    expect(overCap.isEnterprise).toBe(true);
  });

  it('enterprise reports ok below its soft floor', () => {
    const s = computeAccountStorageState({ usedBytes: GiB, tier: 'enterprise' });
    expect(s.state).toBe('ok');
  });

  it('clamps a negative used to 0 (defensive)', () => {
    const s = computeAccountStorageState({ usedBytes: -123, tier: 'solo_manual' });
    expect(s.usedBytes).toBe(0);
    expect(s.fraction).toBe(0);
    expect(s.state).toBe('ok');
  });

  it('zero used → ok, fraction 0', () => {
    const s = computeAccountStorageState({ usedBytes: 0, tier: 'team_manual' });
    expect(s.state).toBe('ok');
    expect(s.fraction).toBe(0);
  });
});

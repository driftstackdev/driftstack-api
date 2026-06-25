// doc-150 item 6 — per-account profile-storage quota math.
//
// The ENFORCED quota is the PER-ACCOUNT TOTAL: the SUM of every live
// (non-trashed) profile's `size_bytes`. The per-profile 1 GiB / 5 GiB
// rails from doc-150 are NOT customer-facing-enforced — the 256 MiB-per-
// blob harness backstop already bounds one profile; those stay internal.
//
// This module is PURE: it takes the already-summed `usedBytes` plus the
// account `tier` and derives the quota state. The enforcement decision
// (block / warn / allow) is made by the caller:
//   - session-launch (hard): refuse a profile-backed create when
//     `state === 'hard'` (and the tier isn't enterprise).
//   - dashboard (soft): surface the `'soft'` state at >= 80% but never block.
//
// Enterprise is SOFT-ONLY: its cap (TIER_STORAGE_BYTES_CAP.enterprise) is
// an alert floor, so `state` is capped at `'soft'` for enterprise — it can
// reach/exceed the floor but never reports `'hard'`, so the launch gate
// never blocks an enterprise account.

import {
  STORAGE_SOFT_WARN_FRACTION,
  TIER_STORAGE_BYTES_CAP,
  type AccountTier,
} from '@driftstack/api-types';

export type StorageQuotaState = 'ok' | 'soft' | 'hard';

export interface AccountStorageState {
  /** Bytes the account currently stores (sum of live profiles' size_bytes). */
  usedBytes: number;
  /** The tier's per-account storage cap in bytes (TIER_STORAGE_BYTES_CAP). */
  capBytes: number;
  /** usedBytes / capBytes. 0 when capBytes is non-positive (defensive). */
  fraction: number;
  /**
   * 'ok'   — under the soft threshold;
   * 'soft' — at/over 80% but under the cap (warn, never block);
   * 'hard' — at/over the cap (block at session-launch, unless enterprise).
   * Enterprise never reaches 'hard' (soft-only — see module header).
   */
  state: StorageQuotaState;
  /** True for enterprise — the cap is a soft alert floor, never a hard block. */
  isEnterprise: boolean;
}

/**
 * Derive the per-account storage quota state from the summed bytes + tier.
 * Pure; no side effects, no I/O. `usedBytes` is clamped at 0 (a negative
 * sum is never legitimate). Enterprise is soft-only: its state is capped at
 * 'soft' so the hard launch gate never blocks it.
 */
export function computeAccountStorageState(args: {
  usedBytes: number;
  tier: AccountTier;
}): AccountStorageState {
  const usedBytes = Math.max(0, args.usedBytes);
  const capBytes = TIER_STORAGE_BYTES_CAP[args.tier];
  const isEnterprise = args.tier === 'enterprise';
  const fraction = capBytes > 0 ? usedBytes / capBytes : 0;

  let state: StorageQuotaState;
  if (fraction >= 1) {
    // Enterprise is soft-only — over the floor still reports 'soft', so the
    // launch gate (which blocks only on 'hard') never refuses an enterprise
    // account.
    state = isEnterprise ? 'soft' : 'hard';
  } else if (fraction >= STORAGE_SOFT_WARN_FRACTION) {
    state = 'soft';
  } else {
    state = 'ok';
  }

  return { usedBytes, capBytes, fraction, state, isEnterprise };
}

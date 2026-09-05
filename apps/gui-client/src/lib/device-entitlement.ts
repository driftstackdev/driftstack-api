// P-15 (2026-09-05) — the desktop pickers know the account's tier.
//
// Both create surfaces used to preselect the iPhone 17 for every account and show a
// free account all 81 devices as selectable, so a free customer picked a paid device,
// pressed Create and got a 403 with an upgrade sentence. The server's per-tier default
// (api-types defaultArchetypeIdForTier) was unreachable from the app, which always
// sends a device. These helpers apply the same rule client-side, from the same
// single source: ARCHETYPE_DEVICES_PER_TIER.

import {
  ARCHETYPE_DEVICES_PER_TIER,
  archetypeAllowedForTier,
  defaultArchetypeIdForTier,
  type AccountTier,
} from '@driftstack/sdk';

function asTier(tier: string | undefined): AccountTier | null {
  return tier !== undefined && Object.hasOwn(ARCHETYPE_DEVICES_PER_TIER, tier)
    ? (tier as AccountTier)
    : null;
}

/** Whether `archetypeId` is a device this tier may run. Unknown tier → not restricted. */
export function isEntitled(tier: string | undefined, archetypeId: string): boolean {
  const t = asTier(tier);
  return t === null ? true : archetypeAllowedForTier(t, archetypeId);
}

/** The device to preselect: the tier's default when the tier is known, else `fallback`. */
export function initialArchetypeForTier(tier: string | undefined, fallback: string): string {
  const t = asTier(tier);
  return t === null ? fallback : defaultArchetypeIdForTier(t);
}

/** The picker's rows with devices outside the entitlement demoted to reference rows. */
export function pickerDevicesForTier<
  T extends { readonly id: string; readonly selectable: boolean },
>(tier: string | undefined, devices: readonly T[]): readonly T[] {
  const t = asTier(tier);
  if (t === null || ARCHETYPE_DEVICES_PER_TIER[t] === null) return devices;
  return devices.map((d) =>
    d.selectable && !archetypeAllowedForTier(t, d.id) ? { ...d, selectable: false } : d,
  );
}

/** One sentence naming the plan's devices, or null when the tier is not restricted. */
export function entitledDevicesNote(tier: string | undefined): string | null {
  const t = asTier(tier);
  const allowed = t === null ? null : ARCHETYPE_DEVICES_PER_TIER[t];
  if (allowed === null || allowed === undefined) return null;
  const list =
    allowed.length > 1
      ? `${allowed.slice(0, -1).join(', ')} and ${allowed[allowed.length - 1]}`
      : (allowed[0] ?? '');
  return `Your ${t} plan runs on ${list}; other devices are shown for reference.`;
}

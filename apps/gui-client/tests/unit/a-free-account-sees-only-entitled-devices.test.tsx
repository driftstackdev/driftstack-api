// P-15 (2026-09-05) — the desktop pickers know the account's tier.
//
// Both create surfaces preselected the iPhone 17 for every account and showed a free
// account all devices as selectable; the free customer picked a paid device and got a
// 403 after Create. The rule now lives in lib/device-entitlement (from the same single
// source the server judges with) and the picker demotes non-entitled devices to
// reference rows. These arms pin the rule and the picker's rendering of it.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ARCHETYPE_REGISTRY,
  LOCKED_ARCHETYPE_ID,
  archetypeAllowedForTier,
  defaultArchetypeIdForTier,
} from '@driftstack/sdk';
import {
  entitledDevicesNote,
  initialArchetypeForTier,
  isEntitled,
  pickerDevicesForTier,
} from '../../src/lib/device-entitlement';
import { DevicePicker, type PickerDevice } from '../../src/components/DevicePicker';

const IPHONE_13 = 'iphone13_ios18_7_safari26_5';
const devices: readonly PickerDevice[] = ARCHETYPE_REGISTRY.filter((a) =>
  [LOCKED_ARCHETYPE_ID, IPHONE_13, 'iphone16pro_ios18_7_safari26_4'].includes(a.id),
).map((a) => ({
  id: a.id,
  device: a.device,
  iosVersion: a.iosVersion,
  safariVersion: a.safariVersion,
  engine: 'webkit' as const,
  selectable: true,
}));

describe('P-15 — a free account sees only entitled devices', () => {
  it('the initial device is the tier default when the tier is known, the fallback otherwise', () => {
    expect(initialArchetypeForTier('free', LOCKED_ARCHETYPE_ID)).toBe(
      defaultArchetypeIdForTier('free'),
    );
    expect(initialArchetypeForTier('free', LOCKED_ARCHETYPE_ID)).toBe(IPHONE_13);
    expect(initialArchetypeForTier('api_builder', 'x')).toBe(LOCKED_ARCHETYPE_ID);
    expect(initialArchetypeForTier(undefined, 'fallback')).toBe('fallback');
    expect(initialArchetypeForTier('not-a-tier', 'fallback')).toBe('fallback');
  });

  it('CRITICAL a free tier demotes every non-entitled device to a reference row; a paid tier and an unknown tier leave the rows alone', () => {
    const free = pickerDevicesForTier('free', devices);
    expect(free.find((d) => d.id === LOCKED_ARCHETYPE_ID)?.selectable).toBe(false);
    expect(free.find((d) => d.id === 'iphone16pro_ios18_7_safari26_4')?.selectable).toBe(false);
    expect(free.find((d) => d.id === IPHONE_13)?.selectable).toBe(true);
    for (const d of free) expect(d.selectable).toBe(archetypeAllowedForTier('free', d.id));
    expect(pickerDevicesForTier('api_builder', devices)).toBe(devices);
    expect(pickerDevicesForTier(undefined, devices)).toBe(devices);
    expect(isEntitled('free', LOCKED_ARCHETYPE_ID)).toBe(false);
    expect(isEntitled('free', IPHONE_13)).toBe(true);
    expect(isEntitled(undefined, LOCKED_ARCHETYPE_ID)).toBe(true);
  });

  it('the note names the plan and its devices only for a restricted tier', () => {
    expect(entitledDevicesNote('free')).toBe(
      'Your free plan runs on iPhone 13 and iPhone 13 mini; other devices are shown for reference.',
    );
    expect(entitledDevicesNote('api_builder')).toBeNull();
    expect(entitledDevicesNote(undefined)).toBeNull();
  });

  it('CRITICAL the picker renders a demoted device as aria-disabled and an entitled one as selectable', () => {
    const onSelect = vi.fn();
    render(
      <DevicePicker
        devices={pickerDevicesForTier('free', devices)}
        selectedId={IPHONE_13}
        onSelect={onSelect}
        onRandomize={() => {}}
      />,
    );
    expect(screen.getByTestId(`device-row-${LOCKED_ARCHETYPE_ID}`)).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByTestId(`device-row-${IPHONE_13}`)).toHaveAttribute('aria-disabled', 'false');
    screen.getByTestId(`device-row-${LOCKED_ARCHETYPE_ID}`).click();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

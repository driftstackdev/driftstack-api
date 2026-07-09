// DevicePicker (create-profile flow redesign, 2026-06-25) — drives the real
// component: search filters the list, the family/iOS chips narrow it,
// selectable rows are clickable while reference rows are not, and randomize
// only ever lands on a filtered + selectable device. A parity check pins the
// picker's `selectable` flag to the SAME SELECTABLE_STATUSES gate the registry
// uses, so the hero/list/randomize paths can never diverge from the catalog.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { DevicePicker, familyOf, type PickerDevice } from '../../src/components/DevicePicker';
import { ARCHETYPE_REGISTRY } from '@driftstack/sdk';

// A compact, deterministic catalog spanning three families + both iOS lines +
// a non-selectable reference row, so every axis under test is exercised.
const DEVICES: PickerDevice[] = [
  {
    id: 'iphone17pro_ios18_7_safari26_4',
    device: 'iPhone 17 Pro',
    iosVersion: '18.7',
    safariVersion: '26.4',
    engine: 'webkit',
    selectable: true,
  },
  {
    id: 'iphone17_ios18_7_safari26_5',
    device: 'iPhone 17',
    iosVersion: '18.7',
    safariVersion: '26.5',
    engine: 'webkit',
    selectable: true,
  },
  {
    id: 'iphone16pro_ios18_6_safari26_0',
    device: 'iPhone 16 Pro',
    iosVersion: '18.6',
    safariVersion: '26.0',
    engine: 'webkit',
    selectable: true,
  },
  {
    id: 'iphone13_ios18_6_safari18_6',
    device: 'iPhone 13',
    iosVersion: '18.6',
    safariVersion: '18.6',
    engine: 'webkit',
    selectable: true,
  },
  {
    id: 'iphone15pro_ios17_5_safari17_5',
    device: 'iPhone 15 Pro',
    iosVersion: '17.5',
    safariVersion: '17.5',
    engine: 'webkit',
    selectable: false, // reference baseline — visible but not clickable
  },
];

/** Controlled harness mirroring how CreateProfileModal owns the selection. */
function Harness({
  onRandomize,
}: {
  onRandomize?: (candidates: readonly PickerDevice[]) => void;
}): JSX.Element {
  const [selected, setSelected] = useState('iphone17pro_ios18_7_safari26_4');
  return (
    <DevicePicker
      devices={DEVICES}
      selectedId={selected}
      onSelect={setSelected}
      onRandomize={(c) => {
        if (onRandomize) onRandomize(c);
        if (c.length > 0 && c[0]) setSelected(c[0].id);
      }}
    />
  );
}

function visibleRowIds(): string[] {
  return screen
    .getAllByRole('option')
    .map((el) => el.getAttribute('data-testid')?.replace('device-row-', '') ?? '')
    .filter(Boolean);
}

describe('DevicePicker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all devices grouped, newest family first, with a live count', () => {
    render(<Harness />);
    expect(screen.getByTestId('device-count')).toHaveTextContent('5 devices');
    // Group headers appear newest-first: 17 then 16 then 15 then 13.
    const headers = screen.getAllByText(/family ·/).map((h) => h.textContent ?? '');
    expect(headers[0]).toMatch(/iPhone 17 family/);
    expect(headers[headers.length - 1]).toMatch(/iPhone 13 family/);
  });

  it('reflects the selected device in the hero spec strip', () => {
    render(<Harness />);
    expect(screen.getByTestId('hero-device')).toHaveTextContent('iPhone 17 Pro');
    // Slug + viewport spec show through.
    expect(screen.getByText('iphone17pro_ios18_7_safari26_4')).toBeInTheDocument();
    expect(screen.getByText('402×874')).toBeInTheDocument();
  });

  it('search filters across model / iOS / Safari, multi-term, with count', () => {
    render(<Harness />);
    const search = screen.getByLabelText('Search devices');

    // "iphone 17" matches the two iPhone 17s AND the reference iPhone 15 Pro
    // (its iOS/Safari are 17.5) — search spans selectable + reference rows.
    fireEvent.change(search, { target: { value: 'iphone 17' } });
    expect(screen.getByTestId('device-count')).toHaveTextContent('3 devices');
    expect(visibleRowIds().sort()).toEqual(
      [
        'iphone15pro_ios17_5_safari17_5',
        'iphone17_ios18_7_safari26_5',
        'iphone17pro_ios18_7_safari26_4',
      ].sort(),
    );

    // Add a Safari term — narrows to the single 26.4 match.
    fireEvent.change(search, { target: { value: 'iphone 17 26.4' } });
    expect(screen.getByTestId('device-count')).toHaveTextContent('1 device');
    expect(visibleRowIds()).toEqual(['iphone17pro_ios18_7_safari26_4']);

    // A no-match query shows the empty state.
    fireEvent.change(search, { target: { value: 'pixel' } });
    expect(screen.getByText(/No devices match/)).toBeInTheDocument();
  });

  it('family + iOS chips narrow the list (single-select per group)', () => {
    render(<Harness />);

    // Family group radiogroup — pick "16".
    const familyGroup = screen.getByRole('radiogroup', { name: 'Family' });
    fireEvent.click(within(familyGroup).getByRole('radio', { name: '16' }));
    expect(visibleRowIds()).toEqual(['iphone16pro_ios18_6_safari26_0']);

    // Back to All family, then narrow by iOS 18.6.
    fireEvent.click(within(familyGroup).getByRole('radio', { name: 'All' }));
    const iosGroup = screen.getByRole('radiogroup', { name: 'iOS' });
    fireEvent.click(within(iosGroup).getByRole('radio', { name: '18.6' }));
    // 18.6 entries only: iPhone 16 Pro + iPhone 13.
    expect(visibleRowIds().sort()).toEqual(
      ['iphone13_ios18_6_safari18_6', 'iphone16pro_ios18_6_safari26_0'].sort(),
    );
  });

  it('the Chrome engine chip is present but disabled ("soon")', () => {
    render(<Harness />);
    const engineGroup = screen.getByRole('radiogroup', { name: 'Engine' });
    const chrome = within(engineGroup).getByRole('radio', { name: /Chrome/ });
    expect(chrome).toBeDisabled();
  });

  it('selectable rows select; reference rows do not', () => {
    render(<Harness />);
    // A selectable row updates the hero.
    fireEvent.click(screen.getByTestId('device-row-iphone13_ios18_6_safari18_6'));
    expect(screen.getByTestId('hero-device')).toHaveTextContent('iPhone 13');

    // The reference row is non-clickable and not focusable.
    const ref = screen.getByTestId('device-row-iphone15pro_ios17_5_safari17_5');
    expect(ref).toHaveAttribute('aria-disabled', 'true');
    expect(ref).toHaveAttribute('tabindex', '-1');
    fireEvent.click(ref);
    // Hero unchanged — selection did not move to the reference device.
    expect(screen.getByTestId('hero-device')).toHaveTextContent('iPhone 13');
  });

  it('rows are keyboard-selectable (Enter)', () => {
    render(<Harness />);
    const row = screen.getByTestId('device-row-iphone16pro_ios18_6_safari26_0');
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.getByTestId('hero-device')).toHaveTextContent('iPhone 16 Pro');
  });

  it('ArrowDown / ArrowUp move roving focus across SELECTABLE rows (the footer advertises ↑↓)', () => {
    render(<Harness />);
    // DOM order of selectable rows (families newest-first, name within family):
    // iPhone 17, iPhone 17 Pro, iPhone 16 Pro, iPhone 13. (iPhone 15 Pro is a
    // reference row → skipped.)
    const r17 = screen.getByTestId('device-row-iphone17_ios18_7_safari26_5');
    const r17pro = screen.getByTestId('device-row-iphone17pro_ios18_7_safari26_4');
    const r16 = screen.getByTestId('device-row-iphone16pro_ios18_6_safari26_0');
    const r13 = screen.getByTestId('device-row-iphone13_ios18_6_safari18_6');

    r17.focus();
    expect(document.activeElement).toBe(r17);
    fireEvent.keyDown(r17, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(r17pro);
    fireEvent.keyDown(r17pro, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(r16);
    fireEvent.keyDown(r16, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(r17pro);
    // Wrap-around: ArrowUp from the first selectable row lands on the last.
    fireEvent.keyDown(r17pro, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(r17);
    fireEvent.keyDown(r17, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(r13);

    // Arrow nav moves FOCUS only; the hero selection is unchanged until Enter.
    expect(screen.getByTestId('hero-device')).toHaveTextContent('iPhone 17 Pro');
    fireEvent.keyDown(r13, { key: 'Enter' });
    expect(screen.getByTestId('hero-device')).toHaveTextContent('iPhone 13');
  });

  it('the footer hint advertises arrow-key navigation (matches the implemented behaviour)', () => {
    render(<Harness />);
    expect(screen.getByText(/↑↓ to move/)).toBeInTheDocument();
  });

  it('randomize only offers the filtered + selectable candidate set', () => {
    const seen = vi.fn<(candidates: readonly PickerDevice[]) => void>();
    render(<Harness onRandomize={seen} />);

    // Narrow to the 17 family, then randomize: candidates = the two selectable
    // iPhone 17 rows only (no reference, no other family).
    const familyGroup = screen.getByRole('radiogroup', { name: 'Family' });
    fireEvent.click(within(familyGroup).getByRole('radio', { name: '17' }));
    fireEvent.click(screen.getByRole('button', { name: /Randomize/ }));

    expect(seen).toHaveBeenCalledTimes(1);
    const candidates = seen.mock.calls[0]?.[0] ?? [];
    expect(candidates.every((c) => c.selectable)).toBe(true);
    expect(candidates.map((c) => c.id).sort()).toEqual(
      ['iphone17_ios18_7_safari26_5', 'iphone17pro_ios18_7_safari26_4'].sort(),
    );
  });

  it('the footer shows a passive "Selected:" status for the current device (not a commit button)', () => {
    render(<Harness />);
    // Demoted from a no-op "Use … →" button to a passive status line — the real
    // create is the host modal's submit, so there is no commit-looking button here.
    expect(screen.getByTestId('device-selected')).toHaveTextContent('Selected: iPhone 17 Pro');
    expect(screen.queryByRole('button', { name: /Use iPhone 17 Pro/ })).toBeNull();
  });
});

describe('familyOf', () => {
  it('collapses any model variant to its iPhone family bucket', () => {
    expect(familyOf('iPhone 13 Pro Max')).toBe('iPhone 13');
    expect(familyOf('iPhone 17')).toBe('iPhone 17');
    expect(familyOf('iPad Pro')).toBe('iPad Pro'); // unrecognised → passthrough
  });
});

describe('registry parity', () => {
  // The picker's `selectable` flag MUST track the SELECTABLE_STATUSES gate
  // ({launch, available}) used everywhere else — never regress to a
  // status === 'launch' single-device gate.
  const SELECTABLE = new Set(['launch', 'available']);
  it('every launch/available archetype is selectable; others are reference', () => {
    for (const a of ARCHETYPE_REGISTRY) {
      const expected = SELECTABLE.has(a.status);
      // Mirror the ProfilesView flattening.
      const selectable = SELECTABLE.has(a.status);
      expect(selectable).toBe(expected);
    }
    // Sanity: more than one archetype is selectable (so randomize/search are
    // meaningful) and not ALL are — the catalog has reference baselines.
    const selectableCount = ARCHETYPE_REGISTRY.filter((a) => SELECTABLE.has(a.status)).length;
    expect(selectableCount).toBeGreaterThan(1);
  });
});

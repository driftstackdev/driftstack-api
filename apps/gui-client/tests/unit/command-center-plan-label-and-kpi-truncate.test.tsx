// T-18 — the Command Center Plan label overflowed its box. Two independent
// defects, one guard each:
//
//   (a) The Plan KPI rendered the account tier through a local title-caser that
//       only uppercased the first character, so 'agency_manual' showed as
//       "Agency_manual" (and 'api_builder' as "Api_builder") — a raw enum key,
//       not a human label. The fix resolves the tier through the canonical
//       TIER_LABEL map (the same one TierBadge uses): 'agency_manual' → "Agency".
//
//   (b) The Kpi value span had no width guard, so a long value escaped the
//       rounded card border of its ~147px 4-up grid slot. The fix adds `truncate`
//       (clip + ellipsis) and a `title` carrying the full value, protecting
//       EVERY Kpi value, not just Plan.
//
// Each mutation was planted at the production site and watched go red:
//   (a) restoring the title-caser (Plan shows "Agency_manual") → the label arm reds.
//   (b) removing `truncate` from the value span → the truncate arm reds.
// The VACUITY CONTROL renders a short, agreeing value ("Free") that does NOT
// discriminate the label bug (old title-caser and new map both produce "Free"),
// proving the tile renders a value at all and that truncate/title leave a short
// value's text intact — so the arms above are not vacuously green on an absent
// tile.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { HomeNavTarget } from '../../src/views/CommandCenterView';

let accountMe: unknown = null;
let client: unknown = null;
let activeWorkspace: string | null = null;
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    settings: { apiKey: null },
    accountMe,
    client,
    activeWorkspace,
    refreshAccountMe: () => Promise.resolve(),
  }),
}));

const { CommandCenterView } = await import('../../src/views/CommandCenterView');

// A well-formed account; `tier` is the knob each test turns. No client, so the
// async strips show their connect placeholders and the KPI tiles — which render
// synchronously from accountMe — are all this file asserts on.
const ACC = {
  id: 'acct_t18',
  tier: 'free',
  concurrent_session_active: 0,
  concurrent_session_cap: 10,
  profile_count: 0,
  profile_cap: 10,
};

function nav() {
  return vi.fn<(k: HomeNavTarget) => void>();
}

/** The Plan KPI card — walked up from its "Plan" section label to the card
 *  wrapper (the ancestor carrying the shared `rounded-xl` card chrome). */
function planCard(): HTMLElement {
  const card = screen.getByText('Plan').closest('.rounded-xl');
  if (card === null) throw new Error('Plan KPI card not found');
  return card as HTMLElement;
}

describe('Command Center Plan label + KPI truncate (T-18)', () => {
  beforeEach(() => {
    cleanup();
    accountMe = null;
    client = null;
    activeWorkspace = null;
  });

  it('resolves the tier through the canonical label map — "agency_manual" → "Agency"', () => {
    accountMe = { ...ACC, tier: 'agency_manual' };
    render(<CommandCenterView onNavigate={nav()} />);
    // The human label, not the raw enum key.
    const planValue = screen.getByText('Agency');
    expect(planValue).toBeInTheDocument();
    expect(screen.queryByText('Agency_manual')).toBeNull();
    // …and it is the Plan tile that shows it.
    expect(planCard().textContent).toContain('Agency');
    expect(planCard().textContent).not.toContain('Agency_manual');
  });

  it('the Kpi value span carries `truncate`, with the full value on `title`', () => {
    accountMe = { ...ACC, tier: 'agency_manual' };
    render(<CommandCenterView onNavigate={nav()} />);
    const planValue = screen.getByText('Agency');
    // The width guard that keeps a long value inside the rounded card border.
    expect(planValue.className).toContain('truncate');
    // The full value stays available on hover after truncation.
    expect(planValue).toHaveAttribute('title', 'Agency');
  });

  it('VACUITY CONTROL — a short, agreeing value ("Free") renders intact and unaltered', () => {
    accountMe = { ...ACC, tier: 'free' };
    render(<CommandCenterView onNavigate={nav()} />);
    // 'free' is a value where the OLD title-caser and the NEW map agree ("Free"),
    // so this arm does not discriminate the label bug. It proves the Plan tile
    // renders a value at all, and that truncate/title leave a short value's text
    // content untouched (only the CSS would clip, and only when it overflows).
    const planValue = screen.getByText('Free');
    expect(planValue).toBeInTheDocument();
    expect(planValue.textContent).toBe('Free');
    expect(planValue).toHaveAttribute('title', 'Free');
  });
});

// T-18 — the Command Center Plan label overflowed its box. Two independent
// defects, one guard each:
//
//   (a) The Plan KPI rendered the account tier through a local title-caser that
//       only uppercased the first character, so 'agency_manual' showed as
//       "Agency_manual" (and 'api_builder' as "Api_builder") — a raw enum key,
//       not a human label. The fix resolves the tier through the canonical
//       TIER_LABEL map (the same one TierBadge uses): 'agency_manual' → "Agency".
//
//   (b) The plan tier is a CATEGORY, not a number, and the numeric KPI treatment
//       (`mono text-3xl … truncate`) clipped a long label like "Enterprise" to
//       "Enterpr…" at the card edge — the cut-off word the owner reported as the
//       plan "falling out of the box". The fix renders the Plan value as a
//       <TierBadge> pill (a content-sized chip that shows the FULL label and
//       cannot be clipped), while the numeric KPIs keep `truncate` for any long
//       numeric value. Verified with a faithful headless render of the 0.1.23 vs
//       fixed structure (scratchpad/kpi-render.png): 0.1.23 clips to "Enterpr…";
//       the badge shows the whole word.
//
// Each mutation was planted at the production site and watched go red:
//   (a) restoring the title-caser (Plan shows "Agency_manual") → the label arm reds.
//   (b) dropping `valueNode` so Plan falls back to the big-number span → the badge
//       arm reds (no role="status" chip; a `text-3xl` value reappears in the card).
//   (b′) removing `truncate` from the numeric value span → the numeric-truncate arm reds.
// The VACUITY CONTROL renders a short value ("Free") and asserts the badge still
// renders it as a chip — so the arms above are not vacuously green on an absent tile.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
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

/** A KPI card — walked up from its section label to the card wrapper (the
 *  ancestor carrying the shared `rounded-xl` card chrome). */
function cardFor(label: string): HTMLElement {
  const card = screen.getByText(label).closest('.rounded-xl');
  if (card === null) throw new Error(`${label} KPI card not found`);
  return card as HTMLElement;
}

describe('Command Center Plan label + KPI treatment (T-18)', () => {
  beforeEach(() => {
    cleanup();
    accountMe = null;
    client = null;
    activeWorkspace = null;
  });

  it('resolves the tier through the canonical label map — "agency_manual" → "Agency"', () => {
    accountMe = { ...ACC, tier: 'agency_manual' };
    render(<CommandCenterView onNavigate={nav()} />);
    // The human label, not the raw enum key — rendered inside the Plan tile.
    expect(screen.getByText('Agency')).toBeInTheDocument();
    expect(screen.queryByText('Agency_manual')).toBeNull();
    expect(cardFor('Plan').textContent).toContain('Agency');
    expect(cardFor('Plan').textContent).not.toContain('Agency_manual');
  });

  it('renders the plan as a TierBadge chip, NOT the clippable big-number span', () => {
    accountMe = { ...ACC, tier: 'enterprise' };
    render(<CommandCenterView onNavigate={nav()} />);
    const plan = cardFor('Plan');
    // The value is the badge (role="status", labelled by tier) showing the FULL word…
    const badge = within(plan).getByRole('status', { name: 'Tier: Enterprise' });
    expect(badge.textContent).toBe('Enterprise');
    // …and the Plan card carries NO `text-3xl` value span — the numeric treatment
    // that clips "Enterprise" to "Enterpr…" is gone from this tile. (Mutation:
    // drop `valueNode` → Plan falls back to the big-number span → this reds.)
    expect(plan.querySelector('.text-3xl')).toBeNull();
  });

  it('the numeric KPIs keep `truncate` on their big-number value span', () => {
    accountMe = { ...ACC, tier: 'enterprise', profile_count: 0, profile_cap: 10 };
    render(<CommandCenterView onNavigate={nav()} />);
    // Profiles is a numeric KPI (value from accountMe, rendered synchronously).
    const profiles = cardFor('Profiles');
    const valueSpan = profiles.querySelector('.text-3xl');
    expect(valueSpan).not.toBeNull();
    // The width guard that keeps a long numeric value inside the card border.
    // (Mutation: remove `truncate` from the value span → this reds.)
    expect(valueSpan?.className).toContain('truncate');
  });

  it('VACUITY CONTROL — a short tier ("Free") still renders as a chip', () => {
    accountMe = { ...ACC, tier: 'free' };
    render(<CommandCenterView onNavigate={nav()} />);
    // 'free' is a value where the OLD title-caser and the NEW map agree ("Free"),
    // so this arm does not discriminate the label bug. It proves the Plan tile
    // renders its badge at all — the arms above are not vacuously green on an
    // absent tile.
    const badge = within(cardFor('Plan')).getByRole('status', { name: 'Tier: Free' });
    expect(badge.textContent).toBe('Free');
  });
});

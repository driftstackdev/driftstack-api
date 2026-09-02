// Absent data must never be rendered as a measurement.
//
// Three surfaces derived a definite claim from a value that had not loaded, all
// via a `?? 0` that turned "we do not know" into "the answer is zero":
//
//  1. The Active KPI summed a known driver count with an UNKNOWN agent count and
//     printed the result. Driver 0 + agents-unknown printed a confident "0"
//     while a phone was running.
//  2. Home's onboarding checklist derived "Launch a session — not done" from the
//     same unknown count, so a fetch failure told a returning user they had
//     never launched anything.
//  3. Profiles' checklist rendered before `accountMe` existed at all, so every
//     step was computed from `?? 0` over absent data — a first-run checklist
//     shown to an account with profiles and sessions.
//
// These are guards, not behaviour tests: each asserts the honest rendering that
// the coercion destroyed, so restoring any `?? 0` turns one red.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { OnboardingChecklist } from '../../src/components/OnboardingChecklist';
import { buildOnboardingSteps } from '../../src/lib/use-onboarding-steps';

let accountMe: unknown = null;
let client: unknown = null;
let settingsApiKey: string | null = null;
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    settings: { apiKey: settingsApiKey },
    accountMe,
    client,
    activeWorkspace: null,
    refreshAccountMe: () => Promise.resolve(),
  }),
}));

const { CommandCenterView } = await import('../../src/views/CommandCenterView');

const emptyPage = () => Promise.resolve({ data: [], has_more: false, next_cursor: null });

/** A client whose strips all resolve empty, so a test exercising the agent-session
 *  count does not crash on an unrelated effect. `agentSessions` is the knob. */
function makeClient(agentSessions?: () => Promise<unknown>) {
  return {
    sessions: { list: emptyPage },
    auditLog: { list: emptyPage },
    profiles: { list: emptyPage },
    agentSessions: { list: agentSessions ?? emptyPage },
  };
}

/** The Active KPI's rendered value — the Kpi card puts the label and the value in
 *  sibling spans, so read the card and strip the label off the front. */
function activeKpiValue(): string {
  const label = screen.getByText('Active');
  const card = label.parentElement?.parentElement;
  return (card?.textContent ?? '').replace('Active', '').trim();
}

beforeEach(() => {
  accountMe = null;
  client = null;
  settingsApiKey = null;
});
afterEach(() => {
  cleanup();
});

describe('an unknown step is neither done nor the next action', () => {
  const steps = (launch: boolean | null) => [
    { id: 'connect', label: 'Connect your account', done: true },
    { id: 'profile', label: 'Create a profile', done: true },
    { id: 'launch', label: 'Launch a session', done: launch, go: vi.fn() },
  ];

  // Mutation note: reverting the doneCount filter to `steps.filter(s => s.done)`
  // is a NO-OP, not an uncovered mutation. `done` is `boolean | null`, and the
  // only falsy values in that type are `false` and `null` — both of which must
  // be excluded — so the truthy test and the `=== true` test agree on every
  // input the type admits. No assertion can distinguish them; do not chase it.
  it('does not count an unknown step as done', () => {
    render(<OnboardingChecklist steps={steps(null)} onDismiss={vi.fn()} />);
    // 2/3, not 3/3 — an unknown must not inflate progress.
    expect(screen.getByText('2/3')).toBeTruthy();
  });

  it('does not let an unknown step auto-hide the card', () => {
    // Every KNOWN step is done; only the unknown is outstanding. The card must
    // still render, because "all done" is not something we can claim.
    const { container } = render(<OnboardingChecklist steps={steps(null)} onDismiss={vi.fn()} />);
    expect(container.querySelector('[data-component="onboarding-checklist"]')).toBeTruthy();
  });

  it('does not offer an unknown step as a click-through', () => {
    // `go` is supplied, but an unknown step must not become a call to action —
    // we cannot send someone somewhere on data we do not have.
    render(<OnboardingChecklist steps={steps(null)} onDismiss={vi.fn()} />);
    const buttons = screen
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes('Launch a session'));
    expect(buttons).toHaveLength(0);
    expect(screen.getByText('checking…')).toBeTruthy();
  });

  it('does not let an unknown step steal the next-action arrow', () => {
    // Ordering matters: the unknown sits ABOVE a genuinely outstanding step. A
    // `find(s => !s.done)` scan stops at the unknown (null is falsy) and hands
    // the highlight to a step we cannot say is outstanding, leaving the real
    // next action unmarked. The arrow is the user's guidance — it must land on
    // the step we actually know they still have to do.
    render(
      <OnboardingChecklist
        steps={[
          { id: 'connect', label: 'Connect your account', done: true },
          { id: 'launch', label: 'Launch a session', done: null },
          { id: 'profile', label: 'Create a profile', done: false, go: vi.fn() },
        ]}
        onDismiss={vi.fn()}
      />,
    );
    const profileRow = screen.getByText('Create a profile').closest('li');
    const launchRow = screen.getByText('Launch a session').closest('li');
    expect(profileRow?.textContent).toContain('→');
    expect(launchRow?.textContent).not.toContain('→');
  });

  it('still offers a KNOWN-incomplete step as a click-through', () => {
    // Vacuity control: the same step, known false, IS actionable. Without this
    // the test above passes on a component that renders no buttons at all.
    render(<OnboardingChecklist steps={steps(false)} onDismiss={vi.fn()} />);
    const buttons = screen
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes('Launch a session'));
    expect(buttons).toHaveLength(1);
  });

  it('carries a null hasLiveSession through the shared builder', () => {
    const built = buildOnboardingSteps(
      { apiKeyPresent: true, hasProfile: true, hasLiveSession: null },
      { goConnect: vi.fn(), goProfile: vi.fn() },
    );
    expect(built.find((s) => s.id === 'launch')?.done).toBeNull();
  });
});

describe('the Active KPI never prints a definite count from a half-unknown sum', () => {
  it('renders "—", not "0", when the agent count failed to load', async () => {
    accountMe = {
      concurrent_session_active: 0,
      concurrent_session_cap: 10,
      profile_count: 1,
      profile_cap: 10,
    };
    client = makeClient(() => Promise.reject(new Error('network')));
    render(<CommandCenterView onNavigate={vi.fn()} />);
    // "0" here would be the bug: zero drivers plus an unknown number of agent
    // sessions is not zero sessions.
    await waitFor(() => {
      expect(activeKpiValue()).toBe('—');
    });
  });

  it('renders a floor with "+" when the known half is already non-zero', async () => {
    accountMe = {
      concurrent_session_active: 3,
      concurrent_session_cap: 10,
      profile_count: 1,
      profile_cap: 10,
    };
    client = makeClient(() => Promise.reject(new Error('network')));
    render(<CommandCenterView onNavigate={vi.fn()} />);
    // Three drivers are a fact; the agent count is not. "3+" says both.
    await waitFor(() => {
      expect(activeKpiValue()).toBe('3+');
    });
  });

  it('renders an exact total, with no "+", once both halves are known', async () => {
    accountMe = {
      concurrent_session_active: 2,
      concurrent_session_cap: 10,
      profile_count: 1,
      profile_cap: 10,
    };
    client = makeClient(() =>
      Promise.resolve({
        data: [{ id: 'agt_1', status: 'active' }],
        has_more: false,
        next_cursor: null,
      }),
    );
    render(<CommandCenterView onNavigate={vi.fn()} />);
    // Vacuity control for the two above: when nothing is unknown the KPI is a
    // plain number, so the "—"/"+" assertions are about absence, not about the
    // tile always being non-numeric.
    await waitFor(() => {
      expect(activeKpiValue()).toBe('3');
    });
  });
});

describe("Home's checklist does not claim a session was never launched", () => {
  it('shows the launch step as unknown while the agent count is unavailable', async () => {
    settingsApiKey = 'sk_test';
    accountMe = {
      concurrent_session_active: 0,
      concurrent_session_cap: 10,
      profile_count: 1,
      profile_cap: 10,
    };
    client = makeClient(() => Promise.reject(new Error('network')));
    render(<CommandCenterView onNavigate={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Launch a session')).toBeTruthy();
    });
    // The step is present but unclaimed — no strike-through, no arrow, no link.
    expect(screen.getByText('checking…')).toBeTruthy();
  });
});

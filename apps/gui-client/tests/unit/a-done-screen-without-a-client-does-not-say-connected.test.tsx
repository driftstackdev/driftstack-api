// The first-run wizard's Done screen used to say "Your account is connected"
// no matter what. The profile step it follows can be reached with no SDK
// client — its own Create error reads "Your account isn't connected yet. Skip
// this step and sign in from Settings." — so a customer who did exactly that
// was then told the opposite on the very next screen. The Done screen now says
// what actually happened: the connected sentence only when the client exists,
// otherwise "Sign in from Settings to connect your account."
//
// Drives the REAL wizard (welcome → hosting → paste a key → profile → skip)
// rather than mounting the done step directly, so the guard covers the path a
// customer takes. Mutation that turns the first test red: render the
// connected sentence unconditionally (drop the `client !== null` branch in the
// done step of FirstRunWizard.tsx).
//
// The green check-mark is the same claim in the visual channel, so it branches
// with the copy and is pinned here too. Second mutation that turns the first
// test red: restore the unconditional `✓` glyph above the heading.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Read at call time, so each test picks its own client shape.
let client: unknown = null;
const update = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client, update }),
}));
vi.mock('../../src/lib/browser-sign-in', () => ({
  useBrowserSignIn: () => ({ state: { kind: 'idle' }, start: vi.fn(), cancel: vi.fn() }),
}));

const { FirstRunWizard } = await import('../../src/views/FirstRunWizard');

// validateAndSave builds its own one-shot SDK client and calls account.me()
// over fetch; a 200 with the self-profile shape is all it needs to advance.
const ME = {
  tier: 'personal',
  teams: [],
  concurrent_session_active: 0,
  concurrent_session_cap: 5,
  profile_count: 0,
  profile_cap: 10,
};

beforeEach(() => {
  client = null;
  update.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(ME), { status: 200 }))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function skipThroughToDone(): Promise<void> {
  render(<FirstRunWizard onComplete={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /get started/i }));
  await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
  await userEvent.click(
    screen.getByRole('button', { name: /have an api key\? paste it instead/i }),
  );
  await userEvent.type(screen.getByLabelText(/api key/i), 'ds_live_test_key');
  await userEvent.click(screen.getByRole('button', { name: /check key and continue/i }));
  await screen.findByText(/create your first profile/i);
  // The profile step's own "Skip for now" (the mode/apikey escape hatch is a
  // different button and is not rendered on this step).
  await userEvent.click(screen.getByRole('button', { name: /^skip for now$/i }));
  await screen.findByRole('button', { name: /go to profiles/i });
}

describe('First-run wizard Done screen — says what actually happened', () => {
  it('with no client, the skipped path says to sign in from Settings and never claims the account is connected', async () => {
    client = null;
    await skipThroughToDone();

    expect(screen.getByText(/Sign in from Settings to connect your account\./)).toBeInTheDocument();
    expect(screen.getByText(/Your account isn.t connected yet\./)).toBeInTheDocument();
    expect(screen.queryByText(/Your account is connected\./)).toBeNull();
    // The heading must not over-promise either.
    expect(screen.getByRole('heading', { name: /one more step/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /you.re all set/i })).toBeNull();
    // Nor may the glyph: a success tick over "One more step" is the same
    // claim-what-didn't-happen in the visual channel.
    expect(screen.queryByText('✓')).toBeNull();
    expect(screen.getByText('→')).toBeInTheDocument();
    // The next step is still spelled out: Profiles, once signed in.
    expect(screen.getByText(/Then head to/)).toBeInTheDocument();
  });

  it('POSITIVE CONTROL — with a client, the connected sentence renders and the Settings nudge does not', async () => {
    client = {
      account: { me: () => Promise.resolve({ tier: 'personal' }) },
      profiles: { create: vi.fn(() => Promise.resolve({ id: 'p1' })) },
    };
    await skipThroughToDone();

    expect(screen.getByText(/Your account is connected\./)).toBeInTheDocument();
    expect(screen.queryByText(/Sign in from Settings to connect your account\./)).toBeNull();
    expect(screen.queryByText(/isn.t connected yet/)).toBeNull();
    expect(screen.getByRole('heading', { name: /you.re all set/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /one more step/i })).toBeNull();
    // POSITIVE CONTROL for the glyph branch: the success tick DOES render when
    // the account really is connected, so the assertion above is not vacuous.
    expect(screen.getByText('✓')).toBeInTheDocument();
    expect(screen.queryByText('→')).toBeNull();
  });

  it('the stepper labels the hosting choice "Hosting", not "Deployment"', async () => {
    render(<FirstRunWizard onComplete={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /get started/i }));
    const stepper = screen.getByRole('navigation', { name: /setup progress/i });
    expect(stepper).toHaveTextContent('Hosting');
    expect(stepper).not.toHaveTextContent('Deployment');
  });
});

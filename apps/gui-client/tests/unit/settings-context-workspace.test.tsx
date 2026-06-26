// Cross-account workspace-scope safety for SettingsContext. A persisted/active
// team workspace (sent as X-Driftstack-Account on every request) must NOT leak
// across a sign-out, a deployment (baseUrl) change, or into an account that
// isn't a member of that team. These tests render the REAL provider with the
// underlying client/settings/telemetry modules mocked and assert that the
// active workspace falls back to personal scope in each case.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useSettings, SettingsProvider } from '../../src/lib/SettingsContext';

// ── module mocks ───────────────────────────────────────────────
// loadSettings resolves whatever the test seeds; saveSettings is a no-op.
let seededSettings: { apiKey: string | null; baseUrl: string; telemetryOptIn: boolean | null } = {
  apiKey: 'ds_live_a',
  baseUrl: 'https://api.driftstack.dev',
  telemetryOptIn: null,
};
vi.mock('../../src/lib/settings', () => ({
  DEFAULT_SETTINGS: { apiKey: null, baseUrl: 'http://localhost:3000', telemetryOptIn: null },
  loadSettings: () => Promise.resolve(seededSettings),
  saveSettings: () => Promise.resolve(),
}));
vi.mock('../../src/lib/telemetry', () => ({ initTelemetry: vi.fn() }));

// buildClient returns a stub whose account.me() resolves whatever teams the
// test set. null apiKey → null client (matches the real buildClient contract).
let meTeams: Array<{ owner_account_id: string }> = [];
vi.mock('../../src/lib/client', () => ({
  buildClient: (apiKey: string | null) =>
    apiKey === null
      ? null
      : {
          account: {
            me: () =>
              Promise.resolve({
                tier: 'solo_manual',
                concurrent_session_cap: 5,
                concurrent_session_active: 0,
                profile_cap: 10,
                profile_count: 0,
                teams: meTeams,
              }),
          },
        },
}));

// A consumer that surfaces the live activeWorkspace + lets the test drive
// update() and setActiveWorkspace().
function Probe(): JSX.Element {
  const { activeWorkspace, setActiveWorkspace, update } = useSettings();
  return (
    <div>
      <span data-testid="ws">{activeWorkspace ?? 'personal'}</span>
      <button type="button" onClick={() => setActiveWorkspace('acct_team')}>
        pick-team
      </button>
      <button
        type="button"
        onClick={() => {
          void update({ apiKey: null });
        }}
      >
        sign-out
      </button>
      <button
        type="button"
        onClick={() => {
          void update({ baseUrl: 'http://localhost:3000' });
        }}
      >
        change-base
      </button>
    </div>
  );
}

function renderProvider(): void {
  render(
    <SettingsProvider>
      <Probe />
    </SettingsProvider>,
  );
}

// jsdom in this project's config doesn't ship a usable localStorage; provide a
// minimal Map-backed shim so the context's persistence path is exercised.
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
}

beforeEach(() => {
  installLocalStorage();
  seededSettings = {
    apiKey: 'ds_live_a',
    baseUrl: 'https://api.driftstack.dev',
    telemetryOptIn: null,
  };
  meTeams = [];
});

describe('SettingsContext — workspace scope safety', () => {
  it('clears the active workspace on sign-out (apiKey → null)', async () => {
    localStorage.setItem('ds_active_workspace', 'acct_team');
    meTeams = [{ owner_account_id: 'acct_team' }]; // member, so it survives load
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('ws')).toHaveTextContent('acct_team'));

    screen.getByRole('button', { name: 'sign-out' }).click();

    await waitFor(() => expect(screen.getByTestId('ws')).toHaveTextContent('personal'));
    expect(localStorage.getItem('ds_active_workspace')).toBeNull();
  });

  it('clears the active workspace on a baseUrl (deployment) change', async () => {
    localStorage.setItem('ds_active_workspace', 'acct_team');
    meTeams = [{ owner_account_id: 'acct_team' }];
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('ws')).toHaveTextContent('acct_team'));

    screen.getByRole('button', { name: 'change-base' }).click();

    await waitFor(() => expect(screen.getByTestId('ws')).toHaveTextContent('personal'));
  });

  it('drops a persisted workspace that is not one of the new account’s teams', async () => {
    localStorage.setItem('ds_active_workspace', 'acct_stale');
    meTeams = [{ owner_account_id: 'acct_other' }]; // active key is NOT in acct_stale
    renderProvider();

    // It starts from localStorage, then reconciles to personal once accountMe loads.
    await waitFor(() => expect(screen.getByTestId('ws')).toHaveTextContent('personal'));
    expect(localStorage.getItem('ds_active_workspace')).toBeNull();
  });

  it('keeps a workspace that IS one of the account’s teams', async () => {
    localStorage.setItem('ds_active_workspace', 'acct_team');
    meTeams = [{ owner_account_id: 'acct_team' }];
    renderProvider();
    // Give the accountMe reconcile a chance to run; it must NOT clear a valid one.
    await waitFor(() => expect(screen.getByTestId('ws')).toHaveTextContent('acct_team'));
  });
});

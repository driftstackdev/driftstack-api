// Cross-account workspace-scope safety for SettingsContext. A persisted/active
// team workspace (sent as X-Driftstack-Account on every request) must NOT leak
// across a sign-out, a deployment (baseUrl) change, or into an account that
// isn't a member of that team. These tests render the REAL provider with the
// underlying client/settings/telemetry modules mocked and assert that the
// active workspace falls back to personal scope in each case.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useSettings, SettingsProvider } from '../../src/lib/SettingsContext';

// ── module mocks ───────────────────────────────────────────────
// loadSettings resolves whatever the test seeds; saveSettings can be failed to
// prove the provider's default best-effort vs explicit-reporting boundary.
let seededSettings: { apiKey: string | null; baseUrl: string; telemetryOptIn: boolean | null } = {
  apiKey: 'ds_live_a',
  baseUrl: 'https://api.driftstack.dev',
  telemetryOptIn: null,
};
let persistError: Error | null = null;
let lastCredentialUnchanged: boolean | undefined;
vi.mock('../../src/lib/settings', () => ({
  DEFAULT_SETTINGS: { apiKey: null, baseUrl: 'http://localhost:3000', telemetryOptIn: null },
  loadSettings: () => Promise.resolve(seededSettings),
  saveSettings: (_settings: unknown, options?: { credentialUnchanged?: boolean }) => {
    lastCredentialUnchanged = options?.credentialUnchanged;
    return persistError === null ? Promise.resolve() : Promise.reject(persistError);
  },
}));
vi.mock('../../src/lib/telemetry', () => ({ initTelemetry: vi.fn() }));

// buildClient returns a stub whose account.me() resolves whatever teams the
// test set. null apiKey → null client (matches the real buildClient contract).
// account.me() echoes the apiKey into the email so a test can assert WHICH
// account's profile is surfaced (P2 #4 stale-across-switch); meReject makes the
// fetch throw to exercise the fail-closed + cleared-on-switch path.
let meTeams: Array<{ owner_account_id: string }> = [];
let meReject = false;
vi.mock('../../src/lib/client', () => ({
  buildClient: (apiKey: string | null) =>
    apiKey === null
      ? null
      : {
          account: {
            me: () =>
              meReject
                ? Promise.reject(new Error('unauthorized'))
                : Promise.resolve({
                    email: `${apiKey}@example.com`,
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
  const { activeWorkspace, setActiveWorkspace, update, accountMe, settings } = useSettings();
  const [persistOutcome, setPersistOutcome] = useState('idle');
  return (
    <div>
      <span data-testid="ws">{activeWorkspace ?? 'personal'}</span>
      <span data-testid="me-email">{accountMe?.email ?? 'none'}</span>
      <span data-testid="persist-outcome">{persistOutcome}</span>
      <span data-testid="current-base">{settings.baseUrl}</span>
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
          void update({ apiKey: 'ds_live_b' });
        }}
      >
        switch-account
      </button>
      <button
        type="button"
        onClick={() => {
          void update({ baseUrl: 'http://localhost:3000' });
        }}
      >
        change-base
      </button>
      <button
        type="button"
        onClick={() => {
          void update(
            { baseUrl: 'https://reported.example.com' },
            { reportPersistenceFailure: true },
          ).then(
            () => setPersistOutcome('saved'),
            () => setPersistOutcome('failed'),
          );
        }}
      >
        report-save
      </button>
      <button
        type="button"
        onClick={() => {
          void update({ baseUrl: 'https://background.example.com' }).then(
            () => setPersistOutcome('best-effort'),
            () => setPersistOutcome('unexpected-rejection'),
          );
        }}
      >
        background-save
      </button>
      <button
        type="button"
        onClick={() => {
          void update({ telemetryOptIn: true }).then(() => setPersistOutcome('preferences-saved'));
        }}
      >
        preferences-save
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
  meReject = false;
  persistError = null;
  lastCredentialUnchanged = undefined;
});

describe('SettingsContext — persistence outcome boundary', () => {
  it('rejects only when an explicit save asks to report persistence failure', async () => {
    persistError = new Error('credential store locked');
    renderProvider();

    screen.getByRole('button', { name: 'report-save' }).click();
    await waitFor(() => expect(screen.getByTestId('persist-outcome')).toHaveTextContent('failed'));
    expect(screen.getByTestId('current-base')).toHaveTextContent('https://api.driftstack.dev');

    screen.getByRole('button', { name: 'background-save' }).click();
    await waitFor(() =>
      expect(screen.getByTestId('persist-outcome')).toHaveTextContent('best-effort'),
    );
    expect(screen.getByTestId('current-base')).toHaveTextContent('https://background.example.com');
  });

  it('marks preferences-only updates so persistence skips credential access', async () => {
    renderProvider();

    screen.getByRole('button', { name: 'preferences-save' }).click();
    await waitFor(() =>
      expect(screen.getByTestId('persist-outcome')).toHaveTextContent('preferences-saved'),
    );
    expect(lastCredentialUnchanged).toBe(true);
  });
});

// P2 #4 — accountMe must NOT show the previous account's email/tier/caps after an
// account or deployment switch. The fail-closed catch keeps the last-known me on a
// transient blip for the SAME account, but a real identity change must clear it.
describe('SettingsContext — accountMe freshness across account/deployment switch', () => {
  it('clears + re-fetches accountMe when the apiKey (account) changes', async () => {
    renderProvider();
    // Initial account A's email is surfaced.
    await waitFor(() =>
      expect(screen.getByTestId('me-email')).toHaveTextContent('ds_live_a@example.com'),
    );
    // Switch to account B.
    screen.getByRole('button', { name: 'switch-account' }).click();
    // It must NOT keep showing A; it ends on B's email (cleared then re-fetched).
    await waitFor(() =>
      expect(screen.getByTestId('me-email')).toHaveTextContent('ds_live_b@example.com'),
    );
  });

  it('does NOT pin the previous account when the new fetch FAILS (no stale leak)', async () => {
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId('me-email')).toHaveTextContent('ds_live_a@example.com'),
    );
    // The next account's me() fails (e.g. a bad key on the switched deployment).
    meReject = true;
    screen.getByRole('button', { name: 'switch-account' }).click();
    // The prior account's email must be CLEARED (shown as 'none'), not pinned.
    await waitFor(() => expect(screen.getByTestId('me-email')).toHaveTextContent('none'));
  });
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

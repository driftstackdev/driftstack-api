// "Get set up" is first-time-only.
//
// Owner (T-13, 2026-09-03): "Get set up" keeps coming back even after a
// customer launched a session and later removed it; it should be first-time
// only. MEASURED: OnboardingChecklist returned null only while
// doneCount === steps.length, and the steps are re-derived from LIVE counts on
// every render (profile_count, concurrent_session_active, agent sessions). The
// only durable flag was ds_onboarding_dismissed, set ONLY by the ✕. So: launch
// → 3/3 → hidden; remove the session → 2/3 → the card came back to someone who
// had already finished it.
//
// The fix: the checklist emits onCompleted the first time it sees every step
// done; both surfaces persist that as ds_onboarding_completed and gate on it.
// These arms drive the REAL views (not the checklist alone) because the gate
// under test lives in the views: dropping `!completed` from a view's gate is a
// regression the checklist cannot see.
//
// Mutations this guard must catch: (1) remove `!onboardingCompleted` from the
// ProfilesView gate → "stays hidden" goes red; (2) never call onCompleted /
// markCompleted → "flag is set" goes red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const COMPLETED_KEY = 'ds_onboarding_completed';

const emptyPage = () => Promise.resolve({ data: [], has_more: false, next_cursor: null });

// Stable references: ProfilesView keys effects on useSettings() identity, so
// the mock returns ONE object and each arm mutates its fields before render.
const stable = {
  client: {
    profiles: {
      list: emptyPage,
      iterate: function* () {
        /* empty — no profiles */
      },
    },
    sessions: { list: emptyPage },
    auditLog: { list: emptyPage },
    agentSessions: { list: emptyPage },
  },
  settings: { apiKey: 'ds_test_x' as string | null, baseUrl: 'http://localhost:3000' },
  accountMe: {
    tier: 'solo_manual',
    concurrent_session_cap: 1,
    concurrent_session_active: 0,
    profile_cap: 10,
    profile_count: 0,
    profile_active: 0,
  },
  activeWorkspace: null,
  refreshAccountMe: vi.fn(() => Promise.resolve()),
  loading: false,
  update: vi.fn(() => Promise.resolve()),
};

vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => stable }));

vi.mock('../../src/lib/recordings', () => {
  const rec = {
    recordings: new Map(),
    deleteRecording: vi.fn(() => Promise.resolve()),
    loading: false,
  };
  return {
    useRecordings: () => rec,
    formatDuration: () => '0s',
    recordingDurationMs: () => 0,
    recordingTotalBytes: () => 0,
  };
});

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve([]),
  listProxyMetadata: () => Promise.resolve([]),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');
const { CommandCenterView } = await import('../../src/views/CommandCenterView');

// Map-backed Storage installed on the global, cleared between arms.
const values = new Map<string, string>();
const testStorage: Storage = {
  get length() {
    return values.size;
  },
  clear() {
    values.clear();
  },
  getItem(key) {
    return values.get(key) ?? null;
  },
  key(index) {
    return [...values.keys()][index] ?? null;
  },
  removeItem(key) {
    values.delete(key);
  },
  setItem(key, value) {
    values.set(key, value);
  },
};

/** Every step done: key present, a profile counted, a session live. */
function allDone(): void {
  stable.settings.apiKey = 'ds_test_x';
  stable.accountMe.profile_count = 1;
  stable.accountMe.concurrent_session_active = 1;
}
/** The launched session was removed: 2/3 by the live counts. */
function sessionRemoved(): void {
  stable.settings.apiKey = 'ds_test_x';
  stable.accountMe.profile_count = 1;
  stable.accountMe.concurrent_session_active = 0;
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: testStorage });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: testStorage });
  values.clear();
  sessionRemoved();
});
afterEach(() => {
  cleanup();
  values.clear();
});

describe('Profiles — the checklist is first-time-only', () => {
  it('sets ds_onboarding_completed the first time every step is done', async () => {
    allDone();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => {
      expect(values.get(COMPLETED_KEY)).toBe('1');
    });
    // 3/3 is hidden — that was always true; the flag is what is new.
    expect(screen.queryByText('Get set up')).toBeNull();
  });

  it('stays hidden after the launched session is removed (flag set by the earlier render)', async () => {
    allDone();
    const first = render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => {
      expect(values.get(COMPLETED_KEY)).toBe('1');
    });
    first.unmount();

    sessionRemoved();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    // The heading is on screen (the view rendered) — the checklist is not.
    await screen.findByRole('heading', { name: 'No profiles yet' });
    expect(screen.queryByText('Get set up')).toBeNull();
    expect(document.querySelector('[data-component="onboarding-checklist"]')).toBeNull();
  });

  it('stays hidden on a fresh mount when the flag is already persisted', async () => {
    values.set(COMPLETED_KEY, '1');
    sessionRemoved();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await screen.findByRole('heading', { name: 'No profiles yet' });
    expect(screen.queryByText('Get set up')).toBeNull();
  });

  it('VACUITY CONTROL — no flag + steps incomplete DOES render "Get set up"', async () => {
    sessionRemoved();
    expect(values.get(COMPLETED_KEY)).toBeUndefined();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByText('Get set up')).toBeInTheDocument();
    expect(screen.getByText('2/3')).toBeInTheDocument();
    // Rendering an incomplete checklist must NOT mark it completed.
    expect(values.get(COMPLETED_KEY)).toBeUndefined();
  });
});

describe('Home — the same flag closes the same gate', () => {
  it('sets ds_onboarding_completed the first time every step is done', async () => {
    allDone();
    render(<CommandCenterView onNavigate={vi.fn()} />);
    await waitFor(() => {
      expect(values.get(COMPLETED_KEY)).toBe('1');
    });
    expect(screen.queryByText('Get set up')).toBeNull();
  });

  it('stays hidden on a fresh mount when the flag is already persisted', async () => {
    values.set(COMPLETED_KEY, '1');
    sessionRemoved();
    render(<CommandCenterView onNavigate={vi.fn()} />);
    // Something from the home renders (the KPI label), the checklist does not.
    await screen.findByText('Active');
    expect(screen.queryByText('Get set up')).toBeNull();
  });

  it('VACUITY CONTROL — no flag + steps incomplete DOES render "Get set up"', async () => {
    sessionRemoved();
    render(<CommandCenterView onNavigate={vi.fn()} />);
    expect(await screen.findByText('Get set up')).toBeInTheDocument();
    expect(values.get(COMPLETED_KEY)).toBeUndefined();
  });
});

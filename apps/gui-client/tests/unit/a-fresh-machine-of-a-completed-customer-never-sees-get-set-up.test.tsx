// A fresh machine of a customer who already finished never sees "Get set up".
//
// Owner (T-13, 2026-09-03): "Get set up" should be for first-time customers
// only. The first fix made completion durable ON ONE MACHINE: the checklist
// writes ds_onboarding_completed to localStorage the first time it sees every
// step done, and both surfaces gate on it. MEASURED: that flag never leaves
// the install. A customer who finished on one Mac and installed on a second
// one was greeted as a first-time customer again — the gate read only what
// this machine had seen.
//
// The fix keys completion on the ACCOUNT as well. Two mechanisms, both pinned
// here against the REAL views (the gate under test lives in the views):
//   • SEED — /me carries onboarding_completed_at; useOnboardingCompleted folds
//     it into `completed` in the same render that sees the account, so the
//     card never paints on a fresh machine, and persists it locally.
//   • MIRROR — the first local completion fires ONE best-effort
//     PATCH /v1/account/me {onboarding_completed:true}. A failure never throws
//     and never blocks the local hide.
// The account only ever ADDS completion — a completion this machine recorded
// stands when the account says nothing.
//
// Mutations this guard must catch: (a) ignore the account value in the gate
// (completed = local flag only) → "fresh machine" goes red; (b) drop the PATCH
// from markCompleted → "exactly one PATCH" goes red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type * as SettingsModule from '../../src/lib/settings';

const COMPLETED_KEY = 'ds_onboarding_completed';
const FINISHED_ELSEWHERE = '2026-09-03T00:00:00Z';

const emptyPage = () => Promise.resolve({ data: [], has_more: false, next_cursor: null });

/** The flat /v1/account/me shape the views read, with the new field. */
function makeAccountMe() {
  return {
    tier: 'solo_manual',
    concurrent_session_cap: 1,
    concurrent_session_active: 0,
    profile_cap: 10,
    profile_count: 0,
    profile_active: 0,
    onboarding_completed_at: null as string | null,
  };
}

// Stable references: the views key effects on useSettings() identity, so the
// mock returns ONE object and each arm mutates its fields before render.
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
  accountMe: makeAccountMe() as ReturnType<typeof makeAccountMe> | null,
  activeWorkspace: null,
  refreshAccountMe: vi.fn(() => Promise.resolve()),
  loading: false,
  update: vi.fn(() => Promise.resolve()),
};

vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => stable }));

// The mirror goes through the session-control transport's bearer path, which
// reads the account key from the settings store. Only that read is replaced;
// everything else in the module stays real.
vi.mock('../../src/lib/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsModule>()),
  loadSettings: () => Promise.resolve({ apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' }),
}));

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

// Map-backed Storage installed on the global, cleared between arms — every arm
// starts as a machine that has never run the app.
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

// The wire: every fetch the views and the mirror make, recorded. The PATCH is
// asserted at this level (URL, method, body, bearer) — the transport in
// between is the real one.
interface Recorded {
  url: string;
  method: string;
  body: string | null;
  authorization: string | null;
}
const recorded: Recorded[] = [];
let networkGone = false;
const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const headers = new Headers(init?.headers);
  recorded.push({
    url,
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? init.body : null,
    authorization: headers.get('authorization'),
  });
  if (networkGone) return Promise.reject(new Error('network gone'));
  return Promise.resolve(
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
});
const patches = (): Recorded[] =>
  recorded.filter((r) => r.method === 'PATCH' && r.url.endsWith('/v1/account/me'));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Every step done by the live counts: key present, a profile, a session. */
function allDone(): void {
  stable.settings.apiKey = 'ds_test_x';
  if (stable.accountMe === null) stable.accountMe = makeAccountMe();
  stable.accountMe.profile_count = 1;
  stable.accountMe.concurrent_session_active = 1;
}
/** 2/3 by the live counts — what a second machine sees before it launches. */
function sessionRemoved(): void {
  stable.settings.apiKey = 'ds_test_x';
  if (stable.accountMe === null) stable.accountMe = makeAccountMe();
  stable.accountMe.profile_count = 1;
  stable.accountMe.concurrent_session_active = 0;
}
function accountFinishedElsewhere(): void {
  if (stable.accountMe === null) stable.accountMe = makeAccountMe();
  stable.accountMe.onboarding_completed_at = FINISHED_ELSEWHERE;
}
const CARD = '[data-component="onboarding-checklist"]';
const card = (): Element | null => document.querySelector(CARD);

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: testStorage });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: testStorage });
  vi.stubGlobal('fetch', fetchStub);
  values.clear();
  recorded.length = 0;
  networkGone = false;
  stable.accountMe = makeAccountMe();
  sessionRemoved();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  values.clear();
});

describe('Profiles — a fresh machine of a customer whose account finished', () => {
  it('never renders "Get set up" (empty storage, /me says finished)', async () => {
    expect(values.get(COMPLETED_KEY)).toBeUndefined();
    accountFinishedElsewhere();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    // The view rendered (its heading is on screen) — the checklist is not.
    await screen.findByRole('heading', { name: 'No profiles yet' });
    expect(screen.queryByText('Get set up')).toBeNull();
    expect(card()).toBeNull();
  });

  it('seeds the local flag from the account, so the next launch hides the card before /me lands', async () => {
    accountFinishedElsewhere();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => {
      expect(values.get(COMPLETED_KEY)).toBe('1');
    });
  });

  it('sends nothing back when seeding — the account already knows', async () => {
    accountFinishedElsewhere();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await screen.findByRole('heading', { name: 'No profiles yet' });
    await flush();
    expect(patches()).toHaveLength(0);
  });

  it('never paints the card even when the account lands AFTER the first render', async () => {
    // The account read is async in the app. Count every insertion of the card
    // into the DOM across the whole sequence: null account → account lands.
    let insertions = 0;
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          // The card itself may be the inserted node (its parent is already
          // mounted), so match the node before searching its descendants.
          if (n instanceof Element && (n.matches(CARD) || n.querySelector(CARD) !== null)) {
            insertions += 1;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      stable.accountMe = null;
      const view = render(<ProfilesView onGoToSettings={vi.fn()} />);
      await screen.findByRole('heading', { name: 'No profiles yet' });
      stable.accountMe = makeAccountMe();
      sessionRemoved();
      accountFinishedElsewhere();
      view.rerender(<ProfilesView onGoToSettings={vi.fn()} />);
      await waitFor(() => {
        expect(values.get(COMPLETED_KEY)).toBe('1');
      });
      await flush();
      expect(insertions).toBe(0);
      expect(card()).toBeNull();
    } finally {
      observer.disconnect();
    }
  });

  it('VACUITY CONTROL — the same fresh machine with /me saying NOT finished DOES render "Get set up"', async () => {
    expect(values.get(COMPLETED_KEY)).toBeUndefined();
    expect(stable.accountMe?.onboarding_completed_at).toBeNull();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByText('Get set up')).toBeInTheDocument();
    expect(screen.getByText('2/3')).toBeInTheDocument();
    // Rendering an incomplete checklist neither completes nor mirrors.
    expect(values.get(COMPLETED_KEY)).toBeUndefined();
    await flush();
    expect(patches()).toHaveLength(0);
  });

  it('the account never removes a completion this machine recorded', async () => {
    values.set(COMPLETED_KEY, '1');
    expect(stable.accountMe?.onboarding_completed_at).toBeNull();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await screen.findByRole('heading', { name: 'No profiles yet' });
    expect(screen.queryByText('Get set up')).toBeNull();
  });
});

describe('Home — the same seed closes the same gate', () => {
  it('never renders "Get set up" (empty storage, /me says finished)', async () => {
    accountFinishedElsewhere();
    render(<CommandCenterView onNavigate={vi.fn()} />);
    // Something from the home renders (the KPI label), the checklist does not.
    await screen.findByText('Active');
    expect(screen.queryByText('Get set up')).toBeNull();
    expect(card()).toBeNull();
  });

  it('VACUITY CONTROL — /me saying NOT finished DOES render "Get set up"', async () => {
    render(<CommandCenterView onNavigate={vi.fn()} />);
    expect(await screen.findByText('Get set up')).toBeInTheDocument();
  });
});

describe('Mirror — the first local completion tells the account', () => {
  it('fires exactly one PATCH /v1/account/me with {onboarding_completed:true}', async () => {
    allDone();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => {
      expect(patches()).toHaveLength(1);
    });
    // Let anything queued behind the first one land — there must be nothing.
    await flush();
    await flush();
    expect(patches()).toHaveLength(1);
    expect(JSON.parse(patches()[0]?.body ?? 'null')).toEqual({ onboarding_completed: true });
  });

  it('addresses the configured deployment with the account key', async () => {
    allDone();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => {
      expect(patches()).toHaveLength(1);
    });
    expect(patches()[0]?.url).toBe('http://localhost:3000/v1/account/me');
    expect(patches()[0]?.authorization).toBe('Bearer ds_test_x');
  });

  it('Home completes through the same path — exactly one PATCH', async () => {
    allDone();
    render(<CommandCenterView onNavigate={vi.fn()} />);
    await waitFor(() => {
      expect(patches()).toHaveLength(1);
    });
    await flush();
    await flush();
    expect(patches()).toHaveLength(1);
    expect(JSON.parse(patches()[0]?.body ?? 'null')).toEqual({ onboarding_completed: true });
  });

  it('a failing PATCH neither throws nor blocks the local hide', async () => {
    networkGone = true;
    allDone();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => {
      expect(patches()).toHaveLength(1);
    });
    // The rejection is swallowed inside the mirror; an escaped one would fail
    // this file as an unhandled error. The local half still completed.
    await flush();
    await flush();
    expect(values.get(COMPLETED_KEY)).toBe('1');
    expect(screen.queryByText('Get set up')).toBeNull();
  });

  it('VACUITY CONTROL — an incomplete checklist sends no PATCH', async () => {
    sessionRemoved();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByText('Get set up')).toBeInTheDocument();
    await flush();
    await flush();
    expect(patches()).toHaveLength(0);
  });
});

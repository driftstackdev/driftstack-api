// V-290 — empty-state render tests for the three V-275/V-276/V-277
// list views: ProfilesView, RecordingsView, ProxiesView.
//
// Each view's empty state is the V-275 vocabulary: oxblood-tinted
// icon + heading + body + optional CTA + footnote. Cheap regression
// coverage protects vocabulary consistency from accidental drift.
//
// Profiles (T-7, 2026-09-03) — owner: the "A profile is a persistent
// identity…" empty state is too long/messy. MEASURED: the hand-rolled card
// stacked FOUR text blocks (heading, a 40-word definition, then two footnotes
// about ephemeral sessions and proxies). It is now the shared EmptyState with
// one ≤120-character line and the proxy note folded into the CTA's tooltip.
// The arms below pin the new copy AND the absence of the old blocks, so the
// card cannot quietly grow back.
//
// ConnectivityView intentionally NOT covered — V-277 left it as-is
// (already in good shape; no empty-state pattern applies).
//
// Mock surfaces per view differ (each consumes different hooks +
// modules), so this is three describe blocks instead of describe.each.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── ProfilesView ─────────────────────────────────────────────────

// IMPORTANT: stable references in each mock — components depend on
// useSettings()/useRecordings() return-value reference identity for
// useEffect dep arrays. A factory that returns a new object each call
// would loop the render cycle and OOM the test worker.

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        list: () => Promise.resolve({ data: [] }),
        // 2026-05-20 — ProfilesView walks iterate({limit:50}) now (was
        // raw list()). Empty-async-iterator preserves the empty-state
        // assertion below without coupling the mock to a real cursor
        // walk.
        iterate: function* () {
          // empty sync generator — the consumer's `for await` accepts
          // it because every iterator IS async-iterable in JS.
        },
      },
      sessions: {
        list: () => Promise.resolve({ data: [] }),
      },
    },
    settings: { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' },
    accountMe: {
      tier: 'solo_manual',
      concurrent_session_cap: 1,
      concurrent_session_active: 0,
      profile_cap: 10,
      profile_active: 0,
    },
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    update: vi.fn(() => Promise.resolve()),
  };
  return { useSettings: () => stable };
});

vi.mock('../../src/lib/recordings', () => {
  const stable = {
    recordings: new Map(),
    deleteRecording: vi.fn(() => Promise.resolve()),
    loading: false,
  };
  return {
    useRecordings: () => stable,
    formatDuration: () => '0s',
    recordingDurationMs: () => 0,
    recordingTotalBytes: () => 0,
  };
});

vi.mock('../../src/lib/proxies', () => ({
  // Pure predicate — use the real one. A stub here would let a suite
  // disagree with the app about what "usable" means, which is the very
  // drift this predicate was introduced to remove.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve([]),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');
const { RecordingsView } = await import('../../src/views/RecordingsView');
const { ProxiesView } = await import('../../src/views/ProxiesView');
const { ToastProvider } = await import('../../src/lib/toasts');

describe('V-275 ProfilesView empty state', () => {
  const viewModeKey = 'ds-profiles-view-mode';
  const storageValues = new Map<string, string>();
  const testStorage: Storage = {
    get length() {
      return storageValues.size;
    },
    clear() {
      storageValues.clear();
    },
    getItem(key) {
      return storageValues.get(key) ?? null;
    },
    key(index) {
      return [...storageValues.keys()][index] ?? null;
    },
    removeItem(key) {
      storageValues.delete(key);
    },
    setItem(key, value) {
      storageValues.set(key, value);
    },
  };

  beforeEach(() => {
    // Keep first-paint mode restoration deterministic under Node's incomplete
    // experimental localStorage implementation.
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: testStorage,
    });
    testStorage.clear();
  });

  afterEach(() => {
    testStorage.clear();
  });

  const DESCRIPTION =
    "A profile keeps a device's logins and identity between sessions. Create one to launch.";

  it('renders the shared EmptyState: title + the one-line description + the bright CTA', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);

    // Empty-state heading is the canonical phrasing.
    const heading = await screen.findByRole('heading', { name: 'No profiles yet' });
    expect(heading).toBeInTheDocument();

    // Exactly one line of copy, pinned verbatim.
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();

    // Inline CTA button (gated on tier-cap; here cap=10, active=0 → enabled),
    // on the bright first-action variant (T-8), not the darker .btn-primary.
    const cta = screen.getByRole('button', { name: 'Create your first profile' });
    expect(cta).toBeInTheDocument();
    expect(cta).not.toBeDisabled();
    expect(cta).toHaveClass('btn-primary-bright');
    expect(cta).not.toHaveClass('btn-primary');
  });

  it('folds the proxy note into the CTA tooltip when there are no proxies', async () => {
    // listProxies is mocked to [] above — zero proxies — so the note that used
    // to be a footnote is the button's title. It does NOT disable the button:
    // creating a profile never needed a proxy, launching one does.
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    const cta = await screen.findByRole('button', { name: 'Create your first profile' });
    expect(cta).toHaveAttribute('title', 'Add a proxy first — sessions run through one.');
    expect(cta).not.toBeDisabled();
  });

  it('keeps the description to one line (≤120 chars) and drops the old footnotes', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);

    // VACUITY CONTROL — the title renders, so the empty state is on screen and
    // the absences below are absences from a rendered card, not from nothing.
    const heading = await screen.findByRole('heading', { name: 'No profiles yet' });
    expect(heading).toBeInTheDocument();

    // Read the length off the RENDERED description, not the constant, so a
    // rewrite that grows the copy is caught by the DOM and not by this file.
    const description = screen.getByText(DESCRIPTION);
    expect((description.textContent ?? '').length).toBeLessThanOrEqual(120);

    // The three dropped blocks: the 40-word definition and both footnotes.
    expect(screen.queryByText(/persistent identity/i)).toBeNull();
    expect(screen.queryByText(/cookies, localStorage, IndexedDB/i)).toBeNull();
    expect(screen.queryByText(/ephemeral/i)).toBeNull();
    expect(screen.queryByText(/Proxies tab/i)).toBeNull();
  });

  it('first-paints the default grid as folder rail + phone-card silhouettes', () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    // Synchronously after mount — the initial refresh is still in flight (its
    // async resolution hasn't run). The skeleton is shown and the empty state
    // must NOT flash (it used to render for a beat on every open, reading as
    // data loss). No await here: we assert the FIRST paint.
    const loading = screen.getByLabelText('Loading profiles');
    expect(loading.querySelector('[data-component="profiles-loading-rail"]')).not.toBeNull();
    expect(loading.querySelector('[data-component="profiles-loading-grid"]')).not.toBeNull();
    expect(loading.querySelectorAll('[data-component="profiles-loading-phone-card"]')).toHaveLength(
      6,
    );
    expect(loading.querySelector('[data-component="profiles-loading-list"]')).toBeNull();
    expect(screen.queryByRole('heading', { name: /no profiles yet/i })).toBeNull();
  });

  it('first-paints a persisted list choice as a table header + six realistic rows', () => {
    window.localStorage.setItem(viewModeKey, 'list');

    render(<ProfilesView onGoToSettings={vi.fn()} />);

    const loading = screen.getByLabelText('Loading profiles');
    const table = loading.querySelector('[data-component="profiles-loading-table"]');
    expect(loading.querySelector('[data-component="profiles-loading-rail"]')).not.toBeNull();
    expect(loading.querySelector('[data-component="profiles-loading-list"]')).not.toBeNull();
    expect(table?.querySelector('thead')).not.toBeNull();
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(6);
    expect(loading.querySelector('[data-component="profiles-loading-grid"]')).toBeNull();
    expect(screen.queryByRole('heading', { name: /no profiles yet/i })).toBeNull();
  });
});

describe('V-276 RecordingsView empty state', () => {
  it('renders oxblood-tinted bullseye icon + heading + body + footnote', () => {
    render(
      <ToastProvider>
        <RecordingsView onOpen={vi.fn()} />
      </ToastProvider>,
    );

    const heading = screen.getByRole('heading', { name: /no recordings yet/i });
    expect(heading).toBeInTheDocument();

    // Body explains every-frame capture for replay + audit.
    expect(screen.getByText(/recordings capture every frame/i)).toBeInTheDocument();

    // The "click Record" guidance text — `Record` appears in multiple
    // places (header + empty-state body); at least one must be present.
    expect(screen.getAllByText(/Record/).length).toBeGreaterThan(0);

    // The persistence footnote (gallery port 2026-06-12: copy corrected
    // to reality — the ndjson disk-persistence phase shipped) — appears
    // in both the page header + empty-state footnote.
    expect(screen.getAllByText(/Recordings persist on this machine/i).length).toBeGreaterThan(0);
  });
});

describe('V-277 ProxiesView empty state', () => {
  it('renders the shared EmptyState: heading + SOCKS5 body + an "Add a proxy" CTA', async () => {
    render(<ProxiesView />);

    const heading = await screen.findByRole('heading', { name: /no proxies configured/i });
    expect(heading).toBeInTheDocument();

    // Body explains SOCKS5 + protected local/encrypted account sync. SOCKS5
    // appears in header + empty-state body.
    expect(screen.getAllByText(/SOCKS5/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/protected locally and synced in encrypted form to your account/i),
    ).toBeInTheDocument();

    // 5→10 consistency pass: migrated to the shared EmptyState with an
    // actionable CTA in place of the old "Click New proxy above" footnote.
    expect(screen.getByRole('button', { name: 'Add a proxy' })).toBeInTheDocument();
  });
});

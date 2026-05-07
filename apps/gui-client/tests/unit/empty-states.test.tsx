// V-290 — empty-state render tests for the three V-275/V-276/V-277
// list views: ProfilesView, RecordingsView, ProxiesView.
//
// Each view's empty state is the V-275 vocabulary: oxblood-tinted
// icon + heading + body + optional CTA + footnote. Cheap regression
// coverage protects vocabulary consistency from accidental drift.
//
// ConnectivityView intentionally NOT covered — V-277 left it as-is
// (already in good shape; no empty-state pattern applies).
//
// Mock surfaces per view differ (each consumes different hooks +
// modules), so this is three describe blocks instead of describe.each.

import { describe, expect, it, vi } from 'vitest';
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
  listProxies: () => Promise.resolve([]),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');
const { RecordingsView } = await import('../../src/views/RecordingsView');
const { ProxiesView } = await import('../../src/views/ProxiesView');

describe('V-275 ProfilesView empty state', () => {
  it('renders oxblood-tinted icon + heading + body + CTA + footnote', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);

    // Empty-state heading is the canonical V-275 phrasing.
    const heading = await screen.findByRole('heading', { name: /no profiles yet/i });
    expect(heading).toBeInTheDocument();

    // Body explains what a profile is + when to use one. The phrase
    // "persistent identity" appears in both the page header and the
    // empty-state body — getAllByText returns at least one.
    expect(screen.getAllByText(/persistent identity/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/cookies, localStorage, IndexedDB/i).length).toBeGreaterThan(0);

    // Inline CTA button (gated on tier-cap; here cap=10, active=0 → enabled).
    const cta = screen.getByRole('button', { name: /create your first profile/i });
    expect(cta).toBeInTheDocument();
    expect(cta).not.toBeDisabled();

    // Footnote about ephemeral sessions.
    expect(screen.getByText(/ephemeral/i)).toBeInTheDocument();
  });
});

describe('V-276 RecordingsView empty state', () => {
  it('renders oxblood-tinted bullseye icon + heading + body + footnote', () => {
    render(<RecordingsView onOpen={vi.fn()} />);

    const heading = screen.getByRole('heading', { name: /no recordings yet/i });
    expect(heading).toBeInTheDocument();

    // Body explains every-frame capture for replay + audit.
    expect(screen.getByText(/recordings capture every frame/i)).toBeInTheDocument();

    // The "click Record" guidance text — `Record` appears in multiple
    // places (header + empty-state body); at least one must be present.
    expect(screen.getAllByText(/Record/).length).toBeGreaterThan(0);

    // The persistence-disclaimer footnote (V-276 preserved this) —
    // appears in both the page header + empty-state footnote.
    expect(
      screen.getAllByText(/Recordings live in memory until the app restarts/i).length,
    ).toBeGreaterThan(0);
  });
});

describe('V-277 ProxiesView empty state', () => {
  it('renders oxblood-tinted network-spoke icon + heading + body + footnote', async () => {
    render(<ProxiesView />);

    const heading = await screen.findByRole('heading', { name: /no proxies configured/i });
    expect(heading).toBeInTheDocument();

    // Body explains SOCKS5 + local-only-storage commitment. SOCKS5
    // appears in header + empty-state body.
    expect(screen.getAllByText(/SOCKS5/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/never uploaded to the Driftstack control plane/i)).toBeInTheDocument();

    // Footnote about API contract dependency — appears in header +
    // empty-state footnote.
    expect(screen.getAllByText(/Wiring to session creation lands when/i).length).toBeGreaterThan(0);
  });
});

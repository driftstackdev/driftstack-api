// Behavior coverage for ProfilesView.handleLaunch — the "Launch" button must
// create a STREAMING agent session (client.agentSessions.create) and, when the
// response carries a `livekit` block, render the live-watch overlay. When no
// livekit block comes back (e.g. LiveKit unconfigured on the deployment) it must
// surface a clear error instead of a black screen. Pins the demo's
// create-profile → launch → watch path + its prod-safe fallback.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const agentCreate = vi.fn<(b: unknown) => Promise<unknown>>();

function profile() {
  return {
    id: 'prof_1',
    name: 'Demo',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    description: null,
    last_used_at: null,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
  };
}

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        list: () => Promise.resolve({ data: [profile()] }),
        // eslint-disable-next-line @typescript-eslint/require-await
        iterate: async function* () {
          yield profile();
        },
      },
      sessions: { list: () => Promise.resolve({ data: [] }) },
      agentSessions: { create: (b: unknown) => agentCreate(b) },
    },
    settings: { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' },
    accountMe: {
      tier: 'solo_manual',
      concurrent_session_cap: 1,
      concurrent_session_active: 0,
      profile_cap: 10,
      profile_active: 1,
    },
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    update: vi.fn(() => Promise.resolve()),
  };
  return { useSettings: () => stable };
});

vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () => Promise.resolve([]),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: vi.fn(() => Promise.resolve()),
  markLaunched: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(() => Promise.resolve()),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/proxies', () => ({
  listProxies: () =>
    Promise.resolve([{ id: 'p1', host: '127.0.0.1', port: 1080, username: null, password: null }]),
  addProxy: vi.fn(() => Promise.resolve({ id: 'p_new' })),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: vi.fn(() => Promise.resolve({ reachable: true })),
}));

// Stub the LiveKit-connecting panel so the overlay renders without a real WS.
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');

const LIVEKIT = {
  ws_url: 'ws://localhost:7880',
  room: 'agt_demo_room',
  token: 'tok',
  participant_identity: 'customer-acc',
  expires_at: '2026-06-08T12:00:00Z',
};

describe('ProfilesView launch → stream', () => {
  it('Launch creates an agent session and shows the live-watch overlay when livekit is returned', async () => {
    agentCreate.mockResolvedValueOnce({ id: 'agt_1', livekit: LIVEKIT });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
    // The overlay shows "Live session" + the room id once watchInfo is set.
    expect(await screen.findByText('agt_demo_room')).toBeTruthy();
    // AgentSessionPanel is lazy()-loaded (Suspense), so it resolves a microtask
    // after the room-id text — use findByTestId (async) not getByTestId, else
    // this races the lazy mount + flakes under full-suite load.
    expect(await screen.findByTestId('agent-session-panel')).toBeTruthy();
    expect(agentCreate).toHaveBeenCalledTimes(1);
    // Launch attaches THIS profile (file 57) — the canonical prof_<uuid> id is
    // passed as-is (the API normalizes it server-side, W335/W336).
    expect(agentCreate).toHaveBeenCalledWith({ profile_id: 'prof_1' });
  });

  it('no livekit block → clear error, not a black screen (prod-safe fallback)', async () => {
    agentCreate.mockResolvedValueOnce({ id: 'agt_2' });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(screen.getByText(/no live stream was returned/i)).toBeTruthy());
  });
});

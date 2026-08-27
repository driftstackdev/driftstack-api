// The profile grid sat below a stack of furniture.
//
// Five blocks render above it: the workspace-recovery bar, the privacy banner,
// the storage meter, the workspace strip, and the hero. Only the privacy banner
// could be dismissed, so seeing a profile card meant scrolling past context you
// had already read.
//
// The storage meter and workspace strip are ambient CONTEXT, so both collapse.
// The hero deliberately does NOT: it carries Import and New profile, and hiding
// the primary actions to reclaim vertical space trades one complaint for a
// worse one. That is also why the toggle lives IN the hero — a control that
// collapses itself cannot bring anything back.
//
// Mock set copied wholesale from profiles-view-stale-exit-geo: ProfilesView
// takes its profiles from client.profiles on the settings context, not from a
// lib module, and a hand-built approximation of that renders nothing at all.

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const LIVEKIT = {
  ws_url: 'ws://localhost:7880',
  room: 'agt_room',
  token: 'tok',
  participant_identity: 'customer-acc',
  expires_at: '2026-06-08T12:00:00Z',
};

function profile() {
  return {
    id: 'prof_1',
    name: 'Demo',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    description: null,
    last_used_at: null,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
    // ⭐ 4.3 GiB against the solo_manual cap of 5 GiB = 86%, ABOVE
    // STORAGE_SOFT_WARN_FRACTION. The meter is now only rendered once storage is
    // actionable, so a zero-byte fixture would hide it and these collapse arms
    // would pass vacuously — green while testing nothing.
    size_bytes: 4_617_089_843,
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
      sessions: { list: () => Promise.resolve({ data: [] }), create: vi.fn() },
      agentSessions: {
        create: vi.fn(),
        close: vi.fn(),
        livekitToken: () => Promise.resolve(LIVEKIT),
        list: () => Promise.resolve({ data: [] }),
      },
    },
    settings: {
      apiKey: 'ds_test_x',
      baseUrl: 'http://localhost:3000',
      startUrl: 'https://driftstack.dev',
    },
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
    activeWorkspace: null,
    setActiveWorkspace: vi.fn(),
  };
  return { useSettings: () => stable };
});

// Bind the profile to the default proxy p1.
vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () =>
    Promise.resolve([
      { profileId: 'prof_1', defaultProxyId: 'p1', currentSessionId: null, lastLaunchedAt: null },
    ]),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: vi.fn(() => Promise.resolve()),
  markLaunched: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(() => Promise.resolve()),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/proxies', () => ({
  // Pure predicate — use the real one. A stub here would let a suite
  // disagree with the app about what "usable" means, which is the very
  // drift this predicate was introduced to remove.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  // Same reasoning as isProxyUsable above: the WORDS for a verdict are as
  // drift-prone as the verdict. Kept in step with lib/proxies.proxyVerdict.
  proxyVerdict: (r: {
    reachable: boolean;
    auth_ok: boolean;
    can_route: boolean;
    latency_ms: number;
  }): { ok: boolean; label: string } =>
    !r.reachable
      ? { ok: false, label: 'Not reachable' }
      : !r.auth_ok
        ? { ok: false, label: 'Auth failed' }
        : !r.can_route
          ? { ok: false, label: 'Cannot route' }
          : { ok: true, label: `Reachable · ${r.latency_ms} ms` },
  listProxies: () =>
    Promise.resolve([
      {
        id: 'p1',
        label: 'P1',
        host: '127.0.0.1',
        port: 1080,
        username: null,
        password: null,
        createdAt: '2026-06-08T00:00:00Z',
        serverId: 'aprx_1',
      },
    ]),
  addProxy: vi.fn(),
  setProxyServerId: vi.fn(() => Promise.resolve()),
  testProxy: vi.fn(() =>
    // A launch-path stub must model a proxy that ROUTES, not merely one that
    // answers. The pre-launch gate re-tests and refuses anything unusable, so a
    // bare { reachable: true } now blocks every launch these suites assert.
    Promise.resolve({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      can_route: true,
      connect_reply: 0x00,
      latency_ms: 12,
      message: 'Working — CONNECT succeeded.',
    }),
  ),
  probeProxyExit: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../src/lib/account-proxies', () => ({
  createProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
  updateProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
  buildWireGuardProxyInput: vi.fn(),
  buildOpenVpnProxyInput: vi.fn(),
}));

// The cached probe (loadProbeCache on mount). A prior healthy probe recorded an
// exit IP/country; the LAST probe's reachability is configurable per test.
const lastReachable = false;
vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  // Spread the REAL module: this double overrides only the I/O. Stubbing
  // the pure derivation instead would make the arms that depend on it pass
  // vacuously, and a hand-listed factory silently omits every export added
  // later — which is exactly how P-8 broke 18 files at once.
  ...(await importOriginal<typeof ProbeCacheModule>()),
  loadProbeCache: () =>
    Promise.resolve({
      p1: {
        result: {
          reachable: lastReachable,
          auth_ok: lastReachable,
          udp_associate: false,
          can_route: true,
          connect_reply: 0x00,
          latency_ms: lastReachable ? 42 : 0,
          message: lastReachable ? 'ok' : 'TCP connect failed: timed out',
        },
        at: Date.now(),
        // Preserved across the failed re-test by saveProbeResult.
        exitIp: '203.0.113.7',
        exitCountry: 'US',
      },
    }),
  saveProbeResult: vi.fn(() => Promise.resolve({})),
  saveExitResult: vi.fn(() => Promise.resolve({})),
  invalidateProbe: vi.fn(() => Promise.resolve({})),
}));

const confirmMock = vi.fn(() => Promise.resolve(true));
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => confirmMock,
  ConfirmProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
}));
vi.mock('../../src/lib/agent-session-control', () => ({
  mintGuiControlKey: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../src/lib/open-simulator', () => ({
  openSimulatorWindow: vi.fn(() => Promise.resolve({ opened: true })),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');

const box = (name: string) => document.querySelector(`[data-component="${name}"]`);

// This runner supplies a localStorage OBJECT whose methods are not functions
// (`--localstorage-file` without a path), so the persistence arm cannot use it
// as-is. A real in-memory store is installed instead — otherwise that arm would
// have to be deleted or, worse, written to pass without exercising anything.
// The component itself wraps every access in try/catch, which is why it behaves
// correctly under the broken stub rather than throwing.
function installMemoryStorage(): void {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  });
}

describe('the grid can be seen without scrolling', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  afterEach(() => {
    // Process-wide stub: leaving it installed leaks into every sibling suite.
    vi.unstubAllGlobals();
  });

  it('CRITICAL collapsing hides the ambient boxes but KEEPS the hero, because the hero carries Import and New profile', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await screen.findByRole('button', { name: 'Launch' });
    expect(box('storage-meter'), 'storage meter was never shown').not.toBeNull();
    expect(box('workspace-strip'), 'workspace strip was never shown').not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /hide storage and workspace/i }));

    await waitFor(() => expect(box('storage-meter')).toBeNull());
    expect(box('workspace-strip')).toBeNull();
    expect(box('profiles-hero'), 'the hero collapsed too, hiding the actions').not.toBeNull();
    expect(screen.getByRole('button', { name: 'New profile' })).toBeInTheDocument();
  });

  it('CRITICAL the toggle survives its own collapse, so the boxes can be brought back', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await screen.findByRole('button', { name: 'Launch' });
    fireEvent.click(screen.getByRole('button', { name: /hide storage and workspace/i }));
    await waitFor(() => expect(box('storage-meter')).toBeNull());

    // A toggle rendered inside the collapsed region would be a one-way door.
    fireEvent.click(screen.getByRole('button', { name: /show storage and workspace/i }));
    await waitFor(() => expect(box('storage-meter')).not.toBeNull());
    expect(box('workspace-strip')).not.toBeNull();
  });

  it('the choice persists, so it is not re-made on every visit', async () => {
    const { unmount } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    await screen.findByRole('button', { name: 'Launch' });
    fireEvent.click(screen.getByRole('button', { name: /hide storage and workspace/i }));
    await waitFor(() => expect(box('storage-meter')).toBeNull());
    expect(localStorage.getItem('ds_profiles_chrome_collapsed')).toBe('1');
    unmount();

    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await screen.findByRole('button', { name: 'Launch' });
    expect(box('storage-meter'), 'the collapse was forgotten on remount').toBeNull();
  });

  it('reports its state to assistive tech, not only by rotating a chevron', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await screen.findByRole('button', { name: 'Launch' });
    const toggle = screen.getByRole('button', { name: /hide storage and workspace/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /show storage and workspace/i })).toHaveAttribute(
        'aria-expanded',
        'false',
      ),
    );
  });
});

// A profile with a proxy BOUND must never launch without `proxy_id`.
//
// The server treats an ABSENT proxy_id as operator-default egress. So omitting it
// does not fail the launch — it succeeds, quietly, out through Driftstack's shared
// datacenter IP instead of the customer's proxy. For an anti-detect product that is
// the worst possible failure mode: the session works, looks fine, and is wearing the
// wrong exit IP. The server's own fail-closed guard cannot help, because it only
// covers a present-but-unresolvable proxy_id; an omitted one is indistinguishable
// from "this customer wants the default".
//
// `ensureServerProxy` has TWO ways of not producing an id, and only one was closed.
// The 2026-07-08 sweep caught the THROW (SSRF-rejected host, 4xx, offline blip) and
// wrote twenty lines explaining why a proxy-less create body must never be built.
// Three lines below that comment, the create body was a ternary whose else-branch
// built exactly that, for the case where `ensureServerProxy` RETURNS `undefined` —
// excused in the comment as "only the no-API-key case, which fails at create anyway".
//
// That excuse rested on a fact in a different module: `buildClient` returns null for
// an empty key, and `handleLaunch` returns early on `!client`. True today, unstated
// here, and load-bearing for an egress guarantee. One more `return undefined` inside
// `ensureServerProxy` — an unsupported scheme, a key cleared mid-flight — and the
// leak is live again with no test to notice.
//
// So this file drives the state that production wiring currently makes unreachable:
// a client that exists alongside an empty API key. That is deliberate. The point of
// the arm is that the launch path must refuse on its own evidence, rather than
// inheriting safety from a coincidence two modules away. If the branch is genuinely
// unreachable the arm costs nothing; on the day it becomes reachable it is the only
// thing standing between a customer and a silent exit-IP leak.
//
// AgentChatView.resolveProfileProxyId already treats `undefined` as `blocked` for
// exactly this reason. These two mirrored launch paths now agree.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const agentCreate = vi.fn<(b: unknown, opts?: unknown) => Promise<unknown>>(() =>
  Promise.resolve({ id: 'agt_1', livekit: LIVEKIT }),
);

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
  };
}

// Mutable so one arm can present a client WITHOUT an API key — the exact state
// `ensureServerProxy` answers `undefined` to. Reset in beforeEach so the arms stay
// order-independent.
let apiKeyValue = 'ds_test_x';

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
        create: (b: unknown, opts?: unknown) => agentCreate(b, opts),
        close: vi.fn(() => Promise.resolve({})),
        livekitToken: () => Promise.resolve(LIVEKIT),
        list: () => Promise.resolve({ data: [] }),
      },
    },
    // A getter, not a snapshot: ProfilesView reads settings.apiKey at launch time.
    get settings() {
      return {
        apiKey: apiKeyValue,
        baseUrl: 'http://localhost:3000',
        startUrl: 'https://driftstack.dev',
      };
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

// The profile is BOUND to p1 — this is the case where an omitted proxy_id is a leak
// rather than a preference. An unbound profile returns earlier ("Sessions require a
// proxy on this deployment") and never reaches the create body at all.
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
        // Already synced, so ensureServerProxy takes the refresh (PUT) path.
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

// Per-arm control over the account-proxies sync. `updateProxy` is the call
// ensureServerProxy makes for an already-synced proxy.
let syncFails = false;
vi.mock('../../src/lib/account-proxies', () => ({
  createProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
  updateProxy: vi.fn(() =>
    syncFails
      ? Promise.reject(Object.assign(new Error('sync down'), { status: 500 }))
      : Promise.resolve({ id: 'aprx_1' }),
  ),
  buildWireGuardProxyInput: vi.fn(),
  buildOpenVpnProxyInput: vi.fn(),
}));

// No cached probe result → no "Launch anyway?" confirm, so every confirm observed in
// these arms is an egress block and not the down-proxy override.
vi.mock('../../src/lib/proxy-probe-cache', () => ({
  loadProbeCache: () => Promise.resolve({}),
  saveProbeResult: vi.fn(() => Promise.resolve({})),
  clearProbeResult: vi.fn(() => Promise.resolve({})),
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

/** The one message every egress block must carry, whatever caused it. */
const LEAK_COPY = /was NOT launched[\s\S]*default IP/;

describe('a launch that cannot name the proxy must not launch', () => {
  beforeEach(() => {
    agentCreate.mockClear();
    confirmMock.mockClear();
    confirmMock.mockResolvedValue(true);
    apiKeyValue = 'ds_test_x';
    syncFails = false;
  });

  it('CONTROL a healthy sync launches, and the create body names the proxy. A guard that only ever refuses proves nothing; this is the arm that fails if the fail-closed check is inverted or over-broad.', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));

    await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
    const body = agentCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.proxy_id, 'the create body must carry the synced proxy id').toBe('aprx_1');
    expect(confirmMock, 'a healthy launch must not raise an egress block').not.toHaveBeenCalled();
  });

  it('CRITICAL the sync returning NO id blocks the launch instead of omitting proxy_id. This is the branch the old ternary served: it built a create body with no proxy_id at all, which the server reads as "use the operator default" — a session on Driftstack’s datacenter IP under a profile the customer bound to their own proxy.', async () => {
    apiKeyValue = '';
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(
      agentCreate,
      'no session may be created when the proxy id is unknown — an unproxied create is the leak, not a fallback',
    ).not.toHaveBeenCalled();
    const msg = String(confirmMock.mock.calls[0]?.[0] ?? '');
    expect(msg, 'the customer must be told the launch did not happen, and why').toMatch(LEAK_COPY);
    expect(
      msg,
      'and this cause has its own remedy — nothing failed, the key is simply not connected',
    ).toMatch(/API key/i);
  });

  it('CRITICAL a THROWN sync failure blocks the launch too, with the same promise kept. Same outcome, different cause: the id could not be fetched rather than not existing, so the remedy names the proxy instead of the key.', async () => {
    syncFails = true;
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(
      agentCreate,
      'a failed sync must not fall through to an unproxied create',
    ).not.toHaveBeenCalled();
    const msg = String(confirmMock.mock.calls[0]?.[0] ?? '');
    expect(msg, 'the customer must be told the launch did not happen, and why').toMatch(LEAK_COPY);
    expect(msg, 'the remedy here is the proxy, not the API key').toMatch(/Check the proxy/i);
  });
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
// (i) I4 — the fleet test a VPN row runs in a sweep (see
// a-vpn-row-check-runs-the-fleet-test); the SOCKS5 arms never reach it.
const { testAccountProxy } = vi.hoisted(() => ({
  testAccountProxy:
    vi.fn<
      (
        baseUrl: string,
        apiKey: string,
        id: string,
        opts?: { vantage?: 'cp' | 'fleet' },
      ) => Promise<AccountProxiesModule.AccountProxyTestResult>
    >(),
}));
vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  testAccountProxy: (
    baseUrl: string,
    apiKey: string,
    id: string,
    opts?: { vantage?: 'cp' | 'fleet' },
  ) => testAccountProxy(baseUrl, apiKey, id, opts),
}));
// No request leaves this suite: the list sync a signed-in grid fires on mount
// gets a 500 and is best-effort.
vi.mock('../../src/lib/fetch-with-deadline', () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  fetchWithDeadline: (): Promise<Response> => Promise.resolve(new Response('{}', { status: 500 })),
}));
const removeProxy = vi.fn<(id: string) => Promise<void>>();
const confirmFn = vi.fn(() => Promise.resolve(true));

const HEALTHY: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 30,
  message: 'ok',
};
const UNREACHABLE: ProxyTestResult = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'timed out',
};
const AUTH_FAILED: ProxyTestResult = {
  reachable: true,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 40,
  message: 'credentials rejected',
};

function proxy(id: string, scheme: ProxyConfig['scheme'] = 'socks5'): ProxyConfig {
  return {
    id,
    label: `proxy-${id}`,
    host: `${id}.example.com`,
    port: 1080,
    username: 'user',
    password: 'pass',
    createdAt: '2026-07-01T00:00:00.000Z',
    scheme,
  };
}

let stored: ProxyConfig[] = [];

vi.mock('../../src/lib/proxies', () => ({
  // Pure predicate — use the real one. A stub here would let a suite
  // disagree with the app about what "usable" means, which is the very
  // drift this predicate was introduced to remove.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: (id: string) => removeProxy(id),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: vi.fn(() => Promise.resolve({ resolved: true, ip: '1.2.3.4', message: 'ok' })),
}));

vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  // Spread the REAL module: this double overrides only the I/O. Stubbing
  // the pure derivation instead would make the arms that depend on it pass
  // vacuously, and a hand-listed factory silently omits every export added
  // later — which is exactly how P-8 broke 18 files at once.
  ...(await importOriginal<typeof ProbeCacheModule>()),
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () => Promise.resolve({}),
  saveExitResult: vi.fn(() => Promise.resolve()),
  saveProbeResult: vi.fn(() => Promise.resolve()),
  // (i) I4 — the VPN row's own writes (pre-flight, fleet result, failure):
  // there is no store under this suite, so they are inert here.
  saveEndpointResult: vi.fn(() => Promise.resolve({})),
  saveServerProbeResult: vi.fn(() => Promise.resolve({})),
  saveOsFingerprint: vi.fn(() => Promise.resolve({})),
  saveFleetFailure: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  clearBindingsForProxy: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => confirmFn,
}));

const settingsStub = {
  settings: { apiKey: null as string | null, baseUrl: 'http://localhost:3000' },
};
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

describe('ProxiesView Test all completion summary', () => {
  beforeEach(() => {
    testProxy.mockReset();
    removeProxy.mockReset();
    removeProxy.mockImplementation((id) => {
      stored = stored.filter((item) => item.id !== id);
      return Promise.resolve();
    });
    confirmFn.mockClear();
    testAccountProxy.mockReset();
    settingsStub.settings.apiKey = null;
    stored = [proxy('one')];
  });

  // (i) I4 — a fleet `ok` with `latency_ms: null` brought the tunnel UP (the
  // row adopts the exit and QUIC verdict from that reply); it was tallied "not
  // tested (the fleet Mac reported no measurement)" while the row wore those
  // fields. It is counted up, and the clause names the missing number.
  // MUTATION: file `latencyMs === null` under notTested again → red.
  it('CRITICAL counts a fleet ok with no latency as a VPN tunnel UP (no latency reported) beside the SOCKS5 buckets, with the "tunnel up · no latency" pill', async () => {
    settingsStub.settings.apiKey = 'ds_test_x';
    stored = [proxy('one'), { ...proxy('vpn1', 'wireguard'), serverId: 'aprx_vpn' }];
    testProxy.mockResolvedValue(HEALTHY);
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: null,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
      quic_probe: true,
      exit_observed: { ip: '203.0.113.9', country: 'NL', timezone: null, region: null, city: null },
    });
    render(<ProxiesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));

    expect(
      await screen.findByText('Tested 2 — 1 healthy, 1/1 VPN tunnel up (no latency reported)'),
    ).toBeInTheDocument();
    expect(screen.getByText('tunnel up · no latency')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
    expect(screen.queryByText(/not tested/)).toBeNull();
    expect(testAccountProxy).toHaveBeenCalledWith(
      'http://localhost:3000',
      'ds_test_x',
      'aprx_vpn',
      {
        vantage: 'fleet',
      },
    );
  });

  it('CONTROL — the same fleet ok WITH a latency is "1/1 VPN tunnel up" and a plain "tunnel up" pill', async () => {
    settingsStub.settings.apiKey = 'ds_test_x';
    stored = [proxy('one'), { ...proxy('vpn1', 'wireguard'), serverId: 'aprx_vpn' }];
    testProxy.mockResolvedValue(HEALTHY);
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 42,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
    });
    render(<ProxiesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));

    expect(await screen.findByText('Tested 2 — 1 healthy, 1/1 VPN tunnel up')).toBeInTheDocument();
    expect(screen.getByText('tunnel up')).toBeInTheDocument();
    expect(screen.queryByText('tunnel up · no latency')).toBeNull();
  });

  it('announces the completed sweep with honest health buckets', async () => {
    stored = [proxy('one'), proxy('two'), proxy('three')];
    testProxy
      .mockResolvedValueOnce(HEALTHY)
      .mockResolvedValueOnce(UNREACHABLE)
      .mockResolvedValueOnce(AUTH_FAILED);
    render(<ProxiesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));

    expect(
      await screen.findByText('Tested 3 — 1 healthy, 1 unreachable, 1 auth failure'),
    ).toBeInTheDocument();
    expect(testProxy).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: 'Dismiss test summary' })).toBeInTheDocument();
  });

  it('auto-dismisses the one-shot summary after five seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      testProxy.mockResolvedValue(HEALTHY);
      render(<ProxiesView />);

      fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
      expect(await screen.findByText('Tested 1 — 1 healthy')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.queryByText('Tested 1 — 1 healthy')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start or announce a zero-probe sweep', async () => {
    // (b) VPN exit parity — a VPN row is now SWEEPABLE (its endpoint check + the
    // fleet test; see a-vpn-row-check-runs-the-fleet-test), so the zero-probe
    // pool is an HTTP row, which has neither a native probe nor a fleet test.
    stored = [proxy('http1', 'http')];
    render(<ProxiesView />);

    const button = await screen.findByRole('button', { name: 'Test all' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      'title',
      'No SOCKS5 or VPN proxies to test — HTTP endpoints are verified at launch',
    );
    expect(testProxy).not.toHaveBeenCalled();
    expect(document.querySelector('[data-component="proxy-test-all-summary"]')).toBeNull();
  });

  it('coalesces rapid activation into one sweep and one summary', async () => {
    let release: (result: ProxyTestResult) => void = () => undefined;
    testProxy.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(<ProxiesView />);

    const button = await screen.findByRole('button', { name: 'Test all' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(1));

    release(HEALTHY);
    expect(await screen.findByText('Tested 1 — 1 healthy')).toBeInTheDocument();
    expect(screen.getAllByText('Tested 1 — 1 healthy')).toHaveLength(1);
    expect(testProxy).toHaveBeenCalledTimes(1);
  });

  it('excludes a result invalidated by removing its proxy mid-sweep', async () => {
    stored = [proxy('stale'), proxy('current')];
    let releaseFirst: (result: ProxyTestResult) => void = () => undefined;
    testProxy
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(HEALTHY);
    render(<ProxiesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() => expect(removeProxy).toHaveBeenCalledWith('stale'));

    releaseFirst(UNREACHABLE);
    expect(await screen.findByText('Tested 1 — 1 healthy')).toBeInTheDocument();
    expect(testProxy).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Tested 2/)).not.toBeInTheDocument();
  });
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
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
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  clearBindingsForProxy: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => confirmFn,
}));

const settingsStub = { settings: { apiKey: null, baseUrl: 'http://localhost:3000' } };
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
    stored = [proxy('one')];
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
    stored = [proxy('vpn', 'wireguard')];
    render(<ProxiesView />);

    const button = await screen.findByRole('button', { name: 'Test all' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      'title',
      'No SOCKS5 proxies to test — VPN/HTTP endpoints are verified at launch',
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

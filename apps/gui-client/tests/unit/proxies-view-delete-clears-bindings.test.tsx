// Deep-audit HIGH: deleting a proxy that a profile was bound to as its DEFAULT
// must clear that dangling binding — otherwise Launch silently reroutes the
// profile's egress to a different proxy (an anti-detect privacy hazard). These
// tests render ProxiesView, click Remove on a proxy, and assert
// clearBindingsForProxy is called for the removed id and that the unbound-profiles
// notice surfaces.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ProxyConfig } from '../../src/lib/proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const removeProxy = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
const clearBindingsForProxy = vi.fn<(id: string) => Promise<string[]>>(() => Promise.resolve([]));

// handleRemove is now gated behind a useConfirm() danger dialog. Mock the
// confirm to auto-resolve true so the delete proceeds (mirrors the sibling
// confirm-gated tests, e.g. sessions-view-consistency). The real dialog copy /
// tone is covered by ConfirmProvider.test.tsx; here we exercise the
// binding-clear path once the operator has confirmed.
const confirmFn = vi.fn<(msg: string, opts?: unknown) => Promise<boolean>>(() =>
  Promise.resolve(true),
);
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => confirmFn,
}));

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
  clearBindingsForProxy: (id: string) => clearBindingsForProxy(id),
}));

// ProxiesView reads useSettings() (to delete the server-side account_proxies row
// on remove). With apiKey:null the server delete is skipped — the local CRUD +
// binding-clear path under test is unaffected. Stable object → useEffect-dep safe.
const settingsStub = { settings: { apiKey: null, baseUrl: 'http://localhost:3000' } };
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

const PROXY: ProxyConfig = {
  id: 'px_eu',
  label: 'eu-west',
  host: 'proxy.example.com',
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
};

async function clickRemove(): Promise<void> {
  await screen.findByText('eu-west');
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
}

describe('ProxiesView — deleting a proxy clears dangling profile bindings', () => {
  beforeEach(() => {
    removeProxy.mockClear();
    clearBindingsForProxy.mockReset();
    clearBindingsForProxy.mockResolvedValue([]);
    stored = [PROXY];
  });

  it('calls clearBindingsForProxy with the removed proxy id', async () => {
    render(<ProxiesView />);
    await clickRemove();
    await waitFor(() => expect(removeProxy).toHaveBeenCalledWith('px_eu'));
    expect(clearBindingsForProxy).toHaveBeenCalledWith('px_eu');
  });

  it('surfaces a notice naming how many profiles were unbound', async () => {
    clearBindingsForProxy.mockResolvedValue(['prof_a', 'prof_b']);
    render(<ProxiesView />);
    await clickRemove();
    await waitFor(() =>
      expect(screen.getByText(/2 profiles were using this proxy as a default/i)).toBeTruthy(),
    );
  });

  it('shows no notice when nothing was bound to the deleted proxy', async () => {
    clearBindingsForProxy.mockResolvedValue([]);
    render(<ProxiesView />);
    await clickRemove();
    await waitFor(() => expect(clearBindingsForProxy).toHaveBeenCalled());
    expect(screen.queryByText(/using this proxy as a default/i)).toBeNull();
  });
});

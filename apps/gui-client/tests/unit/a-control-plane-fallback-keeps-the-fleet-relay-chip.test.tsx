// (q) Item 3 residual — a control-plane FALLBACK must not erase the fleet's relay
// verdict on the Proxies grid.
//
// MEASURED (re-verification against b65ddc209): a fleet miss on a SOCKS5 row
// falls back to the control plane (account-me.ts), which never emits `quic_ok`;
// account-proxies drops `quic_probe` unless the vantage is 'fleet'; then
// ProxiesView.applyServerProbeOutcome `dropKey`'d the in-memory relay verdict and
// saveServerProbeResult erased the cached one — so a row whose QUIC chip was
// green from the last fleet run reverted to '~' on a Test the customer did not
// cause to miss, with no cause named. The control plane measured NOTHING about
// QUIC; the fleet's fact stands (the vantage label still flips to "server", so
// the fallback itself is never silent). The cache half is pinned in
// a-fleet-test-result-parses-its-vantage-and-never-merges-quic.test.ts; this is
// the grid half, through the real Test button — which reads 'Re-test' once a
// result is cached, as it is here by construction.
//
// ⛔ PRODUCTION LINE WHOSE REVERSION REDS ARM 1: in applyServerProbeOutcome,
//    `relay !== undefined ? {…} : cpFallback ? m : dropKey(m, id)` — put the
//    unconditional `dropKey` back and the green chip goes on the CP fallback.
// ⛔ Widen it — keep the relay on EVERY vantage — and the CONTROL (arm 2) reds:
//    a fleet Mac that ran and produced no relay verdict must drop the old one.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type { AccountProxyTestResult } from '../../src/lib/account-proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const HEALTHY: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'ok',
};

const { testAccountProxy } = vi.hoisted(() => ({
  testAccountProxy: vi.fn<(...a: unknown[]) => Promise<AccountProxyTestResult>>(),
}));

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () =>
    Promise.resolve<ProxyConfig[]>([
      {
        id: 's1',
        label: 'socks-with-relay',
        host: '203.0.113.5',
        port: 1080,
        username: null,
        password: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        scheme: 'socks5',
        serverId: 'aprx_s1',
      },
    ]),
  addProxy: vi.fn(),
  removeProxy: vi.fn(),
  updateProxy: vi.fn(),
  setProxyServerId: vi.fn(() => Promise.resolve(null)),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: () => Promise.resolve(HEALTHY),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: vi.fn(),
}));
vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  updateProxy: vi.fn(() => Promise.resolve({ id: 'aprx_s1' })),
  createProxy: vi.fn(() => Promise.resolve({ id: 'aprx_s1' })),
  testAccountProxy: (...a: unknown[]) => testAccountProxy(...a),
}));
// The cache starts with the FLEET's last answer: relay verdict true. Writes are
// swallowed so the grid's own in-memory application is what is measured here.
vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeCacheModule>()),
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () =>
    Promise.resolve({
      s1: {
        result: HEALTHY,
        at: Date.now() - 60_000,
        serverLatencyMs: 31,
        measuredFrom: 'fleet',
        nodeId: 'mac-mini-07',
        quicProbe: true,
        serverProbeAt: Date.now() - 60_000,
      },
    }),
  subscribeProbeCache: () => () => undefined,
  saveProbeResult: vi.fn(() => Promise.resolve({})),
  saveServerProbeResult: vi.fn(() => Promise.resolve({})),
  saveOsFingerprint: vi.fn(() => Promise.resolve({})),
  saveExitResult: vi.fn(() => Promise.resolve({})),
  clearExitResult: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  profilesUsingProxy: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ settings: { apiKey: 'ds_test_x', baseUrl: 'http://x' } }),
}));

const { ProxiesView } = await import('../../src/views/ProxiesView');

/** The QUIC chip of the only row — the relay verdict renders it as a `✓ QUIC` chip. */
function quicChipText(): string {
  const cells = screen.getAllByRole('cell');
  return cells.map((c) => c.textContent ?? '').join(' | ');
}

beforeEach(() => {
  testAccountProxy.mockReset();
});

describe('(q) Item 3 residual — the grid keeps the fleet relay verdict across a control-plane fallback', () => {
  it('ARM 1 — CRITICAL: a Test whose fleet leg fell back to the control plane leaves the relay ✓ QUIC chip in place', async () => {
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 90,
      measured_from: 'control_plane',
    });
    render(<ProxiesView />);
    await screen.findByText('socks-with-relay');
    // Hydrated from the cache: the fleet relay chip is green before the Test.
    await waitFor(() => expect(quicChipText()).toMatch(/✓\s*QUIC/));
    fireEvent.click(screen.getByRole('button', { name: /^(re-)?test$/i }));
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    // The fallback is VISIBLE — the latency now wears the server label…
    await waitFor(() => expect(screen.getByText(/90\s*ms/)).toBeInTheDocument());
    // (P2 2026-09-12) — pinned as the EXACT chip text, not /from the server/i:
    // the health pill now names its own machine too ("healthy from the server"),
    // so the loose regex matched two elements and getByText threw. The chip
    // beside the number is the element this arm is about.
    await waitFor(() => expect(screen.getByText('from the server')).toBeInTheDocument());
    // …and the relay fact the control plane could not re-measure still stands.
    expect(quicChipText()).toMatch(/✓\s*QUIC/);
  });

  it('ARM 2 — CONTROL: a FLEET answer that carried no relay verdict drops the chip — that Mac ran and produced none', async () => {
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 35,
      measured_from: 'fleet',
      node_id: 'mac-mini-08',
    });
    render(<ProxiesView />);
    await screen.findByText('socks-with-relay');
    await waitFor(() => expect(quicChipText()).toMatch(/✓\s*QUIC/));
    fireEvent.click(screen.getByRole('button', { name: /^(re-)?test$/i }));
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/35\s*ms/)).toBeInTheDocument());
    await waitFor(() => expect(quicChipText()).not.toMatch(/✓\s*QUIC/));
  });
});

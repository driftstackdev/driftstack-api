// Behavior coverage for the Proxies-tab "Test" button (ProxiesView).
// The native probe itself is covered in Rust + the testProxy wrapper
// unit test; here we render the view, click Test on a saved proxy, and
// assert the card surfaces the correct verdict for each outcome.
//
// The Console restyle (2026-06-14) replaced the inline result row's
// prose headlines with a structured card: a HEALTH PILL verdict
// (healthy / slow / auth fail / unreachable / untested), a latency
// meter ("<n>ms"), a UDP badge, and a test-detail block deriving the
// QUIC + WebRTC capability line. These tests assert the SAME states
// the old copy did — in particular that a reachable-but-auth-rejected
// probe reads "auth fail", never the misleading "unreachable".

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ProxyTestResult } from '../../src/lib/proxies';

const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();

vi.mock('../../src/lib/proxies', () => ({
  listProxies: () =>
    Promise.resolve([
      {
        id: 'p1',
        label: 'london-socks',
        host: 'proxy.example.com',
        port: 1080,
        username: 'u',
        password: 'p',
        createdAt: '2026-05-20T00:00:00.000Z',
      },
    ]),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: () => Promise.resolve(null),
}));

const { ProxiesView } = await import('../../src/views/ProxiesView');

async function clickTestAndSettle(): Promise<void> {
  // The proxy row loads async; wait for the Test button to appear.
  const btn = await screen.findByRole('button', { name: 'Test' });
  fireEvent.click(btn);
}

describe('ProxiesView "Test" button result card', () => {
  beforeEach(() => {
    testProxy.mockReset();
  });

  it('reachable + auth ok + UDP + fast → "healthy" pill + "<ms>" latency + a UDP badge', async () => {
    testProxy.mockResolvedValue({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      latency_ms: 42,
      message: 'ok',
    });
    render(<ProxiesView />);
    await clickTestAndSettle();

    // Health verdict for a reachable + authed + fast (<=100ms) probe.
    expect(await screen.findByText('healthy')).toBeTruthy();
    // Latency meter value (mono "<n>ms").
    expect(screen.getByText('42ms')).toBeTruthy();
    // UDP badge present on a UDP-capable exit (the proxy-row badge is the
    // literal "UDP"; the QUIC line is a separate, longer text node).
    expect(screen.getByText('UDP')).toBeTruthy();
  });

  it('reachable + auth ok + UDP but slow (>100ms) → "slow" pill (not "healthy")', async () => {
    testProxy.mockResolvedValue({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      latency_ms: 180,
      message: 'ok',
    });
    render(<ProxiesView />);
    await clickTestAndSettle();

    expect(await screen.findByText('slow')).toBeTruthy();
    expect(screen.queryByText('healthy')).toBeNull();
    expect(screen.getByText('180ms')).toBeTruthy();
  });

  it('reachable + auth rejected → "auth fail" pill (not "unreachable")', async () => {
    testProxy.mockResolvedValue({
      reachable: true,
      auth_ok: false,
      udp_associate: false,
      latency_ms: 88,
      message: 'Connected, but the proxy rejected the username/password.',
    });
    render(<ProxiesView />);
    await clickTestAndSettle();

    expect(await screen.findByText('auth fail')).toBeTruthy();
    expect(screen.queryByText('unreachable')).toBeNull();
  });

  it('unreachable → "unreachable" pill with no UDP badge', async () => {
    testProxy.mockResolvedValue({
      reachable: false,
      auth_ok: false,
      udp_associate: false,
      latency_ms: 0,
      message: 'TCP connect failed: timed out',
    });
    render(<ProxiesView />);
    await clickTestAndSettle();

    expect(await screen.findByText('unreachable')).toBeTruthy();
    // No UDP capability badge when the exit isn't even reachable — the
    // badge slot reads "no relay" instead, and there is no "UDP" node.
    expect(screen.queryByText('UDP')).toBeNull();
    expect(screen.getByText('no relay')).toBeTruthy();
  });
});

describe('capability board (approved proxy-health port)', () => {
  beforeEach(() => {
    testProxy.mockReset();
  });

  it('UDP-capable result renders the derived "QUIC + WebRTC ride UDP" line + pool stats appear after a test', async () => {
    testProxy.mockResolvedValue({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      latency_ms: 42,
      message: 'ok',
    });
    render(<ProxiesView />);
    await clickTestAndSettle();
    expect(await screen.findByText('QUIC + WebRTC ride UDP')).toBeInTheDocument();
    // Pool stats are derived over TESTED proxies only.
    expect(screen.getByText('Tested')).toBeInTheDocument();
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
    expect(screen.getByText('Full-stack (UDP)')).toBeInTheDocument();
  });

  it('no-UDP result renders the honest fallback line (h2 / TURN)', async () => {
    testProxy.mockResolvedValue({
      reachable: true,
      auth_ok: true,
      udp_associate: false,
      latency_ms: 42,
      message: 'no udp',
    });
    render(<ProxiesView />);
    await clickTestAndSettle();
    expect(await screen.findByText('QUIC + WebRTC fall back to h2 / TURN')).toBeInTheDocument();
  });

  it('Test all probes every saved proxy and disables while running', async () => {
    // Hold the probe open so we can observe the in-flight disabled state
    // before it settles.
    let release: (r: ProxyTestResult) => void = () => undefined;
    testProxy.mockImplementation(
      () =>
        new Promise<ProxyTestResult>((resolve) => {
          release = resolve;
        }),
    );
    render(<ProxiesView />);
    const btn = await screen.findByRole('button', { name: 'Test all' });
    fireEvent.click(btn);

    // While the (single) probe is in flight the Test-all control flips to
    // "Testing all…" and is disabled so a second sweep can't pile on.
    const running = await screen.findByRole('button', { name: 'Testing all…' });
    expect((running as HTMLButtonElement).disabled).toBe(true);

    // Let the probe finish and assert it actually probed + the result lands.
    release({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      latency_ms: 10,
      message: 'ok',
    });
    expect(await screen.findByText('QUIC + WebRTC ride UDP')).toBeInTheDocument();
    await waitFor(() => {
      expect(testProxy).toHaveBeenCalledTimes(1); // one saved proxy in the mock store
    });
    // The control returns to its idle "Test all" label once the sweep ends.
    expect(await screen.findByRole('button', { name: 'Test all' })).toBeInTheDocument();
  });
});

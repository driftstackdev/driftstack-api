// Behavior coverage for the Proxies-tab "Test" button (ProxiesView).
// The native probe itself is covered in Rust + the testProxy wrapper
// unit test; here we render the view, click Test on a saved proxy, and
// assert the card surfaces the correct verdict for each outcome.
//
// The Console restyle (2026-06-14) replaced the inline result row's
// prose headlines with a structured card: a HEALTH PILL verdict
// (healthy / slow / auth fail / unreachable / untested), a latency
// meter ("<n>ms"), and — since the G1 "professional UDP" pass — a
// protocol-capability chip row (WebRTC / QUIC / HTTP-2, each ✓ or
// fell-back via data-ok) in place of the bare "UDP" badge + prose
// QUIC/WebRTC line. These tests assert the SAME states the old copy
// did — in particular that a reachable-but-auth-rejected probe reads
// "auth fail", never the misleading "unreachable".

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

  it('reachable + auth ok + UDP + fast → "healthy" pill + "<ms>" latency + protocol chips', async () => {
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
    // Professional protocol-capability chips on a UDP-capable exit
    // (replaced the bare "UDP" badge): WebRTC + QUIC + HTTP/2.
    expect(screen.getByText('WebRTC')).toBeTruthy();
    expect(screen.getByText('QUIC')).toBeTruthy();
    expect(screen.getByText('HTTP/2')).toBeTruthy();
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

  it('unreachable → "unreachable" pill, no protocol chips, "no egress" note', async () => {
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
    // No protocol-capability chips when the exit isn't even reachable — the
    // slot reads "no egress" instead, and there is no WebRTC chip.
    expect(screen.queryByText('WebRTC')).toBeNull();
    expect(screen.getByText('no egress')).toBeTruthy();
  });
});

describe('capability board (approved proxy-health port)', () => {
  beforeEach(() => {
    testProxy.mockReset();
  });

  it('UDP-capable result renders the protocol chips (all ok) + pool stats appear after a test', async () => {
    testProxy.mockResolvedValue({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      latency_ms: 42,
      message: 'ok',
    });
    const { container } = render(<ProxiesView />);
    await clickTestAndSettle();
    // The capability chips render with every protocol ok (data-ok="true").
    expect(await screen.findByText('WebRTC')).toBeInTheDocument();
    expect(container.querySelector('[data-capability="webrtc"][data-ok="true"]')).not.toBeNull();
    expect(container.querySelector('[data-capability="quic"][data-ok="true"]')).not.toBeNull();
    // Pool stats are derived over TESTED proxies only.
    expect(screen.getByText('Tested')).toBeInTheDocument();
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
    expect(screen.getByText('WebRTC + QUIC')).toBeInTheDocument();
  });

  it('no-UDP result shows WebRTC + QUIC as fell-back (data-ok="false"), HTTP/2 ok', async () => {
    testProxy.mockResolvedValue({
      reachable: true,
      auth_ok: true,
      udp_associate: false,
      latency_ms: 42,
      message: 'no udp',
    });
    const { container } = render(<ProxiesView />);
    await clickTestAndSettle();
    await screen.findByText('WebRTC');
    expect(container.querySelector('[data-capability="webrtc"][data-ok="false"]')).not.toBeNull();
    expect(container.querySelector('[data-capability="quic"][data-ok="false"]')).not.toBeNull();
    expect(container.querySelector('[data-capability="http2"][data-ok="true"]')).not.toBeNull();
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
    expect(await screen.findByText('WebRTC')).toBeInTheDocument();
    await waitFor(() => {
      expect(testProxy).toHaveBeenCalledTimes(1); // one saved proxy in the mock store
    });
    // The control returns to its idle "Test all" label once the sweep ends.
    expect(await screen.findByRole('button', { name: 'Test all' })).toBeInTheDocument();
  });
});

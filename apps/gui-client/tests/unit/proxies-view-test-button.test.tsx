// Behavior coverage for the Proxies-tab "Test" button (ProxiesView).
// The native probe itself is covered in Rust + the testProxy wrapper
// unit test; here we render the view, click Test on a saved proxy, and
// assert the inline result row renders the correct headline for each
// outcome — in particular that a reachable-but-auth-rejected probe
// reads "Auth failed", not the misleading "Not reachable".

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
}));

const { ProxiesView } = await import('../../src/views/ProxiesView');

async function clickTestAndSettle(): Promise<void> {
  // The proxy row loads async; wait for the Test button to appear.
  const btn = await screen.findByRole('button', { name: 'Test' });
  fireEvent.click(btn);
}

describe('ProxiesView "Test" button result row', () => {
  beforeEach(() => {
    testProxy.mockReset();
  });

  it('reachable + auth ok + UDP → "Reachable · <ms>" with a UDP ✓ badge', async () => {
    testProxy.mockResolvedValue({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      latency_ms: 42,
      message: 'ok',
    });
    render(<ProxiesView />);
    await clickTestAndSettle();

    expect(await screen.findByText('Reachable · 42 ms')).toBeTruthy();
    expect(screen.getByText('UDP ✓')).toBeTruthy();
  });

  it('reachable + auth rejected → "Auth failed" (not "Not reachable")', async () => {
    testProxy.mockResolvedValue({
      reachable: true,
      auth_ok: false,
      udp_associate: false,
      latency_ms: 88,
      message: 'Connected, but the proxy rejected the username/password.',
    });
    render(<ProxiesView />);
    await clickTestAndSettle();

    expect(await screen.findByText('Auth failed')).toBeTruthy();
    expect(screen.queryByText('Not reachable')).toBeNull();
  });

  it('unreachable → "Not reachable" with no UDP badge', async () => {
    testProxy.mockResolvedValue({
      reachable: false,
      auth_ok: false,
      udp_associate: false,
      latency_ms: 0,
      message: 'TCP connect failed: timed out',
    });
    render(<ProxiesView />);
    await clickTestAndSettle();

    expect(await screen.findByText('Not reachable')).toBeTruthy();
    expect(screen.queryByText('UDP ✓')).toBeNull();
    expect(screen.queryByText('UDP ✗')).toBeNull();
  });
});

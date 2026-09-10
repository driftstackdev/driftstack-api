// Guard for MED #5 — the in-form "Test connection" panel must colour its verdict
// with the SHARED usability predicate (lib/proxies.isProxyUsable), which includes
// `can_route`, NOT the old `reachable && auth_ok` pair.
//
// A SOCKS5 proxy can complete the TCP connect, finish the greeting and accept
// credentials while refusing every CONNECT — reachable:true, auth_ok:true,
// can_route:false. Before the fix the panel read that as green "✓ Connected from
// this Mac", telling the customer a dead proxy works (the exact drift the single
// `isProxyUsable` predicate was introduced to remove — see lib/proxies).
//
// Harness mirrors a-local-or-allowlist-proxy-is-warned-in-the-form.test.tsx:
// render the canonical ProxyForm directly, spread the REAL lib/proxies so
// `isProxyUsable`/`proxyVerdict` are the app's own (a stub here could disagree
// with the app about "usable", the very drift under test), and stub only I/O —
// `testProxy` returns the non-routing result, the proxy-probe-cache side effects
// are neutralised.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type * as ProxiesModule from '../../src/lib/proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';
import type { ProxyDraft } from '../../src/lib/proxies';

// reachable + auth_ok but NOT routing — the case the old check mis-verdicted.
const NON_ROUTING = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: false,
  connect_reply: 0x02, // 0x02 = connection not allowed by ruleset
  latency_ms: 12,
  message: 'Connected and authenticated, but CONNECT was refused.',
};

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve([]),
  addProxy: vi.fn(() => Promise.resolve()),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve()),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: vi.fn(() => Promise.resolve({ resolved: true, ip: '1.2.3.4', message: 'ok' })),
  testProxy: vi.fn(() => Promise.resolve(NON_ROUTING)),
}));

vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeCacheModule>()),
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () => Promise.resolve({}),
  saveExitResult: vi.fn(() => Promise.resolve()),
  saveProbeResult: vi.fn(() => Promise.resolve()),
}));

const { ProxyForm } = await import('../../src/views/ProxiesView');

// A fully valid SOCKS5 draft so the form's own validateDraft passes and the
// Test-connection handler reaches the native probe.
const VALID_DRAFT: ProxyDraft = {
  label: 'eu-1',
  scheme: 'socks5',
  host: 'proxy.example.com',
  port: 1080,
  username: 'alice',
  password: 'p4ss',
};

function panel(): HTMLElement | null {
  return document.querySelector('[data-component="form-test-result"]');
}

describe('the in-form Test-connection verdict honours can_route (MED #5)', () => {
  it('CRITICAL a reachable + authenticated but NON-ROUTING proxy renders RED "✗ Failed", never green "✓ Connected"', async () => {
    render(
      <ProxyForm initial={VALID_DRAFT} mode="add" onCancel={() => undefined} onSave={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    // The panel commits the verdict once the probe resolves.
    const failed = await screen.findByText('✗ Failed');
    expect(failed).toBeTruthy();
    // The green verdict must NOT appear for a non-routing proxy.
    expect(screen.queryByText('✓ Connected from this Mac')).toBeNull();

    // The container carries the error palette, not the ready/green palette. This
    // is the assertion that breaks on a revert: with `reachable && auth_ok` the
    // container would gain `text-status-ready` and lose `text-status-error`.
    const box = panel();
    expect(box, 'the test-result panel did not render').not.toBeNull();
    expect(box?.className).toContain('text-status-error');
    expect(box?.className).not.toContain('text-status-ready');

    // The routing indicator was added to the detail line and reports the failure.
    expect(box).toHaveTextContent('route ✗');
  });
});

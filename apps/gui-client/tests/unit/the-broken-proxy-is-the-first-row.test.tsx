// The proxies page is a grid now, and a grid has one weakness.
//
// It replaced a three-column card deck. Cards are enormous targets — a failure
// turned a whole tile red — but they cost roughly 3x the vertical space per
// proxy, so a real fleet meant scrolling to see any of it. The grid fits twenty
// proxies on screen, sorts, and does bulk work.
//
// What it gives up is exactly that target size: in a row, a failure is a
// coloured stripe and a word, easy to walk straight past when you opened the
// page to do something else. These arms cover the two things that buy it back:
//
//   1. problems sort to the TOP by default, so you do not have to notice — the
//      broken proxy is simply the first row under the header;
//   2. the count of proxies needing attention is stated in words above the grid.
//
// The third arm is the one that would go stale silently: equal-status rows must
// keep their ORIGINAL order. An alphabetical tie-break reorders the whole page
// relative to the order proxies were added, and "the first Remove button" stops
// meaning the first proxy — which is how this was caught.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';

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
const SLOW: ProxyTestResult = { ...HEALTHY, latency_ms: 240, message: 'ok, slow' };
const UNREACHABLE: ProxyTestResult = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'timed out',
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

vi.mock('../../src/lib/proxy-probe-cache', () => ({
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () => Promise.resolve({}),
  saveExitResult: vi.fn(() => Promise.resolve()),
  saveProbeResult: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  clearBindingsForProxy: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../src/components/ConfirmProvider', () => ({ useConfirm: () => confirmFn }));

const settingsStub = { settings: { apiKey: null, baseUrl: 'http://localhost:3000' } };
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

/** Row labels top-to-bottom, which is the whole subject of this file. */
function rowOrder(): string[] {
  const body = document.querySelector('[data-component="proxy-table"] tbody');
  return [...(body?.querySelectorAll('tr') ?? [])].map(
    // The label cell also carries the username underneath, so read the label
    // element rather than the whole cell — otherwise a row identifies as
    // "proxy-buser" and a toContain match starts passing by accident.
    (tr) => tr.querySelector('td:nth-child(2) > div')?.textContent?.trim() ?? '',
  );
}

describe('the broken proxy is the first row', () => {
  beforeEach(() => {
    testProxy.mockReset();
    removeProxy.mockReset();
    removeProxy.mockImplementation((id) => {
      stored = stored.filter((item) => item.id !== id);
      return Promise.resolve();
    });
    confirmFn.mockClear();
    confirmFn.mockResolvedValue(true);
    stored = [];
  });

  it('CRITICAL a failure sorts to the top without being asked. In a row a failure is a stripe and a word — if you had to notice it, the grid would be worse than the cards it replaced.', async () => {
    stored = [proxy('good'), proxy('slow'), proxy('broken')];
    // Sweep order follows the stored order.
    testProxy
      .mockResolvedValueOnce(HEALTHY)
      .mockResolvedValueOnce(SLOW)
      .mockResolvedValueOnce(UNREACHABLE);
    render(<ProxiesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(3));

    // broken (rank 0) → slow (1) → healthy (3). Untested would sit at 2.
    await waitFor(() => expect(rowOrder()[0]).toContain('proxy-broken'));
    expect(rowOrder()[1]).toContain('proxy-slow');
    expect(rowOrder()[2]).toContain('proxy-good');
  });

  it('CRITICAL says in words how many need attention, so the count survives a glance that misses the colour', async () => {
    stored = [proxy('good'), proxy('broken')];
    testProxy.mockResolvedValueOnce(HEALTHY).mockResolvedValueOnce(UNREACHABLE);
    render(<ProxiesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/1 needs attention/i)).toBeInTheDocument();
  });

  it('CRITICAL equal-status rows keep the order they were added. An alphabetical tie-break silently reorders the page and "the first Remove" stops meaning the first proxy.', async () => {
    // Nothing tested: every row ties on status. 'stale' sorts AFTER 'current'
    // alphabetically, so an alphabetical tie-break would flip these two.
    stored = [proxy('stale'), proxy('current')];
    render(<ProxiesView />);

    await waitFor(() => expect(rowOrder().length).toBe(2));
    expect(rowOrder()[0]).toContain('proxy-stale');
    expect(rowOrder()[1]).toContain('proxy-current');

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() => expect(removeProxy).toHaveBeenCalledWith('stale'));
  });

  it('sorting by latency puts the fastest first and parks the unreachable at the end, not at zero', async () => {
    stored = [proxy('slow'), proxy('fast'), proxy('down')];
    testProxy
      .mockResolvedValueOnce(SLOW)
      .mockResolvedValueOnce(HEALTHY)
      .mockResolvedValueOnce(UNREACHABLE);
    render(<ProxiesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Test all' }));
    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByRole('button', { name: /latency/i }));

    // A down proxy reports latency_ms 0. Sorted naively it would claim to be
    // the fastest exit in the fleet.
    await waitFor(() => expect(rowOrder()[0]).toContain('proxy-fast'));
    expect(rowOrder()[1]).toContain('proxy-slow');
    expect(rowOrder()[2]).toContain('proxy-down');
  });

  it('CRITICAL a bulk remove confirms ONCE for the whole selection, not once per proxy', async () => {
    stored = [proxy('a'), proxy('b'), proxy('c')];
    render(<ProxiesView />);
    await waitFor(() => expect(rowOrder().length).toBe(3));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all proxies' }));
    const bar = document.querySelector('[data-component="proxy-bulk-bar"]');
    expect(bar, 'no bulk bar appeared after selecting').not.toBeNull();
    expect(within(bar as HTMLElement).getByText('3 selected')).toBeInTheDocument();

    fireEvent.click(within(bar as HTMLElement).getByRole('button', { name: 'Remove selected' }));

    await waitFor(() => expect(removeProxy).toHaveBeenCalledTimes(3));
    // Three modals for one intent is not a confirmation, it is an obstacle
    // course — and it trains the reflex of clicking through them.
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(String(confirmFn.mock.calls[0]?.[0])).toMatch(/Remove 3 proxies/);
  });

  it('a selection that disappears underneath you does not keep voting — the count must not lie', async () => {
    stored = [proxy('a'), proxy('b')];
    render(<ProxiesView />);
    await waitFor(() => expect(rowOrder().length).toBe(2));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all proxies' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    // Remove one through its own row button; the bulk selection must shrink.
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() => expect(removeProxy).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(rowOrder().length).toBe(1));
    await waitFor(() => expect(screen.getByText('1 selected')).toBeInTheDocument());
  });
});

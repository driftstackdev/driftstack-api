// Follow-up A (owner list 2026-09-24): "for a Free desktop key, the SOCKS5 row's
// Test says 'not tested · Driftstack' with no reason. Give it the plan reason."
//
// ROOT CAUSE. On a Free plan the full check through Driftstack is refused: the
// desktop sign-in key cannot reach `POST /v1/account/me/proxies/:id/test` (the
// free-desktop route policy), and `testAccountProxy` turns that 403 into
// `not_run: 'desktop_credential'` with the Free-plan sentence. The Proxies grid
// applied a `not_run` to a SOCKS5 row as "nothing changes" and never recorded it,
// so the latency cell's missing Driftstack side fell through to its last arm —
// "not tested", titled "Driftstack's network has not measured this proxy yet" —
// a promise of a measurement the plan will never take, and no reason at all. The
// VPN row already said the plan reason; the SOCKS5 row did not.
//
// The rule pinned here: a SOCKS5 row whose Driftstack side is missing BECAUSE of
// the plan says so — in the reading's word and in its hover — both right after a
// Test the server refused, and after a remount on a Free account (the plan is an
// account fact, so a reload must not fall back to "not tested"). VACUITY: a paid
// account's row that has simply not been tested by Driftstack still says
// "not tested".

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as ProxiesModule from '../../src/lib/proxies';
import type { AccountProxyTestResult } from '../../src/lib/account-proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type { ProbeCacheMap } from '../../src/lib/proxy-probe-cache';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';
import { DESKTOP_CREDENTIAL_FLEET_TEST_REASON } from '../../src/lib/account-proxies';
import { FREE_PLAN_FLEET_TEST_SENTENCE } from '../../src/lib/proxy-check-copy';

const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
const listProxies = vi.fn<() => Promise<ProxyConfig[]>>();
const testAccountProxy =
  vi.fn<
    (
      baseUrl: string,
      apiKey: string,
      id: string,
      opts?: { vantage?: 'cp' | 'fleet' },
    ) => Promise<AccountProxyTestResult>
  >();

const NATIVE_42: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};

const savedProxy: ProxyConfig = {
  id: 'p1',
  label: 'london-socks',
  host: 'proxy.example.com',
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
  serverId: 'aprx_1',
};

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => listProxies(),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: () => Promise.resolve(null),
}));

vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  testAccountProxy: (
    baseUrl: string,
    apiKey: string,
    id: string,
    opts?: { vantage?: 'cp' | 'fleet' },
  ) => testAccountProxy(baseUrl, apiKey, id, opts),
  // Proxy-accuracy audit G3 — a SOCKS5 Test pushes the stored row before the
  // fleet leg; the account accepts it.
  updateProxy: () => Promise.resolve({}),
}));

let cacheFixture: ProbeCacheMap = {};
vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeCacheModule>()),
  loadProbeCache: () => Promise.resolve(cacheFixture),
}));

const settingsStub: {
  settings: { apiKey: string | null; baseUrl: string };
  accountMe: { tier: string; teams: unknown[] } | null;
} = {
  settings: { apiKey: 'ds_desktop', baseUrl: 'http://localhost:3000' },
  accountMe: null,
};
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

function missingServer(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-latency-missing="server"]');
}

describe('follow-up A — a Free plan SOCKS5 row says WHY Driftstack did not test it', () => {
  beforeEach(() => {
    cleanup();
    listProxies.mockReset();
    listProxies.mockResolvedValue([savedProxy]);
    testProxy.mockReset();
    testProxy.mockResolvedValue(NATIVE_42);
    testAccountProxy.mockReset();
    settingsStub.settings = { apiKey: 'ds_desktop', baseUrl: 'http://localhost:3000' };
    settingsStub.accountMe = null;
    cacheFixture = {};
  });

  it('CRITICAL after a Test the plan refused: the Driftstack side names the plan, in its word and its hover', async () => {
    // What `testAccountProxy` returns for the free-desktop route policy's 403.
    testAccountProxy.mockResolvedValue({
      ok: false,
      reason: DESKTOP_CREDENTIAL_FLEET_TEST_REASON,
      not_run: 'desktop_credential',
    });
    const { container } = render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    await screen.findByText('42ms');
    await vi.waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(missingServer(container)?.getAttribute('title')).toBe(FREE_PLAN_FLEET_TEST_SENTENCE),
    );
    const el = missingServer(container) as HTMLElement;
    expect(el.textContent).toContain('not on plan');
    expect(el.textContent).toContain('Driftstack');
    expect(el.textContent).not.toContain('not tested');
    expect(el.getAttribute('data-missing-why')).toBe('plan');
  });

  it('after a reload on a Free account (no Test in this mount) it still says the plan, never "not tested"', async () => {
    settingsStub.accountMe = { tier: 'free', teams: [] };
    cacheFixture = { p1: { result: NATIVE_42, at: Date.UTC(2026, 8, 10) } };
    const { container } = render(<ProxiesView />);
    await screen.findByText('42ms');
    const el = missingServer(container);
    expect(el?.textContent).toContain('not on plan');
    expect(el?.getAttribute('title')).toBe(FREE_PLAN_FLEET_TEST_SENTENCE);
    expect(testAccountProxy).not.toHaveBeenCalled();
  });

  it('VACUITY: a paid account row Driftstack has not tested yet still says "not tested"', async () => {
    settingsStub.accountMe = { tier: 'solo_manual', teams: [] };
    cacheFixture = { p1: { result: NATIVE_42, at: Date.UTC(2026, 8, 10) } };
    const { container } = render(<ProxiesView />);
    await screen.findByText('42ms');
    const el = missingServer(container);
    expect(el?.textContent).toContain('not tested');
    expect(el?.getAttribute('title')).not.toBe(FREE_PLAN_FLEET_TEST_SENTENCE);
    expect(el?.getAttribute('data-missing-why')).toBeNull();
  });
});

// (n) N2 + N3 — a WireGuard row's Check must be about the config the customer just
// saved, not the one the last LAUNCH happened to store.
//
// N2 MEASURED: nothing in ProxiesView ever called `updateAccountProxy`. The only
// writers of the account row were the two launch paths (ProfilesView.ensureServerProxy,
// AgentChatView), so between Save and the next launch the account row still held the
// previous private key and endpoint — and `handleCheckEndpoint` asked the fleet to bring
// THAT tunnel up. The row (and the profile card) then showed the old tunnel's latency,
// exit IP, country and timezone as the verdict for the conf just pasted, and every
// manual Check repeated it. A SOCKS5 row is unaffected: its Test is native and reads the
// local credentials.
//
// N3 MEASURED: the post-save invalidation compared scheme/host/port/username/password
// only. Host and port are DERIVED from the conf's Endpoint line and username/password
// are null on a VPN row, so a key rotation (the provider reissues the conf, same server)
// changed none of them — no invalidation, no re-test, and yesterday's "tunnel up" stood
// over keys the fleet had never used.
//
// The arms drive the REAL view through the REAL form and the REAL wg parser: the defect
// is in what ProxiesView sends and when, so nothing between the paste and the request is
// stubbed except the two network calls being measured.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, ProxyDraft, ProxyTestResult } from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const PRIV_OLD = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const PRIV_NEW = 'aB3z5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

/** A wg0.conf as a provider hands it over. */
function conf(opts: { privateKey?: string; endpoint?: string } = {}): string {
  return [
    '[Interface]',
    `PrivateKey = ${opts.privateKey ?? PRIV_NEW}`,
    'Address = 10.7.0.2/32',
    'DNS = 10.64.0.1',
    '[Peer]',
    `PublicKey = ${PUB}`,
    `Endpoint = ${opts.endpoint ?? 'wg-old.example.com:51820'}`,
    'AllowedIPs = 0.0.0.0/0',
  ].join('\n');
}

const OLD_BLOCK = {
  private_key: PRIV_OLD,
  peer_public_key: PUB,
  endpoint: 'wg-old.example.com:51820',
  allowed_ips: '0.0.0.0/0',
  address: '10.7.0.2/32',
  dns: '10.64.0.1',
};

function wgRow(): ProxyConfig {
  return {
    id: 'wg1',
    label: 'wg-london',
    host: 'wg-old.example.com',
    port: 51820,
    username: null,
    password: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    scheme: 'wireguard',
    serverId: 'aprx_wg',
    wireguard: OLD_BLOCK,
  };
}

let stored: ProxyConfig[] = [];

const resolveEndpoint =
  vi.fn<
    (host: string, port: number) => Promise<{ resolved: boolean; ip: string; message: string }>
  >();
const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
const invalidateProbe = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
const { updateAccountProxy, testAccountProxy } = vi.hoisted(() => ({
  updateAccountProxy:
    vi.fn<
      (
        baseUrl: string,
        apiKey: string,
        id: string,
        patch: Record<string, unknown>,
      ) => Promise<{ id: string }>
    >(),
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

const settingsStub = { settings: { apiKey: 'ds_test_x' as string | null, baseUrl: 'http://x' } };

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  // The local registry write, kept STATEFUL: the post-save check re-lists and
  // tests whatever the registry now holds, so a mock that dropped the edit would
  // make the N2 arm assert against the pre-edit row and pass for the wrong reason.
  updateProxy: vi.fn((id: string, patch: ProxyDraft) => {
    stored = stored.map((p) => (p.id === id ? { ...p, ...patch } : p));
    return Promise.resolve(stored.find((p) => p.id === id));
  }),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: (host: string, port: number) => resolveEndpoint(host, port),
}));

vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  // The two calls under measurement. Everything else (buildWireGuardProxyInput,
  // the account list) stays REAL, so the block the view pushes is the block the
  // real builder produced from the real parser.
  updateProxy: (baseUrl: string, apiKey: string, id: string, patch: Record<string, unknown>) =>
    updateAccountProxy(baseUrl, apiKey, id, patch),
  testAccountProxy: (
    baseUrl: string,
    apiKey: string,
    id: string,
    opts?: { vantage?: 'cp' | 'fleet' },
  ) => testAccountProxy(baseUrl, apiKey, id, opts),
  listProxies: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeCacheModule>()),
  invalidateProbe: (id: string) => invalidateProbe(id),
  loadProbeCache: () => Promise.resolve({}),
  saveExitResult: vi.fn(() => Promise.resolve({})),
  saveProbeResult: vi.fn(() => Promise.resolve({})),
  saveOsFingerprint: vi.fn(() => Promise.resolve({})),
  saveServerProbeResult: vi.fn(() => Promise.resolve({})),
  saveEndpointResult: vi.fn(() => Promise.resolve({})),
  saveFleetFailure: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  profilesUsingProxy: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

const FLEET_OK: AccountProxiesModule.AccountProxyTestResult = {
  ok: true,
  latency_ms: 42,
  measured_from: 'fleet',
  node_id: 'mac-mini-07',
  exit_observed: {
    ip: '203.0.113.9',
    country: 'NL',
    timezone: 'Europe/Amsterdam',
    region: 'North Holland',
    city: 'Amsterdam',
  },
};

beforeEach(() => {
  stored = [wgRow()];
  resolveEndpoint.mockReset();
  resolveEndpoint.mockResolvedValue({ resolved: true, ip: '198.51.100.1', message: 'Resolved' });
  testProxy.mockReset();
  invalidateProbe.mockClear();
  updateAccountProxy.mockReset();
  updateAccountProxy.mockResolvedValue({ id: 'aprx_wg' });
  testAccountProxy.mockReset();
  testAccountProxy.mockResolvedValue(FLEET_OK);
  settingsStub.settings.apiKey = 'ds_test_x';
});

async function openEdit(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  await screen.findByRole('button', { name: 'Save changes' });
}

function pasteConf(text: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: /wg0\.conf/i }), {
    target: { value: text },
  });
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
}

describe('(n) N2 — the fleet tests the material this Mac holds, not the last launch’s', () => {
  it('CRITICAL an edited WireGuard row pushes the NEW block to the account row BEFORE the fleet test runs', async () => {
    render(<ProxiesView />);
    await openEdit();
    pasteConf(conf({ endpoint: 'wg-new.example.com:51820', privateKey: PRIV_NEW }));
    save();

    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    // The PUT carried the material the customer just pasted…
    expect(updateAccountProxy).toHaveBeenCalledTimes(1);
    const [baseUrl, apiKey, id, patch] = updateAccountProxy.mock.calls[0] ?? [];
    expect([baseUrl, apiKey, id]).toEqual(['http://x', 'ds_test_x', 'aprx_wg']);
    expect(patch).toMatchObject({
      scheme: 'wireguard',
      host: 'wg-new.example.com',
      port: 51820,
      wireguard: { endpoint: 'wg-new.example.com:51820', private_key: PRIV_NEW },
    });
    // …and it landed BEFORE the fleet was asked to bring the tunnel up. Order is
    // the whole finding: a push that lands after the test still leaves the test
    // measuring the previous config.
    const pushedAt = updateAccountProxy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const testedAt = testAccountProxy.mock.invocationCallOrder[0] ?? 0;
    expect(pushedAt, 'the account row was refreshed AFTER the fleet test').toBeLessThan(testedAt);
    expect(testAccountProxy).toHaveBeenCalledWith('http://x', 'ds_test_x', 'aprx_wg', {
      vantage: 'fleet',
    });
  });

  it('CRITICAL CONTROL — a label-only rename pushes nothing and tests nothing: the endpoint and the material are unchanged, so the standing verdict still describes the row', async () => {
    render(<ProxiesView />);
    await openEdit();
    fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), {
      target: { value: 'wg-london-2' },
    });
    save();

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(invalidateProbe).not.toHaveBeenCalled();
    expect(resolveEndpoint).not.toHaveBeenCalled();
    expect(testAccountProxy).not.toHaveBeenCalled();
    expect(updateAccountProxy).not.toHaveBeenCalled();
  });

  it('a manual Check (no edit) refreshes the account row too — the row may have been edited in an earlier visit that never launched', async () => {
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: /^check vpn$|^re-check$/i }));
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    expect(updateAccountProxy).toHaveBeenCalledTimes(1);
    expect(updateAccountProxy.mock.calls[0]?.[3]).toMatchObject({
      wireguard: { private_key: PRIV_OLD },
    });
  });

  it('CONTROL — a push that fails never blocks the check: the fleet is still asked (a refresh is not a precondition)', async () => {
    updateAccountProxy.mockRejectedValue(Object.assign(new Error('offline'), { status: 500 }));
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: /^check vpn$|^re-check$/i }));
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('tunnel up')).toBeInTheDocument();
  });

  it('CONTROL — with no API key nothing is pushed (there is no account row to push to) and the fleet is not asked', async () => {
    settingsStub.settings.apiKey = null;
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: /^check vpn$|^re-check$/i }));
    expect(await screen.findByText('endpoint ok')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(updateAccountProxy).not.toHaveBeenCalled();
    expect(testAccountProxy).not.toHaveBeenCalled();
  });
});

describe('(n) N3 — a key rotation on the SAME endpoint invalidates and re-checks', () => {
  it('CRITICAL a re-pasted conf with the same Endpoint and a different PrivateKey drops the cached verdict and runs the check', async () => {
    render(<ProxiesView />);
    await openEdit();
    // Same server, new keys — host, port, username and password are all unchanged,
    // which is exactly why this edit used to pass through unnoticed.
    pasteConf(conf({ endpoint: 'wg-old.example.com:51820', privateKey: PRIV_NEW }));
    save();

    await waitFor(() => expect(invalidateProbe).toHaveBeenCalledWith('wg1'));
    await waitFor(() => expect(resolveEndpoint).toHaveBeenCalledWith('wg-old.example.com', 51820));
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    // And the fleet tested the NEW key, not the one the account row held.
    expect(updateAccountProxy.mock.calls[0]?.[3]).toMatchObject({
      wireguard: { private_key: PRIV_NEW, endpoint: 'wg-old.example.com:51820' },
    });
  });

  it('CRITICAL VACUITY CONTROL — re-pasting the IDENTICAL conf changes nothing: no invalidation, no re-check. A compare that answered "changed" for every edit would satisfy the arm above and fail this.', async () => {
    render(<ProxiesView />);
    await openEdit();
    pasteConf(conf({ endpoint: 'wg-old.example.com:51820', privateKey: PRIV_OLD }));
    save();

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(invalidateProbe).not.toHaveBeenCalled();
    expect(resolveEndpoint).not.toHaveBeenCalled();
    expect(testAccountProxy).not.toHaveBeenCalled();
  });
});

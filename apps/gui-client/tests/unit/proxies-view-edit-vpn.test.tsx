// Regression: editing a VPN (WireGuard / OpenVPN) proxy must preserve its
// `scheme` + config block.
//
// toDraft() (the ProxyConfig → ProxyDraft seed for the edit form) historically
// copied ONLY the socks5 fields (label/host/port/username/password), dropping
// `scheme` and the `openvpn`/`wireguard` blocks. So editing a VPN proxy — even
// a label-only rename — saved back with no scheme/config, silently reverting a
// working OpenVPN/WireGuard proxy into a broken SOCKS5 one. These tests render
// the view, open the edit form for a saved VPN proxy, change only the label,
// save, and assert updateProxy receives the scheme + config intact.

import type * as ProxiesModule from '../../src/lib/proxies';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ProxyConfig, ProxyDraft } from '../../src/lib/proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const updateProxy = vi.fn<(id: string, patch: ProxyDraft) => Promise<unknown>>();
const addProxy = vi.fn<(draft: ProxyDraft) => Promise<unknown>>();

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const WIREGUARD_PROXY: ProxyConfig = {
  id: 'wg1',
  label: 'wg-london',
  host: 'wg.example.com',
  port: 51820,
  username: null,
  password: null,
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'wireguard',
  wireguard: {
    // Keys the way `wg genkey | wg pubkey` prints them (43 base64 chars + `=`). The
    // form now runs the server's own WireGuardProxyConfigSchema over the stored block
    // before Save (wireguardRefusal), so a placeholder key here would disable Save and
    // this arm would measure that gate instead of the rename. A stored block always
    // passed that schema at create time, so real-shaped keys are the faithful fixture.
    private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
    peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
    endpoint: 'wg.example.com:51820',
    allowed_ips: '0.0.0.0/0',
    address: '10.7.0.2/32',
  },
};

const OPENVPN_PROXY: ProxyConfig = {
  id: 'ovpn1',
  label: 'ovpn-paris',
  host: 'vpn.example.com',
  port: 1194,
  username: null,
  password: null,
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'openvpn',
  openvpn: {
    config_blob: 'client\nremote vpn.example.com 1194 udp\ndev tun\n',
    username: 'ovpnuser',
  },
};

let stored: ProxyConfig[] = [];

// ⛔ PARTIAL mock, not a replacement. A factory that enumerates exports breaks the
// moment the module gains one — `hostWarningFor` was added for the local-proxy
// advice and seven suites went red on a module they only wanted two stubs from.
// The spread keeps every real export; the keys below still override the ones this
// suite controls.
vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  // Pure predicate — use the real one. A stub here would let a suite
  // disagree with the app about what "usable" means, which is the very
  // drift this predicate was introduced to remove.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: (draft: ProxyDraft) => addProxy(draft),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: (id: string, patch: ProxyDraft) => updateProxy(id, patch),
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

// The probe-cache module is loaded by the view; stub it so the test doesn't hit
// the real tauri store.
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

// ProxiesView reads useSettings() (server-side proxy delete on remove). Stub it —
// apiKey:null short-circuits the server call; the edit path under test is unaffected.
const settingsStub = { settings: { apiKey: null, baseUrl: 'http://localhost:3000' } };
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

async function openEditAndRename(label: string, newLabel: string): Promise<void> {
  // Wait for the card to load, then click its Edit button.
  await screen.findByText(label);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  // The label field is seeded with the existing label; change ONLY it.
  const labelInput = await screen.findByDisplayValue(label);
  fireEvent.change(labelInput, { target: { value: newLabel } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
}

describe('ProxiesView — editing a VPN proxy preserves scheme + config', () => {
  beforeEach(() => {
    addProxy.mockReset();
    addProxy.mockResolvedValue({});
    updateProxy.mockReset();
    updateProxy.mockResolvedValue({});
  });

  // item 6c client half (audit follow-up 2026-09-08): the .ovpn paste handler now
  // runs the SAME shared api-types finders the server enforces, so a config the
  // server would reject is flagged INSTANTLY at paste rather than via a round-trip
  // 400. Two classes: an external cert-file reference, and a script directive.
  it('paste warns instantly on an external cert-file reference (server would reject it)', async () => {
    stored = [];
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'New proxy' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'openvpn' } });
    const textarea = await screen.findByPlaceholderText(/remote vpn\.example\.com/);
    fireEvent.change(textarea, {
      target: { value: 'client\nremote vpn.example.com 1194\nca ca.crt\ndev tun\n' },
    });
    expect(
      await screen.findByText((c) => c.includes('points to a file') && c.includes('inline')),
    ).toBeTruthy();
  });

  it('paste AUTO-NORMALIZES a script-executing directive (inert on Driftstack) instead of blocking', async () => {
    // N1 (owner) — the server refuses a script directive, but Driftstack never runs VPN
    // scripts, so the strip removes it without changing how the tunnel connects. The paste
    // flow now applies that automatically (paste OR file upload) with a transparent note,
    // rather than stopping behind a "Remove unsupported lines" button.
    stored = [];
    render(<ProxiesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'New proxy' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'openvpn' } });
    const textarea = await screen.findByPlaceholderText(/remote vpn\.example\.com/);
    fireEvent.change(textarea, {
      target: { value: 'client\nremote vpn.example.com 1194\nup /etc/openvpn/up.sh\ndev tun\n' },
    });
    // Accepted (✓ remote), with an honest note that the script directive was removed.
    expect(
      await screen.findByText(
        (c) => c.includes('✓ remote vpn.example.com:1194') && c.includes('script directive'),
      ),
    ).toBeTruthy();
  });

  it('single-flights Add, locks the draft, and keeps the busy state through refresh', async () => {
    stored = [];
    const pending = deferred<unknown>();
    addProxy.mockReturnValueOnce(pending.promise);
    render(<ProxiesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'New proxy' }));
    const submit = screen.getByRole('button', { name: 'Add proxy' });
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(addProxy).toHaveBeenCalledTimes(1));
    const adding = screen.getByRole('button', { name: 'Adding…' });
    expect(adding).toBeDisabled();
    expect(adding).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    const form = adding.closest('form');
    expect(form).toHaveAttribute('inert');
    expect(form).toHaveAttribute('aria-disabled', 'true');

    pending.resolve({});
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Adding…' })).toBeNull());
    expect(addProxy).toHaveBeenCalledTimes(1);
  });

  it('releases the Add latch after failure so the same draft can retry once', async () => {
    stored = [];
    addProxy.mockRejectedValueOnce(new Error('vault unavailable')).mockResolvedValueOnce({});
    render(<ProxiesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'New proxy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add proxy' }));
    await screen.findByText(/Couldn't save this proxy/);

    const retry = screen.getByRole('button', { name: 'Add proxy' });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(addProxy).toHaveBeenCalledTimes(2));
  });

  it('single-flights two same-turn Save changes activations', async () => {
    stored = [WIREGUARD_PROXY];
    const pending = deferred<unknown>();
    updateProxy.mockReturnValueOnce(pending.promise);
    render(<ProxiesView />);
    await screen.findByText('wg-london');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByDisplayValue('wg-london'), {
      target: { value: 'wg-london-renamed' },
    });

    const submit = screen.getByRole('button', { name: 'Save changes' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(updateProxy).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    pending.resolve({});
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Saving…' })).toBeNull());
    expect(updateProxy).toHaveBeenCalledTimes(1);
  });

  it('renaming a WireGuard proxy keeps scheme:wireguard + the wireguard block', async () => {
    stored = [WIREGUARD_PROXY];
    render(<ProxiesView />);
    await openEditAndRename('wg-london', 'wg-london-renamed');

    await waitFor(() => expect(updateProxy).toHaveBeenCalledTimes(1));
    const [id, patch] = updateProxy.mock.calls[0] as [string, ProxyDraft];
    expect(id).toBe('wg1');
    expect(patch.label).toBe('wg-london-renamed');
    // The bug: these were dropped, reverting the proxy to a broken SOCKS5 one.
    expect(patch.scheme).toBe('wireguard');
    expect(patch.wireguard).toEqual(WIREGUARD_PROXY.wireguard);
    expect(patch.openvpn).toBeUndefined();
  });

  it('renaming an OpenVPN proxy keeps scheme:openvpn + the openvpn block', async () => {
    stored = [OPENVPN_PROXY];
    render(<ProxiesView />);
    await openEditAndRename('ovpn-paris', 'ovpn-paris-renamed');

    await waitFor(() => expect(updateProxy).toHaveBeenCalledTimes(1));
    const [id, patch] = updateProxy.mock.calls[0] as [string, ProxyDraft];
    expect(id).toBe('ovpn1');
    expect(patch.label).toBe('ovpn-paris-renamed');
    expect(patch.scheme).toBe('openvpn');
    expect(patch.openvpn).toEqual(OPENVPN_PROXY.openvpn);
    expect(patch.wireguard).toBeUndefined();
  });

  // P2 #3 — the saved-proxy card used to hardcode "🔒 SOCKS5" and always offer a
  // SOCKS5 probe Test, so a VPN/HTTP proxy was mislabeled AND its Test always read
  // "unreachable". The card now labels by the actual scheme and gates the SOCKS5 Test.
  // N4 — the static "Verified at launch" note became an on-demand "Check endpoint"
  // button (a DNS pre-flight; the tunnel still verifies at launch, per its tooltip).
  it('labels a VPN proxy by its scheme (not SOCKS5) + replaces the SOCKS5 Test with an endpoint check', async () => {
    stored = [WIREGUARD_PROXY];
    render(<ProxiesView />);
    await screen.findByText('wg-london');
    // Labeled WireGuard, NOT SOCKS5.
    expect(screen.getByText('WireGuard')).toBeInTheDocument();
    expect(screen.queryByText('SOCKS5')).toBeNull();
    // No SOCKS5 Test/Re-test button — the tunnel verifies at launch.
    expect(screen.queryByRole('button', { name: /^(Test|Re-test)$/ })).toBeNull();
    // N4 — instead it offers an on-demand DNS endpoint check (the tunnel verifies at launch).
    expect(screen.getByRole('button', { name: /^check vpn$/i })).toBeInTheDocument();
    expect(screen.queryByText('Verified at launch')).toBeNull();
  });

  it('keeps the SOCKS5 label + Test button for a SOCKS5 proxy', async () => {
    stored = [
      {
        id: 's1',
        label: 'socks-ams',
        host: '1.2.3.4',
        port: 1080,
        username: null,
        password: null,
        createdAt: '2026-05-20T00:00:00.000Z',
        scheme: 'socks5',
      },
    ];
    render(<ProxiesView />);
    await screen.findByText('socks-ams');
    expect(screen.getByText('SOCKS5')).toBeInTheDocument();
    // The SOCKS5 probe Test IS offered for a socks5 proxy.
    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();
    expect(screen.queryByText('Verified at launch')).toBeNull();
  });

  // (l) #16 (review of the batch) — handleSave re-tested EVERY connection
  // edit through handleTest, which had no scheme gate: an OpenVPN row whose
  // remote moved (or a row edited onto a VPN scheme) got the native SOCKS5
  // handshake against a UDP endpoint — the T-20 "unreachable" false negative
  // written into the cache as this row's verdict. MUTATION: route the edited
  // row back to `handleTest` unconditionally AND drop handleTest's own scheme
  // gate → testProxy is invoked with the VPN host → red.
  it('CRITICAL editing an OpenVPN row’s remote re-tests with ITS check (the endpoint pre-flight), never the SOCKS5 probe', async () => {
    stored = [OPENVPN_PROXY];
    const Proxies = await import('../../src/lib/proxies');
    vi.mocked(Proxies.testProxy).mockClear();
    vi.mocked(Proxies.resolveEndpoint).mockClear();
    render(<ProxiesView />);
    await screen.findByText('ovpn-paris');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    // The stub registry must reflect the save: handleSave re-lists and tests
    // the row AS STORED, so a static list would re-check the old remote.
    updateProxy.mockImplementation((id, patch) => {
      stored = stored.map((p) => (p.id === id ? { ...p, ...patch } : p));
      return Promise.resolve({});
    });
    const blob = await screen.findByPlaceholderText(/remote vpn\.example\.com 1194 udp/);
    fireEvent.change(blob, {
      target: { value: 'client\nremote vpn-moved.example.com 1194 udp\ndev tun\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateProxy).toHaveBeenCalledTimes(1));
    const [, patch] = updateProxy.mock.calls[0] as [string, ProxyDraft];
    expect(patch.host).toBe('vpn-moved.example.com');
    expect(patch.scheme).toBe('openvpn');
    // The moved endpoint is re-checked the way a VPN row is checked…
    await waitFor(() =>
      expect(Proxies.resolveEndpoint).toHaveBeenCalledWith('vpn-moved.example.com', 1194),
    );
    // …and the SOCKS5 greeting is never sent to it.
    await new Promise((r) => setTimeout(r, 20));
    expect(Proxies.testProxy).not.toHaveBeenCalled();
    expect(screen.queryByText(/unreachable/i)).toBeNull();
  });

  it('CONTROL — editing a SOCKS5 row’s host still re-tests with the native probe', async () => {
    stored = [
      {
        id: 's1',
        label: 'socks-a',
        host: '10.0.0.1',
        port: 1080,
        username: null,
        password: null,
        createdAt: '2026-05-20T00:00:00.000Z',
        scheme: 'socks5',
      },
    ];
    const Proxies = await import('../../src/lib/proxies');
    vi.mocked(Proxies.testProxy).mockClear();
    vi.mocked(Proxies.resolveEndpoint).mockClear();
    updateProxy.mockImplementation((id, patch) => {
      stored = stored.map((p) => (p.id === id ? { ...p, ...patch } : p));
      return Promise.resolve({});
    });
    render(<ProxiesView />);
    await screen.findByText('socks-a');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const host = await screen.findByDisplayValue('10.0.0.1');
    fireEvent.change(host, { target: { value: '10.0.0.2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateProxy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(Proxies.testProxy).toHaveBeenCalledWith(expect.objectContaining({ host: '10.0.0.2' })),
    );
    expect(Proxies.resolveEndpoint).not.toHaveBeenCalled();
  });

  it('renders the VPN scheme fields (not the SOCKS5 host/port) when editing a VPN proxy', async () => {
    stored = [WIREGUARD_PROXY];
    render(<ProxiesView />);
    await screen.findByText('wg-london');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    // The scheme <select> reflects the saved scheme, so the form opens on the
    // WireGuard editor (the wg0.conf textarea), not the SOCKS5 host/port grid.
    // findByDisplayValue returns HTMLElement & { value } so .value is in scope.
    const schemeSelect = await screen.findByDisplayValue<HTMLSelectElement>('WireGuard');
    expect(schemeSelect.value).toBe('wireguard');
    // The SOCKS5 quick-paste field is hidden for a VPN scheme.
    expect(
      screen.queryByPlaceholderText('paste a proxy line to auto-fill the fields below'),
    ).toBeNull();
  });
});

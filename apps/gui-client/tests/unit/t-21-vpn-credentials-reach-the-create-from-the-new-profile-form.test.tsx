// T-21 (ledger, owner #8's twin) — "OpenVPN adding, perhaps wireguard too, does
// not take login credentials at New Profile > New proxy, only at proxies tab."
//
// The New-Profile modal used to render its OWN hand-rolled proxy mini-form, which
// omitted the OpenVPN auth username/password fields entirely (and called
// buildOpenVpnProxyInput with three args, never the credential fourth). So a
// customer adding an OpenVPN egress from the profile-create flow had no way to
// type the credentials the endpoint needs, and the proxy authenticated with
// nothing. The fix deletes that duplicate and renders the ONE canonical ProxyForm
// — the same component as the Proxies tab, which has the auth fields.
//
// This is the behavioral arm: adding an OpenVPN proxy from the New-Profile form,
// with an auth username + password, must call the proxy create with those
// credentials present on the openvpn block. The vacuity control is a SOCKS5 proxy
// added the same way, which carries no VPN credentials and is unaffected by the
// credential-passthrough this arm protects — so a form that always attached the
// fields (or always dropped them) cannot satisfy both arms.

import type * as ProxiesModule from '../../src/lib/proxies';
import type * as OpenVpnModule from '../../src/lib/parse-openvpn';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const addProxy = vi.fn<(d: unknown) => Promise<{ id: string }>>(() =>
  Promise.resolve({ id: 'p_new' }),
);

const stableContext = {
  client: {
    profiles: {
      list: () => Promise.resolve({ data: [] }),
      iterate: function* () {
        /* empty hub */
      },
      create: vi.fn(() => Promise.resolve({ id: 'prof_new' })),
    },
    sessions: { list: () => Promise.resolve({ data: [] }) },
    agentSessions: { list: () => Promise.resolve({ data: [] }) },
  },
  settings: { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' },
  accountMe: {
    tier: 'solo_manual',
    concurrent_session_cap: 5,
    concurrent_session_active: 0,
    profile_cap: 10,
    profile_count: 0,
  },
  refreshAccountMe: vi.fn(() => Promise.resolve()),
  loading: false,
  activeWorkspace: null,
  setActiveWorkspace: vi.fn(),
};
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => stableContext }));

vi.mock('../../src/lib/profiles-meta', () => ({
  loadProfilesMeta: () => Promise.resolve({}),
  persistProfilesMeta: vi.fn(() => Promise.resolve()),
  saveProfileMeta: vi.fn(() => Promise.resolve({})),
  saveProfilesMetaBulk: vi.fn(() => Promise.resolve({})),
  seedMetaFromServer: (local: unknown) => ({ map: local, changed: false }),
  folderList: () => [],
  aggregateTags: () => [],
}));
vi.mock('../../src/lib/folders-store', () => ({
  loadFolders: () => Promise.resolve([]),
  addFolder: vi.fn(() => Promise.resolve([])),
  loadFolderIcons: () => Promise.resolve({}),
  replaceAllFolders: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/lib/tags-store', () => ({
  loadTags: () => Promise.resolve([]),
  addTag: vi.fn(() => Promise.resolve([])),
  replaceAllTags: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/lib/account-organization', () => ({
  fetchOrganization: () => Promise.reject(new Error('offline')),
  saveOrganization: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadProbeCache: () => Promise.resolve({}),
  saveProbeResult: vi.fn(() => Promise.resolve({})),
  saveExitResult: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../src/lib/agent-session-control', () => ({
  mintGuiControlKey: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () => Promise.resolve([]),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: vi.fn(() => Promise.resolve()),
  markLaunched: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(() => Promise.resolve()),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));

// The .ovpn parse is stubbed to accept our fixture and hand back a remote, so the
// form builds the openvpn block; validateDraft stays REAL (from the spread) so
// the "Add proxy" gate genuinely passes only a well-formed draft.
vi.mock('../../src/lib/parse-openvpn', async (importOriginal) => ({
  ...(await importOriginal<typeof OpenVpnModule>()),
  validateOpenVpnConfig: () => ({
    ok: true as const,
    remoteHost: 'vpn.example.com',
    remotePort: 1194,
  }),
}));

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve([]),
  addProxy: (d: unknown) => addProxy(d),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  testProxy: vi.fn(() => Promise.resolve({})),
  probeProxyExit: vi.fn(() => Promise.resolve({})),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');

const OVPN = ['client', 'remote vpn.example.com 1194 udp', 'dev tun'].join('\n');

async function openNewProfileProxyForm(): Promise<void> {
  render(<ProfilesView onGoToSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Create your first profile' }));
  // Proxy tab → with no saved proxies the picker defaults to create-new, which
  // renders the canonical ProxyForm.
  fireEvent.click(await screen.findByRole('tab', { name: '🌍 Proxy' }));
  await screen.findByPlaceholderText('prod-eu-west');
}

describe('T-21 — VPN credentials reach the create from the New-Profile proxy form', () => {
  beforeEach(() => {
    addProxy.mockClear();
    addProxy.mockResolvedValue({ id: 'p_new' });
  });

  it('CRITICAL an OpenVPN proxy added here carries its auth username + password to the create', async () => {
    await openNewProfileProxyForm();

    fireEvent.change(screen.getByPlaceholderText('prod-eu-west'), { target: { value: 'ovpn-eu' } });
    // Switch the ProxyForm to OpenVPN (its scheme select is labelled "Type").
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'openvpn' } });
    // Paste the .ovpn — the endpoint auto-fills and the openvpn block is built.
    fireEvent.change(screen.getByRole('textbox', { name: /Paste your \.ovpn/i }), {
      target: { value: OVPN },
    });
    // The auth fields the old inline form OMITTED — the whole point of T-21.
    fireEvent.change(screen.getByLabelText(/Auth username \(optional\)/i), {
      target: { value: 'vpnuser' },
    });
    fireEvent.change(screen.getByLabelText(/Auth password \(optional\)/i), {
      target: { value: 'vpnpass' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add proxy' }));

    await waitFor(() => expect(addProxy).toHaveBeenCalledTimes(1));
    const draft = addProxy.mock.calls[0]![0] as {
      scheme?: string;
      openvpn?: { config_blob?: string; username?: string; password?: string };
    };
    expect(draft.scheme).toBe('openvpn');
    expect(draft.openvpn?.username, 'the OpenVPN auth username never reached the create').toBe(
      'vpnuser',
    );
    expect(draft.openvpn?.password, 'the OpenVPN auth password never reached the create').toBe(
      'vpnpass',
    );
  });

  it('VACUITY CONTROL — a SOCKS5 proxy added the same way creates with NO VPN credential block', async () => {
    await openNewProfileProxyForm();

    fireEvent.change(screen.getByPlaceholderText('prod-eu-west'), {
      target: { value: 'socks-eu' },
    });
    fireEvent.change(screen.getByPlaceholderText('proxy.example.com'), {
      target: { value: '1.2.3.4' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add proxy' }));

    await waitFor(() => expect(addProxy).toHaveBeenCalledTimes(1));
    const draft = addProxy.mock.calls[0]![0] as { scheme?: string; openvpn?: unknown };
    expect(draft.scheme).toBe('socks5');
    // The credential-passthrough the arm above protects is OpenVPN-specific; a
    // SOCKS5 proxy has no openvpn block, so the mutation that drops it leaves this
    // arm green — which is exactly what makes the OpenVPN arm non-vacuous.
    expect(draft.openvpn).toBeUndefined();
  });
});

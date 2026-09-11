// (n) N8 — the profile proxy picker named a VPN row by its raw enum.
//
// New Profile / Edit Profile listed a saved tunnel as
// `wg-london · wireguard · wg.example.com:51820` while the Proxies tab, the
// scheme <select> and every sentence in the GUI call the same row "WireGuard"
// (and "OpenVPN"). Both <option> sites now render the display name through one
// helper (`vpnSchemeDisplayName`); a SOCKS5 row shows no scheme there, as before.
//
// MUTATION: revert either <option> site to `${p.scheme} · …` → the option text
// carries `wireguard ·` / `openvpn ·` again → the matching arm reds. The SOCKS5
// control pins that the change did not start naming a scheme where none was.

import type * as ProxiesModule from '../../src/lib/proxies';
import type { ProxyConfig } from '../../src/lib/proxies';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

function profileFixture() {
  return {
    id: 'prof_1',
    name: 'Warm profile',
    archetype: 'iphone17_ios18_7_safari26_4',
    description: '',
    last_used_at: null,
    size_bytes: 3_145_728,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        list: () => Promise.resolve({ data: [profileFixture()] }),
        // eslint-disable-next-line @typescript-eslint/require-await
        iterate: async function* () {
          yield profileFixture();
        },
        create: vi.fn(() => Promise.resolve({ id: 'prof_new' })),
        update: vi.fn(() => Promise.resolve({})),
      },
      sessions: { list: () => Promise.resolve({ data: [] }) },
      agentSessions: { list: () => Promise.resolve({ data: [] }) },
    },
    settings: { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' },
    accountMe: {
      tier: 'solo_manual',
      concurrent_session_cap: 1,
      concurrent_session_active: 0,
      profile_cap: 10,
      profile_active: 1,
    },
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    update: vi.fn(() => Promise.resolve()),
  };
  return { useSettings: () => stable };
});

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
  saveEndpointResult: vi.fn(() => Promise.resolve({})),
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

const WG: ProxyConfig = {
  id: 'wg1',
  label: 'wg-london',
  host: 'wg.example.com',
  port: 51820,
  username: null,
  password: null,
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'wireguard',
  wireguard: {
    private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
    peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
    endpoint: 'wg.example.com:51820',
    allowed_ips: '0.0.0.0/0',
    address: '10.7.0.2/32',
  },
};
const OVPN: ProxyConfig = {
  id: 'ovpn1',
  label: 'ResVPN',
  host: 'vpn.example.com',
  port: 1194,
  username: null,
  password: null,
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'openvpn',
  openvpn: { config_blob: 'client\nremote vpn.example.com 1194\n' },
};
const SOCKS5: ProxyConfig = {
  id: 'socks1',
  label: 'eu-socks',
  host: 'proxy.example.com',
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'socks5',
};

// Partial mock — the pure predicates stay real; only the store reads are stubbed.
vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve([WG, OVPN, SOCKS5]),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  testProxy: vi.fn(() => Promise.reject(new Error('not under test'))),
  resolveEndpoint: vi.fn(() => Promise.resolve({ resolved: true, ip: '1.2.3.4', message: 'ok' })),
  probeProxyExit: vi.fn(() => Promise.resolve(null)),
  setProxyServerId: vi.fn(() => Promise.resolve()),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');

function optionTexts(select: HTMLElement): string[] {
  return Array.from(select.querySelectorAll('option')).map((o) => o.textContent ?? '');
}

describe('(n) N8 — the profile proxy picker names a tunnel scheme by its display name', () => {
  it('CRITICAL Edit Profile: a WireGuard row reads "WireGuard · host:port", never the raw enum', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Warm profile' }));
    const select = await screen.findByLabelText('Profile proxy');
    const texts = optionTexts(select);
    const wg = texts.find((t) => t.startsWith('wg-london'));
    expect(wg).toBe('wg-london · WireGuard · wg.example.com:51820');
    expect(wg).not.toMatch(/wireguard ·/);
    const ovpn = texts.find((t) => t.startsWith('ResVPN'));
    expect(ovpn).toBe('ResVPN · OpenVPN · vpn.example.com:1194');
    expect(ovpn).not.toMatch(/openvpn ·/);
    // No option anywhere in the picker carries a raw enum.
    expect(texts.join('\n')).not.toMatch(/\b(wireguard|openvpn) ·/);
  });

  it('CONTROL — a SOCKS5 row still shows no scheme in the picker (label · host:port only)', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Warm profile' }));
    const select = await screen.findByLabelText('Profile proxy');
    const socks = optionTexts(select).find((t) => t.startsWith('eu-socks'));
    expect(socks).toBe('eu-socks · proxy.example.com:1080');
  });

  it('CRITICAL New Profile: the same picker names WireGuard / OpenVPN by display name', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /New profile/ }));
    fireEvent.click(await screen.findByRole('tab', { name: '🌍 Proxy' }));
    // The New-Profile picker has no aria-label; it is the <select> holding the
    // "First available saved proxy" option.
    const first = await screen.findByRole('option', { name: 'First available saved proxy' });
    const select = first.closest('select');
    expect(select).not.toBeNull();
    const texts = optionTexts(select as HTMLElement);
    expect(texts).toContain('wg-london · WireGuard · wg.example.com:51820');
    expect(texts).toContain('ResVPN · OpenVPN · vpn.example.com:1194');
    expect(texts).toContain('eu-socks · proxy.example.com:1080');
    expect(texts.join('\n')).not.toMatch(/\b(wireguard|openvpn) ·/);
  });
});

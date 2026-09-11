// (n) N18 — the Profiles LIST view had no VPN check surface at all.
//
// MEASURED: ProfilesTable.tsx contained no occurrence of 'vpn'. The row object
// ProfilesView builds for the table carried no `vpn` / `vpnFailure` /
// `vpnNotice` / `checkedAtIso` key, while the grid CARD for the same profile has
// taken all four since (h). So one profile, bound to one WireGuard proxy, read:
//
//   list  → 'Test' (titled 'Test proxy — reachability, latency, exit IP'),
//           'no exit IP', '–' under UDP, and NOTHING for a tunnel the fleet
//           could not bring up — indistinguishable from an untested row.
//   card  → 'Check VPN', 'no exit measured yet — run Check VPN', 'UDP via
//           tunnel', and the red 'VPN tunnel down' banner with the reason.
//
// The click itself was always routed correctly (ProfilesView onTest → resolve +
// fleet test), so only the rendering diverged — which is the worst shape of this
// bug: the surface works and lies about what it did.
//
// MUTATION: drop the `vpn:` key from the list-row builder in ProfilesView (or
// revert either ProfilesTable branch to its unconditional form) → the WireGuard
// row is back to 'Test' / 'no exit IP' / '–' with no failure line → the CRITICAL
// arm reds. The SOCKS5 control is what pins that the fix did not simply rewrite
// the cell for every row.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type * as ProxiesModule from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import { CHECK_VPN_ACTION, CHECK_VPN_TITLE, VPN_NO_EXIT_YET } from '../../src/lib/proxy-check-copy';

const stores = new Map<string, Map<string, unknown>>();
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private file: string;
    constructor(file: string) {
      this.file = file;
      if (!stores.has(file)) stores.set(file, new Map());
    }
    private map(): Map<string, unknown> {
      let m = stores.get(this.file);
      if (!m) {
        m = new Map();
        stores.set(this.file, m);
      }
      return m;
    }
    get(key: string): Promise<unknown> {
      return Promise.resolve(this.map().get(key));
    }
    set(key: string, value: unknown): Promise<void> {
      this.map().set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const FLEET_DOWN = 'The Mac that runs your profiles could not bring this tunnel up.';
const FAILED_AT = Date.UTC(2026, 8, 11, 11, 0, 0);

function profiles() {
  return [
    {
      id: 'prof_wg',
      name: 'London tunnel',
      archetype: 'iphone17_ios18_7_safari26_4',
      description: null,
      last_used_at: null,
      size_bytes: 1024,
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
    },
    {
      id: 'prof_socks',
      name: 'Amsterdam shopper',
      archetype: 'iphone17_ios18_7_safari26_4',
      description: null,
      last_used_at: null,
      size_bytes: 1024,
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
    },
  ];
}

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        list: () => Promise.resolve({ data: profiles() }),
        // eslint-disable-next-line @typescript-eslint/require-await
        iterate: async function* () {
          for (const p of profiles()) yield p;
        },
      },
      sessions: { list: () => Promise.resolve({ data: [] }) },
      agentSessions: { list: () => Promise.resolve({ data: [] }) },
    },
    settings: { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' },
    accountMe: {
      tier: 'solo_manual',
      concurrent_session_cap: 2,
      concurrent_session_active: 0,
      profile_cap: 10,
      profile_active: 2,
    },
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    update: vi.fn(() => Promise.resolve()),
    activeWorkspace: null,
    setActiveWorkspace: vi.fn(),
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
vi.mock('../../src/lib/agent-session-control', () => ({
  mintGuiControlKey: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () =>
    Promise.resolve([
      {
        profileId: 'prof_wg',
        defaultProxyId: 'wg1',
        currentSessionId: null,
        lastLaunchedAt: null,
      },
      {
        profileId: 'prof_socks',
        defaultProxyId: 'socks1',
        currentSessionId: null,
        lastLaunchedAt: null,
      },
    ]),
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
  serverId: 'aprx_wg',
  wireguard: {
    private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
    peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
    endpoint: 'wg.example.com:51820',
    allowed_ips: '0.0.0.0/0',
    address: '10.7.0.2/32',
  },
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
  serverId: 'aprx_socks',
};

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve([WG, SOCKS5]),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  testProxy: vi.fn(() => Promise.reject(new Error('not under test'))),
  resolveEndpoint: vi.fn(() =>
    Promise.resolve({ resolved: true, ip: '203.0.113.9', message: 'ok' }),
  ),
  probeProxyExit: vi.fn(() => Promise.resolve(null)),
  setProxyServerId: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  testAccountProxy: vi.fn(() => Promise.reject(new Error('not under test'))),
  updateProxy: vi.fn(() => Promise.resolve({})),
  createProxy: vi.fn(() => Promise.resolve({ id: 'aprx_new' })),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');

/** A VPN row's capability slot is a fail-closed placeholder — the endpoint
 *  verdict is what the row is made of, never a SOCKS5 handshake. */
const ENDPOINT_PLACEHOLDER: ProxyTestResult = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'Resolved',
};
const SOCKS5_HEALTHY: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'Working — CONNECT succeeded.',
};

function seedCache(): void {
  stores.set(
    'proxy-probe-cache.json',
    new Map<string, unknown>([
      [
        'probes',
        {
          // A WireGuard row the fleet could not bring up: the pre-flight
          // resolved, the tunnel did not come up, the exit was superseded.
          wg1: {
            result: ENDPOINT_PLACEHOLDER,
            at: FAILED_AT - 5,
            endpoint: { resolved: true, ip: '203.0.113.9', message: 'Resolved' },
            serverProbeAt: FAILED_AT,
            exitSupersededAt: FAILED_AT,
            fleetFailureReason: FLEET_DOWN,
          },
          // The control: a healthy SOCKS5 row that has simply never had its exit
          // measured.
          socks1: { result: SOCKS5_HEALTHY, at: FAILED_AT },
        },
      ],
    ]),
  );
}

async function renderList(): Promise<void> {
  seedCache();
  render(<ProfilesView onGoToSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '☰ List' }));
  await screen.findByRole('table');
}

function rowFor(name: string): HTMLElement {
  const cell = screen.getByText(name);
  const tr = cell.closest('tr');
  if (tr === null) throw new Error(`no row for ${name}`);
  return tr;
}

describe('(n) N18 — the Profiles LIST view carries the VPN check, verdict and UDP truth', () => {
  it('CRITICAL a WireGuard-bound row names the VPN check, says why there is no exit, shows the tunnel-down reason, and says UDP rides the tunnel', async () => {
    await renderList();
    const row = rowFor('London tunnel');
    const q = within(row);

    // The action is the tunnel's check, by its ONE name, with its own title —
    // not the SOCKS5 reachability probe's.
    const button = q.getByRole('button', { name: CHECK_VPN_ACTION });
    expect(button.getAttribute('title')).toBe(CHECK_VPN_TITLE);
    expect(row.textContent).not.toContain('Test proxy — reachability');

    // The empty exit cell names the next step instead of dead-ending.
    expect(q.getByText(VPN_NO_EXIT_YET)).toBeTruthy();
    expect(row.textContent).not.toContain('no exit IP');

    // The fleet's verdict is ON the row, not only on the card.
    const failure = row.querySelector('[data-component="profile-row-vpn-failure"]');
    expect(failure).not.toBeNull();
    expect(failure?.textContent).toContain('VPN tunnel down');
    expect(failure?.textContent).toContain(FLEET_DOWN);

    // …dated by the FLEET's own stamp, never the DNS pre-flight before it.
    expect(
      row
        .querySelector('[data-component="profile-row-checked-at"]')
        ?.getAttribute('data-checked-at'),
    ).toBe(new Date(FAILED_AT).toISOString());

    // UDP is not measurable on a tunnel; the dash read as "not measured".
    expect(q.getByText('UDP via tunnel')).toBeTruthy();
    expect(row.querySelector('[data-udp="tunnel"]')).not.toBeNull();
    expect(q.queryByText('–')).toBeNull();
  });

  it('CONTROL — the SOCKS5-bound row in the SAME table keeps "Test" and "no exit IP" (the cells were scoped, not rewritten)', async () => {
    await renderList();
    const row = rowFor('Amsterdam shopper');
    const q = within(row);
    const button = q.getByRole('button', { name: 'Test' });
    expect(button.getAttribute('title')).toBe('Test proxy — reachability, latency, exit IP');
    expect(q.getByText('no exit IP')).toBeTruthy();
    expect(q.queryByText(VPN_NO_EXIT_YET)).toBeNull();
    expect(row.querySelector('[data-component="profile-row-vpn-failure"]')).toBeNull();
    expect(row.querySelector('[data-udp="tunnel"]')).toBeNull();
    expect(row.textContent).not.toContain('UDP via tunnel');
  });
});

// (q) Items 2 / 13(a) — a STORED refusable OpenVPN blob is normalised at the
// launch/sync chokepoint, not only on the edit form's mount.
//
// MEASURED (re-verification against b65ddc209): the three sync paths —
// ProfilesView.ensureServerProxy, AgentChatView.ensureServerProxyId and
// ProxiesView.pushLocalMaterialToAccount — each built the wire body by hand and
// forwarded `p.openvpn` VERBATIM. A row pasted on a build that predates the
// paste/upload strip (the owner's `…_resvpn.ovpn` with `script-security 2` on
// line 46) therefore 400'd on EVERY launch from the grid and from the chat
// (`Line 46: "script-security 2" — Driftstack does not run scripts from VPN
// configs…`) until the owner opened it in Edit AND re-saved; the mount heal
// rewrote only the draft, and Cancel left the raw blob. The Check path PUT the
// same raw blob and, being best-effort, swallowed the 400.
//
// The body is now built ONCE (`accountProxyInputFor`) with the same strip the
// paste path applies, and `ensureAccountProxyRow` is the one sync step all
// three surfaces call. These arms pin the lib; the view arms live in
// a-legacy-ovpn-row-launches-without-a-resave.test.tsx.
//
// ⛔ PRODUCTION LINE WHOSE REVERSION REDS ARMS 1, 5, 8, 10: in
//    `accountProxyInputFor`, `openvpnAutoStrip(p.scheme, p.openvpn.config_blob)`
//    deciding the `openvpn` block of the body. Put `p.openvpn` back verbatim and
//    the PUT/POST body carries `script-security 2` again — the exact 400.
// ⛔ Widen it — strip/persist unconditionally, or report `healedOpenvpn` for a
//    clean blob — and the VACUITY arms (2, 6) red: a clean stored row would be
//    rewritten locally and its body would no longer be the bytes the customer
//    stored. That is the direction the real failure goes for a self-heal.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type * as ProxiesModule from '../../src/lib/proxies';
import type { ProxyConfig, ProxyDraft } from '../../src/lib/proxies';

const h = vi.hoisted(() => ({
  createProxy: vi.fn<(...a: unknown[]) => Promise<{ id: string }>>(),
  updateProxy: vi.fn<(...a: unknown[]) => Promise<{ id: string }>>(),
  // See the note above the mock factory below.
  setProxyServerId: vi.fn<(id: string, serverId: string) => Promise<ProxyConfig | null>>(() =>
    Promise.resolve({ id: 'p1', serverId: 'aprx_new' } as unknown as ProxyConfig),
  ),
  updateLocalProxy: vi.fn<(id: string, patch: ProxyDraft) => Promise<null>>(() =>
    Promise.resolve(null),
  ),
}));

vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  createProxy: (...a: unknown[]) => h.createProxy(...a),
  updateProxy: (...a: unknown[]) => h.updateProxy(...a),
}));
/** ⛔ (V4 follow-up 2026-09-12) — `setProxyServerId` MUST NOT BE STUBBED AS
 *  `Promise.resolve(null)`. Its contract (lib/proxies) is "No-op if the local
 *  proxy is gone. Returns the updated row" — so `null` MEANS "there is no such
 *  local row any more", and `ensureAccountProxyRow` now acts on it: it deletes
 *  the account row it just created rather than orphaning the customer's VPN
 *  secret on the control plane after a delete that raced the check. A `null`
 *  here therefore no longer stands in for "void"; it asserts a deleted row.
 *  Return the updated row (or `undefined`, which is what the 22 other suites'
 *  `Promise.resolve()` stubs yield and which is read as success). */
vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  setProxyServerId: (id: string, serverId: string) => h.setProxyServerId(id, serverId),
  updateProxy: (id: string, patch: ProxyDraft) => h.updateLocalProxy(id, patch),
}));

const { accountProxyInputFor, ensureAccountProxyRow } =
  await import('../../src/lib/proxy-server-test');

/** A config a build predating the client-side strip happily stored — the owner's
 *  shape: a bare `script-security 2` with no script directive. */
const LEGACY_BLOB = [
  'client',
  'dev tun',
  'remote 72.65.206.209 1194 udp',
  'script-security 2',
  '<ca>',
  'MIIB',
  '</ca>',
]
  .join('\n')
  .concat('\n');
const CLEAN_BLOB = ['client', 'dev tun', 'remote 72.65.206.209 1194 udp', '<ca>', 'MIIB', '</ca>']
  .join('\n')
  .concat('\n');

function ovpnRow(blob: string, over: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    id: 'p1',
    label: 'resvpn',
    host: '72.65.206.209',
    port: 1194,
    username: null,
    password: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    scheme: 'openvpn',
    openvpn: { config_blob: blob, username: 'vpnuser', password: 'vpnpass' },
    ...over,
  };
}

type Body = { openvpn?: { config_blob: string; username?: string }; scheme?: string };

beforeEach(() => {
  h.createProxy.mockReset();
  h.updateProxy.mockReset();
  h.setProxyServerId.mockClear();
  h.updateLocalProxy.mockClear();
  h.updateProxy.mockResolvedValue({ id: 'aprx_1' });
  h.createProxy.mockResolvedValue({ id: 'aprx_new' });
});

describe('accountProxyInputFor — the ONE wire body, with the stored blob normalised', () => {
  it('ARM 1 — CRITICAL: a stored `script-security 2` reaches the wire as `script-security 1`, everything else intact', () => {
    const { input, healedOpenvpn } = accountProxyInputFor(ovpnRow(LEGACY_BLOB));
    expect(input.openvpn?.config_blob).toMatch(/^script-security 1$/m);
    expect(input.openvpn?.config_blob).not.toMatch(/script-security\s+2/);
    // Nothing else moves: the remote line, the inline CA and the VPN credentials.
    expect(input.openvpn?.config_blob).toMatch(/^remote 72\.65\.206\.209 1194 udp$/m);
    expect(input.openvpn?.config_blob).toContain('<ca>\nMIIB\n</ca>');
    expect(input.openvpn).toMatchObject({ username: 'vpnuser', password: 'vpnpass' });
    expect(input).toMatchObject({ scheme: 'openvpn', host: '72.65.206.209', port: 1194 });
    // The caller persists exactly what went on the wire.
    expect(healedOpenvpn).toBe(input.openvpn?.config_blob);
  });

  it('ARM 2 — CRITICAL VACUITY CONTROL: a clean stored blob is forwarded byte for byte, and reports no heal', () => {
    const row = ovpnRow(CLEAN_BLOB);
    const { input, healedOpenvpn } = accountProxyInputFor(row);
    expect(input.openvpn).toBe(row.openvpn); // the very object — not a rewrite that happens to match
    expect(input.openvpn?.config_blob).toBe(CLEAN_BLOB);
    expect(healedOpenvpn).toBeNull();
  });

  it('ARM 3 — CONTROL: the strip never invents missing material — an external cert reference is untouched', () => {
    const withFile = CLEAN_BLOB.concat('cert /etc/openvpn/client.crt\n');
    const { input, healedOpenvpn } = accountProxyInputFor(ovpnRow(withFile));
    expect(input.openvpn?.config_blob).toBe(withFile);
    expect(healedOpenvpn).toBeNull();
  });

  it('ARM 4 — a SOCKS5 row carries no openvpn block; a WireGuard row forwards its block unchanged', () => {
    const socks = accountProxyInputFor({
      id: 's1',
      label: 'socks',
      host: '1.2.3.4',
      port: 1080,
      username: 'u',
      password: 'p',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    expect(socks.input).toEqual({
      label: 'socks',
      scheme: 'socks5',
      host: '1.2.3.4',
      port: 1080,
      username: 'u',
      password: 'p',
    });
    expect(socks.healedOpenvpn).toBeNull();
    const wg = {
      private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
      peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
      endpoint: 'wg.example.com:51820',
      allowed_ips: '0.0.0.0/0',
      address: '10.7.0.2/32',
    };
    const wgRow = accountProxyInputFor({
      id: 'w1',
      label: 'wg',
      host: 'wg.example.com',
      port: 51820,
      username: null,
      password: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      scheme: 'wireguard',
      wireguard: wg,
    });
    expect(wgRow.input.wireguard).toBe(wg);
    expect(wgRow.input).not.toHaveProperty('openvpn');
  });
});

describe('ensureAccountProxyRow — the one sync step launch, chat and Test share', () => {
  it('ARM 5 — CRITICAL: a stored legacy row PUTs the normalised blob and persists it locally ONCE', async () => {
    const r = await ensureAccountProxyRow(
      ovpnRow(LEGACY_BLOB, { serverId: 'aprx_1' }),
      'http://x',
      'ds_key',
    );
    expect(r).toEqual({ id: 'aprx_1', created: false, healed: true });
    expect(h.updateProxy).toHaveBeenCalledTimes(1);
    const [baseUrl, key, id, body] = h.updateProxy.mock.calls[0] as [string, string, string, Body];
    expect([baseUrl, key, id]).toEqual(['http://x', 'ds_key', 'aprx_1']);
    expect(body.openvpn?.config_blob).toMatch(/^script-security 1$/m);
    expect(body.openvpn?.config_blob).not.toMatch(/script-security\s+2/);
    // The heal lands on the LOCAL row too, so the next launch sends the same bytes
    // without healing again — same label/endpoint/scheme, only the blob changes.
    expect(h.updateLocalProxy).toHaveBeenCalledTimes(1);
    const [localId, patch] = h.updateLocalProxy.mock.calls[0] as [string, ProxyDraft];
    expect(localId).toBe('p1');
    expect(patch.openvpn?.config_blob).toBe(body.openvpn?.config_blob);
    expect(patch).toMatchObject({
      label: 'resvpn',
      scheme: 'openvpn',
      host: '72.65.206.209',
      port: 1194,
    });
    expect(patch.openvpn).toMatchObject({ username: 'vpnuser', password: 'vpnpass' });
    expect(h.createProxy).not.toHaveBeenCalled();
  });

  it('ARM 6 — CRITICAL VACUITY CONTROL: a clean stored row is NOT rewritten locally and its body is its own bytes', async () => {
    const r = await ensureAccountProxyRow(
      ovpnRow(CLEAN_BLOB, { serverId: 'aprx_1' }),
      'http://x',
      'ds_key',
    );
    expect(r).toEqual({ id: 'aprx_1', created: false, healed: false });
    expect(h.updateLocalProxy).not.toHaveBeenCalled();
    const body = h.updateProxy.mock.calls[0]?.[3] as Body;
    expect(body.openvpn?.config_blob).toBe(CLEAN_BLOB);
  });

  it('ARM 7 — no API key: nothing is stored, nothing is healed, undefined is returned', async () => {
    await expect(ensureAccountProxyRow(ovpnRow(LEGACY_BLOB), 'http://x', null)).resolves.toBe(
      undefined,
    );
    await expect(ensureAccountProxyRow(ovpnRow(LEGACY_BLOB), 'http://x', '')).resolves.toBe(
      undefined,
    );
    expect(h.updateProxy).not.toHaveBeenCalled();
    expect(h.createProxy).not.toHaveBeenCalled();
    expect(h.updateLocalProxy).not.toHaveBeenCalled();
  });

  it('ARM 8 — a never-stored row is CREATED with the normalised blob and the id is cached on the local row', async () => {
    const r = await ensureAccountProxyRow(ovpnRow(LEGACY_BLOB), 'http://x', 'ds_key');
    expect(r).toEqual({ id: 'aprx_new', created: true, healed: true });
    expect(h.updateProxy).not.toHaveBeenCalled();
    const body = h.createProxy.mock.calls[0]?.[2] as Body;
    expect(body.openvpn?.config_blob).toMatch(/^script-security 1$/m);
    expect(body.openvpn?.config_blob).not.toMatch(/script-security\s+2/);
    expect(h.setProxyServerId).toHaveBeenCalledWith('p1', 'aprx_new');
  });

  it('ARM 9 — a stale cached id (PUT 404) self-heals by re-creating; any other failure is thrown, not swallowed', async () => {
    h.updateProxy.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    const r = await ensureAccountProxyRow(
      ovpnRow(CLEAN_BLOB, { serverId: 'aprx_stale' }),
      'http://x',
      'ds_key',
    );
    expect(r).toEqual({ id: 'aprx_new', created: true, healed: false });
    expect(h.setProxyServerId).toHaveBeenCalledWith('p1', 'aprx_new');

    h.createProxy.mockClear();
    h.updateProxy.mockRejectedValueOnce(
      Object.assign(new Error('refused'), { status: 400, detail: 'Line 3: nope' }),
    );
    await expect(
      ensureAccountProxyRow(ovpnRow(CLEAN_BLOB, { serverId: 'aprx_1' }), 'http://x', 'ds_key'),
    ).rejects.toMatchObject({ status: 400, detail: 'Line 3: nope' });
    expect(h.createProxy).not.toHaveBeenCalled();
  });

  it('ARM 10 — the local heal is best-effort: when the local write fails, the wire STILL carries the normalised blob', async () => {
    h.updateLocalProxy.mockRejectedValueOnce(new Error('keychain locked'));
    const r = await ensureAccountProxyRow(
      ovpnRow(LEGACY_BLOB, { serverId: 'aprx_1' }),
      'http://x',
      'ds_key',
    );
    expect(r).toEqual({ id: 'aprx_1', created: false, healed: true });
    const body = h.updateProxy.mock.calls[0]?.[3] as Body;
    expect(body.openvpn?.config_blob).not.toMatch(/script-security\s+2/);
  });
});

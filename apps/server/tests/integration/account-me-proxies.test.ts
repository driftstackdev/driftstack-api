// ARC A slice 2 — integration tests for the /v1/account/me/proxies CRUD surface.
//
// Verifies the customer-facing contract + the security invariants that matter at
// the API edge: the password is WRITE-ONLY (never echoed — responses carry
// has_password), the routes are account_owner-scoped (403 otherwise), and a
// proxy is addressable only within its own account (404 on unknown id; the
// repo-level cross-account isolation is unit-tested separately).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { InMemoryAccountProxiesRepo } from '../../src/db/account-proxies-repo.js';

let fx: TestAppFixture;

afterEach(async () => {
  vi.restoreAllMocks();
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

interface ProxyMeta {
  id: string;
  label: string;
  scheme: string;
  host: string;
  port: number;
  username: string | null;
  has_password: boolean;
  has_secret?: boolean;
  created_at: string;
  updated_at: string;
}

describe('POST/GET /v1/account/me/proxies', () => {
  it('creates a proxy and lists it — password is NEVER echoed (has_password instead)', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'home', host: '1.2.3.4', port: 1080, username: 'u', password: 'hunter2' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<ProxyMeta>();
    expect(created.id).toBeTruthy();
    expect(created.scheme).toBe('socks5'); // default
    expect(created.has_password).toBe(true);
    // The plaintext password must not appear anywhere in the response.
    expect(create.body).not.toContain('hunter2');
    expect(created).not.toHaveProperty('password');
    expect(created).not.toHaveProperty('wrapped_password');

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ data: ProxyMeta[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.host).toBe('1.2.3.4');
    expect(list.body).not.toContain('hunter2');
  });

  it('a proxy with no password has has_password=false', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'open', host: 'p.example', port: 8080, scheme: 'http' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json<ProxyMeta>().has_password).toBe(false);
    expect(create.json<ProxyMeta>().scheme).toBe('http');
  });

  it('enforces the calling account tier cap atomically', async () => {
    const cappedCreate = vi.spyOn(InMemoryAccountProxiesRepo.prototype, 'createIfUnderLimit');
    fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device' });

    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'only', host: 'one.proxy.example', port: 1080 },
    });
    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'blocked', host: 'two.proxy.example', port: 1080 },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(400);
    expect(second.body).toContain('Proxy limit reached (1).');
    expect(cappedCreate).toHaveBeenCalledTimes(2);
    expect(cappedCreate.mock.calls.every((call) => call[2] === 1)).toBe(true);
  });

  it('does not invent a numeric cap for an Enterprise custom contract', async () => {
    const create = vi.spyOn(InMemoryAccountProxiesRepo.prototype, 'create');
    const cappedCreate = vi.spyOn(InMemoryAccountProxiesRepo.prototype, 'createIfUnderLimit');
    fx = await buildTestApp({ tier: 'enterprise' });

    const response = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'contract', host: 'enterprise.proxy.example', port: 1080 },
    });

    expect(response.statusCode).toBe(201);
    expect(create).toHaveBeenCalledOnce();
    expect(cappedCreate).not.toHaveBeenCalled();
  });
});

describe('PUT /v1/account/me/proxies/:id', () => {
  it('updates fields; omitting password keeps it, null clears it', async () => {
    fx = await buildTestApp();
    const created = (
      await fx.app.inject({
        method: 'POST',
        url: '/v1/account/me/proxies',
        headers: { ...auth(fx), 'content-type': 'application/json' },
        payload: { label: 'a', host: 'h', port: 1080, password: 'secret' },
      })
    ).json<ProxyMeta>();

    // Omit password → kept (still has_password).
    const renamed = await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${created.id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<ProxyMeta>().label).toBe('renamed');
    expect(renamed.json<ProxyMeta>().has_password).toBe(true);

    // Explicit null → cleared.
    const cleared = await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${created.id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { password: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<ProxyMeta>().has_password).toBe(false);
  });

  it('404 on unknown id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/proxies/00000000-0000-0000-0000-000000000000',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /v1/account/me/proxies/:id', () => {
  it('deletes an owned proxy (204) then 404 on re-delete', async () => {
    fx = await buildTestApp();
    const created = (
      await fx.app.inject({
        method: 'POST',
        url: '/v1/account/me/proxies',
        headers: { ...auth(fx), 'content-type': 'application/json' },
        payload: { label: 'a', host: 'h', port: 1080 },
      })
    ).json<ProxyMeta>();
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/account/me/proxies/${created.id}`,
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);
    const again = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/account/me/proxies/${created.id}`,
      headers: auth(fx),
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('proxy path-id validation', () => {
  it('returns a stable 400 before any repository call on PUT, DELETE and test', async () => {
    const find = vi.spyOn(InMemoryAccountProxiesRepo.prototype, 'findById');
    const remove = vi.spyOn(InMemoryAccountProxiesRepo.prototype, 'delete');
    fx = await buildTestApp();
    find.mockClear();
    remove.mockClear();

    const requests = [
      fx.app.inject({
        method: 'PUT',
        url: '/v1/account/me/proxies/not-a-uuid',
        headers: { ...auth(fx), 'content-type': 'application/json' },
        payload: { label: 'x' },
      }),
      fx.app.inject({
        method: 'DELETE',
        url: '/v1/account/me/proxies/not-a-uuid',
        headers: auth(fx),
      }),
      fx.app.inject({
        method: 'POST',
        url: '/v1/account/me/proxies/not-a-uuid/test',
        headers: auth(fx),
      }),
    ];
    const responses = await Promise.all(requests);
    for (const response of responses) {
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('Proxy id must be a valid UUID.');
      expect(response.body).not.toContain('22P02');
    }
    expect(find).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    find.mockRestore();
    remove.mockRestore();
  });
});

describe('SSRF host guard', () => {
  it('rejects a private/loopback/metadata host on create (400)', async () => {
    fx = await buildTestApp();
    for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.5', 'localhost']) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/account/me/proxies',
        headers: { ...auth(fx), 'content-type': 'application/json' },
        payload: { label: 'bad', host, port: 1080 },
      });
      expect(res.statusCode, host).toBe(400);
    }
  });

  it('rejects an unsafe host on update (400)', async () => {
    fx = await buildTestApp();
    const created = (
      await fx.app.inject({
        method: 'POST',
        url: '/v1/account/me/proxies',
        headers: { ...auth(fx), 'content-type': 'application/json' },
        payload: { label: 'ok', host: 'proxy.customer.example', port: 1080 },
      })
    ).json<ProxyMeta>();
    const res = await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${created.id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { host: '192.168.1.1' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/account/me/proxies/:id/test', () => {
  async function makeProxy(host: string): Promise<string> {
    return (
      await fx.app.inject({
        method: 'POST',
        url: '/v1/account/me/proxies',
        headers: { ...auth(fx), 'content-type': 'application/json' },
        payload: { label: 't', host, port: 1080 },
      })
    ).json<ProxyMeta>().id;
  }

  it('ok:true + latency_ms for a reachable proxy', async () => {
    fx = await buildTestApp();
    const id = await makeProxy('reachable-proxy.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; latency_ms?: number }>();
    expect(body.ok).toBe(true);
    expect(typeof body.latency_ms).toBe('number');
  });

  it('ok:false + reason for an unreachable proxy (200, not an error)', async () => {
    fx = await buildTestApp();
    const id = await makeProxy('unreachable-proxy.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: false,
      reason: 'Proxy unreachable. Check the host, port, and firewall.',
    });
  });

  it('does not reflect raw socket diagnostics in the unreachable result', async () => {
    const hostile = 'connect ECONNREFUSED 10.0.0.7:5432 password=do-not-reflect';
    fx = await buildTestApp({
      proxyTcpProbe: () => Promise.reject(new Error(hostile)),
    });
    const id = await makeProxy('unreachable-proxy.example.com');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: false,
      reason: 'Proxy unreachable. Check the host, port, and firewall.',
    });
    expect(res.body).not.toContain(hostile);
  });

  it('404 testing an unknown id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies/00000000-0000-0000-0000-000000000000/test',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('account_owner scope', () => {
  it('403 when the key lacks account_owner scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });
});

// OVPN/WG arc slice 2 — VPN proxy create. The SECRET (config_blob / private_key)
// is write-only: wrapped under the account TMK, NEVER echoed (has_secret instead).
describe('VPN proxies — /v1/account/me/proxies (openvpn / wireguard)', () => {
  const WG_PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
  const WG_PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';
  const OVPN_BLOB = 'client\nremote vpn.example.com 1194 udp\ndev tun\n';

  // V-763 — `TIER_FEATURES.vpnEgress` is false only on free, and its doc has always read
  // "OpenVPN / WireGuard egress profiles allowed on this tier. `false` on free (SOCKS5 proxy
  // only)". Nothing enforced it: a free account could register a VPN profile and egress through
  // it end to end, so the paid tiers' differentiator was not real. The published pricing table
  // reads that flag directly, which is what made it a customer-facing claim rather than an
  // internal note.
  it('CRITICAL free tier CANNOT register a VPN proxy — the flag every pricing surface renders is now enforced', async () => {
    fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device' });
    for (const payload of [
      {
        label: 'wg-free',
        scheme: 'wireguard',
        host: 'vpn.example.com',
        port: 51820,
        wireguard: {
          private_key: WG_PRIV,
          peer_public_key: WG_PUB,
          endpoint: 'vpn.example.com:51820',
          allowed_ips: '0.0.0.0/0',
        },
      },
      {
        label: 'ovpn-free',
        scheme: 'openvpn',
        host: 'vpn.example.com',
        port: 1194,
        openvpn: { config_blob: OVPN_BLOB },
      },
    ]) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/account/me/proxies',
        headers: auth(fx),
        payload,
      });
      expect(res.statusCode, `${String(payload.scheme)} must be refused on free`).toBe(403);
      expect(res.body).toContain('vpnEgress');
    }
  });

  it('free tier keeps its one SOCKS5 proxy — the gate is scheme-specific, not a proxy ban', async () => {
    // PROXIES_PER_TIER.free === 1 and the free-desktop route policy allowlists proxy writes on
    // purpose. Refusing socks5 here would break a documented free-tier capability, so this is
    // the other half of the guard: it pins that the gate narrowed nothing else.
    fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: { label: 'socks-free', host: 'one.proxy.example', port: 1080 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<ProxyMeta>().scheme).toBe('socks5');
  });

  it('CRITICAL free tier cannot PUT a socks5 proxy UP to a VPN scheme — gating create alone would leave the restriction trivially bypassable', async () => {
    fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device' });
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: { label: 'starts-socks', host: 'one.proxy.example', port: 1080 },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<ProxyMeta>().id;

    const upgraded = await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${id}`,
      headers: auth(fx),
      payload: {
        scheme: 'wireguard',
        host: 'vpn.example.com',
        port: 51820,
        wireguard: {
          private_key: WG_PRIV,
          peer_public_key: WG_PUB,
          endpoint: 'vpn.example.com:51820',
          allowed_ips: '0.0.0.0/0',
        },
      },
    });
    expect(upgraded.statusCode).toBe(403);
    expect(upgraded.body).toContain('vpnEgress');

    // Not re-read through GET to confirm the row is untouched: the free-desktop route policy
    // deliberately allowlists only POST/PUT/DELETE on proxies, not GET, so a free cli_device
    // key cannot list them. Non-mutation is structural instead — the gate sits above
    // `const updates`, so the refusal happens before any field is staged.
  });

  // ─── the guard on the REAL egress ────────────────────────────────────
  //
  // Added 2026-08-15. The "SSRF host guard" describe above posts
  // `{ label, host, port }` — the socks5/http DISPLAY host. For a VPN profile
  // that host is decorative: the connection is made to the embedded `remote` /
  // `endpoint`, which is why the route says so in its own comment —
  //
  //     SSRF: the real egress is the embedded `remote <host>`, NOT the display
  //     host — guard it.
  //
  // `classifyUnsafeVpnTargets` is thoroughly unit-tested and the registration
  // arms above post SAFE configs, so both halves looked covered while **no test
  // ever posted an unsafe VPN config**. All five refusals in
  // `routes/account-me.ts` were unexecuted (assessment item 5i). Removing the
  // `classifyUnsafeVpnTargets(...)` call from the route left the entire suite
  // green — the classifier's own tests still passed, and these registration arms
  // still passed because their configs are safe.
  //
  // ⭐ EVERY payload below keeps `host: 'vpn.example.com'` — a SAFE display host.
  // That is the whole point: a refusal here cannot be the display-host guard
  // doing the work, because that guard has nothing to complain about. Only the
  // embedded target is unsafe.
  //
  // MUTATION-PROVED against routes/account-me.ts and lib/webhook-target-guard.ts
  // — controls 35/35 here, 32/32 on the classifier's own unit test:
  //
  //                                                    here    guard-lib pin
  //   the route stops calling the guard for OpenVPN    3 red       GREEN
  //   the route stops calling the guard for WireGuard  2 red       GREEN
  //   WireGuard checks endpoint but not DNS            1 red       GREEN
  //   script-security threshold slips >=2 to >=3       1 red       1 red
  //
  // The first three are the point of this block. The classifier is untouched and
  // its own tests all still pass; what broke is that the ROUTE no longer asks it.
  // Before these arms existed, that mutation left the entire suite green.
  //
  // The fourth is the opposite case and shows the division of labour is right: a
  // change to the CLASSIFICATION logic is caught by the classifier's unit test,
  // as it should be, and now here as well. It took a second attempt to get there
  // — the RCE arm below trips both halves of the guard at once (a dangerous
  // directive AND the level), so it could not tell a slipped threshold from a
  // working one. The level-only arm was added to separate them.

  const SAFE_DISPLAY = { host: 'vpn.example.com', port: 1194 };

  it('CRITICAL an OpenVPN config whose embedded `remote` is the cloud metadata address is refused, even though the display host is fine. 169.254.169.254 is the instance-credentials endpoint on every major cloud; a VPN profile that egresses there turns a customer-supplied config into a read of the fleet host’s own IAM credentials. The display host guard cannot see this — it is looking at a different field.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: {
        label: 'ovpn-metadata',
        scheme: 'openvpn',
        ...SAFE_DISPLAY,
        openvpn: { config_blob: 'client\nremote 169.254.169.254 1194 udp\ndev tun\n' },
      },
    });
    expect(res.statusCode, 'refused').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/metadata|private|loopback/i);
  });

  it('CRITICAL an OpenVPN config carrying a script-executing directive is refused. This one is not SSRF: `up /bin/sh` runs a program on the egress host when the tunnel comes up, so accepting the config is accepting remote code execution from customer input. It is refused before the target hosts are even resolved.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: {
        label: 'ovpn-rce',
        scheme: 'openvpn',
        ...SAFE_DISPLAY,
        // Safe remote, safe display host — the ONLY unsafe thing is the directive.
        openvpn: {
          config_blob: 'client\nremote vpn.example.com 1194 udp\nscript-security 2\nup /bin/sh\n',
        },
      },
    });
    expect(res.statusCode, 'refused').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/script/i);
  });

  it('CRITICAL `script-security 2` alone is refused, with no dangerous directive present. The guard has two independent halves — a keyword list and a level threshold — and the arm above trips BOTH at once, so it cannot tell them apart. Measured: raising the threshold from >=2 to >=3 left that arm green while the classifier’s own unit test caught it. This arm isolates the level, so a slipped threshold reds the ROUTE too.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: {
        label: 'ovpn-level-only',
        scheme: 'openvpn',
        ...SAFE_DISPLAY,
        // No up/down/route-up/tls-verify — the level is the only problem.
        openvpn: { config_blob: 'client\nremote vpn.example.com 1194 udp\nscript-security 2\n' },
      },
    });
    expect(res.statusCode, 'level 2 is refused on its own').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/script/i);
  });

  it('CRITICAL `script-security 1` is NOT refused — the guard bounds the dangerous level rather than banning the keyword. Level 1 permits only built-ins and the box floors there anyway; refusing it would reject working configurations and teach customers the validator is arbitrary.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: {
        label: 'ovpn-safe-level',
        scheme: 'openvpn',
        ...SAFE_DISPLAY,
        openvpn: { config_blob: 'client\nremote vpn.example.com 1194 udp\nscript-security 1\n' },
      },
    });
    expect(res.statusCode, 'accepted — level 1 is safe').toBe(201);
  });

  it('CRITICAL a WireGuard endpoint on a private address is refused. The endpoint is the real egress; a 10.0.0.0/8 target reaches whatever sits on the fleet host’s own network segment.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: {
        label: 'wg-private',
        scheme: 'wireguard',
        ...SAFE_DISPLAY,
        wireguard: {
          private_key: WG_PRIV,
          peer_public_key: WG_PUB,
          endpoint: '10.0.0.5:51820',
          allowed_ips: '0.0.0.0/0',
        },
      },
    });
    expect(res.statusCode, 'refused').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/private|loopback|metadata/i);
  });

  it('CRITICAL a WireGuard DNS entry is guarded too, not just the endpoint. DNS is the second field the tunnel actually contacts, and a safe endpoint with a metadata-address resolver is the obvious way past a guard that only checked the endpoint.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: {
        label: 'wg-dns',
        scheme: 'wireguard',
        ...SAFE_DISPLAY,
        wireguard: {
          private_key: WG_PRIV,
          peer_public_key: WG_PUB,
          endpoint: 'vpn.example.com:51820',
          allowed_ips: '0.0.0.0/0',
          dns: '169.254.169.254',
        },
      },
    });
    expect(res.statusCode, 'refused').toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/metadata|private|loopback/i);
  });

  // ─── update-body validation surfaces the SPECIFIC reason ──────────────
  //
  // Added 2026-08-15. The update route's schema refusal had no arms, and its
  // validation is deliberately unlike the rest of the codebase: instead of `ValidationError(parsed.error.flatten())`
  // it lifts the FIRST zod issue message into a `BadRequestError`. That choice
  // is what turns "your update was rejected" into "port must be <= 65535", and
  // nothing exercised it.

  it('CRITICAL an invalid update body is refused with the SPECIFIC schema reason, not a generic message. The route lifts the first zod issue into the detail on purpose; losing that leaves a customer editing a proxy with no indication of which field they got wrong.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: { label: 'patchable', host: 'proxy.example.test', port: 1080 },
    });
    expect(created.statusCode, 'seeded').toBe(201);
    const id = created.json<ProxyMeta>().id;

    const res = await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { scheme: 'socks5', port: 65536 },
    });
    expect(res.statusCode, 'refused').toBe(400);
    const detail = res.json<{ detail: string }>().detail;
    expect(detail, 'the schema reason reaches the caller').toMatch(/65535|less than or equal/i);
    expect(detail, 'not the generic fallback').not.toBe('Invalid proxy.');
  });

  it('CRITICAL a valid update still succeeds, so the arm above is about the MESSAGE rather than the update route being broken. Without this a build that refused every update would satisfy the refusal arm and look correct.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: { label: 'patchable-ok', host: 'proxy.example.test', port: 1080 },
    });
    const id = created.json<ProxyMeta>().id;
    const res = await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { scheme: 'socks5', port: 1081 },
    });
    expect(res.statusCode, 'a legal update is accepted').toBe(200);
    expect(res.json<ProxyMeta & { port: number }>().port).toBe(1081);
  });

  it('a paid tier is unaffected — wireguard still registers', async () => {
    fx = await buildTestApp({ tier: 'api_starter' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: {
        label: 'wg-paid',
        scheme: 'wireguard',
        host: 'vpn.example.com',
        port: 51820,
        wireguard: {
          private_key: WG_PRIV,
          peer_public_key: WG_PUB,
          endpoint: 'vpn.example.com:51820',
          allowed_ips: '0.0.0.0/0',
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<ProxyMeta>().scheme).toBe('wireguard');
  });

  it('creates a WireGuard proxy — private_key is NEVER echoed (has_secret=true)', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: {
        label: 'wg-home',
        scheme: 'wireguard',
        host: 'vpn.example.com',
        port: 51820,
        wireguard: {
          private_key: WG_PRIV,
          peer_public_key: WG_PUB,
          endpoint: 'vpn.example.com:51820',
          allowed_ips: '0.0.0.0/0',
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const meta = create.json<ProxyMeta>();
    expect(meta.scheme).toBe('wireguard');
    expect(meta.has_secret).toBe(true);
    expect(meta.has_password).toBe(false);
    // The secret key must not appear anywhere in the response body.
    expect(create.body).not.toContain(WG_PRIV);
    // …nor in the list view.
    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
    });
    expect(list.body).not.toContain(WG_PRIV);
  });

  it('CRITICAL the UPDATE and TEST responses never echo a secret either. api/proxies.md promises secrets are "never returned in ANY response"; create and list were checked, PUT and /test were not — and PUT is the route that ACCEPTS a new password, so it is the one most likely to hand it straight back.', async () => {
    fx = await buildTestApp();
    const UPDATED_PW = 'rotated-secret-marker-9f3a';

    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: {
        scheme: 'socks5',
        label: 'rotating',
        host: '1.2.3.4',
        port: 1080,
        username: 'u',
        password: 'original-secret',
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json<ProxyMeta & { id: string }>().id;

    const update = await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${id}`,
      headers: auth(fx),
      payload: {
        scheme: 'socks5',
        label: 'rotating',
        host: '1.2.3.4',
        port: 1080,
        username: 'u',
        password: UPDATED_PW,
      },
    });
    expect(update.statusCode, `PUT returned ${update.statusCode}`).toBeLessThan(400);
    expect(update.body, 'PUT echoed the new password').not.toContain(UPDATED_PW);
    // …and the update must actually have applied, or the absence proves nothing.
    expect(update.json<ProxyMeta>().has_password).toBe(true);

    const test = await fx.app.inject({
      method: 'POST',
      url: `/v1/account/me/proxies/${id}/test`,
      headers: auth(fx),
      payload: {},
    });
    expect(test.body, '/test echoed the password').not.toContain(UPDATED_PW);

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
    });
    expect(list.body, 'list echoed the rotated password').not.toContain(UPDATED_PW);
  });

  it('creates an OpenVPN proxy — config_blob is NEVER echoed (has_secret=true)', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: {
        label: 'ovpn-work',
        scheme: 'openvpn',
        host: 'vpn.example.com',
        port: 1194,
        openvpn: { config_blob: OVPN_BLOB, username: 'u' },
      },
    });
    expect(create.statusCode).toBe(201);
    const meta = create.json<ProxyMeta>();
    expect(meta.scheme).toBe('openvpn');
    expect(meta.has_secret).toBe(true);
    expect(create.body).not.toContain('remote vpn.example.com');
  });

  it('scheme=wireguard WITHOUT a wireguard block → 400', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: { label: 'bad', scheme: 'wireguard', host: 'h', port: 51820 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a VPN block on a socks5 scheme → 400 (stray block, no half-typed row)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
      payload: {
        label: 'mismatch',
        scheme: 'socks5',
        host: '1.2.3.4',
        port: 1080,
        wireguard: {
          private_key: WG_PRIV,
          peer_public_key: WG_PUB,
          endpoint: 'vpn.example.com:51820',
          allowed_ips: '0.0.0.0/0',
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a password-only partial update on an existing VPN row', async () => {
    fx = await buildTestApp();
    const created = (
      await fx.app.inject({
        method: 'POST',
        url: '/v1/account/me/proxies',
        headers: auth(fx),
        payload: {
          label: 'wg-password-guard',
          scheme: 'wireguard',
          host: 'vpn.example.com',
          port: 51820,
          wireguard: {
            private_key: WG_PRIV,
            peer_public_key: WG_PUB,
            endpoint: 'vpn.example.com:51820',
            allowed_ips: '0.0.0.0/0',
          },
        },
      })
    ).json<ProxyMeta>();

    const response = await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${created.id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { password: 'must-not-be-stored' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('matching VPN configuration');
    const listed = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
    });
    const row = listed.json<{ data: ProxyMeta[] }>().data.find((proxy) => proxy.id === created.id);
    expect(row?.has_secret).toBe(true);
    expect(row?.has_password).toBe(false);
  });

  // Regression: PUT switching a VPN row AWAY from openvpn/wireguard must wipe
  // the stale wrapped VPN secret (private_key/config_blob ciphertext) — not
  // just leave it orphaned under a socks5/http row with a misleading
  // has_secret=true.
  it('PUT scheme wireguard -> socks5 clears the stale wrapped secret (has_secret goes false)', async () => {
    fx = await buildTestApp();
    const created = (
      await fx.app.inject({
        method: 'POST',
        url: '/v1/account/me/proxies',
        headers: auth(fx),
        payload: {
          label: 'wg-then-socks',
          scheme: 'wireguard',
          host: 'vpn.example.com',
          port: 51820,
          wireguard: {
            private_key: WG_PRIV,
            peer_public_key: WG_PUB,
            endpoint: 'vpn.example.com:51820',
            allowed_ips: '0.0.0.0/0',
          },
        },
      })
    ).json<ProxyMeta>();
    expect(created.has_secret).toBe(true);

    const switched = await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${created.id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { scheme: 'socks5', password: 'newpass' },
    });
    expect(switched.statusCode).toBe(200);
    const meta = switched.json<ProxyMeta>();
    expect(meta.scheme).toBe('socks5');
    // The new socks5 password DID get wrapped/set...
    expect(meta.has_password).toBe(true);
    // ...but the stale WireGuard private_key ciphertext must NOT survive.
    expect(meta.has_secret).toBe(false);

    // GET (list) reflects the same cleared state, not just the PUT response.
    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
    });
    const listed = list.json<{ data: ProxyMeta[] }>().data.find((p) => p.id === created.id);
    expect(listed?.has_secret).toBe(false);
  });
});

describe('proxy audit emit — egress-config changes land in the account audit log', () => {
  interface AuditEntry {
    action: string;
    target_resource_id: string | null;
  }

  it('POST emits proxy.created with the proxy id + non-secret metadata (no password)', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'audited', host: '1.2.3.4', port: 1080, password: 'hunter2' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json<ProxyMeta>().id;

    const log = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=proxy.created&limit=10',
      headers: auth(fx),
    });
    expect(log.statusCode).toBe(200);
    const entries = log.json<{ data: AuditEntry[] }>().data;
    const entry = entries.find((e) => e.target_resource_id === `proxy_${id}`);
    expect(entry).toBeTruthy();
    // The secret must never leak into the audit log either.
    expect(log.body).not.toContain('hunter2');
  });

  it('DELETE emits proxy.deleted for the removed proxy', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'to-delete', host: '5.6.7.8', port: 1080 },
    });
    const id = create.json<ProxyMeta>().id;
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/account/me/proxies/${id}`,
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);

    const log = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=proxy.deleted&limit=10',
      headers: auth(fx),
    });
    const entries = log.json<{ data: AuditEntry[] }>().data;
    expect(entries.some((e) => e.target_resource_id === `proxy_${id}`)).toBe(true);
  });

  it('PUT emits proxy.updated for the edited proxy', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'before', host: '9.9.9.9', port: 1080 },
    });
    const id = create.json<ProxyMeta>().id;
    const put = await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'after' },
    });
    expect(put.statusCode).toBe(200);

    const log = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=proxy.updated&limit=10',
      headers: auth(fx),
    });
    const entries = log.json<{ data: AuditEntry[] }>().data;
    expect(entries.some((e) => e.target_resource_id === `proxy_${id}`)).toBe(true);
  });
});

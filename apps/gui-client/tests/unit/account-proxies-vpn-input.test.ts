import { describe, it, expect } from 'vitest';
import {
  buildWireGuardProxyInput,
  buildOpenVpnProxyInput,
  type WireGuardConfigInput,
} from '../../src/lib/account-proxies';
import { parseWireGuardConfigDetailed } from '../../src/lib/parse-wireguard';

const WG: WireGuardConfigInput = {
  private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
  peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
  endpoint: 'vpn.example.com:51820',
  allowed_ips: '0.0.0.0/0',
  address: '10.7.0.2/32',
};

describe('buildWireGuardProxyInput', () => {
  it('builds a wireguard create body, host/port from the endpoint', () => {
    expect(buildWireGuardProxyInput('wg-home', WG)).toEqual({
      label: 'wg-home',
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      wireguard: WG,
    });
  });

  it('error when the paste did not parse', () => {
    expect(buildWireGuardProxyInput('x', null)).toEqual({
      error: expect.stringMatching(/wg0\.conf/),
    });
  });

  it('error on a malformed endpoint (no port)', () => {
    const bad = { ...WG, endpoint: 'vpn.example.com' };
    expect(buildWireGuardProxyInput('x', bad)).toEqual({
      error: expect.stringMatching(/host:port/),
    });
  });

  // WG parity pass (2026-09-10).

  it('unwraps a bracketed IPv6 endpoint for the display host but keeps the brackets on the wire', () => {
    // The native endpoint_resolve reads a bare address; wg-quick (and the
    // server) want the bracketed form on the `endpoint` string. Both at once.
    const v6 = { ...WG, endpoint: '[2606:4700::1111]:51820' };
    expect(buildWireGuardProxyInput('x', v6)).toEqual({
      label: 'x',
      scheme: 'wireguard',
      host: '2606:4700::1111',
      port: 51820,
      wireguard: { ...v6, endpoint: '[2606:4700::1111]:51820' },
    });
  });

  it('strips one bracket pair only — a host that is just brackets is still an error', () => {
    expect(buildWireGuardProxyInput('x', { ...WG, endpoint: '[]:51820' })).toEqual({
      error: expect.stringMatching(/host:port/),
    });
  });

  it('surfaces the field the detailed parse named, verbatim', () => {
    expect(
      buildWireGuardProxyInput('x', { ok: false, reason: '[Interface] Address line is required' }),
    ).toEqual({ error: '[Interface] Address line is required' });
  });

  it('builds the body from an ok detailed result', () => {
    expect(buildWireGuardProxyInput('wg-home', { ok: true, value: WG })).toEqual({
      label: 'wg-home',
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      wireguard: WG,
    });
  });

  it('paste → body: a wg0.conf with no Address is told about Address, not about its keys', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${WG.private_key}`,
      '[Peer]',
      `PublicKey = ${WG.peer_public_key}`,
      'Endpoint = vpn.example.com:51820',
    ].join('\n');
    expect(buildWireGuardProxyInput('x', parseWireGuardConfigDetailed(conf))).toEqual({
      error: '[Interface] Address line is required',
    });
  });

  it('a null (no reason available) still says wg0.conf and now names Address among the needs', () => {
    expect(buildWireGuardProxyInput('x', null)).toEqual({
      error: expect.stringMatching(/wg0\.conf.*Address/),
    });
  });
});

describe('buildOpenVpnProxyInput', () => {
  it('builds an openvpn create body with the blob + extracted remote + creds', () => {
    const blob = 'client\nremote vpn.example.com 1194\n';
    expect(
      buildOpenVpnProxyInput(
        'ovpn',
        blob,
        { host: 'vpn.example.com', port: 1194 },
        { username: 'u' },
      ),
    ).toEqual({
      label: 'ovpn',
      scheme: 'openvpn',
      host: 'vpn.example.com',
      port: 1194,
      openvpn: { config_blob: blob, username: 'u' },
    });
  });

  it('omits creds when not supplied', () => {
    const out = buildOpenVpnProxyInput('o', 'client\nremote h 1194\n', { host: 'h', port: 1194 });
    expect(out).toEqual({
      label: 'o',
      scheme: 'openvpn',
      host: 'h',
      port: 1194,
      openvpn: { config_blob: 'client\nremote h 1194\n' },
    });
  });

  it('error when the remote could not be extracted', () => {
    expect(buildOpenVpnProxyInput('o', 'garbage', null)).toEqual({
      error: expect.stringMatching(/\.ovpn/),
    });
  });
});

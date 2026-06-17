import { describe, it, expect } from 'vitest';
import {
  buildWireGuardProxyInput,
  buildOpenVpnProxyInput,
  type WireGuardConfigInput,
} from '../../src/lib/account-proxies';

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

// EG-API-1.6 — unit tests for SocksProxyBackend.
//
// Pins:
//   - applyToSession with valid SOCKS5 config returns an
//     EgressHandle with the documented envOverrides set.
//   - UDP-ASSOCIATE defaults true (so QUIC + HTTP/3 work
//     end-to-end through the customer's proxy).
//   - Optional credentials are propagated as DRIFTSTACK_*
//     env vars when both username + password are present.
//   - Half-set credentials (just username, or just password)
//     are rejected — both or neither.
//   - Empty host / out-of-range port are rejected.
//   - Non-SOCKS5 proxy types (openvpn, wireguard) are rejected
//     with a typed error naming the planning-133 phase that
//     ships them.
//   - releaseFromSession is a no-op (returns resolved void).

import { describe, expect, it } from 'vitest';
import { SocksProxyBackend } from '../../src/services/proxy-backends/socks5.js';
import type { SessionEgressConfig } from '../../src/services/session-egress.js';

const SAFEGUARD = {
  block_direct_internet: true,
  block_unproxied_dns: true,
  block_webrtc_stun_leakage: true,
};

function socks5Config(
  overrides: Partial<{
    sessionId: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
    udp_associate?: boolean;
  }> = {},
): SessionEgressConfig {
  return {
    session_id: overrides.sessionId ?? 'ses_test_xxx',
    proxy: {
      type: 'socks5',
      socks5: {
        host: overrides.host ?? 'p.example.com',
        port: overrides.port ?? 1080,
        udp_associate: overrides.udp_associate ?? true,
        ...(overrides.username !== undefined ? { username: overrides.username } : {}),
        ...(overrides.password !== undefined ? { password: overrides.password } : {}),
      },
    },
    egress_safeguard: SAFEGUARD,
  };
}

describe('EG-API-1.6 SocksProxyBackend', () => {
  it('applyToSession returns EgressHandle with the canonical env-var contract', async () => {
    const backend = new SocksProxyBackend();
    const handle = await backend.applyToSession({ config: socks5Config() });
    expect(handle.sessionId).toBe('ses_test_xxx');
    expect(handle.type).toBe('socks5');
    expect(handle.cleanup.envOverrides).toEqual({
      DRIFTSTACK_SOCKS5_PROXY_HOST: 'p.example.com',
      DRIFTSTACK_SOCKS5_PROXY_PORT: '1080',
      DRIFTSTACK_SOCKS5_UDP_ASSOCIATE: '1',
    });
  });

  it('UDP_ASSOCIATE defaults true (QUIC + HTTP/3 work end-to-end)', async () => {
    const backend = new SocksProxyBackend();
    const handle = await backend.applyToSession({ config: socks5Config({ udp_associate: true }) });
    expect(handle.cleanup.envOverrides?.DRIFTSTACK_SOCKS5_UDP_ASSOCIATE).toBe('1');
  });

  it('udp_associate=false drops the UDP path (TCP-only egress)', async () => {
    const backend = new SocksProxyBackend();
    const handle = await backend.applyToSession({ config: socks5Config({ udp_associate: false }) });
    expect(handle.cleanup.envOverrides?.DRIFTSTACK_SOCKS5_UDP_ASSOCIATE).toBe('0');
  });

  it('username + password are both propagated when present', async () => {
    const backend = new SocksProxyBackend();
    const handle = await backend.applyToSession({
      config: socks5Config({ username: 'alice', password: 'topsecret' }),
    });
    expect(handle.cleanup.envOverrides?.DRIFTSTACK_SOCKS5_PROXY_USERNAME).toBe('alice');
    expect(handle.cleanup.envOverrides?.DRIFTSTACK_SOCKS5_PROXY_PASSWORD).toBe('topsecret');
  });

  it('username-without-password is rejected (both or neither)', async () => {
    const backend = new SocksProxyBackend();
    await expect(
      backend.applyToSession({ config: socks5Config({ username: 'alice' }) }),
    ).rejects.toThrow(/both username \+ password, or neither/);
  });

  it('password-without-username is rejected (both or neither)', async () => {
    const backend = new SocksProxyBackend();
    await expect(
      backend.applyToSession({ config: socks5Config({ password: 'topsecret' }) }),
    ).rejects.toThrow(/both username \+ password, or neither/);
  });

  it('empty-host is rejected before env vars are emitted', async () => {
    const backend = new SocksProxyBackend();
    await expect(backend.applyToSession({ config: socks5Config({ host: '   ' }) })).rejects.toThrow(
      /socks5\.host/,
    );
  });

  it('out-of-range port is rejected', async () => {
    const backend = new SocksProxyBackend();
    await expect(backend.applyToSession({ config: socks5Config({ port: 70000 }) })).rejects.toThrow(
      /port must be in \[1, 65535\]/,
    );
  });

  it('OpenVPN config is rejected with a typed planning-133-phase reference', async () => {
    const backend = new SocksProxyBackend();
    const config: SessionEgressConfig = {
      session_id: 'ses_test_xxx',
      proxy: {
        type: 'openvpn',
        openvpn: {
          config_blob: 'client\nremote ovpn.example.com 1194\n',
        },
      },
      egress_safeguard: SAFEGUARD,
    };
    await expect(backend.applyToSession({ config })).rejects.toThrow(/Phase 2\/3 per planning 133/);
  });

  it('WireGuard config is rejected with a typed planning-133-phase reference', async () => {
    const backend = new SocksProxyBackend();
    const config: SessionEgressConfig = {
      session_id: 'ses_test_xxx',
      proxy: {
        type: 'wireguard',
        wireguard: {
          private_key: 'A'.repeat(43) + '=',
          peer_public_key: 'B'.repeat(43) + '=',
          endpoint: 'wg.example.com:51820',
          allowed_ips: '0.0.0.0/0',
        },
      },
      egress_safeguard: SAFEGUARD,
    };
    await expect(backend.applyToSession({ config })).rejects.toThrow(/Phase 2\/3 per planning 133/);
  });

  it('releaseFromSession is a no-op (env vars are process-scoped to the WebKit child)', async () => {
    const backend = new SocksProxyBackend();
    const handle = await backend.applyToSession({ config: socks5Config() });
    await expect(backend.releaseFromSession(handle)).resolves.toBeUndefined();
  });
});

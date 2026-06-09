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

import { createServer, type Server } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { SocksProxyBackend, defaultTcpProbe } from '../../src/services/proxy-backends/socks5.js';
import type { SessionEgressConfig } from '../../src/services/session-egress.js';

// All tests inject a tcpProbe stub so we never open real sockets
// during unit tests. Default stub resolves (probe success); the
// reachability tests pass a rejecting stub.
function probeOk(): Promise<void> {
  return Promise.resolve();
}

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
    require_remote_dns?: boolean;
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
        require_remote_dns: overrides.require_remote_dns ?? false,
        ...(overrides.username !== undefined ? { username: overrides.username } : {}),
        ...(overrides.password !== undefined ? { password: overrides.password } : {}),
      },
    },
    egress_safeguard: SAFEGUARD,
  };
}

describe('EG-API-1.6 SocksProxyBackend', () => {
  it('applyToSession returns EgressHandle with the canonical env-var contract', async () => {
    const backend = new SocksProxyBackend({ tcpProbe: probeOk });
    const handle = await backend.applyToSession({ config: socks5Config() });
    expect(handle.sessionId).toBe('ses_test_xxx');
    expect(handle.type).toBe('socks5');
    expect(handle.cleanup.envOverrides).toEqual({
      DRIFTSTACK_SOCKS5_PROXY_HOST: 'p.example.com',
      DRIFTSTACK_SOCKS5_PROXY_PORT: '1080',
      DRIFTSTACK_SOCKS5_UDP_ASSOCIATE: '1',
      DRIFTSTACK_SOCKS5_REQUIRE_REMOTE_DNS: '0',
    });
  });

  // EG-WK-1.9 propagation regression: schema accepts
  // `require_remote_dns` (founder verdict 2026-05-17) but the backend
  // wasn't passing it through to envOverrides — silent fallback to
  // local DNS would leak the host's resolver behind the proxy. This
  // test pins the propagation both ways so a future refactor can't
  // re-drop the flag.
  it('require_remote_dns=true propagates as DRIFTSTACK_SOCKS5_REQUIRE_REMOTE_DNS=1', async () => {
    const backend = new SocksProxyBackend({ tcpProbe: probeOk });
    const handle = await backend.applyToSession({
      config: socks5Config({ require_remote_dns: true }),
    });
    expect(handle.cleanup.envOverrides?.DRIFTSTACK_SOCKS5_REQUIRE_REMOTE_DNS).toBe('1');
  });

  it('require_remote_dns=false (default) propagates as DRIFTSTACK_SOCKS5_REQUIRE_REMOTE_DNS=0', async () => {
    const backend = new SocksProxyBackend({ tcpProbe: probeOk });
    const handle = await backend.applyToSession({
      config: socks5Config({ require_remote_dns: false }),
    });
    expect(handle.cleanup.envOverrides?.DRIFTSTACK_SOCKS5_REQUIRE_REMOTE_DNS).toBe('0');
  });

  it('UDP_ASSOCIATE defaults true (QUIC + HTTP/3 work end-to-end)', async () => {
    const backend = new SocksProxyBackend({ tcpProbe: probeOk });
    const handle = await backend.applyToSession({ config: socks5Config({ udp_associate: true }) });
    expect(handle.cleanup.envOverrides?.DRIFTSTACK_SOCKS5_UDP_ASSOCIATE).toBe('1');
  });

  it('udp_associate=false drops the UDP path (TCP-only egress)', async () => {
    const backend = new SocksProxyBackend({ tcpProbe: probeOk });
    const handle = await backend.applyToSession({ config: socks5Config({ udp_associate: false }) });
    expect(handle.cleanup.envOverrides?.DRIFTSTACK_SOCKS5_UDP_ASSOCIATE).toBe('0');
  });

  it('username + password are both propagated when present', async () => {
    const backend = new SocksProxyBackend({ tcpProbe: probeOk });
    const handle = await backend.applyToSession({
      config: socks5Config({ username: 'alice', password: 'topsecret' }),
    });
    expect(handle.cleanup.envOverrides?.DRIFTSTACK_SOCKS5_PROXY_USERNAME).toBe('alice');
    expect(handle.cleanup.envOverrides?.DRIFTSTACK_SOCKS5_PROXY_PASSWORD).toBe('topsecret');
  });

  it('username-without-password is rejected (both or neither)', async () => {
    const backend = new SocksProxyBackend({ tcpProbe: probeOk });
    await expect(
      backend.applyToSession({ config: socks5Config({ username: 'alice' }) }),
    ).rejects.toThrow(/both username \+ password, or neither/);
  });

  it('password-without-username is rejected (both or neither)', async () => {
    const backend = new SocksProxyBackend({ tcpProbe: probeOk });
    await expect(
      backend.applyToSession({ config: socks5Config({ password: 'topsecret' }) }),
    ).rejects.toThrow(/both username \+ password, or neither/);
  });

  it('empty-host is rejected before env vars are emitted', async () => {
    const backend = new SocksProxyBackend({ tcpProbe: probeOk });
    await expect(backend.applyToSession({ config: socks5Config({ host: '   ' }) })).rejects.toThrow(
      /socks5\.host/,
    );
  });

  it('out-of-range port is rejected', async () => {
    const backend = new SocksProxyBackend({ tcpProbe: probeOk });
    await expect(backend.applyToSession({ config: socks5Config({ port: 70000 }) })).rejects.toThrow(
      /port must be in \[1, 65535\]/,
    );
  });

  it('§4.17 SSRF guard — a private/loopback/metadata/numeric-encoding socks5.host is rejected BEFORE the TCP probe (no internal-network connect)', async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const backend = new SocksProxyBackend({ tcpProbe: probe });
    for (const host of [
      '127.0.0.1', // loopback
      'localhost', // loopback name
      '10.0.0.5', // RFC1918
      '192.168.1.1', // RFC1918
      '169.254.169.254', // link-local / cloud metadata
      '::1', // IPv6 loopback
      '2130706433', // decimal-encoded 127.0.0.1 (smuggling)
      '0x7f000001', // hex-encoded 127.0.0.1
    ]) {
      await expect(
        backend.applyToSession({ config: socks5Config({ host }) }),
        host,
      ).rejects.toThrow(/egress-proxy-host-not-allowed/);
    }
    // The guard runs before the probe — no internal-network connection attempted.
    expect(probe).not.toHaveBeenCalled();
  });

  it('§4.17 a public socks5.host passes the guard (probed normally)', async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const backend = new SocksProxyBackend({ tcpProbe: probe });
    await backend.applyToSession({ config: socks5Config({ host: 'proxy.example.com' }) });
    expect(probe).toHaveBeenCalledOnce();
  });

  it('host with surrounding whitespace is trimmed before BOTH the TCP probe and the env var (no self-inflicted egress-tunnel-unreachable for a stray space)', async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const backend = new SocksProxyBackend({ tcpProbe: probe });
    const handle = await backend.applyToSession({
      config: socks5Config({ host: '  proxy.example.com  ' }),
    });
    // Probe gets the trimmed host (untrimmed would DNS-fail → spurious 4xx).
    expect(probe).toHaveBeenCalledWith('proxy.example.com', 1080, expect.any(Number));
    // The WebKit fork's env var carries the trimmed host (untrimmed would
    // mis-configure the fork's NetworkSession SOCKS5 target).
    expect(handle.cleanup?.envOverrides?.DRIFTSTACK_SOCKS5_PROXY_HOST).toBe('proxy.example.com');
  });

  it('OpenVPN config is rejected with a typed planning-133-phase reference', async () => {
    const backend = new SocksProxyBackend({ tcpProbe: probeOk });
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
    const backend = new SocksProxyBackend({ tcpProbe: probeOk });
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
    const backend = new SocksProxyBackend({ tcpProbe: probeOk });
    const handle = await backend.applyToSession({ config: socks5Config() });
    await expect(backend.releaseFromSession(handle)).resolves.toBeUndefined();
  });

  describe('Q.0.b tunnel-reachability TCP probe', () => {
    it('invokes the probe with host + port + injected timeout before returning the handle', async () => {
      const probe = vi.fn().mockResolvedValue(undefined);
      const backend = new SocksProxyBackend({ tcpProbe: probe, probeTimeoutMs: 1234 });
      await backend.applyToSession({ config: socks5Config({ host: 'p.example', port: 1080 }) });
      expect(probe).toHaveBeenCalledWith('p.example', 1080, 1234);
    });

    it('throws egress-tunnel-unreachable when the probe rejects (firewall / wrong host / wrong port)', async () => {
      const probe = vi.fn().mockRejectedValue(new Error('egress-tunnel-unreachable: ECONNREFUSED'));
      const backend = new SocksProxyBackend({ tcpProbe: probe });
      await expect(backend.applyToSession({ config: socks5Config() })).rejects.toThrow(
        /egress-tunnel-unreachable/,
      );
    });

    it('does NOT call the probe when schema validation fails first (no point probing an invalid config)', async () => {
      const probe = vi.fn().mockResolvedValue(undefined);
      const backend = new SocksProxyBackend({ tcpProbe: probe });
      await expect(
        backend.applyToSession({ config: socks5Config({ host: '   ' }) }),
      ).rejects.toThrow(/socks5\.host/);
      expect(probe).not.toHaveBeenCalled();
    });

    it('does NOT call the probe for non-SOCKS5 proxy types (rejects at the type check)', async () => {
      const probe = vi.fn().mockResolvedValue(undefined);
      const backend = new SocksProxyBackend({ tcpProbe: probe });
      const config: SessionEgressConfig = {
        session_id: 'ses_test_xxx',
        proxy: {
          type: 'openvpn',
          openvpn: { config_blob: 'client\nremote ovpn.example.com 1194\n' },
        },
        egress_safeguard: SAFEGUARD,
      };
      await expect(backend.applyToSession({ config })).rejects.toThrow(
        /Phase 2\/3 per planning 133/,
      );
      expect(probe).not.toHaveBeenCalled();
    });

    it('default probe timeout is 3000ms when not injected', async () => {
      let observedTimeout: number | undefined;
      const probe = (_h: string, _p: number, t: number): Promise<void> => {
        observedTimeout = t;
        return Promise.resolve();
      };
      const backend = new SocksProxyBackend({ tcpProbe: probe });
      await backend.applyToSession({ config: socks5Config() });
      expect(observedTimeout).toBe(3000);
    });
  });

  // §4.17 SSRF — connection-time DNS-rebind layer in the REAL probe.
  // The literal-host guard can't see a DOMAIN that resolves to an internal IP;
  // the probe checks the actual connected peer address. Loopback (127.0.0.1) is
  // an internal address, so probing a local server must be rejected — proving the
  // guard fires on a host that resolved to an internal IP.
  describe('defaultTcpProbe — connection-time internal-IP SSRF guard', () => {
    it('rejects when the host resolves/connects to an internal (loopback) IP', async () => {
      const server: Server = createServer();
      await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      try {
        await expect(defaultTcpProbe('127.0.0.1', port, 3000)).rejects.toThrow(
          /egress-proxy-host-not-allowed.*resolved to internal address.*SSRF guard/,
        );
      } finally {
        await new Promise<void>((res) => server.close(() => res()));
      }
    });
  });
});

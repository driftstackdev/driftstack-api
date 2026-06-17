import { describe, it, expect } from 'vitest';
import { validateOpenVpnConfig } from '../../src/lib/parse-openvpn';

describe('validateOpenVpnConfig', () => {
  it('valid client .ovpn → ok + extracts remote host/port from the remote line', () => {
    const conf = ['client', 'dev tun', 'proto udp', 'remote vpn.example.com 1194 udp'].join('\n');
    expect(validateOpenVpnConfig(conf)).toEqual({
      ok: true,
      remoteHost: 'vpn.example.com',
      remotePort: 1194,
    });
  });

  it('remote without a port → falls back to the `port` directive', () => {
    const conf = ['client', 'remote 203.0.113.9', 'port 443'].join('\n');
    expect(validateOpenVpnConfig(conf)).toEqual({
      ok: true,
      remoteHost: '203.0.113.9',
      remotePort: 443,
    });
  });

  it('remote without any port → defaults to 1194', () => {
    expect(validateOpenVpnConfig(['client', 'remote vpn.example.com'].join('\n'))).toEqual({
      ok: true,
      remoteHost: 'vpn.example.com',
      remotePort: 1194,
    });
  });

  it('takes the FIRST remote (failover lines ignored) and tolerates comments', () => {
    const conf = [
      '# my vpn',
      'client',
      'remote primary.example.com 1194  # primary',
      'remote backup.example.com 1195',
      '; trailing note',
    ].join('\n');
    expect(validateOpenVpnConfig(conf)).toEqual({
      ok: true,
      remoteHost: 'primary.example.com',
      remotePort: 1194,
    });
  });

  it('missing `client` → not ok', () => {
    const r = validateOpenVpnConfig(['remote vpn.example.com 1194'].join('\n'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/client/);
  });

  it('missing `remote` → not ok', () => {
    const r = validateOpenVpnConfig(['client', 'dev tun'].join('\n'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/remote/);
  });

  it('empty input → not ok', () => {
    expect(validateOpenVpnConfig('').ok).toBe(false);
    expect(validateOpenVpnConfig('   \n ').ok).toBe(false);
  });

  it('oversized blob (>256 KB) → not ok', () => {
    const huge = 'client\nremote vpn.example.com 1194\n' + 'x'.repeat(256 * 1024 + 1);
    const r = validateOpenVpnConfig(huge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too large/);
  });
});

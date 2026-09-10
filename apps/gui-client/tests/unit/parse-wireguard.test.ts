import { describe, it, expect } from 'vitest';
import { parseWireGuardConfig, parseWireGuardConfigDetailed } from '../../src/lib/parse-wireguard';

// Canonical WireGuard example keys (wg(8) quickstart) — valid 44-char base64.
const PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

describe('parseWireGuardConfig', () => {
  it('parses a standard wg0.conf into the structured fields', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.0.0.2/32',
      'DNS = 1.1.1.1',
      '',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = vpn.example.com:51820',
      'AllowedIPs = 0.0.0.0/0',
    ].join('\n');
    expect(parseWireGuardConfig(conf)).toEqual({
      private_key: PRIV,
      peer_public_key: PUB,
      endpoint: 'vpn.example.com:51820',
      allowed_ips: '0.0.0.0/0',
      address: '10.0.0.2/32',
      dns: '1.1.1.1',
    });
  });

  it('defaults allowed_ips to 0.0.0.0/0 when absent, and omits dns when absent', () => {
    const conf = [
      '[Interface]',
      `PrivateKey=${PRIV}`,
      'Address=10.0.0.2/32',
      '[Peer]',
      `PublicKey=${PUB}`,
      'Endpoint=203.0.113.5:51820',
    ].join('\n');
    expect(parseWireGuardConfig(conf)).toEqual({
      private_key: PRIV,
      peer_public_key: PUB,
      endpoint: '203.0.113.5:51820',
      allowed_ips: '0.0.0.0/0',
      address: '10.0.0.2/32',
    });
  });

  it('tolerates comments, blank lines, and case-insensitive keys', () => {
    const conf = [
      '# my home VPN',
      '[Interface]',
      `privatekey = ${PRIV}`,
      'address = 10.0.0.2/32',
      '; a semicolon comment',
      '',
      '[Peer]',
      `PUBLICKEY = ${PUB}`,
      'endpoint = 198.51.100.7:443',
    ].join('\n');
    expect(parseWireGuardConfig(conf)).toEqual({
      private_key: PRIV,
      peer_public_key: PUB,
      endpoint: '198.51.100.7:443',
      allowed_ips: '0.0.0.0/0',
      address: '10.0.0.2/32',
    });
  });

  it('strips an INLINE comment on a value line (common in provider exports)', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.0.0.2/32',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = vpn.example.com:51820 # primary',
      'AllowedIPs = 0.0.0.0/0 ; full tunnel',
    ].join('\n');
    expect(parseWireGuardConfig(conf)).toEqual({
      private_key: PRIV,
      peer_public_key: PUB,
      endpoint: 'vpn.example.com:51820',
      allowed_ips: '0.0.0.0/0',
      address: '10.0.0.2/32',
    });
  });

  it('accepts a bracketed IPv6 endpoint (standard wg-quick syntax)', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.0.0.2/32',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = [2001:db8::1]:51820',
    ].join('\n');
    expect(parseWireGuardConfig(conf)?.endpoint).toBe('[2001:db8::1]:51820');
  });

  it('accepts a bracketed IPv6 endpoint with an inline comment', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.0.0.2/32',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = [2001:db8::1]:51820 # ipv6 only',
    ].join('\n');
    expect(parseWireGuardConfig(conf)?.endpoint).toBe('[2001:db8::1]:51820');
  });

  it('returns null when a required field is missing (no Endpoint)', () => {
    const conf = [
      '[Interface]',
      `PrivateKey=${PRIV}`,
      'Address=10.0.0.2/32',
      '[Peer]',
      `PublicKey=${PUB}`,
    ].join('\n');
    expect(parseWireGuardConfig(conf)).toBeNull();
  });

  it('returns null when Address is missing (the WG ifconfig needs it)', () => {
    const conf = [
      '[Interface]',
      `PrivateKey=${PRIV}`,
      '[Peer]',
      `PublicKey=${PUB}`,
      'Endpoint=vpn.example.com:51820',
    ].join('\n');
    expect(parseWireGuardConfig(conf)).toBeNull();
  });

  it('returns null on a malformed key (not 44-char base64)', () => {
    const conf = [
      '[Interface]',
      'PrivateKey=not-a-real-key',
      '[Peer]',
      `PublicKey=${PUB}`,
      'Endpoint=vpn.example.com:51820',
    ].join('\n');
    expect(parseWireGuardConfig(conf)).toBeNull();
  });

  it('returns null on an empty / whitespace input', () => {
    expect(parseWireGuardConfig('')).toBeNull();
    expect(parseWireGuardConfig('   \n  \n')).toBeNull();
  });

  // WG parity pass (2026-09-10) — the gaps where the form showed ✓ and the
  // server (or the tunnel) then refused. Each arm goes red if its fix is
  // reverted: the un-normalised value is what comes back.

  it('writes the /32 wg-quick implies on a mask-less IPv4 Address (the server requires the mask)', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = vpn.example.com:51820',
    ].join('\n');
    expect(parseWireGuardConfig(conf)?.address).toBe('10.7.0.2/32');
  });

  it('writes /128 on a mask-less IPv6 Address entry and leaves a masked entry alone', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2/24, fd00:7::2',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = vpn.example.com:51820',
    ].join('\n');
    expect(parseWireGuardConfig(conf)?.address).toBe('10.7.0.2/24, fd00:7::2/128');
  });

  it('writes the mask on a mask-less AllowedIPs entry the same way wg(8) reads it', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2/32',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = vpn.example.com:51820',
      'AllowedIPs = 10.0.0.1, fd00::1, 192.168.0.0/16',
    ].join('\n');
    expect(parseWireGuardConfig(conf)?.allowed_ips).toBe(
      '10.0.0.1/32, fd00::1/128, 192.168.0.0/16',
    );
  });

  it('keeps the resolver IPs and drops a DNS search domain (the server takes IP literals only)', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2/32',
      'DNS = 10.64.0.1, corp.local, fd00::1',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = vpn.example.com:51820',
    ].join('\n');
    expect(parseWireGuardConfig(conf)?.dns).toBe('10.64.0.1, fd00::1');
  });

  it('omits dns when the DNS line held only search domains', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2/32',
      'DNS = corp.local, ad.example.com',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = vpn.example.com:51820',
    ].join('\n');
    const parsed = parseWireGuardConfig(conf);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('dns');
  });

  it('carries a [Peer] PresharedKey (dropping it fails the handshake at launch)', () => {
    const PSK = 'FpCyhws9cxwWoV4xbZ8MqE3ZPxc7l7aY3hEhKMk6uNc=';
    // Positive control on the fixture: a mistyped key would make the arm below
    // read as "the parser dropped it" when the parser never saw a key.
    expect(PSK).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2/32',
      '[Peer]',
      `PublicKey = ${PUB}`,
      `PresharedKey = ${PSK}`,
      'Endpoint = vpn.example.com:51820',
    ].join('\n');
    expect(parseWireGuardConfig(conf)?.preshared_key).toBe(PSK);
  });

  it('does not refuse the paste over a PresharedKey that is not a key — it is just not carried', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2/32',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'PresharedKey = not-a-key',
      'Endpoint = vpn.example.com:51820',
    ].join('\n');
    const parsed = parseWireGuardConfig(conf);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('preshared_key');
  });
});

describe('parseWireGuardConfigDetailed', () => {
  // One null used to stand for four causes, and the form rendered every one of
  // them as "missing keys or endpoint" — a conf with no Address was told to
  // check its keys. Each arm pins the reason that names the field.

  it('names a missing [Interface] Address', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = vpn.example.com:51820',
    ].join('\n');
    expect(parseWireGuardConfigDetailed(conf)).toEqual({
      ok: false,
      reason: '[Interface] Address line is required',
    });
  });

  it('names a PrivateKey that is not a key, whether malformed or absent', () => {
    const malformed = [
      '[Interface]',
      'PrivateKey = not-a-real-key',
      'Address = 10.7.0.2/32',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = vpn.example.com:51820',
    ].join('\n');
    const absent = [
      '[Interface]',
      'Address = 10.7.0.2/32',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = vpn.example.com:51820',
    ].join('\n');
    for (const conf of [malformed, absent]) {
      expect(parseWireGuardConfigDetailed(conf)).toEqual({
        ok: false,
        reason: 'PrivateKey is not a 44-char base64 key',
      });
    }
  });

  it('names a [Peer] PublicKey that is not a key', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2/32',
      '[Peer]',
      'PublicKey = too-short',
      'Endpoint = vpn.example.com:51820',
    ].join('\n');
    expect(parseWireGuardConfigDetailed(conf)).toEqual({
      ok: false,
      reason: '[Peer] PublicKey is not a 44-char base64 key',
    });
  });

  it('names an Endpoint that is not host:port, whether portless or absent', () => {
    const portless = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2/32',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = vpn.example.com',
    ].join('\n');
    const absent = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2/32',
      '[Peer]',
      `PublicKey = ${PUB}`,
    ].join('\n');
    for (const conf of [portless, absent]) {
      expect(parseWireGuardConfigDetailed(conf)).toEqual({
        ok: false,
        reason: 'Endpoint must be host:port',
      });
    }
  });

  it('asks for a paste on empty input', () => {
    expect(parseWireGuardConfigDetailed('   \n')).toEqual({
      ok: false,
      reason: 'Paste your wg0.conf configuration.',
    });
  });

  it('returns the same value the null-on-failure wrapper does, brackets and all', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2',
      'DNS = 10.64.0.1, corp.local',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = [2606:4700::1111]:51820',
    ].join('\n');
    const detailed = parseWireGuardConfigDetailed(conf);
    expect(detailed).toEqual({
      ok: true,
      value: {
        private_key: PRIV,
        peer_public_key: PUB,
        endpoint: '[2606:4700::1111]:51820',
        allowed_ips: '0.0.0.0/0',
        address: '10.7.0.2/32',
        dns: '10.64.0.1',
      },
    });
    expect(parseWireGuardConfig(conf)).toEqual(detailed.ok ? detailed.value : null);
  });
});

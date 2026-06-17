import { describe, it, expect } from 'vitest';
import { parseWireGuardConfig } from '../../src/lib/parse-wireguard';

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
      dns: '1.1.1.1',
    });
  });

  it('defaults allowed_ips to 0.0.0.0/0 when absent, and omits dns when absent', () => {
    const conf = [
      '[Interface]',
      `PrivateKey=${PRIV}`,
      '[Peer]',
      `PublicKey=${PUB}`,
      'Endpoint=203.0.113.5:51820',
    ].join('\n');
    expect(parseWireGuardConfig(conf)).toEqual({
      private_key: PRIV,
      peer_public_key: PUB,
      endpoint: '203.0.113.5:51820',
      allowed_ips: '0.0.0.0/0',
    });
  });

  it('tolerates comments, blank lines, and case-insensitive keys', () => {
    const conf = [
      '# my home VPN',
      '[Interface]',
      `privatekey = ${PRIV}`,
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
    });
  });

  it('returns null when a required field is missing (no Endpoint)', () => {
    const conf = ['[Interface]', `PrivateKey=${PRIV}`, '[Peer]', `PublicKey=${PUB}`].join('\n');
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
});

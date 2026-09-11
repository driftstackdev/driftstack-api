import { describe, it, expect } from 'vitest';
import {
  OPENVPN_IN_WIREGUARD_FORM_REASON,
  WG_MTU_NOT_CARRIED_NOTICE,
  WG_MTU_REASON,
  multiplePeersReason,
  parseWireGuardConfig,
  parseWireGuardConfigDetailed,
} from '../../src/lib/parse-wireguard';

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

// WireGuard audit batch (n), 2026-09-11 — N5 / N6 / N12 / N17. Each arm names,
// in its comment, the production line whose reversion turns it red.

const PSK = 'FpCyhws9cxwWoV4xbZ8MqE3ZPxc7l7aY3hEhKMk6uNc=';
const PUB2 = 'HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=';

/** A single-peer wg0.conf, LF-joined, with the given extra lines spliced in. */
function wgConf(opts: { iface?: string[]; peer?: string[] } = {}): string {
  return [
    '[Interface]',
    `PrivateKey = ${PRIV}`,
    'Address = 10.7.0.2/32',
    ...(opts.iface ?? []),
    '[Peer]',
    `PublicKey = ${PUB}`,
    'Endpoint = wg.example.com:51820',
    'AllowedIPs = 0.0.0.0/0',
    ...(opts.peer ?? []),
  ].join('\n');
}

const WG_EXPECTED = {
  private_key: PRIV,
  peer_public_key: PUB,
  endpoint: 'wg.example.com:51820',
  allowed_ips: '0.0.0.0/0',
  address: '10.7.0.2/32',
};

describe('N5 — an OpenVPN .ovpn in the WireGuard form is refused as the wrong file type', () => {
  // Positive controls on the fixtures: each is what parse-openvpn's own
  // validateOpenVpnConfig accepts as a client .ovpn (a `client` + a `remote`).
  const OVPN = [
    'client',
    'dev tun',
    'proto udp',
    'remote vpn.example.com 1194',
    'resolv-retry infinite',
    '<ca>',
    '-----BEGIN CERTIFICATE-----',
    'MIIB',
    '-----END CERTIFICATE-----',
    '</ca>',
  ].join('\n');

  it('a client .ovpn is refused with a reason naming OpenVPN, not PrivateKey', () => {
    // Reverting the `!sawHeader && looksLikeOpenVpn(lines)` return falls
    // through to the PrivateKey check — the reason the audit found.
    expect(parseWireGuardConfigDetailed(OVPN)).toEqual({
      ok: false,
      reason: OPENVPN_IN_WIREGUARD_FORM_REASON,
    });
    expect(OPENVPN_IN_WIREGUARD_FORM_REASON).toMatch(/OpenVPN/);
    expect(OPENVPN_IN_WIREGUARD_FORM_REASON).not.toMatch(/PrivateKey/);
    expect(parseWireGuardConfig(OVPN)).toBeNull();
  });

  it.each([
    ['a bare `client` line', 'client\ndev tun\n'],
    ['a `remote <host> <port>` line', 'dev tun\nremote vpn.example.com 1194\n'],
    ['an inline <ca> block', 'dev tun\n<ca>\nMIIB\n</ca>\n'],
    ['an inline <cert> block', 'dev tun\n<cert>\nMIIB\n</cert>\n'],
    ['an inline <key> block', 'dev tun\n<key>\nMIIB\n</key>\n'],
  ])('%s alone is an OpenVPN signature', (_label, text) => {
    // Each alternative of OPENVPN_LINE_RE has its own arm: dropping one from
    // the regex reds exactly that arm.
    expect(parseWireGuardConfigDetailed(text)).toEqual({
      ok: false,
      reason: OPENVPN_IN_WIREGUARD_FORM_REASON,
    });
  });

  it('vacuity control: a wg0.conf still parses, and one whose COMMENT mentions `remote` is not an .ovpn', () => {
    expect(parseWireGuardConfigDetailed(wgConf())).toEqual({ ok: true, value: WG_EXPECTED });
    // stripInlineComment runs before the signature test; a `# remote …` note is
    // a comment, not a directive. Reverting that strip reds this arm.
    const commented = wgConf({ peer: ['# remote backup.example.com 1194 (old OpenVPN server)'] });
    expect(parseWireGuardConfigDetailed(commented)).toEqual({ ok: true, value: WG_EXPECTED });
  });

  it('a paste that carries a WireGuard section header is judged as WireGuard whatever else it holds', () => {
    // The `!sawHeader` half of the guard: a wg0.conf with a stray `client`
    // line is still a wg0.conf (and parses); removing the half reds this arm.
    const mixed = wgConf({ iface: ['client'] });
    expect(parseWireGuardConfigDetailed(mixed)).toEqual({ ok: true, value: WG_EXPECTED });
  });

  it('a paste with neither an OpenVPN signature nor a WireGuard header still names PrivateKey', () => {
    // Control: the refusal is specific to the OpenVPN signature, not to
    // "anything without [Interface]".
    expect(parseWireGuardConfigDetailed('dev tun\nproto udp\n')).toEqual({
      ok: false,
      reason: 'PrivateKey is not a 44-char base64 key',
    });
  });
});

describe('N6 — [Peer] blocks are units; a conf with more than one is refused, never stitched', () => {
  const twoPeersPskOnSecond = [
    '[Interface]',
    `PrivateKey = ${PRIV}`,
    'Address = 10.7.0.2/32',
    '[Peer]',
    `PublicKey = ${PUB}`,
    'Endpoint = wg.example.com:51820',
    'AllowedIPs = 10.0.0.0/8',
    '[Peer]',
    `PublicKey = ${PUB2}`,
    `PresharedKey = ${PSK}`,
    'Endpoint = exit.example.com:51820',
    'AllowedIPs = 0.0.0.0/0',
  ].join('\n');

  it('two peers where only the SECOND has a PresharedKey: the first peer never gets it', () => {
    // Reverting section tracking (one flat map, first-wins) yields
    // { publickey: peer1, endpoint: peer1, presharedkey: peer2 } — the audit's
    // chimera — and `preshared_key` reads PSK here.
    expect(parseWireGuardConfig(twoPeersPskOnSecond)?.preshared_key).toBeUndefined();
    // Reverting the `peers.length > 1` refusal alone parses peer 1 whole
    // (no PSK), which the line above cannot tell from the refusal — the
    // reason pin below can.
    expect(parseWireGuardConfigDetailed(twoPeersPskOnSecond)).toEqual({
      ok: false,
      reason: multiplePeersReason(2),
    });
    expect(multiplePeersReason(2)).toMatch(/2 \[Peer\] blocks/);
    expect(multiplePeersReason(2)).toMatch(/AllowedIPs = 0\.0\.0\.0\/0/);
  });

  it('two peers where only the SECOND has an Endpoint: the first peer is not saved with it', () => {
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2/32',
      '[Peer]',
      `PublicKey = ${PUB}`,
      'AllowedIPs = 10.0.0.0/8',
      '[Peer]',
      `PublicKey = ${PUB2}`,
      'Endpoint = exit.example.com:51820',
      'AllowedIPs = 0.0.0.0/0',
    ].join('\n');
    const parsed = parseWireGuardConfig(conf);
    // The flat map produced { peer_public_key: PUB, endpoint: exit… } — a key
    // and an endpoint from different peers.
    expect(parsed?.endpoint).not.toBe('exit.example.com:51820');
    expect(parsed).toBeNull();
    expect(parseWireGuardConfigDetailed(conf)).toEqual({
      ok: false,
      reason: multiplePeersReason(2),
    });
  });

  it('the reason counts the peers it saw', () => {
    const three = `${twoPeersPskOnSecond}\n[Peer]\nPublicKey = ${PUB2}\nAllowedIPs = 10.9.0.0/16\n`;
    expect(parseWireGuardConfigDetailed(three)).toEqual({
      ok: false,
      reason: multiplePeersReason(3),
    });
    expect(multiplePeersReason(3)).toContain('3 [Peer] blocks');
  });

  it('a [Peer] key written under [Interface] is not a peer key (section scoping, not name matching)', () => {
    // The flat map read PublicKey from anywhere; with sections tracked a
    // PublicKey under [Interface] leaves the peer without one, and the reason
    // names the [Peer] line. Reverting the scoping parses this green.
    const conf = [
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2/32',
      `PublicKey = ${PUB}`,
      '[Peer]',
      'Endpoint = wg.example.com:51820',
    ].join('\n');
    expect(parseWireGuardConfigDetailed(conf)).toEqual({
      ok: false,
      reason: '[Peer] PublicKey is not a 44-char base64 key',
    });
  });

  it('vacuity control: one [Peer] parses whole, and [Peer] before [Interface] is the same conf', () => {
    const single = wgConf({ peer: [`PresharedKey = ${PSK}`] });
    expect(parseWireGuardConfigDetailed(single)).toEqual({
      ok: true,
      value: { ...WG_EXPECTED, preshared_key: PSK },
    });
    const reversed = [
      '[Peer]',
      `PublicKey = ${PUB}`,
      'Endpoint = wg.example.com:51820',
      'AllowedIPs = 0.0.0.0/0',
      `PresharedKey = ${PSK}`,
      '[Interface]',
      `PrivateKey = ${PRIV}`,
      'Address = 10.7.0.2/32',
    ].join('\n');
    expect(parseWireGuardConfigDetailed(reversed)).toEqual(parseWireGuardConfigDetailed(single));
  });

  it('lines before the first section header belong to no section (wg-quick refuses them too)', () => {
    // A PrivateKey above `[Interface]` is not an [Interface] key; the reason
    // names it. Reverting `if (current === null) continue;` (e.g. defaulting
    // to [Interface]) parses this green.
    const conf = [`PrivateKey = ${PRIV}`, ...wgConf().split('\n').slice(2)].join('\n');
    expect(parseWireGuardConfigDetailed(conf)).toEqual({
      ok: false,
      reason: 'PrivateKey is not a 44-char base64 key',
    });
  });
});

describe('N12 — CRLF, script hooks, duplicate keys and a BOM', () => {
  it('a CRLF conf parses identically to its LF form', () => {
    // Guards the line-break handling as a whole: `split(/\r?\n/)` in
    // confLines plus the per-line trim — a regression that keeps a trailing
    // `\r` on the key or the value fails the key regexes and reds this arm.
    const lf = parseWireGuardConfigDetailed(wgConf({ iface: ['DNS = 1.1.1.1'] }));
    const crlf = parseWireGuardConfigDetailed(
      wgConf({ iface: ['DNS = 1.1.1.1'] }).replace(/\n/g, '\r\n'),
    );
    expect(lf.ok).toBe(true); // equality below is not two nulls agreeing
    expect(crlf).toEqual(lf);
    expect(crlf.ok && crlf.value.dns).toBe('1.1.1.1');
  });

  it('PostUp / PreUp / PostDown / PreDown lines are ignored: same value as without them', () => {
    // Regression pin: the hooks are read into the [Interface] map and never
    // consulted; a change that refuses unknown keys, or that reads a hook as a
    // field, reds this arm. (The fleet's userspace tunnel does not run hooks,
    // so nothing is lost by ignoring them — unlike OpenVPN's unsupported
    // directives, which alter the tunnel and get a strip offer.)
    const hooks = [
      'PreUp = echo up',
      'PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE',
      'PreDown = echo down',
      'PostDown = iptables -D FORWARD -i %i -j ACCEPT',
    ];
    const withHooks = parseWireGuardConfigDetailed(wgConf({ iface: hooks }));
    expect(withHooks).toEqual({ ok: true, value: WG_EXPECTED });
    expect(withHooks).toEqual(parseWireGuardConfigDetailed(wgConf()));
  });

  it('a duplicated Endpoint keeps the FIRST (as wg-quick does)', () => {
    // `!current.has(key)` in the scan — a last-wins mutation reds this arm.
    const conf = wgConf({ peer: ['Endpoint = second.example.com:51820'] });
    expect(parseWireGuardConfig(conf)?.endpoint).toBe('wg.example.com:51820');
  });

  it('a duplicated PrivateKey keeps the first too, in its own section', () => {
    const conf = wgConf({ iface: [`PrivateKey = ${PUB2}`] });
    expect(parseWireGuardConfig(conf)?.private_key).toBe(PRIV);
  });

  it('a leading byte-order mark is tolerated (Windows editors write one)', () => {
    // `.replace(/^\uFEFF/, '')` in confLines. The first line is the
    // `[Interface]` header: with the mark kept it is not a header, its keys
    // belong to no section, and the reason would name PrivateKey.
    const bom = parseWireGuardConfigDetailed(`\uFEFF${wgConf()}`);
    expect(bom).toEqual({ ok: true, value: WG_EXPECTED });
    // Positive control on the fixture: the mark is really there.
    expect(`\uFEFF${wgConf()}`.charCodeAt(0)).toBe(0xfeff);
  });
});

describe('N17 — MTU is parsed, never silently dropped', () => {
  it('`MTU = 1280` round-trips to mtu: 1280', () => {
    // `iface.get('mtu')` + `result.mtu = mtu` — reverting either leaves the
    // value out and the toEqual reds.
    expect(parseWireGuardConfigDetailed(wgConf({ iface: ['MTU = 1280'] }))).toEqual({
      ok: true,
      value: { ...WG_EXPECTED, mtu: 1280 },
    });
  });

  it('is absent when the line is missing, and takes an inline comment', () => {
    expect(parseWireGuardConfig(wgConf())).not.toHaveProperty('mtu');
    expect(parseWireGuardConfig(wgConf({ iface: ['MTU = 1420 # provider default'] }))?.mtu).toBe(
      1420,
    );
  });

  it.each([
    ['below 1280', 'MTU = 1200'],
    ['above 1500', 'MTU = 9000'],
    ['not a number', 'MTU = large'],
    ['not a whole number', 'MTU = 1420.5'],
  ])('refuses an MTU that is %s, naming the line', (_label, line) => {
    // The `n < WG_MTU_MIN || n > WG_MTU_MAX` / INTEGER_RE gate. A parser that
    // dropped the bad line instead would parse green and red these.
    expect(parseWireGuardConfigDetailed(wgConf({ iface: [line] }))).toEqual({
      ok: false,
      reason: WG_MTU_REASON,
    });
    expect(WG_MTU_REASON).toMatch(/^MTU must be a whole number from 1280 to 1500$/);
  });

  it('the bounds are inclusive', () => {
    expect(parseWireGuardConfig(wgConf({ iface: ['MTU = 1280'] }))?.mtu).toBe(1280);
    expect(parseWireGuardConfig(wgConf({ iface: ['MTU = 1500'] }))?.mtu).toBe(1500);
  });

  it('the not-carried notice names MTU and the default, and never claims it was applied', () => {
    expect(WG_MTU_NOT_CARRIED_NOTICE).toMatch(/MTU/);
    expect(WG_MTU_NOT_CARRIED_NOTICE).toMatch(/default/);
    expect(WG_MTU_NOT_CARRIED_NOTICE).toMatch(/not applied/);
  });
});

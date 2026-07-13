// SSRF guard for customer webhook URLs. The critical property is no
// FALSE POSITIVES (a legit public target must never be rejected) and no
// FALSE NEGATIVES on the literal-internal-IP vectors. Boundary cases on
// every blocked range + public IPs are pinned so a typo'd CIDR (e.g. the
// `::ffff:/96` trap that blocks all IPv4) is caught.

import { describe, expect, it } from 'vitest';
import {
  unsafeWebhookTargetReason as reason,
  classifyUnsafeHost,
  classifyUnsafeVpnTargets,
  openvpnRemoteHosts,
  openvpnProxyHosts,
} from '../../src/lib/webhook-target-guard.js';

describe('unsafeWebhookTargetReason — rejects internal/reserved targets', () => {
  it('rejects non-https', () => {
    expect(reason('http://example.com/hook')).toMatch(/https/);
    expect(reason('ftp://example.com')).toBeTruthy();
  });

  it('rejects URL userinfo credentials that fetch will not send', () => {
    for (const url of [
      'https://user:password@hooks.example.com/h',
      'https://user@hooks.example.com/h',
      'https://:password@hooks.example.com/h',
      'https://user%40tenant:pa%24%24@hooks.example.com/h',
    ]) {
      expect(reason(url), url).toMatch(/username or password credentials/);
    }
  });

  it('rejects localhost + *.localhost', () => {
    expect(reason('https://localhost/hook')).toMatch(/localhost/);
    expect(reason('https://api.localhost/hook')).toMatch(/localhost/);
  });

  it('rejects IPv4 private / loopback / link-local / reserved literals', () => {
    for (const h of [
      'https://10.0.0.5/h',
      'https://172.16.0.1/h',
      'https://172.31.255.255/h',
      'https://192.168.1.1/h',
      'https://127.0.0.1/h',
      'https://169.254.169.254/h', // cloud metadata
      'https://100.64.0.1/h', // CGNAT
      'https://0.0.0.0/h',
      'https://224.0.0.1/h', // multicast
      'https://240.0.0.1/h', // reserved
    ]) {
      expect(reason(h), h).toBeTruthy();
    }
  });

  it('rejects IPv6 loopback / ULA / link-local literals (bracketed)', () => {
    for (const h of [
      'https://[::1]/h',
      'https://[fc00::1]/h',
      'https://[fd12::1]/h',
      'https://[fe80::1]/h',
      'https://[::]/h',
    ]) {
      expect(reason(h), h).toBeTruthy();
    }
  });

  it('rejects IPv4-mapped IPv6 (private-IPv4 smuggling)', () => {
    expect(reason('https://[::ffff:10.0.0.5]/h')).toBeTruthy();
    expect(reason('https://[::ffff:192.168.0.1]/h')).toBeTruthy();
  });

  it('rejects numeric / hex / octal IP encodings that bypass isIP (SSRF-smuggling for 127.0.0.1)', () => {
    for (const h of [
      'https://2130706433/h', // decimal 127.0.0.1
      'https://0x7f000001/h', // hex 127.0.0.1
      'https://0x7f.0.0.1/h', // hex-leading dotted
      'https://0177.0.0.1/h', // octal 127.0.0.1
      'https://127.1/h', // inet_aton short-form 127.0.0.1
    ]) {
      expect(reason(h), h).toBeTruthy();
    }
  });

  it('rejects trailing-FQDN-dot localhost / literal-IP that would otherwise slip past the host checks', () => {
    expect(reason('https://localhost./h')).toMatch(/localhost/);
    expect(reason('https://127.0.0.1./h')).toBeTruthy();
  });

  it('rejects an over-long URL (>2048 chars) — the field has no schema-level .max()', () => {
    const longUrl = `https://hooks.example.com/${'a'.repeat(2100)}`;
    expect(longUrl.length).toBeGreaterThan(2048);
    expect(reason(longUrl)).toMatch(/2048 characters/);
  });
});

describe('unsafeWebhookTargetReason — allows legit public targets (NO false positives)', () => {
  it('allows public IPv4 incl. boundaries just outside blocked ranges', () => {
    for (const h of [
      'https://8.8.8.8/h',
      'https://1.1.1.1/h',
      'https://9.255.255.255/h', // just below 10/8
      'https://11.0.0.0/h', // just above 10/8
      'https://172.15.255.255/h', // just below 172.16/12
      'https://172.32.0.0/h', // just above 172.16/12
      'https://192.167.255.255/h', // just below 192.168/16
      'https://192.169.0.0/h', // just above 192.168/16
      'https://100.63.255.255/h', // just below 100.64/10
      'https://223.255.255.255/h', // just below 224/4 multicast
    ]) {
      expect(reason(h), h).toBeNull();
    }
  });

  it('allows public IPv6 + normal hostnames', () => {
    expect(reason('https://[2606:4700::1111]/h')).toBeNull();
    expect(reason('https://hooks.example.com/driftstack')).toBeNull();
    expect(reason('https://app.customer.io/webhooks/abc?x=1')).toBeNull();
    expect(reason('https://hooks.example.com/callback?signature=signed-value')).toBeNull();
  });

  it('allows a long-but-under-cap URL (e.g. a long signed callback path ≤2048) — no false rejection', () => {
    const longButOk = `https://hooks.example.com/webhooks?sig=${'a'.repeat(1900)}`;
    expect(longButOk.length).toBeLessThanOrEqual(2048);
    expect(reason(longButOk)).toBeNull();
  });

  it('does NOT over-reject hostnames with a numeric label or a trailing FQDN dot', () => {
    // The numeric-encoding guard requires EVERY label to be numeric/hex; a
    // real hostname always carries an alphabetic label/TLD, so these pass.
    expect(reason('https://1.example.com/h')).toBeNull();
    expect(reason('https://api.123.example.io/h')).toBeNull();
    expect(reason('https://hooks.example.com./h')).toBeNull(); // trailing FQDN dot
  });

  it('returns a reason (not throw) for a malformed URL', () => {
    expect(reason('not a url')).toBeTruthy();
    expect(reason('')).toBeTruthy();
  });
});

// classifyUnsafeHost is called on the RAW customer host by the SOCKS5 egress
// backend + account-proxies (NOT URL-normalised, unlike the webhook path). A
// non-canonical IPv6 literal must not slip the mapped/embedded-IPv4 checks.
describe('classifyUnsafeHost — raw-host SSRF (proxy/egress path, no URL normalization)', () => {
  it('blocks fully-expanded IPv4-mapped IPv6 (metadata-exfil bypass)', () => {
    for (const h of [
      '0:0:0:0:0:ffff:169.254.169.254', // expanded ::ffff:169.254.169.254 (metadata)
      '0:0:0:0:0:ffff:127.0.0.1', // expanded ::ffff:127.0.0.1 (loopback)
      '::ffff:169.254.169.254', // compressed form (already covered)
      '::ffff:10.0.0.5',
    ]) {
      expect(classifyUnsafeHost(h), h).toBe('private');
    }
  });

  it('blocks NAT64 + 6to4 IPv4-embedding forms', () => {
    expect(classifyUnsafeHost('64:ff9b::7f00:1'), 'NAT64→127.0.0.1').toBe('private');
    expect(classifyUnsafeHost('64:ff9b::a9fe:a9fe'), 'NAT64→169.254.169.254').toBe('private');
    expect(classifyUnsafeHost('2002:7f00:1::'), '6to4→127.0.0.1').toBe('private');
  });

  // Adversarial review w0p7zonl7: the IPv4-COMPATIBLE form (::a.b.c.d, RFC4291
  // §2.5.5.1) is the deprecated sibling of ::ffff: mapped — Node canonicalises it
  // WITHOUT the `ffff` hextet (::169.254.169.254 → ::a9fe:a9fe), so it slipped both
  // the ::ffff: prefix check and the BlockList. Must be rejected like its siblings.
  it('blocks IPv4-compatible IPv6 (::a.b.c.d) — the deprecated ::ffff: sibling', () => {
    expect(classifyUnsafeHost('::169.254.169.254'), 'IPv4-compatible→metadata').toBe('private');
    expect(classifyUnsafeHost('::127.0.0.1'), 'IPv4-compatible→loopback').toBe('private');
    expect(classifyUnsafeHost('::10.0.0.1'), 'IPv4-compatible→RFC1918').toBe('private');
    expect(classifyUnsafeHost('::a9fe:a9fe'), 'already-canonical IPv4-compatible→metadata').toBe(
      'private',
    );
  });

  it('does NOT false-positive on public IPv6 / IPv4 / hostnames', () => {
    expect(classifyUnsafeHost('2606:4700:4700::1111')).toBeNull(); // Cloudflare public IPv6
    expect(classifyUnsafeHost('8.8.8.8')).toBeNull(); // public IPv4 (no all-IPv4 quirk)
    expect(classifyUnsafeHost('hooks.example.com')).toBeNull();
  });
});

describe('classifyUnsafeVpnTargets — guards the REAL VPN egress (endpoint/dns/remote), not the display host', () => {
  it('flags a WireGuard endpoint pointing at cloud metadata / RFC1918 / loopback (strips :port)', () => {
    expect(classifyUnsafeVpnTargets({ endpoint: '169.254.169.254:80' })).not.toBeNull();
    expect(classifyUnsafeVpnTargets({ endpoint: '10.0.0.5:51820' })).toBe('private');
    expect(classifyUnsafeVpnTargets({ endpoint: '[::1]:51820' })).not.toBeNull(); // IPv6 loopback
    expect(classifyUnsafeVpnTargets({ endpoint: 'localhost:51820' })).toBe('localhost');
  });
  it('blocks UNBRACKETED IPv6 endpoints — the SSRF bypass the last-colon heuristic missed (fc00::9999→fc00:)', () => {
    // The WG endpoint schema accepts unbracketed IPv6 (and rejects the bracketed form),
    // so these are exactly what a customer can submit. The decimal final hextet must NOT
    // be mistaken for a port + chopped to a non-IP that slips past the guard.
    expect(classifyUnsafeVpnTargets({ endpoint: 'fc00::9999' })).toBe('private'); // ULA
    expect(classifyUnsafeVpnTargets({ endpoint: 'fe80::443' })).toBe('private'); // link-local
    expect(classifyUnsafeVpnTargets({ endpoint: 'fd12:3456:789a::5' })).toBe('private'); // ULA
    expect(classifyUnsafeVpnTargets({ endpoint: '::1' })).not.toBeNull(); // loopback, bare
    // ipv6:port unbracketed — strip the real port, still block the ULA host.
    expect(classifyUnsafeVpnTargets({ endpoint: 'fc00::9999:51820' })).toBe('private');
    // No false-positive: a public IPv6 (with or without a port) still passes.
    expect(classifyUnsafeVpnTargets({ endpoint: '2606:4700::1111' })).toBeNull();
    expect(classifyUnsafeVpnTargets({ endpoint: '2606:4700::1111:51820' })).toBeNull();
  });
  it('flags an unsafe WireGuard dns (incl. a list)', () => {
    expect(classifyUnsafeVpnTargets({ endpoint: 'vpn.example.com:51820', dns: '10.0.0.1' })).toBe(
      'private',
    );
    expect(
      classifyUnsafeVpnTargets({
        endpoint: 'vpn.example.com:51820',
        dns: '1.1.1.1, 169.254.169.254',
      }),
    ).not.toBeNull();
  });
  it('flags an OpenVPN remote directive pointing internal', () => {
    expect(
      classifyUnsafeVpnTargets({ configBlob: 'client\nremote 169.254.169.254 1194\n' }),
    ).not.toBeNull();
    expect(classifyUnsafeVpnTargets({ configBlob: 'client\nremote 192.168.1.1 1194 udp\n' })).toBe(
      'private',
    );
  });
  it('rejects a config_blob with a script-executing directive (P0 RCE 118722821 defense-in-depth)', () => {
    // The exact RCE class: up/down/... runs a program (as root on the egress host).
    expect(
      classifyUnsafeVpnTargets({ configBlob: 'client\nremote vpn.example.com 1194\nup /bin/sh\n' }),
    ).toBe('unsafe-directive');
    expect(classifyUnsafeVpnTargets({ configBlob: '  DOWN\t/tmp/x\n' })).toBe('unsafe-directive');
    expect(classifyUnsafeVpnTargets({ configBlob: 'route-up /x\n' })).toBe('unsafe-directive');
    expect(classifyUnsafeVpnTargets({ configBlob: 'tls-verify /x\n' })).toBe('unsafe-directive');
    // script-security 2/3 is the switch that ENABLES the above → reject; 0/1 safe.
    expect(classifyUnsafeVpnTargets({ configBlob: 'script-security 2\n' })).toBe(
      'unsafe-directive',
    );
    expect(classifyUnsafeVpnTargets({ configBlob: 'script-security 3\n' })).toBe(
      'unsafe-directive',
    );
    expect(classifyUnsafeVpnTargets({ configBlob: 'script-security 1\n' })).toBeNull();
  });
  it('does NOT false-positive on a benign config, comments, or a hostname containing a keyword', () => {
    expect(
      classifyUnsafeVpnTargets({ configBlob: 'client\nremote vpn.example.com 1194\ndev tun\n' }),
    ).toBeNull();
    // A comment (# / ;) mentioning up/down is skipped; `remote up-north...` — the
    // directive keyword is `remote`, not `up`.
    expect(
      classifyUnsafeVpnTargets({
        configBlob: '# up /bin/sh (disabled)\n; down /x\nremote up-north.example.com 1194\n',
      }),
    ).toBeNull();
  });
  it('passes a fully public WireGuard + OpenVPN config', () => {
    expect(
      classifyUnsafeVpnTargets({ endpoint: 'vpn.example.com:51820', dns: '1.1.1.1' }),
    ).toBeNull();
    expect(
      classifyUnsafeVpnTargets({ configBlob: 'client\nremote vpn.example.com 1194\n' }),
    ).toBeNull();
    expect(classifyUnsafeVpnTargets({})).toBeNull();
  });
  it('openvpnRemoteHosts extracts every remote host', () => {
    expect(openvpnRemoteHosts('remote a.example 1194\nremote b.example 443\nfoo')).toEqual([
      'a.example',
      'b.example',
    ]);
  });
  // A `remote`-only guard misses a SECOND, distinct egress vector: OpenVPN's
  // `http-proxy`/`socks-proxy` directives tell the client to route the tunnel
  // connection itself through another host — a customer config with an
  // entirely benign `remote` can still smuggle an internal/metadata target via
  // `http-proxy`/`socks-proxy`, which the old remote-only extraction never saw.
  it('flags a malicious http-proxy directive even when the remote host is benign', () => {
    expect(
      classifyUnsafeVpnTargets({
        configBlob: 'client\nremote vpn.example.com 1194\nhttp-proxy 169.254.169.254 80\n',
      }),
    ).toBe('private');
  });
  it('flags a malicious socks-proxy directive even when the remote host is benign', () => {
    expect(
      classifyUnsafeVpnTargets({
        configBlob: 'client\nremote vpn.example.com 1194\nsocks-proxy 10.0.0.5 1080\n',
      }),
    ).toBe('private');
  });
  it('openvpnProxyHosts extracts every http-proxy / socks-proxy host', () => {
    expect(
      openvpnProxyHosts(
        'http-proxy a.example 8080 auto\nsocks-proxy b.example 1080\nremote c.example 1194\nfoo',
      ),
    ).toEqual(['a.example', 'b.example']);
  });
  it('passes a fully public http-proxy / socks-proxy OpenVPN config (no false positives)', () => {
    expect(
      classifyUnsafeVpnTargets({
        configBlob: 'client\nremote vpn.example.com 1194\nhttp-proxy proxy.example.com 8080\n',
      }),
    ).toBeNull();
  });
});

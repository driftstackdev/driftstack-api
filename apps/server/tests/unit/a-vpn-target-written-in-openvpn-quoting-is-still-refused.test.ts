// A VPN target written in OpenVPN's own quoting is still refused (security sweep #19).
//
// The SSRF screen reads every OpenVPN `remote`, `http-proxy` and `socks-proxy` host
// and refuses loopback, private and metadata literals. It matched the raw line with
// `^(?:--)?remote\s+(\S+)`, so OpenVPN's lexer normalisation walked past it:
//   - a quoted host  (`remote "169.254.169.254" 1194`) reached the classifier WITH
//     its quotes, which is not an IP literal, so it was allowed;
//   - a quoted keyword (`"http-proxy" 127.0.0.1 8080`) did not match at all;
//   - a quote closed against the next token (`remote "10.0.0.5"1194`) did both.
// Measured against the shipped OpenVPN 2.7.0 (`--test-crypto`, no network), each is
// the target the unquoted form names. The same screen split lines on `\r?\n` while
// the directive screen beside it splits on `\r\n|\r|\n`.
//
// The extractors now read each line through the shared OpenVPN lexer
// (`readOpenvpnDirectiveLine` in @driftstack/api-types), as well as the old
// whitespace split, and classify every host either reading names.

import { describe, expect, it } from 'vitest';
import {
  classifyUnsafeVpnTargets,
  openvpnProxyHosts,
  openvpnRemoteHosts,
  unsupportedOpenvpnDirectiveDetail,
} from '../../src/lib/webhook-target-guard.js';

const BASE = 'client\ndev tun\n';

describe('a VPN target written in OpenVPN quoting is still refused', () => {
  it.each([
    ['a double-quoted metadata remote', 'remote "169.254.169.254" 1194'],
    ['a single-quoted metadata remote', "remote '169.254.169.254' 1194"],
    ['a quoted remote keyword', '"remote" 10.0.0.5 1194'],
    ['a quoted --remote keyword with a quoted host', '"--remote" "127.0.0.1" 1194'],
    ['a quoted host closed against its port', 'remote "10.0.0.5"1194'],
    ['a quoted http-proxy keyword', 'remote vpn.example.com 1194\n"http-proxy" 127.0.0.1 8080'],
    [
      'a quoted socks-proxy keyword and host',
      'remote vpn.example.com 1194\n"socks-proxy" "192.168.1.1" 1080',
    ],
    ['a host followed by an escaped space', 'remote 169.254.169.254\\ 1194'],
  ])('CRITICAL %s is refused', (_label, line) => {
    expect(classifyUnsafeVpnTargets({ configBlob: `${BASE}${line}\n` })).not.toBeNull();
  });

  it('CRITICAL a classic-Mac (CR-only) config is read line by line, as the directive screen reads it', () => {
    expect(
      classifyUnsafeVpnTargets({
        configBlob: 'client\rremote vpn.example.com 1194\rhttp-proxy 127.0.0.1 8080\r',
      }),
    ).not.toBeNull();
  });

  it.each([
    ['a metadata remote hidden behind a NUL byte', 'remote 169.254.169.254\u0000 1194'],
    ['a loopback remote hidden behind a NUL byte', 'remote 127.0.0.1\u0000junk'],
    [
      'a loopback socks-proxy hidden behind a NUL byte',
      'remote vpn.example.com 1194\nsocks-proxy 127.0.0.1\u0000',
    ],
  ])('CRITICAL %s is refused (security sweep #19)', (_label, line) => {
    // OpenVPN's line parser is a C string: the token after the NUL is dropped, so
    // the config connects to the address BEFORE it (measured on 2.7.0), while the
    // extractor read past the NUL and handed the SSRF screen a non-IP hostname.
    expect(classifyUnsafeVpnTargets({ configBlob: `${BASE}${line}\n` })).not.toBeNull();
  });

  it('the NUL refusal names the byte, not a script line the customer cannot find', () => {
    const detail = unsupportedOpenvpnDirectiveDetail(`${BASE}remote 127.0.0.1\u0000junk\n`);
    expect(detail).toContain('NUL');
    expect(detail).not.toContain('does not run scripts');
  });

  it('CRITICAL a script/plugin directive smuggled past an early inline-block close is refused (security sweep #19)', () => {
    // `</ca>junk` CLOSES the block in OpenVPN and the next line RUNS. The finder
    // used to keep the block open until an exact `</ca>`, swallowing the `plugin`
    // line so the config passed clean; a prefix close matches OpenVPN.
    // Public `remote` so the ONLY thing that can make this config unsafe is the
    // smuggled `plugin` — before the fix the finder swallowed it and the extractor
    // saw only the public host, so classifyUnsafeVpnTargets returned null (bypass).
    const carrier =
      `${BASE}remote vpn.example.com 1194\n` +
      '<ca>\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n</ca>junk\n' +
      'plugin /tmp/evil.so\n' +
      '<auth-user-pass>\nu\n</ca>\n</auth-user-pass>\n';
    expect(classifyUnsafeVpnTargets({ configBlob: carrier })).toBe('unsafe-directive');
  });

  it('the extractors name the host the lexer reads, beside what the plain split reads', () => {
    expect(openvpnRemoteHosts('remote "169.254.169.254"1194\n')).toContain('169.254.169.254');
    expect(openvpnProxyHosts('"http-proxy" 127.0.0.1 8080\n')).toContain('127.0.0.1');
    // An ordinary line still gives exactly one host.
    expect(openvpnRemoteHosts('remote a.example 1194\n')).toEqual(['a.example']);
  });

  it('POSITIVE CONTROL public targets in quoted form stay allowed', () => {
    expect(
      classifyUnsafeVpnTargets({
        configBlob: `${BASE}"remote" "vpn.example.com" 1194\n"http-proxy" "proxy.example.com" 8080\n`,
      }),
    ).toBeNull();
    expect(classifyUnsafeVpnTargets({ configBlob: `${BASE}remote "8.8.8.8"1194\n` })).toBeNull();
  });
});

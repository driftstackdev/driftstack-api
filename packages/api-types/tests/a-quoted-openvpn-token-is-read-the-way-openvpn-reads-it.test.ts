// A quoted OpenVPN token is read the way OpenVPN reads it (security sweep #19).
//
// OpenVPN's config lexer (options.c parse_line) ends a quoted token at its closing
// quote, whether or not whitespace follows, and strips the quotes; outside single
// quotes a backslash escapes the next character. The screens read lines by
// splitting on whitespace and stripping ENCLOSING quotes from the first token, so a
// quote closed against the next token walked past them. Measured against the
// shipped OpenVPN 2.7.0 (`--test-crypto`, no network):
//   "up"/missing.sh               → Options error: --up script fails with '/missing.sh'
//   remote "192.0.2.12"1194       → remote = '192.0.2.12', remote_port = '1194'
// Both are what the unquoted forms mean, and both read as something else here.
//
// `readOpenvpnDirectiveLine` gives every reading of a line — OpenVPN's lexer AND
// the whitespace split the screens always used — and the security finder refuses
// on any of them, so nothing it refused before is accepted now.

import { describe, expect, it } from 'vitest';
import {
  findUnsupportedOpenvpnLines,
  lowerOpenvpnScriptSecurity,
  readOpenvpnDirectiveLine,
  stripUnsupportedOpenvpnLines,
  tokenizeOpenvpnLine,
} from '../src/openvpn-directives.js';

describe('a quoted OpenVPN token is read the way OpenVPN reads it', () => {
  it('CRITICAL a hook whose quoted keyword is closed against its argument is refused', () => {
    for (const [line, directive] of [
      ['"up"/tmp/hook.sh', 'up'],
      ['"--up"/tmp/hook.sh', 'up'],
      ["'down'/tmp/hook.sh", 'down'],
      ['"plugin"/tmp/evil.so', 'plugin'],
      ['"providers"/tmp/evil.dylib', 'providers'],
    ] as const) {
      const hits = findUnsupportedOpenvpnLines(`client\nremote vpn.example.com 1194\n${line}\n`);
      expect(
        hits.map((h) => h.directive),
        line,
      ).toEqual([directive]);
    }
  });

  it('CRITICAL a quoted script-security level is read as the level it is, and lowered', () => {
    const blob = 'client\nremote vpn.example.com 1194\nscript-security "2"\n';
    expect(findUnsupportedOpenvpnLines(blob).map((h) => h.directive)).toEqual(['script-security']);
    expect(lowerOpenvpnScriptSecurity(blob).config).toBe(
      'client\nremote vpn.example.com 1194\nscript-security 1\n',
    );
  });

  it("the lexer: quotes end a token, backslash escapes outside single quotes, and a comment starts only between tokens — OpenVPN's own reading", () => {
    expect(tokenizeOpenvpnLine('remote "192.0.2.12"1194')).toEqual([
      'remote',
      '192.0.2.12',
      '1194',
    ]);
    expect(tokenizeOpenvpnLine("remote '192.0.2.5' 1194")).toEqual(['remote', '192.0.2.5', '1194']);
    expect(tokenizeOpenvpnLine('remote 192.0.2.6"x" 1194')).toEqual([
      'remote',
      '192.0.2.6"x"',
      '1194',
    ]);
    expect(tokenizeOpenvpnLine('remote "192\\"0.2.17" 1194')).toEqual([
      'remote',
      '192"0.2.17',
      '1194',
    ]);
    expect(tokenizeOpenvpnLine('remote 192.0.2.18\\ x 1194')).toEqual([
      'remote',
      '192.0.2.18 x',
      '1194',
    ]);
    expect(tokenizeOpenvpnLine('remote 192.0.2.14#c 1194')).toEqual([
      'remote',
      '192.0.2.14#c',
      '1194',
    ]);
    expect(tokenizeOpenvpnLine('remote 192.0.2.15 1194 # trailing')).toEqual([
      'remote',
      '192.0.2.15',
      '1194',
    ]);
    expect(tokenizeOpenvpnLine('# a comment')).toEqual([]);
  });

  it('every reading of a line is offered: the lexer and the whitespace split', () => {
    expect(readOpenvpnDirectiveLine('"--Remote" "169.254.169.254"1194')).toEqual(
      expect.arrayContaining([
        { keyword: 'remote', args: ['169.254.169.254', '1194'] },
        { keyword: 'remote', args: ['"169.254.169.254"1194'] },
      ]),
    );
    expect(readOpenvpnDirectiveLine('   ')).toEqual([]);
    expect(readOpenvpnDirectiveLine('; comment')).toEqual([]);
  });

  it('CRITICAL a NUL byte ends the line for OpenVPN, so a line carrying one is refused (security sweep #19)', () => {
    // Measured on 2.7.0 (`--verb 4 --test-crypto`, no network): the token AFTER a
    // NUL is dropped, so `remote 169.254.169.254\0 1194` connects to the metadata
    // IP and `socks-proxy 127.0.0.1\0` proxies through loopback — while the JS
    // lexer and the whitespace split both read past the NUL and hand the SSRF
    // screen a non-IP hostname. The config never needs a NUL, so it is refused.
    for (const [label, blob] of [
      ['metadata remote', 'client\nremote 169.254.169.254\u0000 1194\n'],
      ['loopback remote', 'client\nremote 127.0.0.1\u0000junk\n'],
      [
        'loopback socks-proxy',
        'client\nremote vpn.example.com 1194\nsocks-proxy 127.0.0.1\u0000\n',
      ],
      // `Number('2\0')` is NaN, so a level check alone would miss this one.
      ['raised script-security', 'client\nremote vpn.example.com 1194\nscript-security 2\u0000\n'],
    ] as const) {
      expect(
        findUnsupportedOpenvpnLines(blob).map((h) => h.directive),
        label,
      ).toEqual(['nul-byte']);
    }
    // A NUL has no safe auto-fix: the strip leaves the line, so the paste flow
    // surfaces it as an error the customer must correct rather than rewriting it.
    const nul = 'client\nremote 127.0.0.1\u0000junk\n';
    expect(stripUnsupportedOpenvpnLines(nul).config).toBe(nul);
  });

  it('CRITICAL a directive hidden after an early inline-block close is refused — OpenVPN closes `</ca>` on a prefix, this finder must too (security sweep #19)', () => {
    // Measured on 2.7.0: `</ca>junk`, `</ca> ` and `\t</ca>` all CLOSE the block,
    // and the directive on the next line RUNS. This finder used to require an exact
    // `</ca>` line, so a config could close the block early in OpenVPN's eyes while
    // the cursor read on; a later exact `</ca>` re-closed the cursor's view and
    // swallowed the smuggled `plugin`/`up` line, which passed with zero hits.
    const carrier =
      'client\ndev tun\nremote 192.0.2.1 1194\n' +
      '<ca>\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n</ca>junk\n' +
      'plugin /tmp/evil.so\n' +
      '<auth-user-pass>\nu\n</ca>\n</auth-user-pass>\n';
    expect(findUnsupportedOpenvpnLines(carrier).map((h) => [h.line, h.directive])).toEqual([
      [9, 'plugin'],
    ]);
    // A trailing-space close (`</ca> `) hides an `up` line the same way.
    const trailSpace =
      'client\nremote 192.0.2.1 1194\n' +
      '<ca>\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n</ca> \n' +
      'up /x.sh\n<ca>\nx\n</ca>\n';
    expect(findUnsupportedOpenvpnLines(trailSpace).map((h) => h.directive)).toEqual(['up']);
    // POSITIVE CONTROL: an ordinary cert block (exact `</ca>`) whose PEM body
    // contains a directive word is still certificate data — nothing is reported.
    const clean =
      'client\nremote vpn.example.com 1194\n' +
      '<ca>\n-----BEGIN CERTIFICATE-----\nup /etc/openvpn/up.sh\n-----END CERTIFICATE-----\n</ca>\nverb 3\n';
    expect(findUnsupportedOpenvpnLines(clean)).toEqual([]);
  });

  it('POSITIVE CONTROL an ordinary provider config reports nothing, quoted or not', () => {
    expect(
      findUnsupportedOpenvpnLines(
        'client\n"remote" "vpn.example.com" 1194\nproto udp\nverb 3\nscript-security 1\n',
      ),
    ).toEqual([]);
  });
});

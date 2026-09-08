// T-20 — the shared OpenVPN line finder and stripper.
//
// Both ends of the wire now read this module: the control plane refuses a
// config on what `findUnsupportedOpenvpnLines` reports and names the first
// line in its 400; the desktop client will run the same finder on a paste and
// offer `stripUnsupportedOpenvpnLines` as the one-click fix. The arms below pin
// the two things that make that safe to share — the tokenizer is byte-for-byte
// the server's old one (so nothing the server refused is now accepted), and
// the stripper removes exactly what the finder reports and nothing else.

import { describe, expect, it } from 'vitest';
import {
  DANGEROUS_OPENVPN_DIRECTIVES,
  OPENVPN_INLINE_REQUIRED_DIRECTIVES,
  findUnresolvableOpenvpnFileReferences,
  findUnsupportedOpenvpnLines,
  stripUnsupportedOpenvpnLines,
} from '../src/openvpn-directives.js';

// A commercial provider's client config, minus certificates: the two resolv-conf
// hooks on lines 8-9 are what every Linux-oriented provider ships and what the
// API refuses. Comment + blank lines sit ABOVE them so the numbering arms prove
// skipped lines still count toward the line number the customer sees in an editor.
const PROVIDER = [
  'client',
  'dev tun',
  'proto udp',
  '# resolv-conf hooks',
  '',
  'remote vpn.example.com 1194 udp',
  'resolv-retry infinite',
  'up /etc/openvpn/update-resolv-conf',
  'down /etc/openvpn/update-resolv-conf',
  'verb 3',
  '',
].join('\n');

const CLEAN = 'client\nremote vpn.example.com 1194\ndev tun\nscript-security 1\n';

describe('findUnsupportedOpenvpnLines', () => {
  it('POSITIVE CONTROL a clean config reports nothing. Without this, a finder that flagged every line would satisfy each refusal arm below and look like perfect security.', () => {
    expect(findUnsupportedOpenvpnLines(CLEAN)).toEqual([]);
    expect(findUnsupportedOpenvpnLines('')).toEqual([]);
  });

  it('CRITICAL names each offending line by its 1-based number in the pasted file, with comment and blank lines counted, the keyword lower-cased and the trimmed line text. The number is the whole point — it is what the 400 quotes and what the customer looks for in an editor.', () => {
    expect(findUnsupportedOpenvpnLines(PROVIDER)).toEqual([
      {
        line: 8,
        directive: 'up',
        text: 'up /etc/openvpn/update-resolv-conf',
        reason: '`up` runs an external program',
      },
      {
        line: 9,
        directive: 'down',
        text: 'down /etc/openvpn/update-resolv-conf',
        reason: '`down` runs an external program',
      },
    ]);
  });

  it('CRITICAL CRLF line endings number the same as LF — a file saved on Windows must not shift every line number by one per line.', () => {
    const crlf = PROVIDER.replace(/\n/g, '\r\n');
    expect(findUnsupportedOpenvpnLines(crlf).map((h) => h.line)).toEqual([8, 9]);
    expect(findUnsupportedOpenvpnLines(crlf)[0]?.text).toBe('up /etc/openvpn/update-resolv-conf');
  });

  it('CRITICAL matches the keyword case-insensitively with any leading whitespace — a config blob is customer text, not something normalised on the way in.', () => {
    const hits = findUnsupportedOpenvpnLines('client\n  DOWN\t/tmp/x\n');
    expect(hits).toMatchObject([{ line: 2, directive: 'down', text: 'DOWN\t/tmp/x' }]);
  });

  it('CRITICAL a leading `--` is stripped before matching — OpenVPN honors `--plugin`/`--up`/`--script-security 2`, so they must be flagged (a one-character RCE bypass otherwise).', () => {
    // OpenVPN's bypass_doubledash strips one leading `--` (token len >= 3) from
    // config-file directives, so these run exactly like their bare forms.
    expect(findUnsupportedOpenvpnLines('--plugin /tmp/evil.so\n')).toMatchObject([
      { line: 1, directive: 'plugin', text: '--plugin /tmp/evil.so' },
    ]);
    expect(findUnsupportedOpenvpnLines('  --UP\t/x\n')[0]?.directive).toBe('up');
    expect(findUnsupportedOpenvpnLines('--script-security 2\n')[0]?.directive).toBe(
      'script-security',
    );
    // Vacuity: a `--`-prefixed benign directive is not flagged, and a bare `--`
    // (len 2, which OpenVPN does NOT strip) stays inert.
    expect(findUnsupportedOpenvpnLines('--verb 3\n')).toEqual([]);
    expect(findUnsupportedOpenvpnLines('--\n')).toEqual([]);
  });

  it('CRITICAL every directive in the set is reported, and the set is the fourteen the man page names. Iterated rather than hand-listed so a directive added later is covered the moment it lands.', () => {
    expect(DANGEROUS_OPENVPN_DIRECTIVES.size).toBeGreaterThanOrEqual(14);
    for (const d of ['plugin', 'dns-updown', 'client-crresponse', 'auth-user-pass-verify']) {
      expect(DANGEROUS_OPENVPN_DIRECTIVES.has(d), d).toBe(true);
    }
    for (const d of DANGEROUS_OPENVPN_DIRECTIVES) {
      expect(findUnsupportedOpenvpnLines(`${d} /tmp/payload\n`), d).toMatchObject([
        { line: 1, directive: d },
      ]);
    }
  });

  it('CRITICAL `script-security` 2 and 3 are reported with a reason naming the level; 0, 1 and a bare keyword are not. Level 2 is the switch that lets the directives above run programs — 1 permits only built-ins and the box floors there anyway.', () => {
    expect(findUnsupportedOpenvpnLines('script-security 2\n')).toEqual([
      {
        line: 1,
        directive: 'script-security',
        text: 'script-security 2',
        reason:
          '`script-security 2` allows the config to run external programs (level 2 or higher)',
      },
    ]);
    expect(findUnsupportedOpenvpnLines('script-security 3\n')[0]?.reason).toContain(
      'script-security 3',
    );
    expect(findUnsupportedOpenvpnLines('script-security 1\n')).toEqual([]);
    expect(findUnsupportedOpenvpnLines('script-security 0\n')).toEqual([]);
    expect(findUnsupportedOpenvpnLines('script-security\n')).toEqual([]);
  });

  it('does NOT flag a comment mentioning a directive, nor a hostname that merely contains one — the keyword is the first token, and `#`/`;` lines are skipped.', () => {
    expect(
      findUnsupportedOpenvpnLines(
        '# up /bin/sh (disabled)\n; down /x\nremote up-north.example.com 1194\n',
      ),
    ).toEqual([]);
  });
});

describe('stripUnsupportedOpenvpnLines', () => {
  it('POSITIVE CONTROL a clean config comes back byte-identical with nothing removed. A stripper that rewrote every file would satisfy the removal arms and silently reformat customer pastes.', () => {
    expect(stripUnsupportedOpenvpnLines(CLEAN)).toEqual({ config: CLEAN, removed: [] });
  });

  it('CRITICAL removes exactly the lines the finder reports, keeps every other byte, and reports what it removed — so the client can show the customer the diff it is about to submit.', () => {
    const { config, removed } = stripUnsupportedOpenvpnLines(PROVIDER);
    expect(config).toBe(
      [
        'client',
        'dev tun',
        'proto udp',
        '# resolv-conf hooks',
        '',
        'remote vpn.example.com 1194 udp',
        'resolv-retry infinite',
        'verb 3',
        '',
      ].join('\n'),
    );
    expect(removed).toEqual(findUnsupportedOpenvpnLines(PROVIDER));
  });

  it('CRITICAL lowers `script-security` 2+ to 1 in place, keeping the line and its indentation, rather than deleting it — the customer sees what changed. It is listed in `removed` because the finder reported it.', () => {
    const { config, removed } = stripUnsupportedOpenvpnLines(
      'client\n  script-security 3\nup /x\n',
    );
    expect(config).toBe('client\n  script-security 1\n');
    expect(removed.map((r) => r.directive)).toEqual(['script-security', 'up']);
  });

  it('CRITICAL preserves the customer’s line endings — a CRLF paste stays CRLF, so the file still opens cleanly in the editor it came from.', () => {
    const crlf = 'client\r\nup /x\r\nscript-security 2\r\nverb 3\r\n';
    expect(stripUnsupportedOpenvpnLines(crlf).config).toBe(
      'client\r\nscript-security 1\r\nverb 3\r\n',
    );
  });

  it('CRITICAL is idempotent: the finder reports nothing on the stripped config, so a stripped paste is one the API accepts on the directive check. Without this a client could offer a fix that still gets refused.', () => {
    const once = stripUnsupportedOpenvpnLines(PROVIDER).config;
    expect(findUnsupportedOpenvpnLines(once)).toEqual([]);
    expect(stripUnsupportedOpenvpnLines(once)).toEqual({ config: once, removed: [] });
  });

  it('removes an offending LAST line that has no trailing newline without leaving a dangling ending', () => {
    expect(stripUnsupportedOpenvpnLines('client\nup /x').config).toBe('client\n');
  });
});

// The upload-side mirror of the node's external-file-reference reject (A3
// `8a03a3929`). A config that references ca/cert/key FILES the isolated session
// dir won't contain parses fine and dies late in openvpn as a generic "Options
// error"; caught at upload it names the directive. These arms pin the rule to
// the node's verbatim so upload-reject and parse-reject agree by construction.
const INLINE = [
  'client',
  'remote vpn.example.com 1194 udp',
  'dev tun',
  '<ca>',
  '-----BEGIN CERTIFICATE-----',
  'MIIB...redactedbase64...==',
  '-----END CERTIFICATE-----',
  '</ca>',
  '',
].join('\n');

const FILEREF = [
  'client',
  'remote vpn.example.com 1194',
  'ca ca.crt',
  'cert client.crt',
  'key client.key',
  '',
].join('\n');

describe('findUnresolvableOpenvpnFileReferences', () => {
  it('POSITIVE CONTROL a config with inline cert blocks (and no bare file refs) reports nothing, as does an empty blob. Without this, a finder that flagged everything would pass every reject arm and look like security.', () => {
    expect(findUnresolvableOpenvpnFileReferences(INLINE)).toEqual([]);
    expect(findUnresolvableOpenvpnFileReferences('')).toEqual([]);
  });

  it('CRITICAL flags each ca/cert/key file reference by 1-based line, naming the directive and pointing at the inline block — this is the message the customer reads instead of a late opaque openvpn "Options error".', () => {
    const hits = findUnresolvableOpenvpnFileReferences(FILEREF);
    expect(hits.map((h) => [h.line, h.directive])).toEqual([
      [3, 'ca'],
      [4, 'cert'],
      [5, 'key'],
    ]);
    expect(hits[0]?.text).toBe('ca ca.crt');
    expect(hits[0]?.reason).toContain('<ca>');
    expect(hits[0]?.reason.toLowerCase()).toContain('inline');
  });

  it('CRITICAL inline WINS: a stray `ca ca.crt` line is NOT flagged when an inline <ca> block is also present (openvpn uses the block; the line is inert). Flagging it would reject working configs.', () => {
    const both = `client\nca ca.crt\n<ca>\n-----BEGIN CERTIFICATE-----\nx==\n-----END CERTIFICATE-----\n</ca>\n`;
    expect(findUnresolvableOpenvpnFileReferences(both)).toEqual([]);
  });

  it('CRITICAL CASE-SENSITIVE, matching the node parser (A3 diff): `CA ca.crt` (uppercase directive) is NOT flagged — openvpn rejects that LOUD at startup, a different class from the silent file-not-found we guard; and an uppercase `<CA>` block does NOT satisfy `ca ca.crt`, so the file reference IS still flagged (the accept-something-broken miss the cross-language diff caught).', () => {
    // uppercase keyword → left to openvpn's loud "unrecognized option" reject
    expect(findUnresolvableOpenvpnFileReferences('client\nCA ca.crt\n')).toEqual([]);
    expect(findUnresolvableOpenvpnFileReferences('client\n--CA ca.crt\n')).toEqual([]);
    // uppercase inline block does NOT count as the `ca` block → the lowercase file ref stays flagged
    const upperBlock =
      'client\nca ca.crt\n<CA>\n-----BEGIN CERTIFICATE-----\nx==\n-----END CERTIFICATE-----\n</CA>\n';
    expect(findUnresolvableOpenvpnFileReferences(upperBlock).map((h) => h.directive)).toEqual([
      'ca',
    ]);
  });

  it('CRITICAL does NOT require <ca> unconditionally: a config with no cert material at all (no ca/cert/key line, no block) is NOT flagged. The rule is "no unresolvable reference", not "must contain <ca>" — that genuine error openvpn names better than we would.', () => {
    expect(
      findUnresolvableOpenvpnFileReferences('client\nremote vpn.example.com 1194\ndev tun\n'),
    ).toEqual([]);
  });

  it('CRITICAL CRLF (Windows-authored) file references are still flagged — a CRLF-blind split would let every Windows config bypass silently and read clean, worse than no check.', () => {
    const crlf = FILEREF.replace(/\n/g, '\r\n');
    expect(findUnresolvableOpenvpnFileReferences(crlf).map((h) => h.directive)).toEqual([
      'ca',
      'cert',
      'key',
    ]);
    // the trailing \r must not leak into the reported text
    expect(findUnresolvableOpenvpnFileReferences(crlf)[0]?.text).toBe('ca ca.crt');
  });

  it('CRITICAL bare-CR (\\r-only) line endings still split — proves the split covers \\r, not just \\r\\n/\\n; a \\n-only split would treat the whole file as one line and miss the reference.', () => {
    const cr = FILEREF.replace(/\n/g, '\r');
    expect(findUnresolvableOpenvpnFileReferences(cr).map((h) => h.directive)).toEqual([
      'ca',
      'cert',
      'key',
    ]);
  });

  it('accepts comments, bare directives with no argument, and does not confuse `key-direction` with `key`; honours a leading `--` like OpenVPN (so `--ca ca.crt` is still a reference).', () => {
    expect(findUnresolvableOpenvpnFileReferences('# ca ca.crt\n; cert x.crt\n')).toEqual([]);
    expect(findUnresolvableOpenvpnFileReferences('client\nkey\n')).toEqual([]); // bare, no file arg
    expect(findUnresolvableOpenvpnFileReferences('key-direction 1\n')).toEqual([]); // not `key`
    expect(findUnresolvableOpenvpnFileReferences('--ca ca.crt\n')).toMatchObject([
      { line: 1, directive: 'ca' },
    ]);
  });

  it('tls-auth / tls-crypt with a file argument (and optional direction) are flagged without a block, accepted with one — same rule as ca/cert/key.', () => {
    expect(
      findUnresolvableOpenvpnFileReferences('tls-auth ta.key 1\n').map((h) => h.directive),
    ).toEqual(['tls-auth']);
    expect(
      findUnresolvableOpenvpnFileReferences('tls-crypt tc.key\n<tls-crypt>\nk==\n</tls-crypt>\n'),
    ).toEqual([]);
    // the checked set is exactly the five inline-required directives
    expect([...OPENVPN_INLINE_REQUIRED_DIRECTIVES].sort()).toEqual([
      'ca',
      'cert',
      'key',
      'tls-auth',
      'tls-crypt',
    ]);
  });
});

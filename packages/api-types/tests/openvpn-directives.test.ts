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
  OPENVPN_UNRECOGNISED_DIRECTIVES,
  findUnresolvableOpenvpnFileReferences,
  findUnsupportedOpenvpnLines,
  lowerOpenvpnScriptSecurity,
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

  it('CRITICAL bare-CR (\\r-only) line endings are scanned like any other ending. Measured 2026-09-12 against the shipped code: the split was `/\\r?\\n/`, so a classic-Mac-ended .ovpn was ONE line whose first token is `client` — zero hits, config stored, heal a no-op, `script-security 2` and `up /etc/…` across the wire intact, every gate green. The shape schema saw the SAME blob as multi-line (JS `m` counts a bare \\r as a terminator), so the CP validated one file as multi-line for shape and single-line for security.', () => {
    const cr = PROVIDER.replace(/\n/g, '\r');
    expect(findUnsupportedOpenvpnLines(cr).map((h) => h.line)).toEqual([8, 9]);
    expect(findUnsupportedOpenvpnLines(cr)[0]?.text).toBe('up /etc/openvpn/update-resolv-conf');
    // NEGATIVE CONTROL in the same breath: a CR-ended CLEAN config still reports
    // nothing, so the arm above is about the split and not about a finder that
    // started flagging everything the moment it met a \r.
    expect(findUnsupportedOpenvpnLines(CLEAN.replace(/\n/g, '\r'))).toEqual([]);
  });

  it('CRITICAL ONE stray \\r in an otherwise-LF file is enough. `remote vpn.example.com 1194\\rscript-security 2` was a SINGLE line to the shipped split, so the directive vanished AND every later number shifted — the finder reported `up` on line 4 instead of 5, which is a wrong line in a customer-facing 400. This is the reachable shape: a fully classic-Mac .ovpn is rare, a hand-edited or copy-pasted line ending is not.', () => {
    const mixed = 'client\ndev tun\r\nremote vpn.example.com 1194\rscript-security 2\nup /x\n';
    expect(findUnsupportedOpenvpnLines(mixed).map((h) => [h.line, h.directive])).toEqual([
      [4, 'script-security'],
      [5, 'up'],
    ]);
    // The heal keeps EACH line's own ending — LF, CRLF and bare CR all survive in
    // place, so a mixed-ending file is not silently reformatted on the way out.
    expect(stripUnsupportedOpenvpnLines(mixed).config).toBe(
      'client\ndev tun\r\nremote vpn.example.com 1194\rscript-security 1\n',
    );
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

  it('CRITICAL heals a bare-CR paste and leaves it bare-CR: the script lines go, `script-security` is lowered in place, every \\r survives, and a re-scan is clean. The stripper numbers lines with its OWN split, so it and the finder have to move together — a stripper still splitting `/\\r?\\n/` while the finder sees five lines rewrites a line nobody reported.', () => {
    const cr = 'client\rup /x\rscript-security 2\rverb 3\r';
    const { config, removed } = stripUnsupportedOpenvpnLines(cr);
    expect(config).toBe('client\rscript-security 1\rverb 3\r');
    expect(removed.map((r) => r.directive)).toEqual(['up', 'script-security']);
    expect(findUnsupportedOpenvpnLines(config)).toEqual([]);
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

// V-217 — the NARROW sibling of the stripper, and the difference between them is a
// security boundary, not a convenience. `script-security` only PERMITS scripts; the
// directives that RUN one must still be refused, loudly, naming the line. The
// stripper deletes both classes; this one lowers the permission and deletes nothing.
// It exists because every OpenVPN profile one provider issues carries
// `script-security 2` at line 46, so every upload was a 400 and the only way in was
// hand-editing each download.
const OWNER_PROFILE = [
  'client',
  'dev tun',
  'proto udp',
  'remote vpn.example.com 1194 udp',
  'resolv-retry infinite',
  'nobind',
  'persist-key',
  'persist-tun',
  'script-security 2',
  'remote-cert-tls server',
  'verb 3',
  '',
].join('\n');

// ⛔⛔ V-217 (2026-09-14). Two adversarial reviews of the screen, both measured
// against the shipped openvpn 2.7.0, found the refusal set bypassable and
// incomplete. Neither hole needed the script-security change to be reachable —
// that change only removed the coarse backstop that had been masking them.
// These arms are the regression pins. Each names what an attacker's config
// would have done.
describe('the directive screen cannot be walked past', () => {
  const QUOTED_HOOK = 'client\n"script-security" 2\n"up" /tmp/hook.sh\nverb 3\n';

  it('CRITICAL a QUOTED directive is refused exactly like the bare form. OpenVPN’s config lexer strips surrounding quotes, so `"up" /x.sh` IS `--up /x.sh` — measured: both produce the byte-identical `Options error: --up script fails with …`. The finder matched the raw token, so `"up"` missed the set entirely and the hook was accepted with the level left at 2.', () => {
    const hits = findUnsupportedOpenvpnLines(QUOTED_HOOK);
    expect(hits.map((h) => h.directive)).toEqual(['script-security', 'up']);
  });

  it('CRITICAL single quotes too, and a quoted double-dash form — `--` and quotes nest, so stripping only one of them leaves the other as the bypass', () => {
    expect(
      findUnsupportedOpenvpnLines("client\n'plugin' /tmp/e.so\n").map((h) => h.directive),
    ).toEqual(['plugin']);
    expect(
      findUnsupportedOpenvpnLines('client\n"--up" /tmp/e.sh\n').map((h) => h.directive),
    ).toEqual(['up']);
  });

  it('POSITIVE CONTROL quote-stripping does not invent hits: a quoted token that is NOT a directive stays clean, so the rule cannot start refusing ordinary configs', () => {
    expect(findUnsupportedOpenvpnLines('client\n"remote" vpn.example.com 1194\n')).toEqual([]);
  });

  it('CRITICAL the six code-loading directives that were missing are refused. `providers`, `pkcs11-providers` and `engine` dlopen a shared object whose constructor runs at ANY script-security level — measured executing native code at level 0 and at the default 1 — so the node forcing `--script-security 1` does not cover this class at all.', () => {
    for (const line of [
      'providers /tmp/evil.dylib',
      'pkcs11-providers /tmp/evil.so',
      'engine dynamic',
      'tls-crypt-v2-verify /tmp/verify.sh',
      'iproute /tmp/wrapper.sh',
      'config /tmp/stage-two.ovpn',
    ]) {
      const hits = findUnsupportedOpenvpnLines(`client\n${line}\n`);
      expect(hits, `expected "${line}" to be refused`).toHaveLength(1);
    }
  });

  it('CRITICAL a directive-looking line inside an inline `<ca>` block is NOT reported — it is certificate data, openvpn never reads a directive there, and reporting it made the rewriters overwrite the customer’s certificate bytes', () => {
    const withCert = [
      'client',
      '<ca>',
      '-----BEGIN CERTIFICATE-----',
      'up /etc/openvpn/up.sh',
      '-----END CERTIFICATE-----',
      '</ca>',
      'verb 3',
      '',
    ].join('\n');
    expect(findUnsupportedOpenvpnLines(withCert)).toEqual([]);
    expect(stripUnsupportedOpenvpnLines(withCert)).toEqual({ config: withCert, removed: [] });
  });

  it('CRITICAL but a `<connection>` block IS scanned — unlike a PEM block it holds real directives that openvpn parses, so skipping it would turn it into a hiding place for the very thing this finder catches', () => {
    const inConnection =
      'client\n<connection>\nremote vpn.example.com 1194\nup /tmp/e.sh\n</connection>\n';
    expect(findUnsupportedOpenvpnLines(inConnection).map((h) => h.directive)).toEqual(['up']);
  });

  it('a block that is never closed is refused by line, because OpenVPN refuses the whole config for it ("ERROR: Endtag </ca> missing", measured) — so it cannot hide a live directive, but it CAN leave the customer with a session that silently never starts', () => {
    const unterminated = 'client\n<ca>\n-----BEGIN CERTIFICATE-----\nAAAA\n';
    const hits = findUnsupportedOpenvpnLines(unterminated);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.reason).toContain('never closed');
  });

  it('CRITICAL and the auto-fix must NOT "repair" an unterminated block by deleting the tag that opened it — that would strip `<ca>` and hand back a config missing its certificate, worse than the paste', () => {
    const unterminated = 'client\n<ca>\n-----BEGIN CERTIFICATE-----\nAAAA\n';
    expect(stripUnsupportedOpenvpnLines(unterminated).config).toBe(unterminated);
  });
});

describe('lowerOpenvpnScriptSecurity', () => {
  it('CRITICAL the owner’s case: a profile whose ONLY fault is `script-security 2` comes back with that line reading 1, every other byte untouched, and the finder clean — so the API accepts it unedited.', () => {
    const { config, lowered } = lowerOpenvpnScriptSecurity(OWNER_PROFILE);
    expect(lowered).toBe(true);
    expect(config).toBe(OWNER_PROFILE.replace('script-security 2', 'script-security 1'));
    expect(findUnsupportedOpenvpnLines(config)).toEqual([]);
  });

  it('SECURITY BOUNDARY it does NOT remove script directives: a blob carrying both `script-security 2` and `up` keeps the `up` line verbatim, and the finder STILL reports it, so the config is still refused. This is the whole difference from stripUnsupportedOpenvpnLines — a version that called the stripper would pass every other arm here.', () => {
    const blob = 'client\nscript-security 2\nup /etc/openvpn/update-resolv-conf\nverb 3\n';
    const { config } = lowerOpenvpnScriptSecurity(blob);
    expect(config).toContain('up /etc/openvpn/update-resolv-conf');
    expect(config).toBe('client\nscript-security 1\nup /etc/openvpn/update-resolv-conf\nverb 3\n');
    expect(findUnsupportedOpenvpnLines(config).map((h) => h.directive)).toEqual(['up']);
  });

  it('POSITIVE CONTROL a config with no `script-security` line comes back byte-identical and NOT lowered. A rewriter that reformatted every paste would satisfy the arms above.', () => {
    expect(lowerOpenvpnScriptSecurity(PROVIDER)).toEqual({ config: PROVIDER, lowered: false });
  });

  it('a config already at `script-security 1` is not reported by the finder, so it is untouched and not lowered', () => {
    expect(lowerOpenvpnScriptSecurity(CLEAN)).toEqual({ config: CLEAN, lowered: false });
  });

  it('CRITICAL preserves indentation and the customer’s line endings: an indented directive in a CRLF paste keeps both, so the file still opens cleanly in the editor it came from.', () => {
    const crlf = 'client\r\n  script-security 3\r\nverb 3\r\n';
    expect(lowerOpenvpnScriptSecurity(crlf).config).toBe(
      'client\r\n  script-security 1\r\nverb 3\r\n',
    );
  });

  it('CRITICAL heals a bare-CR paste and leaves it bare-CR — this helper numbers lines with its OWN split, so it and the finder must move together; one splitting `/\\r?\\n/` while the finder sees four lines rewrites a line nobody reported.', () => {
    const cr = 'client\rscript-security 2\rverb 3\r';
    expect(lowerOpenvpnScriptSecurity(cr).config).toBe('client\rscript-security 1\rverb 3\r');
  });

  it('CRITICAL is idempotent: lowering twice changes nothing the second time, and the finder is clean — so the value we store is the value we would store again.', () => {
    const once = lowerOpenvpnScriptSecurity(OWNER_PROFILE).config;
    expect(lowerOpenvpnScriptSecurity(once)).toEqual({ config: once, lowered: false });
    expect(findUnsupportedOpenvpnLines(once)).toEqual([]);
  });

  it('SECURITY a QUOTED `"script-security" 2` is lowered like the bare form. Before V-217 the finder read the keyword as `"script-security"`, reported nothing, and this helper left the raised level standing — next to a quoted `"up"` hook the finder also missed.', () => {
    const { config, lowered } = lowerOpenvpnScriptSecurity('client\n"script-security" 2\nverb 3\n');
    expect(lowered).toBe(true);
    expect(config).toBe('client\nscript-security 1\nverb 3\n');
  });

  it('SECURITY does NOT touch bytes inside an inline `<ca>` block: a directive-looking line in certificate material is data, and rewriting it would corrupt the customer’s certificate — a tunnel that can never come up, produced by the repair path itself.', () => {
    const withCert = [
      'client',
      'remote vpn.example.com 1194',
      '<ca>',
      '-----BEGIN CERTIFICATE-----',
      'script-security 2',
      'up /etc/openvpn/up.sh',
      '-----END CERTIFICATE-----',
      '</ca>',
      '',
    ].join('\n');
    expect(lowerOpenvpnScriptSecurity(withCert)).toEqual({ config: withCert, lowered: false });
  });

  it('rewrites EVERY offending line, not just the first — a config that sets the level twice must not come back still carrying one of them.', () => {
    const twice = 'client\nscript-security 2\nverb 3\nscript-security 3\n';
    expect(lowerOpenvpnScriptSecurity(twice).config).toBe(
      'client\nscript-security 1\nverb 3\nscript-security 1\n',
    );
    expect(findUnsupportedOpenvpnLines(lowerOpenvpnScriptSecurity(twice).config)).toEqual([]);
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

// ⛔ THE DIFFERENTIAL. These two finders are the control plane's only readers of a
// customer .ovpn, and they held DIFFERENT ideas of what a line is: the security
// finder split `/\r?\n/`, the file-reference finder `/\r\n|\r|\n/`. The blind one
// was the SECURITY half. Neither function's own arms could see that — each was
// self-consistent, and the file-reference side even carried a bare-CR arm of its
// own, which read as corroboration that the module handled CR. Measured
// 2026-09-12 on the shipped build: a stored blob with `script-security 2` and
// `up /etc/openvpn/update-resolv-conf` under classic-Mac endings passed ingress,
// stored, healed to nothing, and reached the node with both lines intact, while
// `OpenVpnProxyConfigSchema`'s `client`/`remote` refines saw the same bytes as
// multi-line. This block fails in BOTH directions: make either split narrower and
// the equality arm goes red; make either finder flag everything and the vacuity
// control's fixture stops matching its expected line numbers.
describe('the two finders agree on what a line is', () => {
  const MIXED = [
    'client',
    'remote vpn.example.com 1194',
    'ca ca.crt',
    'script-security 2',
    'up /etc/openvpn/update-resolv-conf',
    '',
  ].join('\n');

  const ENDINGS: ReadonlyArray<readonly [string, string]> = [
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['bare CR', '\r'],
  ];

  it('CRITICAL both finders report the same directives on the same line numbers for LF, CRLF and bare CR. A split covering one ending and not another is invisible to a suite that only ever feeds it that ending.', () => {
    for (const [name, sep] of ENDINGS) {
      const blob = MIXED.replace(/\n/g, sep);
      expect(
        findUnsupportedOpenvpnLines(blob).map((h) => [h.line, h.directive]),
        name,
      ).toEqual([
        [4, 'script-security'],
        [5, 'up'],
      ]);
      expect(
        findUnresolvableOpenvpnFileReferences(blob).map((h) => [h.line, h.directive]),
        name,
      ).toEqual([[3, 'ca']]);
    }
  });

  it('VACUITY CONTROL the fixture really does carry both classes under every ending, so the equality arm above cannot pass by finding nothing on both sides. Reporting [] is exactly how the CR gap read green for as long as it did — two agreeing zeroes look like agreement.', () => {
    for (const [name, sep] of ENDINGS) {
      const blob = MIXED.replace(/\n/g, sep);
      expect(findUnsupportedOpenvpnLines(blob).length, name).toBeGreaterThan(0);
      expect(findUnresolvableOpenvpnFileReferences(blob).length, name).toBeGreaterThan(0);
    }
  });

  it('CRITICAL the stripper numbers lines the way the finder does under every ending: it removes exactly what was reported, the blob keeps its own endings byte-for-byte, and a re-scan is clean.', () => {
    for (const [name, sep] of ENDINGS) {
      const blob = MIXED.replace(/\n/g, sep);
      const { config, removed } = stripUnsupportedOpenvpnLines(blob);
      expect(removed, name).toEqual(findUnsupportedOpenvpnLines(blob));
      expect(findUnsupportedOpenvpnLines(config), name).toEqual([]);
      expect(config, name).toBe(
        ['client', 'remote vpn.example.com 1194', 'ca ca.crt', 'script-security 1', ''].join(sep),
      );
    }
  });
});

/* The owner, twice: "session not starting still". Root-caused on the egress
 * node 2026-09-14 — openvpn 2.7.0 spawns, parses the stored config, and
 * rejects it on its own merits with `Options error: Unrecognized option or
 * missing or extra parameter(s)`. The config had passed every check here,
 * because every check here was about what a directive would DO (run a program,
 * read a file) and this one is about whether OpenVPN knows the word at all.
 *
 * ⛔ THE SET IS MEASURED AND THE MEASUREMENT IS THE GUARD. Each member below
 * was fed to the same OpenVPN the egress runs (2.7.0) as a one-line config;
 * only the ones that answered "Unrecognized option" are in the set. Three
 * directives offered as members — ns-cert-type, max-routes, comp-noadapt — are
 * ACCEPTED by 2.7.0, and the negative arm keeps them out: refusing a config
 * that works is the worse failure, because the customer cannot even see why.
 */
describe('a directive OpenVPN cannot parse is refused at entry, not at launch', () => {
  it('every measured-unrecognised directive is found, with a reason that says which kind', () => {
    for (const [directive, why] of OPENVPN_UNRECOGNISED_DIRECTIVES) {
      const hits = findUnsupportedOpenvpnLines(
        `client\n${directive} 256\nremote a.example.com 1194\n`,
      );
      const hit = hits.find((h) => h.directive === directive);
      expect(hit, `${directive} is in the set and the finder walked past it`).toBeDefined();
      expect(hit?.line).toBe(2);
      // The sentence names the directive, why it fails, and WHEN it would fail.
      expect(hit?.reason).toContain(directive);
      expect(hit?.reason).toContain(why);
      expect(hit?.reason).toMatch(/when the session starts/);
      // Removed and Windows-only are told apart, because the fix differs.
      expect(why).toMatch(/^(removed from OpenVPN|Windows-only)/);
    }
  });

  it('CONTROL — directives 2.7.0 ACCEPTS are not refused, including three that were offered as members', () => {
    // Measured accepted on 2.7.0: openvpn answered something other than
    // "Unrecognized option" for each. A guard that refused these would break
    // working configs, and the customer would have no way to tell it was us.
    for (const directive of [
      'ns-cert-type',
      'max-routes',
      'comp-noadapt',
      'comp-lzo',
      'cipher',
      'client-cert-not-required',
      'compat-names',
      'prng',
      'tun-ipv6',
      'verb',
    ]) {
      expect(
        OPENVPN_UNRECOGNISED_DIRECTIVES.has(directive),
        `${directive} is ACCEPTED by openvpn 2.7.0 — refusing it breaks a working config`,
      ).toBe(false);
      const hits = findUnsupportedOpenvpnLines(`client\n${directive} 2\n`);
      expect(hits.map((h) => h.directive)).not.toContain(directive);
    }
  });

  it('the one-click fix removes them too, and leaves the rest of the config alone', () => {
    const blob = 'client\nkeysize 256\nremote a.example.com 1194\nblock-outside-dns\nverb 3\n';
    const { config, removed } = stripUnsupportedOpenvpnLines(blob);
    expect(removed.map((r) => r.directive)).toEqual(['keysize', 'block-outside-dns']);
    expect(config).toContain('remote a.example.com 1194');
    expect(config).toContain('verb 3');
    expect(config).not.toContain('keysize');
    expect(config).not.toContain('block-outside-dns');
  });

  it('the `--` form is caught, exactly as the security directives are', () => {
    // OpenVPN strips a leading `--` from config-file directives, so `--keysize`
    // fails at bring-up identically. A set matched on the bare form only would
    // be a one-character bypass of the entry check.
    const hits = findUnsupportedOpenvpnLines('client\n--keysize 256\n');
    expect(hits.map((h) => h.directive)).toContain('keysize');
  });
});

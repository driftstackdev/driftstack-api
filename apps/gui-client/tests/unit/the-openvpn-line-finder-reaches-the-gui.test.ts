// T-20 — the shared OpenVPN line finder is reachable from the desktop client.
//
// The finder lives in @driftstack/api-types, which this app does not depend on
// directly; it reaches api-types symbols the way it always has — through the
// @driftstack/sdk barrel (CANONICAL_MODIFIER_NAMES, ARCHETYPE_REGISTRY and
// TIER_STORAGE_BYTES_CAP all arrive that way). This file imports through that
// SAME path, so a dropped re-export fails here rather than in the pre-submit
// check the proxy form will build on it — and the list the client will warn
// against is provably the list the server refuses against, because there is
// only one.

import { describe, expect, it } from 'vitest';
import {
  DANGEROUS_OPENVPN_DIRECTIVES,
  findUnsupportedOpenvpnLines,
  stripUnsupportedOpenvpnLines,
} from '@driftstack/sdk';
import { openvpnAutoStrip } from '../../src/lib/openvpn-refusal';

const PROVIDER = [
  'client',
  'dev tun',
  '# resolv-conf hooks',
  'remote vpn.example.com 1194 udp',
  'up /etc/openvpn/update-resolv-conf',
  'verb 3',
  '',
].join('\n');

describe('T-20 the OpenVPN line finder reaches the desktop client through @driftstack/sdk', () => {
  it('CONTROL a clean paste reports nothing and comes back untouched — without this, a finder that flagged everything would satisfy the arm below.', () => {
    const clean = 'client\nremote vpn.example.com 1194\ndev tun\n';
    expect(findUnsupportedOpenvpnLines(clean)).toEqual([]);
    expect(stripUnsupportedOpenvpnLines(clean)).toEqual({ config: clean, removed: [] });
  });

  it('CRITICAL the finder names the line a provider .ovpn is refused for, and the stripper removes exactly it. This is the check the proxy form will run before sending, against the same list the server enforces.', () => {
    expect(findUnsupportedOpenvpnLines(PROVIDER)).toMatchObject([
      { line: 5, directive: 'up', text: 'up /etc/openvpn/update-resolv-conf' },
    ]);
    const { config, removed } = stripUnsupportedOpenvpnLines(PROVIDER);
    expect(config).toBe(PROVIDER.replace('up /etc/openvpn/update-resolv-conf\n', ''));
    expect(removed).toHaveLength(1);
    expect(findUnsupportedOpenvpnLines(config)).toEqual([]);
  });

  it('CRITICAL the set the client reads is the enforced one — populated, and holding the resolv-conf hook directives that trip a provider file.', () => {
    expect(DANGEROUS_OPENVPN_DIRECTIVES.size).toBeGreaterThanOrEqual(14);
    expect(DANGEROUS_OPENVPN_DIRECTIVES.has('up')).toBe(true);
    expect(DANGEROUS_OPENVPN_DIRECTIVES.has('down')).toBe(true);
  });
});

/* The harness side root-caused the owner's "session not starting still" on the egress node
 * 2026-09-14: openvpn 2.7.0 parses the stored config and rejects it outright
 * over a directive it no longer knows (`keysize`). The shared finder now
 * refuses that class at entry, which means the AUTO-STRIP note has to describe
 * it — and the note it inherited said the opposite of the truth twice.
 *
 * It counted anything that was not `script-security` as a "script directive"
 * and closed with "this changes nothing about how the VPN connects". For an
 * unparseable directive both halves are false: it is not a script, and removing
 * it is exactly the difference between a session that starts and one that does
 * not. A customer reads that sentence while watching their VPN fail. */
describe('the auto-strip note tells the truth about WHICH class it removed', () => {
  it('an unparseable directive is never called a script directive, and the tail does not claim it changes nothing', () => {
    const note = openvpnAutoStrip(
      'openvpn',
      'client\nkeysize 256\nremote a.example.com 1194\n',
    )?.note;
    expect(note).toBeDefined();
    expect(note).toContain('keysize');
    expect(note).toMatch(/OpenVPN no longer accepts/);
    expect(note, 'keysize is not a script directive').not.toMatch(/script directive/);
    expect(note, 'removing it is precisely what lets the session start').not.toMatch(
      /changes nothing about how the VPN connects/,
    );
    expect(note).toMatch(/could not have started/);
  });

  it('a script-only config keeps the reassurance it earned — the two tails are not merged', () => {
    const note = openvpnAutoStrip(
      'openvpn',
      'client\nscript-security 2\nup /etc/openvpn/up.sh\nremote a.example.com 1194\n',
    )?.note;
    expect(note).toBeDefined();
    expect(note).toMatch(/lowered script-security to 1/);
    expect(note).toMatch(/script directive/);
    expect(note).toMatch(/changes nothing about how the VPN connects/);
    expect(note).not.toMatch(/OpenVPN no longer accepts/);
  });

  it('a config with BOTH says both, and claims the inert reassurance only for the scripts', () => {
    const note = openvpnAutoStrip(
      'openvpn',
      'client\nscript-security 2\nup /etc/openvpn/up.sh\nkeysize 256\nremote a.example.com 1194\n',
    )?.note;
    expect(note).toBeDefined();
    expect(note).toMatch(/script directive/);
    expect(note).toMatch(/OpenVPN no longer accepts/);
    expect(note).toMatch(/inert here anyway/);
    expect(note).toMatch(/stopped the session from starting/);
    // The blanket claim must not appear when something non-inert was removed.
    expect(note).not.toMatch(/changes nothing about how the VPN connects/);
  });
});

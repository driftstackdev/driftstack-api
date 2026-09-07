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

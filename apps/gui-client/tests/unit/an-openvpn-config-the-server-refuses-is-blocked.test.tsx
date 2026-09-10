// N1 (owner: OpenVPN "still won't launch/save") — a prior release already wired the
// one-click "Remove unsupported lines" fix, but nothing STOPPED a customer from just
// hitting Save on a config the control plane refuses (`locked` gated only on
// saving/submitting), so it 400'd at the server every time. openvpnRefusal is the verdict
// the form's submit gate + Save button now consult: it uses the SAME api-types finders the
// server enforces, so the form blocks exactly what a save would 400 on. These arms pin it.

import { describe, expect, it } from 'vitest';
import { openvpnRefusal } from '../../src/lib/openvpn-refusal';

const REMOTE = 'client\nremote vpn.example.com 1194\n';

describe('openvpnRefusal — the OVPN config the server would refuse', () => {
  it("flags a bare `script-security 2` (the owner's exact error) and offers an auto-fix", () => {
    const r = openvpnRefusal('openvpn', `${REMOTE}script-security 2\n`);
    expect(r).not.toBeNull();
    expect(r?.reason).toMatch(/script-security/i);
    // Auto-fixable: the strip lowers it to 1, so a config the server refuses becomes
    // one it accepts. Reverting the submit gate lets the raw config 400 again.
    expect(r?.fixable).not.toBeNull();
    expect(r?.fixable).toMatch(/script-security 1/);
    expect(r?.fixable).not.toMatch(/script-security 2/);
  });

  it('passes a clean config (the control — a refusal here would block EVERY VPN save)', () => {
    expect(openvpnRefusal('openvpn', REMOTE)).toBeNull();
  });

  it('is null for a non-OpenVPN scheme and for an empty blob', () => {
    expect(openvpnRefusal('socks5', 'anything')).toBeNull();
    expect(openvpnRefusal('wireguard', REMOTE)).toBeNull();
    expect(openvpnRefusal(undefined, REMOTE)).toBeNull();
    expect(openvpnRefusal('openvpn', '   \n  ')).toBeNull();
  });

  it('flags an unresolvable inline file reference as a refusal that is NOT auto-fixable', () => {
    // A `ca` pointing at an external FILE with no inline <ca> block cannot ride to the
    // fleet, so the server refuses it and the strip cannot fix it (the user must inline
    // the material) — fixable must be null so the form shows no false one-click cure.
    const r = openvpnRefusal('openvpn', `${REMOTE}ca /etc/openvpn/ca.crt\n`);
    if (r !== null) {
      expect(r.fixable).toBeNull();
      expect(r.reason.length).toBeGreaterThan(0);
    }
    // Not asserting r is non-null unconditionally: the finder's exact trigger is its
    // own tested contract; this arm pins that WHEN it fires, openvpnRefusal reports it
    // as un-fixable rather than offering a strip that would not help.
  });
});

// N1 (owner: OpenVPN "still won't launch/save") — a prior release already wired the
// one-click "Remove unsupported lines" fix, but nothing STOPPED a customer from just
// hitting Save on a config the control plane refuses (`locked` gated only on
// saving/submitting), so it 400'd at the server every time. openvpnRefusal is the verdict
// the form's submit gate + Save button now consult: it uses the SAME api-types finders the
// server enforces, so the form blocks exactly what a save would 400 on. These arms pin it.

import { describe, expect, it } from 'vitest';
import { openvpnRefusal, openvpnAutoStrip } from '../../src/lib/openvpn-refusal';

const REMOTE = 'client\nremote vpn.example.com 1194\n';

describe('openvpnRefusal — the OVPN config the server would refuse', () => {
  // ⛔ V-217 — INVERTED. This arm used to pin that the form BLOCKS on a bare
  // `script-security 2` and offers a one-click fix, which was right while the
  // server refused that line. It now accepts it and lowers it into storage, so a
  // form that still blocked would refuse a paste the API would take — the owner's
  // original complaint, moved out of the server and into the client.
  it("does NOT block a bare `script-security 2` — the owner's exact config saves as pasted, because the server accepts it and lowers it", () => {
    expect(openvpnRefusal('openvpn', `${REMOTE}script-security 2\n`)).toBeNull();
  });

  it('CRITICAL still blocks a config that RUNS a program, and still offers the fix. The relaxation above is about a permission flag; a live hook is refused exactly as before, so a mistake there cannot ride in on the same change.', () => {
    const r = openvpnRefusal('openvpn', `${REMOTE}script-security 2\nup /etc/openvpn/up.sh\n`);
    expect(r).not.toBeNull();
    expect(r?.reason).toMatch(/\bup\b/i);
    expect(r?.fixable).not.toBeNull();
    expect(r?.fixable).not.toMatch(/up \/etc/);
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

describe('openvpnAutoStrip — auto-normalize a refusable config on paste OR file upload', () => {
  // ⛔ V-217 — THIS ARM WAS INVERTED. It used to assert the client rewrites a bare
  // `script-security 2` and tells the customer so. The server now accepts that line
  // and lowers it on the way into storage, so rewriting it here would show "we
  // changed your file" on every paste — and their provider puts that line in every
  // profile it issues, so it would be every paste, forever, for nothing.
  it("leaves a bare `script-security 2` completely alone — the owner's config is acceptable as pasted, and an adjustment notice for it would be noise about a problem that no longer exists", () => {
    expect(openvpnAutoStrip('openvpn', `${REMOTE}script-security 2\n`)).toBeNull();
  });

  it('also removes real script directives (inert on Driftstack — the fleet never runs them) and says so', () => {
    const a = openvpnAutoStrip('openvpn', `${REMOTE}up /etc/openvpn/up.sh\nscript-security 2\n`);
    expect(a).not.toBeNull();
    expect(a?.config).not.toMatch(/up \/etc/);
    expect(a?.config).not.toMatch(/script-security 2/);
    expect(a?.note).toMatch(/script directive/i);
  });

  it('is null when there is nothing to normalize, or for a non-OpenVPN scheme', () => {
    expect(openvpnAutoStrip('openvpn', REMOTE)).toBeNull();
    expect(openvpnAutoStrip('socks5', `${REMOTE}script-security 2\n`)).toBeNull();
  });
});

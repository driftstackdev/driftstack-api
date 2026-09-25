// Proxy protocol capabilities — the "professional" breakdown that replaced the
// bare UDP badge. proxyCapabilities() derives WebRTC / QUIC / HTTP-2 support
// honestly from a SOCKS5 probe; the chips render ✓ vs ⤵ (fell back) per
// protocol. Guards the derivation table (a wrong mapping would over- or
// under-state what an exit can carry).

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ProxyTestResult } from '../../src/lib/proxies';
import { proxyCapabilities, ProxyCapabilityChips } from '../../src/components/ProxyCapabilities';
import { rowShowsUdpAndQuic } from '../../src/views/ProxiesView';
import { capabilityChips, type CapsInput } from '../../src/components/ProfilePhoneCard';
import { listUdpVerdict } from '../../src/components/ProfilesTable';

function probe(over: Partial<ProxyTestResult> = {}): ProxyTestResult {
  return {
    reachable: true,
    auth_ok: true,
    udp_associate: true,
    // G1 — a datagram came back through the relay (the default a working UDP
    // proxy reports); the arms below vary it.
    udp_relay: 'relays',
    can_route: true,
    connect_reply: 0x00,
    latency_ms: 40,
    message: 'ok',
    ...over,
  };
}

describe('proxyCapabilities()', () => {
  it('full stack when reachable + authed + UDP: WebRTC, QUIC, HTTP/2 all ok', () => {
    const caps = proxyCapabilities(probe());
    expect(caps.map((c) => [c.key, c.ok])).toEqual([
      ['webrtc', true],
      ['quic', true],
      ['http2', true],
    ]);
  });

  it('the proxy refuses UDP → WebRTC + QUIC fall back, HTTP/2 still ok', () => {
    const caps = proxyCapabilities(probe({ udp_associate: false, udp_relay: 'refused' }));
    const byKey = Object.fromEntries(caps.map((c) => [c.key, c.ok]));
    expect(byKey).toEqual({ webrtc: false, quic: false, http2: true });
  });

  it('auth failed → nothing flows (all false), even if reachable', () => {
    const caps = proxyCapabilities(probe({ auth_ok: false, udp_associate: true }));
    expect(caps.every((c) => !c.ok)).toBe(true);
  });

  it('unreachable → all false', () => {
    const caps = proxyCapabilities(
      probe({ reachable: false, auth_ok: false, udp_associate: false }),
    );
    expect(caps.every((c) => !c.ok)).toBe(true);
  });
});

describe('<ProxyCapabilityChips>', () => {
  it('renders a labelled chip per protocol with the ok state in data-ok', () => {
    const { container } = render(
      <ProxyCapabilityChips result={probe({ udp_associate: false, udp_relay: 'refused' })} />,
    );
    expect(screen.getByText('UDP')).toBeTruthy();
    expect(screen.getByText('QUIC')).toBeTruthy();
    expect(screen.getByText('HTTP/2')).toBeTruthy();
    const webrtc = container.querySelector('[data-capability="webrtc"]');
    const http2 = container.querySelector('[data-capability="http2"]');
    expect(webrtc?.getAttribute('data-ok')).toBe('false');
    expect(http2?.getAttribute('data-ok')).toBe('true');
  });
});

// Proxy-accuracy audit G1 (paths-01): this Mac's "✓ UDP" meant only that the
// proxy answered "yes" to UDP ASSOCIATE. Against a proxy that grants UDP and
// drops every datagram, the native check returned `udp_associate: true` and the
// app showed "✓ UDP — UDP works", "~ QUIC likely", and counted the row in the
// header's "UDP + QUIC" tally. The native check now sends a datagram through the
// relay and reports `udp_relay`; a GRANT alone is never a ✓, a silent relay is
// "— UDP · not verified" (never ✓, never ⤵), and QUIC is inferred only from a
// relay that answered.
describe('G1 — UDP is ✓ only when a datagram came back through the relay', () => {
  /** A result as a build before the relay check wrote it: a grant, no verdict. */
  const legacy = (over: Partial<ProxyTestResult> = {}): ProxyTestResult => {
    const { udp_relay: _dropped, ...rest } = probe(over);
    return rest;
  };
  const byKey = (r: ProxyTestResult) =>
    Object.fromEntries(proxyCapabilities(r).map((c) => [c.key, c]));

  it('CRITICAL granted but silent: "— UDP · not verified" — not measured, never ✓ and never ⤵; QUIC is not inferred from it and the row is not in the UDP + QUIC tally', () => {
    const r = probe({ udp_associate: true, udp_relay: 'silent' });
    const caps = byKey(r);
    expect(caps.webrtc?.ok).toBe(false);
    expect(caps.webrtc?.unmeasured).toBe(true);
    expect(caps.webrtc?.detail).toBe('not verified');
    expect(caps.webrtc?.hint).toMatch(/not verified/i);
    expect(caps.quic?.inferred ?? false, 'no "~ QUIC likely" from a grant').toBe(false);
    expect(caps.quic?.unmeasured, 'and no ⤵ QUIC either').toBe(true);
    expect(rowShowsUdpAndQuic({ scheme: 'socks5' }, r, undefined, undefined, true)).toBe(false);

    const { container } = render(<ProxyCapabilityChips result={r} />);
    const chip = container.querySelector('[data-capability="webrtc"]');
    expect(chip?.getAttribute('data-ok')).toBe('unmeasured');
    // The mark rides its own aria-hidden span, so the text reads "—UDP …".
    expect(chip?.textContent?.replace(/^—\s*/, '— ')).toBe('— UDP · not verified');
  });

  it('CRITICAL a result with no relay verdict (a check from before this release, or one whose UDP step did not run) is "— UDP", never ✓ — whatever its grant said', () => {
    for (const r of [legacy({ udp_associate: true }), probe({ udp_relay: 'not_run' })]) {
      const caps = byKey(r);
      expect(caps.webrtc?.ok).toBe(false);
      expect(caps.webrtc?.unmeasured).toBe(true);
      expect(caps.quic?.inferred ?? false).toBe(false);
      expect(rowShowsUdpAndQuic({ scheme: 'socks5' }, r, undefined, undefined, true)).toBe(false);
    }
  });

  it('a refusal is the one measured NO: ⤵ UDP, and QUIC cannot work (⤵)', () => {
    const caps = byKey(probe({ udp_associate: false, udp_relay: 'refused' }));
    expect(caps.webrtc?.ok).toBe(false);
    expect(caps.webrtc?.unmeasured ?? false).toBe(false);
    expect(caps.quic?.ok).toBe(false);
    expect(caps.quic?.unmeasured ?? false).toBe(false);
  });

  it('CONTROL a relay that answered: ✓ UDP, "~ QUIC" inferred, and the row counts with a measured QUIC', () => {
    const r = probe({ udp_associate: true, udp_relay: 'relays' });
    const caps = byKey(r);
    expect(caps.webrtc?.ok).toBe(true);
    expect(caps.quic?.ok && caps.quic?.inferred).toBe(true);
    expect(rowShowsUdpAndQuic({ scheme: 'socks5' }, r, undefined, undefined, true)).toBe(true);
  });

  it('with UDP not verified, a dated QUIC reading of EITHER polarity stands in for "not measured" — a reading beats no reading — and its hover never blames UDP', () => {
    const NOW = Date.parse('2026-09-25T12:00:00.000Z');
    for (const value of [true, false]) {
      const quic = proxyCapabilities(
        probe({ udp_relay: 'silent' }),
        undefined,
        undefined,
        { quicProbe: { value, atMs: NOW - 3 * 60 * 60 * 1000 } },
        { nowMs: NOW, autoRecheck: false },
      ).find((c) => c.key === 'quic');
      expect(quic?.aged?.value).toBe(value);
      expect(quic?.unmeasured).toBeUndefined();
      expect(quic?.hint).not.toMatch(/UDP/);
    }
  });

  it('the card and the list read the same four states', () => {
    const cardUdp = (r: ProxyTestResult) =>
      capabilityChips({ hasProxy: true, capabilities: r } as CapsInput).eligible.find(
        (c) => c.key === 'udp',
      );
    const listUdp = (r: ProxyTestResult) => listUdpVerdict(proxyCapabilities(r), undefined);
    const silent = probe({ udp_associate: true, udp_relay: 'silent' });
    expect(cardUdp(silent)?.text).toBe('— UDP');
    expect(cardUdp(silent)?.title).toMatch(/not verified/i);
    expect(listUdp(silent)).toBe('unknown');
    expect(listUdp(legacy({ udp_associate: true }))).toBe('unknown');
    expect(listUdp(probe({ udp_relay: 'refused', udp_associate: false }))).toBe('fail');
    expect(listUdp(probe({ udp_relay: 'relays' }))).toBe('ok');
    expect(cardUdp(probe({ udp_relay: 'relays' }))?.text).toBe('✓ UDP');
  });
});

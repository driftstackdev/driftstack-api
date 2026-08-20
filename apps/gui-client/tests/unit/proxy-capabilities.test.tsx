// Proxy protocol capabilities — the "professional" breakdown that replaced the
// bare UDP badge. proxyCapabilities() derives WebRTC / QUIC / HTTP-2 support
// honestly from a SOCKS5 probe; the chips render ✓ vs ⤵ (fell back) per
// protocol. Guards the derivation table (a wrong mapping would over- or
// under-state what an exit can carry).

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ProxyTestResult } from '../../src/lib/proxies';
import { proxyCapabilities, ProxyCapabilityChips } from '../../src/components/ProxyCapabilities';

function probe(over: Partial<ProxyTestResult> = {}): ProxyTestResult {
  return {
    reachable: true,
    auth_ok: true,
    udp_associate: true,
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

  it('no UDP relay → WebRTC + QUIC fall back, HTTP/2 still ok', () => {
    const caps = proxyCapabilities(probe({ udp_associate: false }));
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
    const { container } = render(<ProxyCapabilityChips result={probe({ udp_associate: false })} />);
    expect(screen.getByText('WebRTC')).toBeTruthy();
    expect(screen.getByText('QUIC')).toBeTruthy();
    expect(screen.getByText('HTTP/2')).toBeTruthy();
    const webrtc = container.querySelector('[data-capability="webrtc"]');
    const http2 = container.querySelector('[data-capability="http2"]');
    expect(webrtc?.getAttribute('data-ok')).toBe('false');
    expect(http2?.getAttribute('data-ok')).toBe('true');
  });
});

// The QUIC chip showed a green ✓ for a proxy that does not carry HTTP/3.
//
// Reported: an exit that relays UDP but has no QUIC still read as verified.
// Both chips were computed from the SAME expression —
//
//   const udp = live && result.udp_associate;
//   { key: 'webrtc', ok: udp }
//   { key: 'quic',   ok: udp }
//
// — so one measurement was being restated as two different claims.
//
// UDP ASSOCIATE is NECESSARY for QUIC and nowhere near SUFFICIENT. The probe
// proves the exit will relay a datagram, which is exactly what WebRTC needs, so
// that chip is a fair verdict. QUIC additionally needs sustained bidirectional
// UDP on :443 with datagrams big enough for the handshake, and exits routinely
// relay UDP while blocking UDP/443, inspecting the QUIC Initial, or fragmenting
// below its minimum MTU.
//
// ProxyTestResult carries no QUIC signal at all, so this cannot be measured
// from here — only inferred. The fix is to SAY inferred rather than to keep
// asserting a measurement nobody took.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { proxyCapabilities, ProxyCapabilityChips } from '../../src/components/ProxyCapabilities';
import type { ProxyTestResult } from '../../src/lib/proxies';

const UDP_OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'Working — CONNECT succeeded.',
};

const cap = (r: ProxyTestResult, key: string) => proxyCapabilities(r).find((c) => c.key === key)!;

describe('QUIC is inferred, not measured', () => {
  it('CRITICAL a UDP-relaying exit does NOT get a verified QUIC verdict. This is the reported false positive: UDP ASSOCIATE is necessary for HTTP/3 and nowhere near sufficient.', () => {
    const quic = cap(UDP_OK, 'quic');
    expect(quic.ok, 'HTTP/3 is still the likely outcome').toBe(true);
    expect(quic.inferred, 'but it was never measured, and the chip must say so').toBe(true);
  });

  it('WebRTC stays a real verdict — UDP relay IS what it needs, so that chip is not weakened', () => {
    // The fix must not blunt the honest signal while correcting the dishonest one.
    const webrtc = cap(UDP_OK, 'webrtc');
    expect(webrtc.ok).toBe(true);
    expect(webrtc.inferred ?? false).toBe(false);
  });

  it('the NEGATIVE stays solid — no UDP relay means QUIC genuinely cannot work, which is a measurement', () => {
    const quic = cap({ ...UDP_OK, udp_associate: false }, 'quic');
    expect(quic.ok).toBe(false);
    expect(quic.inferred ?? false, 'a negative needs no hedge').toBe(false);
  });

  it('the hint tells the customer it is untested, and names why UDP is not enough', () => {
    const quic = cap(UDP_OK, 'quic');
    expect(quic.hint).toMatch(/not tested|LIKELY/);
    expect(quic.hint).toMatch(/UDP\/443|handshake|fragment/);
    // It must not keep asserting the thing that was wrong.
    expect(quic.hint).not.toMatch(/HTTP\/3 \(QUIC\) tunnels through this exit/);
  });

  it('renders distinctly from a verified chip — a ✓ next to QUIC is the bug itself', () => {
    render(<ProxyCapabilityChips result={UDP_OK} />);
    const quic = document.querySelector('[data-capability="quic"]');
    const webrtc = document.querySelector('[data-capability="webrtc"]');
    expect(quic?.getAttribute('data-inferred')).toBe('true');
    expect(webrtc?.getAttribute('data-inferred')).toBe('false');
    expect(quic?.textContent).not.toContain('✓');
    expect(webrtc?.textContent).toContain('✓');
  });

  it('HTTP/2 is unaffected — it rides the TCP stack the probe actually exercised', () => {
    const http2 = cap(UDP_OK, 'http2');
    expect(http2.ok).toBe(true);
    expect(http2.inferred ?? false).toBe(false);
    expect(cap({ ...UDP_OK, can_route: false }, 'http2').ok).toBe(false);
  });

  it('an unusable exit claims nothing at all, inferred or otherwise', () => {
    // A proxy that authenticates but cannot route must not carry any capability.
    const dead = { ...UDP_OK, can_route: false };
    for (const key of ['webrtc', 'quic', 'http2'] as const) {
      expect(cap(dead, key).ok, `${key} claimed on an exit that cannot route`).toBe(false);
    }
    expect(screen).toBeDefined();
  });
});

// T-6 EXTENSION — the inference above is the fallback; a QUIC verdict the control
// plane MEASURED in a live session overrides it. This does not contradict the
// rows above: with no measurement (the default), the chip stays exactly as
// inferred. The measured path only adds a way OUT of the guess in either
// direction — a real 'h3' that earns the green ✓, and a measured 'h2-only' that
// is an honest negative rather than a hedge.
const capQ = (r: ProxyTestResult, q: 'h3' | 'h2-only' | null | undefined, key: string) =>
  proxyCapabilities(r, q).find((c) => c.key === key)!;

describe('QUIC measured in a live session overrides the inference', () => {
  it("a measured 'h3' is a real verdict, not a guess — ok and NOT inferred (the only green)", () => {
    const quic = capQ(UDP_OK, 'h3', 'quic');
    expect(quic.ok).toBe(true);
    expect(quic.inferred ?? false, 'a measurement is not inferred').toBe(false);
  });

  it("a measured 'h2-only' is a measured NEGATIVE — not ok, and not inferred", () => {
    const quic = capQ(UDP_OK, 'h2-only', 'quic');
    expect(quic.ok, 'HTTP/3 was measured absent').toBe(false);
    expect(quic.inferred ?? false, 'measured, so no hedge').toBe(false);
  });

  it('a measurement overrides the UDP inference even when they disagree', () => {
    // The session is ground truth: a proxy that relays UDP can still block
    // UDP/443, so a measured 'h2-only' beats the optimistic inference…
    expect(capQ(UDP_OK, 'h2-only', 'quic').ok).toBe(false);
    // …and a live session that carried HTTP/3 is proof it works even if the
    // native UDP-associate probe never saw a relay.
    const noUdp = { ...UDP_OK, udp_associate: false };
    const quic = capQ(noUdp, 'h3', 'quic');
    expect(quic.ok).toBe(true);
    expect(quic.inferred ?? false).toBe(false);
  });

  it('VACUITY CONTROL — null and undefined keep the EXACT inferred behaviour the rows above assert', () => {
    // If the measured path had leaked into the unmeasured case, this would fail:
    // the chip must be identical to calling proxyCapabilities with no verdict.
    for (const q of [null, undefined] as const) {
      const quic = capQ(UDP_OK, q, 'quic');
      expect(quic.ok, 'still the UDP inference').toBe(true);
      expect(quic.inferred, 'still inferred — never promoted to a measurement').toBe(true);
    }
  });

  it('WebRTC and HTTP/2 are untouched by a QUIC measurement', () => {
    for (const q of ['h3', 'h2-only'] as const) {
      expect(capQ(UDP_OK, q, 'webrtc').ok).toBe(true);
      expect(capQ(UDP_OK, q, 'webrtc').inferred ?? false).toBe(false);
      expect(capQ(UDP_OK, q, 'http2').ok).toBe(true);
    }
  });
});

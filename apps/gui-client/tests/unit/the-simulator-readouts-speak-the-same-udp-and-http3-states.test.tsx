// Owner item 9 (2026-09-24): "The UDP, QUIC, Apple badges … they should all
// always show accurate stats." — the Simulator arm.
//
// The Simulator's egress readouts had no UDP line at all, and no "no HTTP/3"
// state: a session whose proxy does not relay UDP (so HTTP/3 cannot work) read
// "HTTP/3: not observed", the same words as a session nothing had reported on.
// Every other surface shows both. The Simulator now shows the same states in
// the same words as the profile card and the Proxies grid, for the same
// reading — and this file holds it to them, so it cannot drift again:
//   • UDP  — '— UDP · not measured in this session' for a SOCKS5 session (the
//            report carries only the dispatch constant — proxy-accuracy audit
//            G5), '⇢ UDP' (a VPN: routed through the tunnel, not measured) and
//            '— UDP' (nothing reported). (gui-v0.1.72: the ONE vocabulary, mark
//            first — it read 'UDP ✓' and 'UDP: not measured yet'.)
//   • HTTP/3 — a measured NO: a session set to HTTP/2 only. A real HTTP/3
//            connection still outranks it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';
import { capabilityChips, type CapsInput } from '../../src/components/ProfilePhoneCard';
import { VPN_UDP_NOT_MEASURED_TITLE } from '../../src/lib/proxy-check-copy';
import { SESSION_UDP_NOT_MEASURED_TITLE } from '../../src/lib/simulator-network-readouts';
import { QuicReadout } from '../../src/components/QuicReadout';
import { UdpReadout } from '../../src/components/UdpReadout';
import { getAgentSession } from '../../src/lib/agent-session-control';
import { capabilityReportsEqual } from '../../src/lib/capability-report-equal';

afterEach(cleanup);

const BASE: AgentSessionCapabilityReport = {
  manual_input_available: true,
  streaming_state: 'live',
  egress_state: 'live',
};

/** What the profile card draws for a UDP reading Driftstack took. */
function cardUdpText(p: Partial<CapsInput>): string | undefined {
  const input = { hasProxy: true, capabilities: null, ...p } as CapsInput;
  return capabilityChips(input).eligible.find((c) => c.key === 'udp')?.text;
}
function udpLine(report: AgentSessionCapabilityReport | null): HTMLElement {
  const { container } = render(<UdpReadout report={report} />);
  return container.querySelector('[data-component="sim-udp-readout"]') as HTMLElement;
}
function h3Line(report: AgentSessionCapabilityReport | null): HTMLElement {
  const { container } = render(<QuicReadout report={report} />);
  return container.querySelector('[data-component="sim-quic-readout"]') as HTMLElement;
}

// ⛔ Proxy-accuracy audit G5 (paths-03, GUI half): `proxy_udp_supported` is
// `descriptor.supportsUDP` — the DISPATCH CONSTANT the server writes into every
// SOCKS5 launch config (services/account-proxies.ts), echoed back by the phone.
// Nothing measured it. The line read "✓ UDP" in the ready green, in the measured
// state, for every SOCKS5 session, whatever the proxy does with a datagram. A
// config value is never shown as measured (contract C2): the line says "— UDP ·
// not measured in this session" until a report field carries a real measurement.
describe('the Simulator UDP line never shows the dispatch constant as a measurement', () => {
  it('CRITICAL (T9) a SOCKS5 session whose config says UDP (`proxy_udp_supported: true`) reads "— UDP · not measured in this session" — not measured, never the ready green', () => {
    for (const report of [
      { ...BASE, proxy_kind: 'socks5' as const, proxy_udp_supported: true },
      { ...BASE, proxy_udp_supported: true },
    ]) {
      const el = udpLine(report);
      expect(el.getAttribute('data-state')).toBe('not-measured');
      expect(el.textContent).toBe('— UDP · not measured in this session');
      expect(el.className).not.toContain('text-status-ready');
      expect(el.getAttribute('title')).toBe(SESSION_UDP_NOT_MEASURED_TITLE);
      expect(el.getAttribute('title')).not.toMatch(/UDP works/);
      cleanup();
    }
  });

  it('CRITICAL the same constant set to false is not a measured NO either — no ⤵', () => {
    const el = udpLine({ ...BASE, proxy_kind: 'socks5', proxy_udp_supported: false });
    expect(el.getAttribute('data-state')).toBe('not-measured');
    expect(el.textContent).toBe('— UDP · not measured in this session');
    expect(el.textContent).not.toContain('⤵');
  });

  it('CRITICAL a session that completed an HTTP/3 connection HAS measured UDP on its own path (QUIC needs datagrams both ways): "✓ UDP", measured — the one measurement the report carries today', () => {
    const el = udpLine({
      ...BASE,
      proxy_kind: 'socks5',
      proxy_udp_supported: true,
      h3_connection_observed: true,
      h3_connection_count: 2,
    });
    expect(el.getAttribute('data-state')).toBe('measured');
    expect(el.textContent).toBe('✓ UDP');
    expect(el.className).toContain('text-status-ready');
    expect(el.getAttribute('title')).toMatch(/HTTP\/3/);
    // ⛔ An HTTP/3 connection proves UDP on the web port of this session's path,
    // nothing wider: the hover must not state that calls and media get through
    // (report D3 — a QUIC-relay reading, not generic UDP or WebRTC).
    expect(el.getAttribute('title')).not.toMatch(/WebRTC|calls|media/i);
    // …and the launch setting alone, beside no HTTP/3, is still not a reading.
    cleanup();
    expect(udpLine({ ...BASE, proxy_udp_supported: true }).getAttribute('data-state')).toBe(
      'not-measured',
    );
  });

  it('a VPN session: the card’s "⇢ UDP" and its sentence — routed through the tunnel, not measured', () => {
    const el = udpLine({ ...BASE, proxy_kind: 'wireguard', proxy_udp_supported: true });
    expect(el.getAttribute('data-state')).toBe('not-measured');
    expect(el.textContent).toBe(cardUdpText({ vpn: true }));
    expect(el.getAttribute('title')).toBe(VPN_UDP_NOT_MEASURED_TITLE);
  });

  it('nothing reported yet: "— UDP" (not measured) — never a verdict', () => {
    for (const report of [null, BASE]) {
      const el = udpLine(report);
      expect(el.getAttribute('data-state')).toBe('not-measured');
      expect(el.textContent).toBe('— UDP');
      cleanup();
    }
  });
});

describe('the Simulator HTTP/3 line has the measured NO every other surface has', () => {
  it('G5 — the dispatch constant `proxy_udp_supported: false` is not a measured NO about HTTP/3 either: "not observed", never "⤵ QUIC"', () => {
    const el = h3Line({ ...BASE, proxy_udp_supported: false });
    expect(el.getAttribute('data-state')).toBe('not-observed');
    expect(el.textContent).not.toContain('⤵');
  });

  it('a session set to HTTP/2 only: no HTTP/3, said so', () => {
    const el = h3Line({ ...BASE, proxy_udp_supported: true, transport_mode_active: 'h2-only' });
    expect(el.getAttribute('data-state')).toBe('no-http3');
    expect(el.textContent).toBe('⤵ QUIC · HTTP/2 only');
  });

  it('CONTROL — a real HTTP/3 connection outranks both', () => {
    const el = h3Line({
      ...BASE,
      proxy_udp_supported: false,
      transport_mode_active: 'h2-only',
      h3_connection_observed: true,
      h3_connection_count: 3,
    });
    expect(el.getAttribute('data-state')).toBe('observed');
  });

  it('CONTROL — with UDP working and nothing observed, it is still "not observed", never a NO', () => {
    const el = h3Line({ ...BASE, proxy_udp_supported: true });
    expect(el.getAttribute('data-state')).toBe('not-observed');
  });
});

describe('the readings reach the Simulator, and a change to them is a change', () => {
  it('the session read keeps the UDP and transport readings the server sends', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            mode: 'manual',
            status: 'active',
            capability_report: {
              manual_input_available: true,
              streaming_state: 'live',
              egress_state: 'live',
              proxy_udp_supported: false,
              transport_mode_active: 'h2-only',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    try {
      const s = await getAgentSession('agt_x', {
        controlKey: `gck_${'a'.repeat(32)}`,
        baseUrl: 'https://api.example.test',
      });
      expect(s.capabilityReport?.proxy_udp_supported).toBe(false);
      expect(s.capabilityReport?.transport_mode_active).toBe('h2-only');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('a report that changes only its UDP reading is a new report (the line updates)', () => {
    expect(
      capabilityReportsEqual(
        { ...BASE, proxy_udp_supported: true },
        { ...BASE, proxy_udp_supported: false },
      ),
    ).toBe(false);
    expect(
      capabilityReportsEqual(
        { ...BASE, transport_mode_active: 'h2-and-h3' },
        { ...BASE, transport_mode_active: 'h2-only' },
      ),
    ).toBe(false);
    expect(capabilityReportsEqual({ ...BASE }, { ...BASE })).toBe(true);
  });

  it('a UDP reading alone opens the Egress panel it is drawn in', async () => {
    const { reportHasEgressReadout } = await import('../../src/views/SimulatorWindow');
    expect(reportHasEgressReadout({ ...BASE, proxy_udp_supported: false })).toBe(true);
    expect(reportHasEgressReadout({ ...BASE, transport_mode_active: 'h2-only' })).toBe(true);
    expect(reportHasEgressReadout({ ...BASE })).toBe(false);
  });
});

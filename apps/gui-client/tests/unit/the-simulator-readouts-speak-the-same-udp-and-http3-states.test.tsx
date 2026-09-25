// Owner item 9 (2026-09-24): "The UDP, QUIC, Apple badges … they should all
// always show accurate stats." — the Simulator arm.
//
// The Simulator's egress readouts had no UDP line at all, and no "no HTTP/3"
// state: a session whose proxy does not relay UDP (so HTTP/3 cannot work) read
// "HTTP/3: not observed", the same words as a session nothing had reported on.
// Every other surface shows both. The Simulator now shows the same states in
// the same words as the profile card and the Proxies grid, for the same
// reading — and this file holds it to them, so it cannot drift again:
//   • UDP  — 'UDP ✓' (measured, works) / '⤵ UDP' (measured, does not) /
//            '⇢ UDP' (a VPN: routed through the tunnel, not measured) /
//            'UDP: not measured yet' (nothing reported). WebRTC is in the tooltip.
//   • HTTP/3 — a measured NO: no UDP (HTTP/3 cannot work), or a session set to
//            HTTP/2 only. A real HTTP/3 connection still outranks both.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';
import type { ProxyTestResult } from '../../src/lib/proxies';
import { proxyCapabilities } from '../../src/components/ProxyCapabilities';
import { capabilityChips, type CapsInput } from '../../src/components/ProfilePhoneCard';
import { VPN_UDP_NOT_MEASURED_TITLE } from '../../src/lib/proxy-check-copy';
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

/** A proxy test that carries traffic, with or without a UDP relay. */
function usable(udp: boolean): ProxyTestResult {
  return {
    reachable: true,
    auth_ok: true,
    udp_associate: udp,
    can_route: true,
    connect_reply: 0,
    latency_ms: 40,
    message: '',
  };
}

/** What the profile card draws for a UDP reading Driftstack took. */
function cardUdpText(p: Partial<CapsInput>): string | undefined {
  const input = { hasProxy: true, capabilities: null, ...p } as CapsInput;
  return capabilityChips(input).eligible.find((c) => c.key === 'udp')?.text;
}
/** What the Proxies grid says about the same reading. */
const gridHint = (udp: boolean, key: 'webrtc' | 'quic'): string =>
  proxyCapabilities(usable(udp)).find((c) => c.key === key)?.hint ?? '';

function udpLine(report: AgentSessionCapabilityReport | null): HTMLElement {
  const { container } = render(<UdpReadout report={report} />);
  return container.querySelector('[data-component="sim-udp-readout"]') as HTMLElement;
}
function h3Line(report: AgentSessionCapabilityReport | null): HTMLElement {
  const { container } = render(<QuicReadout report={report} />);
  return container.querySelector('[data-component="sim-quic-readout"]') as HTMLElement;
}

describe('the Simulator UDP line says what the card and the grid say', () => {
  it('measured, works: the card’s "UDP ✓", in green, with WebRTC in the tooltip', () => {
    const el = udpLine({ ...BASE, proxy_udp_supported: true });
    expect(el.getAttribute('data-state')).toBe('measured');
    expect(el.textContent).toBe(cardUdpText({ udpProbe: true }));
    expect(el.textContent).toBe('UDP ✓');
    expect(el.className).toContain('text-status-ready');
    expect(el.getAttribute('title')).toBe(gridHint(true, 'webrtc'));
    expect(el.getAttribute('title')).toMatch(/WebRTC/);
  });

  it('measured, does not work: the card’s "⤵ UDP", muted — a fall-back, never red', () => {
    const el = udpLine({ ...BASE, proxy_udp_supported: false });
    expect(el.getAttribute('data-state')).toBe('failed');
    expect(el.textContent).toBe(cardUdpText({ udpProbe: false }));
    expect(el.textContent).toBe('⤵ UDP');
    expect(el.className).not.toContain('status-error');
    expect(el.getAttribute('title')).toBe(gridHint(false, 'webrtc'));
  });

  it('a VPN session: the card’s "⇢ UDP" and its sentence — routed through the tunnel, not measured', () => {
    const el = udpLine({ ...BASE, proxy_kind: 'wireguard', proxy_udp_supported: true });
    expect(el.getAttribute('data-state')).toBe('not-measured');
    expect(el.textContent).toBe(cardUdpText({ vpn: true }));
    expect(el.getAttribute('title')).toBe(VPN_UDP_NOT_MEASURED_TITLE);
  });

  it('nothing reported yet: "UDP: not measured yet" — never a verdict', () => {
    for (const report of [null, BASE]) {
      const el = udpLine(report);
      expect(el.getAttribute('data-state')).toBe('not-measured');
      expect(el.textContent).toBe('UDP: not measured yet');
      cleanup();
    }
  });
});

describe('the Simulator HTTP/3 line has the measured NO every other surface has', () => {
  it('no UDP: HTTP/3 cannot work — the grid’s own sentence, not "not observed"', () => {
    const el = h3Line({ ...BASE, proxy_udp_supported: false });
    expect(el.getAttribute('data-state')).toBe('no-http3');
    expect(el.textContent).toBe('⤵ HTTP/3 · HTTP/2 only');
    expect(el.getAttribute('title')).toBe(gridHint(false, 'quic'));
  });

  it('a session set to HTTP/2 only: no HTTP/3, said so', () => {
    const el = h3Line({ ...BASE, proxy_udp_supported: true, transport_mode_active: 'h2-only' });
    expect(el.getAttribute('data-state')).toBe('no-http3');
    expect(el.textContent).toBe('⤵ HTTP/3 · HTTP/2 only');
  });

  it('CONTROL — a real HTTP/3 connection outranks both', () => {
    const el = h3Line({
      ...BASE,
      proxy_udp_supported: false,
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

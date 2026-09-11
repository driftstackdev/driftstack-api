// Item 11 guard (N-2) — the cockpit exit-OS readout.
//
// The load-bearing property: os_fingerprint is ABSENT-means-unknown, so absence
// must NEVER render a placeholder OS. Only a real, well-typed {os, confidence}
// shows the observed line — and it is a NEUTRAL fact (muted, not a status colour),
// unlike the green HTTP/3 verdict beside it.
//
// (o) O4 — and absence must not read "measuring…" either: nothing measures a
// session's OS fingerprint (the only producer is the proxy's own Test), so that
// word asserted work in progress that was not happening — the owner's item-11
// symptom. Absence now says "not measured" and names the action that can measure
// it; for a VPN session, where no action can, it says that instead.
// Mutations: rendering an OS on an absent field reds the absence arms; restoring
// the "measuring…" literal reds the never-measuring arm.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OsReadout } from '../../src/components/OsReadout';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';

function report(over: Partial<AgentSessionCapabilityReport>): AgentSessionCapabilityReport {
  return {
    manual_input_available: null,
    streaming_state: null,
    egress_state: null,
    ...over,
  };
}

describe('OsReadout', () => {
  it('renders "not measured" when there is no report yet — and names the action that measures it', () => {
    render(<OsReadout report={null} />);
    const el = screen.getByText(/^OS: not measured$/);
    expect(el).toBeTruthy();
    expect(el.getAttribute('data-state')).toBe('not-measured');
    expect(el.getAttribute('title')).toMatch(/run Test on this profile/i);
  });

  it('renders "not measured" when the report is present but os_fingerprint is ABSENT — absence is not a placeholder OS', () => {
    // The whole point: an absent os_fingerprint must not read as a known OS.
    render(<OsReadout report={report({})} />);
    const el = screen.getByText(/^OS: not measured$/);
    expect(el.getAttribute('data-state')).toBe('not-measured');
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it('(o) O4 — a VPN session says the fingerprint is NOT AVAILABLE, never "run Test": a tunnel has no SOCKS5 stack to fingerprint, so that advice can never work', () => {
    for (const kind of ['openvpn', 'wireguard'] as const) {
      const { unmount } = render(<OsReadout report={report({ proxy_kind: kind })} />);
      const el = screen.getByText(/^OS: not available for a VPN tunnel$/);
      expect(el.getAttribute('data-state')).toBe('not-available');
      expect(el.getAttribute('title') ?? '').not.toMatch(/run Test/i);
      unmount();
    }
  });

  it('(o) O4 — CONTROL: absence NEVER reads "measuring" — the word asserts work in progress, and nothing measures a session OS fingerprint', () => {
    for (const r of [null, report({}), report({ proxy_kind: 'wireguard' })]) {
      const { container, unmount } = render(<OsReadout report={r} />);
      expect(container.textContent ?? '').not.toMatch(/measuring/i);
      expect(container.querySelector('[data-state="measuring"]')).toBeNull();
      unmount();
    }
  });

  it('renders "<os> · <confidence>" once the exit OS fingerprint was observed', () => {
    render(
      <OsReadout report={report({ os_fingerprint: { os: 'windows', confidence: 'medium' } })} />,
    );
    const el = screen.getByText(/OS: windows · medium/);
    expect(el.getAttribute('data-state')).toBe('observed');
    // Neutral, not a status colour (mirrors ExitIpChip's text-white/70).
    expect(el.className).toContain('text-white/70');
  });

  it('shows the observed os + confidence verbatim (no coercion of the confidence label)', () => {
    render(
      <OsReadout report={report({ os_fingerprint: { os: 'macos-or-ios', confidence: 'high' } })} />,
    );
    expect(screen.getByText(/OS: macos-or-ios · high/)).toBeTruthy();
  });
});

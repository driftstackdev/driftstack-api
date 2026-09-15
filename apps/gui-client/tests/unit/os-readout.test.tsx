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
import { OS_FINGERPRINT_TTL_MS } from '../../src/lib/os-fingerprint-verdict';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';

/** WCAG 2.1 contrast of a `text-white/<alpha>` class over the simulator drawer's own chrome
 *  (#1d1e24, dark in BOTH themes) — computed from the class the DOM carries. */
function whiteAlphaContrast(className: string): number {
  const m = /(?:^|\s)text-white\/(\d+)(?:\s|$)/.exec(className);
  if (m === null) throw new Error(`no text-white/<alpha> class on: ${className}`);
  const alpha = Number(m[1]) / 100;
  const chrome: readonly [number, number, number] = [0x1d, 0x1e, 0x24];
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]: readonly [number, number, number]): number =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const over = (v: number): number => 255 * alpha + v * (1 - alpha);
  const fg = lum([over(chrome[0]), over(chrome[1]), over(chrome[2])]);
  const bg = lum(chrome);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

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

  // ⛔⛔ (V-219) THIS FIELD IS NOT A LIVE MEASUREMENT and every field beside it
  // is. The control plane fingerprints a proxy's stack exactly once, when the
  // customer presses Test on the Proxies screen, and stores it on the proxy row;
  // nothing re-reads it while a session runs. So this line rendered a reading of
  // unbounded age in the same present tense as the streaming state and the exit
  // IP next to it — `OS: windows · high`, indistinguishable from a fact measured
  // seconds ago.
  //
  // Labelled rather than dropped: unlike the 178px grid chip, which has no room
  // and drops the reading past the same window, there is room on this line to say
  // when — and an old reading that admits its age is worth more than none.
  const NOW = Date.parse('2026-09-15T12:00:00.000Z');
  const observed = (at: string | undefined): AgentSessionCapabilityReport =>
    report({
      os_fingerprint: { os: 'windows', confidence: 'high', ...(at !== undefined ? { at } : {}) },
    });

  it('CRITICAL a reading past the freshness window says WHEN it was taken — a stored fact rendered in bare present tense is the whole defect', () => {
    const at = new Date(NOW - OS_FINGERPRINT_TTL_MS * 100).toISOString();
    render(<OsReadout report={observed(at)} nowMs={NOW} />);
    const el = screen.getByText(/OS: windows · high ·/);
    expect(el.getAttribute('data-age')).toBe('aged');
    expect(el.textContent ?? '').toMatch(/·\s*\d+\s*d ago$/);
    // And the title says the one thing a customer can do about it, plus WHY the
    // value is not simply re-read: nothing re-measures it during a session.
    expect(el.getAttribute('title') ?? '').toMatch(/press Test|run Test/i);
    expect(el.getAttribute('title') ?? '').toMatch(/does not re-read/i);
  });

  it('CRITICAL a FRESH reading says nothing about age — "just now" on every session is noise, and the label has to mean something when it appears', () => {
    const at = new Date(NOW - 5 * 60 * 1000).toISOString();
    render(<OsReadout report={observed(at)} nowMs={NOW} />);
    const el = screen.getByText(/^OS: windows · high$/);
    expect(el.getAttribute('data-age')).toBe('fresh');
    expect(el.textContent ?? '').not.toMatch(/ago/);
  });

  it('CRITICAL the boundary is the SHARED window, not a second literal — the grid chip drops a reading at exactly this age, and two surfaces disagreeing about the same proxy on the same screen is its own defect', () => {
    const justInside = new Date(NOW - (OS_FINGERPRINT_TTL_MS - 1)).toISOString();
    const justOutside = new Date(NOW - OS_FINGERPRINT_TTL_MS).toISOString();
    const a = render(<OsReadout report={observed(justInside)} nowMs={NOW} />);
    expect(
      a.container.querySelector('[data-component="sim-os-readout"]')?.getAttribute('data-age'),
    ).toBe('fresh');
    a.unmount();
    const b = render(<OsReadout report={observed(justOutside)} nowMs={NOW} />);
    expect(
      b.container.querySelector('[data-component="sim-os-readout"]')?.getAttribute('data-age'),
    ).toBe('aged');
  });

  it('an UNDATED reading still renders — a control plane that predates the stamp is a gap in OUR plumbing, not evidence about the customer\'s proxy, and blanking it would read as "never measured"', () => {
    render(<OsReadout report={observed(undefined)} nowMs={NOW} />);
    const el = screen.getByText(/^OS: windows · high$/);
    expect(el.getAttribute('data-state')).toBe('observed');
    expect(el.getAttribute('data-age')).toBe('undated');
  });

  it('CONTROL — a stamp in the FUTURE reads as current, never as a negative age. Clock skew between the box and this Mac is real, and "-3 d ago" is worse than saying nothing.', () => {
    const at = new Date(NOW + 60 * 60 * 1000).toISOString();
    render(<OsReadout report={observed(at)} nowMs={NOW} />);
    const el = screen.getByText(/^OS: windows · high$/);
    expect(el.getAttribute('data-age')).toBe('fresh');
  });

  it('(S1) the muted absence lines ("not measured", "not available") clear WCAG AA (4.5) on the drawer chrome', () => {
    // Measured 2026-09-12: the shared caption tint text-white/40 is 3.77 on #1d1e24. The
    // guard is the RATIO from the class the DOM carries, with the shipped-before value as
    // the control so the instrument is known to fail.
    for (const r of [null, report({}), report({ proxy_kind: 'wireguard' })]) {
      const { container, unmount } = render(<OsReadout report={r} />);
      const el = container.querySelector('[data-component="sim-os-readout"]');
      expect(el, 'the readout renders').not.toBeNull();
      expect(whiteAlphaContrast(el?.className ?? ''), el?.textContent ?? '').toBeGreaterThanOrEqual(
        4.5,
      );
      unmount();
    }
    expect(whiteAlphaContrast('mt-1 text-white/40')).toBeCloseTo(3.77, 2);
  });
});
